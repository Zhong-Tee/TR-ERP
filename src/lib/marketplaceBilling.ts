import { supabase } from './supabase'
import { insertOrderWithBillNo } from './billNo'
import { CHANNELS_COMPLETE_TO_VERIFIED } from './channelBehavior'
import {
  computePostSlipVerificationStatus,
  fetchOrderOwnerSalesRole,
  nonPumpDesignChecked,
} from './postSlipVerificationStatus'
import type { User } from '../types'
import type { MpOrder, MpOrderItem } from '../types/marketplace'

/**
 * เปิดบิลจากงาน Marketplace: สร้าง or_orders + or_order_items ตาม flow เดียวกับการสร้างบิลปกติ
 * แล้ว claim งาน (mp_orders → done) แบบกันเปิดบิลซ้ำ
 */

interface ProductRef {
  id: string
  product_name: string
}

function bangkokDateAndTime(iso: string | null): { date: string | null; time: string | null } {
  if (!iso) return { date: null, time: null }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: null, time: null }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const parts: Record<string, string> = {}
  fmt.formatToParts(d).forEach((p) => { parts[p.type] = p.value })
  const hour = parts.hour === '24' ? '00' : parts.hour
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}:${parts.second}`,
  }
}

/** สถานะเริ่มต้นของบิล — ตรรกะเดียวกับ OrderForm ตอนบันทึก "ข้อมูลครบ" */
async function computeInitialStatus(
  channelCode: string,
  user: User,
  requiresConfirmDesign: boolean,
): Promise<string> {
  let status = 'ลงข้อมูลเสร็จสิ้น'
  if (CHANNELS_COMPLETE_TO_VERIFIED.includes(channelCode)) {
    status = 'ตรวจสอบแล้ว'
  } else {
    // ช่องทางที่ไม่มีระบบตรวจสลิป → ตรวจสอบแล้ว (เทียบ OrderForm)
    const { data: bscData, error: bscError } = await supabase
      .from('bank_settings_channels')
      .select('bank_setting_id')
      .eq('channel_code', channelCode)
    let hasSlipVerification = false
    if (bscError) {
      hasSlipVerification = true
    } else if (bscData && bscData.length > 0) {
      const ids = bscData.map((r: { bank_setting_id: string }) => r.bank_setting_id)
      const { data: activeBank } = await supabase
        .from('bank_settings')
        .select('id')
        .in('id', ids)
        .eq('is_active', true)
        .limit(1)
      hasSlipVerification = !!(activeBank && activeBank.length > 0)
    }
    if (!hasSlipVerification) status = 'ตรวจสอบแล้ว'
  }

  if (status === 'ตรวจสอบแล้ว') {
    const ownerRole = await fetchOrderOwnerSalesRole(supabase, user.username || user.email)
    if (channelCode === 'PUMP') {
      status = computePostSlipVerificationStatus(ownerRole, channelCode, requiresConfirmDesign, {
        fallbackNonPumpNonSales: 'ตรวจสอบแล้ว',
      })
    } else if (ownerRole === 'sales-tr' && !nonPumpDesignChecked(requiresConfirmDesign)) {
      status = 'รอตรวจคำสั่งซื้อ'
    }
  }
  return status
}

/** ตรวจสต๊อกพอขาย (available = on_hand - reserved) — คืนรายการที่ไม่พอ */
export async function validateStockForItems(
  items: Pick<MpOrderItem, 'product_id' | 'qty'>[],
  productNameById: Map<string, string>,
): Promise<string[]> {
  const requested = new Map<string, number>()
  items.forEach((it) => {
    if (!it.product_id) return
    const qty = Number(it.qty || 0)
    if (qty <= 0) return
    requested.set(it.product_id, (requested.get(it.product_id) || 0) + qty)
  })
  if (requested.size === 0) return []

  const { data } = await supabase
    .from('inv_stock_balances')
    .select('product_id, on_hand, reserved')
    .in('product_id', [...requested.keys()])

  const availableById = new Map<string, number>()
  ;(data || []).forEach((r: { product_id: string; on_hand: number | null; reserved: number | null }) => {
    availableById.set(r.product_id, Number(r.on_hand || 0) - Number(r.reserved || 0))
  })

  const errors: string[] = []
  requested.forEach((qty, productId) => {
    const available = availableById.get(productId) ?? 0
    if (qty > available) {
      const name = productNameById.get(productId) || productId
      errors.push(`${name}: ต้องการ ${qty} คงเหลือขายได้ ${Math.max(0, available)}`)
    }
  })
  return errors
}

export interface OpenBillResult {
  billNo: string
  orderId: string
  status: string
}

export async function openBillFromMpOrder(params: {
  mpOrder: MpOrder
  items: MpOrderItem[]
  user: User
  productById: Map<string, ProductRef>
  paymentMethod: string
  requiresConfirmDesign: boolean
  trackingNo?: string | null
  billingDetails?: Record<string, unknown> | null
}): Promise<OpenBillResult> {
  const { mpOrder, items, user, productById, paymentMethod, requiresConfirmDesign, trackingNo, billingDetails } = params
  const channelCode = mpOrder.channel_code
  const currentUserName = user.username || user.email

  // ราคา: สินค้ารวมจากไฟล์/ที่แก้ไข, ค่าส่งจากไฟล์, ส่วนลด = ส่วนต่างกับยอดจ่ายจริง
  const price = Math.round(
    items.reduce((sum, it) => {
      if (it.is_free) return sum
      const lineTotal = it.line_total != null ? Number(it.line_total) : Number(it.qty || 0) * Number(it.unit_price || 0)
      return sum + (Number.isFinite(lineTotal) ? lineTotal : 0)
    }, 0) * 100,
  ) / 100
  const shipping = Number(mpOrder.shipping_fee || 0)
  const paidTotal = mpOrder.order_total != null ? Number(mpOrder.order_total) : price + shipping
  const discount = Math.max(0, Math.round((price + shipping - paidTotal) * 100) / 100)
  const totalAmount = Math.round((price + shipping - discount) * 100) / 100

  const { date: paymentDate, time: paymentTime } = bangkokDateAndTime(mpOrder.payment_time)
  const status = await computeInitialStatus(channelCode, user, requiresConfirmDesign)

  const addressParts = [mpOrder.address, mpOrder.district, mpOrder.province, mpOrder.postal_code]
    .filter(Boolean)
    .join(' ')

  const orderData = {
    channel_code: channelCode,
    status,
    price,
    shipping_cost: shipping,
    discount,
    total_amount: totalAmount,
    payment_method: paymentMethod || 'โอน',
    promotion: null,
    payment_date: paymentDate,
    payment_time: paymentTime,
    customer_name: mpOrder.buyer_username || mpOrder.recipient_name || '-',
    customer_address: addressParts || '-',
    recipient_name: mpOrder.recipient_name || null,
    channel_order_no: mpOrder.marketplace_order_no,
    tracking_number: (trackingNo ?? mpOrder.tracking_no)?.trim() || null,
    admin_user: currentUserName,
    entry_date: new Date().toISOString().slice(0, 10),
    requires_confirm_design: requiresConfirmDesign,
    billing_details: billingDetails ?? null,
    ship_due_at: mpOrder.ship_due_at,
    overdue_at: mpOrder.overdue_at,
  }

  // 1) สร้างบิล (retry เมื่อเลขบิลชน)
  const { id: orderId, bill_no: billNo } = await insertOrderWithBillNo(orderData, channelCode)

  // 2) สร้างรายการสินค้า — พลาดเมื่อไหร่ ลบบิลชดเชย (or_order_items ลบตาม cascade)
  try {
    const itemsPayload = items
      .filter((it) => it.product_id)
      .map((it, index) => ({
        order_id: orderId,
        item_uid: `${billNo}-${index + 1}`,
        product_id: it.product_id!,
        product_name: productById.get(it.product_id!)?.product_name || it.product_name_raw || '',
        quantity: Number(it.qty || 1),
        unit_price: Number(it.unit_price || 0),
        ink_color: it.ink_color || null,
        product_type: it.product_type || 'ชั้น1',
        cartoon_pattern: it.cartoon_pattern || null,
        line_pattern: it.line_pattern || null,
        font: it.font || null,
        line_1: it.line_1 || null,
        line_2: it.line_2 || null,
        line_3: it.line_3 || null,
        no_name_line: !!it.no_name_line,
        is_free: !!it.is_free,
        notes: it.notes || null,
        file_attachment: null,
      }))
    const { error: itemError } = await supabase.from('or_order_items').insert(itemsPayload)
    if (itemError) throw itemError
  } catch (err) {
    await supabase.from('or_orders').delete().eq('id', orderId)
    throw err
  }

  // 3) claim งาน — กันเปิดบิลซ้ำ (สองเครื่อง/สองแท็บพร้อมกัน)
  const { data: claimed, error: claimError } = await supabase
    .from('mp_orders')
    .update({
      status: 'done',
      billed_order_id: orderId,
      billed_bill_no: billNo,
      billed_at: new Date().toISOString(),
    })
    .eq('id', mpOrder.id)
    .is('billed_order_id', null)
    .select('id')
  if (claimError || !claimed || claimed.length === 0) {
    // มีคนเปิดบิลงานนี้ไปแล้ว → ลบบิลที่เพิ่งสร้าง
    await supabase.from('or_orders').delete().eq('id', orderId)
    const { data: current } = await supabase
      .from('mp_orders')
      .select('billed_bill_no')
      .eq('id', mpOrder.id)
      .maybeSingle()
    throw new Error(
      `ออเดอร์นี้ถูกเปิดบิลไปแล้ว${current?.billed_bill_no ? ` (บิล ${current.billed_bill_no})` : ''}`,
    )
  }

  return { billNo, orderId, status }
}
