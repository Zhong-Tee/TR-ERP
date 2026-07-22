import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import { useWmsModal } from '../wms/useWmsModal'
import { loadFieldRuleMaps, resolveFieldEnabled, type FieldRuleMaps } from '../../lib/productFieldRules'
import { openBillFromMpOrder, validateStockForItems } from '../../lib/marketplaceBilling'
import { formatDateTime } from '../../lib/utils'
import UrgencyBadge from '../common/UrgencyBadge'
import type { User } from '../../types'
import type { MpOrder, MpOrderItem } from '../../types/marketplace'

interface ProductOption {
  id: string
  product_code: string
  product_name: string
  product_category: string | null
}

interface InkOption { id: string; ink_name: string }
interface FontOption { font_code: string; font_name: string }
interface PatternOption { id: string; pattern_name: string }

const LAYERS = ['ชั้น1', 'ชั้น2', 'ชั้น3', 'ชั้น4', 'ชั้น5']

export default function MarketplaceOrderModal({
  mpOrder,
  readOnly,
  user,
  onClose,
  onChanged,
}: {
  mpOrder: MpOrder
  readOnly: boolean
  user: User
  onClose: () => void
  onChanged: () => void
}) {
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<MpOrderItem[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [fieldRules, setFieldRules] = useState<FieldRuleMaps>({ categorySettings: {}, productOverrides: {} })
  const [inkTypes, setInkTypes] = useState<InkOption[]>([])
  const [fonts, setFonts] = useState<FontOption[]>([])
  const [patterns, setPatterns] = useState<PatternOption[]>([])
  const [productSearch, setProductSearch] = useState<Record<string, string>>({})
  const [requiresConfirmDesign, setRequiresConfirmDesign] = useState(false)
  const [saving, setSaving] = useState(false)
  const [billing, setBilling] = useState(false)
  const [followUpMode, setFollowUpMode] = useState(false)
  const [followUpNote, setFollowUpNote] = useState(mpOrder.follow_up_note || '')
  const [cancelMode, setCancelMode] = useState(false)
  const [cancelNote, setCancelNote] = useState('')
  const [trackingNo, setTrackingNo] = useState(mpOrder.tracking_no || '')
  const [copied, setCopied] = useState(false)
  const [showTaxInvoice, setShowTaxInvoice] = useState(false)
  const [taxInvoiceData, setTaxInvoiceData] = useState({ company_name: '', address: '', tax_id: '' })
  // id ของ item ที่มีอยู่จริงใน DB — ใช้ diff ตอนบันทึก (update เดิม / insert ใหม่ / delete ที่หายไป)
  const [persistedIds, setPersistedIds] = useState<Set<string>>(new Set())
  // แผงแยกรายการ: id ของ item ที่กำลังแยก + จำนวนต่อรายการที่จะแยก
  const [splitFor, setSplitFor] = useState<string | null>(null)
  const [splitQtys, setSplitQtys] = useState<number[]>([])
  // map: itemId → groupId ของรายการที่ผู้ใช้กด "แยก" ในเซสชันนี้ (ไม่บันทึกลง DB — ใช้คุมปุ่ม "รวมกลับ")
  const [splitGroups, setSplitGroups] = useState<Record<string, string>>({})

  const productById = useMemo(() => {
    const m = new Map<string, ProductOption>()
    products.forEach((p) => m.set(p.id, p))
    return m
  }, [products])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [itemsRes, productsRes, rules, inkRes, fontRes, patternRes] = await Promise.all([
          supabase.from('mp_order_items').select('*').eq('mp_order_id', mpOrder.id).order('line_index'),
          supabase
            .from('pr_products')
            .select('id, product_code, product_name, product_category')
            .eq('is_active', true)
            .in('product_type', ['FG', 'PP']),
          loadFieldRuleMaps(),
          supabase.from('ink_types').select('id, ink_name').order('ink_name'),
          supabase.from('fonts').select('font_code, font_name').eq('is_active', true),
          supabase.from('cp_cartoon_patterns').select('id, pattern_name').eq('is_active', true),
        ])
        if (cancelled) return
        const loadedItems = (itemsRes.data || []) as MpOrderItem[]
        setItems(loadedItems)
        setPersistedIds(new Set(loadedItems.map((it) => it.id)))
        setProducts((productsRes.data || []) as ProductOption[])
        setFieldRules(rules)
        setInkTypes((inkRes.data || []) as InkOption[])
        setFonts((fontRes.data || []) as FontOption[])
        setPatterns((patternRes.data || []) as PatternOption[])

        const search: Record<string, string> = {}
        const prodMap = new Map(((productsRes.data || []) as ProductOption[]).map((p) => [p.id, p]))
        loadedItems.forEach((it) => {
          search[it.id] = it.product_id ? prodMap.get(it.product_id)?.product_name || '' : ''
        })
        setProductSearch(search)
      } catch (err) {
        console.error('Error loading marketplace order modal:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [mpOrder.id])

  function updateItem(id: string, patch: Partial<MpOrderItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  // แจกจำนวน total ออกเป็น n รายการให้เท่ากันมากที่สุด (เศษกระจายให้รายการแรก ๆ)
  function distributeQty(total: number, n: number): number[] {
    const t = Math.max(0, Math.floor(total))
    const count = Math.max(1, Math.floor(n))
    const base = Math.floor(t / count)
    const remainder = t - base * count
    return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
  }

  // item นี้เป็นสมาชิกของกลุ่มที่ "ผู้ใช้กดแยกในเซสชันนี้" และยังมีสมาชิกในกลุ่ม ≥ 2 แถวหรือไม่
  // (ใช้แสดงปุ่ม "รวมกลับ" — โผล่เฉพาะรายการที่ผู้ใช้แยกเอง ไม่ใช่รายการที่มาแยกจากไฟล์)
  function isSplitMember(it: MpOrderItem): boolean {
    const g = splitGroups[it.id]
    if (!g) return false
    return items.filter((x) => splitGroups[x.id] === g).length >= 2
  }

  function openSplit(it: MpOrderItem) {
    setSplitFor(it.id)
    setSplitQtys(distributeQty(Number(it.qty || 0), 2))
  }

  function closeSplit() {
    setSplitFor(null)
    setSplitQtys([])
  }

  // เปลี่ยนจำนวนรายการที่จะแยก → กระจายจำนวนใหม่ให้เท่ากัน
  function changeSplitCount(total: number, n: number) {
    const count = Math.min(Math.max(1, Math.floor(n || 0)), Math.max(1, Math.floor(total)))
    setSplitQtys(distributeQty(total, count))
  }

  // ยืนยันแยก: แทนแถวเดิมด้วย N แถวที่ copy ทุกช่อง ต่างกันแค่จำนวน (ล้าง line_total ให้คิดเงินจาก qty × ราคา/หน่วย)
  // ทุกแถวในการแยกครั้งนี้ถูก mark ด้วย group id เดียวกัน เพื่อให้ปุ่ม "รวมกลับ" โผล่เฉพาะกลุ่มนี้
  function applySplit(itemId: string, qtys: number[]) {
    const orig = items.find((it) => it.id === itemId)
    if (!orig) return
    const groupId = crypto.randomUUID()
    const rows: MpOrderItem[] = qtys.map((q, i) => ({
      ...orig,
      id: i === 0 ? orig.id : crypto.randomUUID(),
      qty: q,
      line_total: null,
    }))
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === itemId)
      if (idx < 0) return prev
      const next = [...prev]
      next.splice(idx, 1, ...rows)
      return next
    })
    setSplitGroups((prev) => {
      const next = { ...prev }
      rows.forEach((r) => {
        next[r.id] = groupId
      })
      return next
    })
    closeSplit()
  }

  // รวมกลับ: ยุบทุกแถวในกลุ่มที่แยกมาด้วยกัน (รวม qty) เหลือแถวเดียว แล้วล้าง mark ของกลุ่ม
  function mergeRun(itemId: string) {
    const groupId = splitGroups[itemId]
    if (!groupId) return
    setItems((prev) => {
      const firstIdx = prev.findIndex((it) => splitGroups[it.id] === groupId)
      const members = prev.filter((it) => splitGroups[it.id] === groupId)
      if (firstIdx < 0 || members.length < 2) return prev
      const sum = members.reduce((s, it) => s + Number(it.qty || 0), 0)
      const merged: MpOrderItem = { ...prev[firstIdx], qty: sum, line_total: null }
      const next = prev.filter((it) => splitGroups[it.id] !== groupId)
      next.splice(firstIdx, 0, merged)
      return next
    })
    setSplitGroups((prev) => {
      const next = { ...prev }
      Object.keys(next).forEach((k) => {
        if (next[k] === groupId) delete next[k]
      })
      return next
    })
  }

  function fieldEnabled(item: MpOrderItem, fieldKey: string): boolean {
    const product = item.product_id ? productById.get(item.product_id) : null
    return resolveFieldEnabled(product, fieldKey, fieldRules)
  }

  function matchProduct(input: string): ProductOption | undefined {
    const q = input.trim().toLowerCase()
    if (!q) return undefined
    return (
      products.find((p) => p.product_code.trim().toLowerCase() === q) ||
      products.find((p) => p.product_name.trim().toLowerCase() === q)
    )
  }

  async function saveDrafts(): Promise<boolean> {
    try {
      // 1) ลบแถวที่หายไป (เช่น ถูกรวมกลับ) ที่เคยมีอยู่ใน DB
      const currentIds = new Set(items.map((it) => it.id))
      const toDelete = [...persistedIds].filter((id) => !currentIds.has(id))
      if (toDelete.length > 0) {
        const { error } = await supabase.from('mp_order_items').delete().in('id', toDelete)
        if (error) throw error
      }

      // 2) ย้าย line_index ของแถวเดิมไปช่วงชั่วคราว กัน UNIQUE(mp_order_id, line_index) ชนตอน renumber
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        if (persistedIds.has(it.id)) {
          const { error } = await supabase
            .from('mp_order_items')
            .update({ line_index: 100000 + i })
            .eq('id', it.id)
          if (error) throw error
        }
      }

      // 3) update แถวเดิม / insert แถวที่แยกใหม่ ด้วย line_index สุดท้ายตามลำดับในตาราง
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const draft = {
          line_index: i,
          product_id: it.product_id,
          product_type: it.product_type,
          ink_color: it.ink_color,
          cartoon_pattern: it.cartoon_pattern,
          line_pattern: it.line_pattern,
          font: it.font,
          line_1: it.line_1,
          line_2: it.line_2,
          line_3: it.line_3,
          no_name_line: it.no_name_line,
          is_free: it.is_free,
          notes: it.notes,
          qty: it.qty,
          unit_price: it.unit_price,
          line_total: it.line_total,
        }
        if (persistedIds.has(it.id)) {
          const { error } = await supabase.from('mp_order_items').update(draft).eq('id', it.id)
          if (error) throw error
        } else {
          const { error } = await supabase.from('mp_order_items').insert({
            id: it.id,
            mp_order_id: mpOrder.id,
            product_name_raw: it.product_name_raw,
            sku_ref: it.sku_ref,
            variation: it.variation,
            raw_snapshot: it.raw_snapshot,
            ...draft,
          })
          if (error) throw error
        }
      }

      // เก็บเลขพัสดุที่กรอกไว้กับงาน (คงอยู่เมื่อเปิด popup ใหม่ / รอติดตาม)
      const { error: trackErr } = await supabase
        .from('mp_orders')
        .update({ tracking_no: trackingNo.trim() || null })
        .eq('id', mpOrder.id)
      if (trackErr) throw trackErr

      // แถวที่ insert ไปแล้วถือเป็นแถวใน DB — กัน re-save แล้ว insert ซ้ำ
      setPersistedIds(new Set(items.map((it) => it.id)))
      return true
    } catch (err) {
      showMessage({ title: 'บันทึกร่างไม่สำเร็จ', message: (err as Error).message })
      return false
    }
  }

  async function handleSaveDraft() {
    setSaving(true)
    const ok = await saveDrafts()
    setSaving(false)
    if (ok) showMessage({ title: 'บันทึกแล้ว', message: 'บันทึกร่างข้อมูลเรียบร้อย' })
  }

  async function handleFollowUp() {
    setSaving(true)
    try {
      const ok = await saveDrafts()
      if (!ok) return
      const { error } = await supabase
        .from('mp_orders')
        .update({
          status: 'follow_up',
          follow_up_note: followUpNote.trim() || null,
          follow_up_at: new Date().toISOString(),
        })
        .eq('id', mpOrder.id)
      if (error) throw error
      onChanged()
      onClose()
    } catch (err) {
      showMessage({ title: 'ผิดพลาด', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function handleCancel() {
    if (!cancelNote.trim()) {
      showMessage({ title: 'กรุณาระบุเหตุผล', message: 'ต้องระบุเหตุผลการยกเลิกบิล' })
      return
    }
    setSaving(true)
    try {
      const { error } = await supabase
        .from('mp_orders')
        .update({
          status: 'cancelled',
          cancel_note: cancelNote.trim(),
          cancelled_at: new Date().toISOString(),
          cancelled_by: user.id,
        })
        .eq('id', mpOrder.id)
      if (error) throw error
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      onChanged()
      onClose()
    } catch (err) {
      showMessage({ title: 'ผิดพลาด', message: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  function validateForBilling(): string | null {
    if (items.length === 0) return 'ไม่มีรายการสินค้า'
    const problems: string[] = []
    items.forEach((it, idx) => {
      const label = `รายการที่ ${idx + 1} (${it.product_name_raw || it.sku_ref || '-'})`
      if (!it.product_id) {
        problems.push(`${label}: ยังไม่ได้เลือกสินค้าในระบบ`)
        return
      }
      const missing: string[] = []
      if (fieldEnabled(it, 'ink_color') && !it.ink_color?.trim()) missing.push('สีหมึก')
      if (fieldEnabled(it, 'cartoon_pattern') && !it.cartoon_pattern?.trim()) missing.push('ลาย (ไม่ต้องการลายใส่ 0)')
      if (fieldEnabled(it, 'font') && !it.font?.trim()) missing.push('ฟอนต์ (ไม่ต้องการฟอนต์ใส่ 0)')
      if (fieldEnabled(it, 'quantity') && (!it.qty || Number(it.qty) <= 0)) missing.push('จำนวน')
      if (!it.is_free && (!it.unit_price || Number(it.unit_price) <= 0)) missing.push('ราคา/หน่วย')
      if (
        fieldEnabled(it, 'line_1') &&
        !it.no_name_line &&
        !it.line_1?.trim() &&
        !it.line_2?.trim() &&
        !it.line_3?.trim()
      ) {
        missing.push('บรรทัด 1-3 อย่างน้อย 1 ช่อง (หรือติ๊ก "ไม่รับชื่อ")')
      }
      if (missing.length > 0) problems.push(`${label}: ${missing.join(', ')}`)
    })
    return problems.length > 0 ? problems.join('\n') : null
  }

  async function handleOpenBill() {
    if (!trackingNo.trim()) {
      showMessage({ title: 'กรุณากรอกเลขพัสดุ', message: 'ต้องกรอกเลขพัสดุก่อนเปิดบิล' })
      return
    }

    const problem = validateForBilling()
    if (problem) {
      showMessage({ title: 'ข้อมูลยังไม่ครบ', message: problem })
      return
    }

    setBilling(true)
    try {
      // ตรวจสต๊อก
      const nameById = new Map<string, string>()
      productById.forEach((p, id) => nameById.set(id, p.product_name))
      const stockErrors = await validateStockForItems(items, nameById)
      if (stockErrors.length > 0) {
        showMessage({
          title: 'สต๊อกไม่เพียงพอ',
          message: `ไม่สามารถเปิดบิลได้ เนื่องจากสต๊อกไม่พอ\n\n${stockErrors.slice(0, 6).join('\n')}${stockErrors.length > 6 ? '\n...' : ''}`,
        })
        return
      }

      const ok = await showConfirm({
        message: `ยืนยันเปิดบิลออเดอร์ ${mpOrder.marketplace_order_no} ?\nช่องทาง ${mpOrder.channel_code} · ${items.length} รายการ`,
        confirmText: 'เปิดบิล',
      })
      if (!ok) return

      const saved = await saveDrafts()
      if (!saved) return

      const billingDetails = showTaxInvoice
        ? {
            request_tax_invoice: true,
            request_cash_bill: false,
            tax_customer_name: taxInvoiceData.company_name.trim() || null,
            tax_customer_address: taxInvoiceData.address.trim() || null,
            tax_id: taxInvoiceData.tax_id.trim() || null,
            tax_items: items
              .filter((it) => it.product_id && !it.is_free)
              .map((it) => ({
                product_name: productById.get(it.product_id!)?.product_name || it.product_name_raw || '',
                quantity: Number(it.qty || 1),
                unit_price: Number(it.unit_price || 0),
              })),
          }
        : null

      const result = await openBillFromMpOrder({
        mpOrder,
        items,
        user,
        productById: new Map([...productById].map(([id, p]) => [id, { id: p.id, product_name: p.product_name }])),
        paymentMethod: 'โอน',
        requiresConfirmDesign,
        trackingNo,
        billingDetails,
      })
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      showMessage({
        title: 'เปิดบิลสำเร็จ',
        message: `เลขบิล: ${result.billNo}\nสถานะ: ${result.status}`,
      })
      onChanged()
      onClose()
    } catch (err) {
      showMessage({ title: 'เปิดบิลไม่สำเร็จ', message: (err as Error).message })
    } finally {
      setBilling(false)
    }
  }

  async function handleCopyOrderNo() {
    try {
      await navigator.clipboard.writeText(mpOrder.marketplace_order_no)
    } catch {
      // fallback สำหรับเบราว์เซอร์เก่า
      const ta = document.createElement('textarea')
      ta.value = mpOrder.marketplace_order_no
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <Modal open onClose={onClose} contentClassName="max-w-none w-full">
        <div className="p-6 max-h-[90vh] overflow-y-auto space-y-5">
          {/* Header */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopyOrderNo}
              title="คลิกเพื่อคัดลอกเลขคำสั่งซื้อ"
              className="text-xl font-bold text-slate-800 hover:text-blue-700 transition-colors"
            >
              {mpOrder.marketplace_order_no}
            </button>
            {copied && (
              <span className="text-xs text-green-600 font-medium animate-pulse">คัดลอกแล้ว</span>
            )}
            <UrgencyBadge order={mpOrder} />
            <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold text-sm">
              {mpOrder.channel_code}
            </span>
            {mpOrder.platform_status && (
              <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600 text-sm">{mpOrder.platform_status}</span>
            )}
            {mpOrder.billed_bill_no && (
              <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 font-semibold text-sm">
                เปิดบิลแล้ว: {mpOrder.billed_bill_no}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              ปิด
            </button>
          </div>

          {/* ข้อมูลออเดอร์ */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 bg-gray-50 rounded-xl px-4 py-2.5 text-sm">
            <span className="flex gap-1.5">
              <span className="text-gray-500">ผู้ซื้อ</span>
              <span className="text-slate-800 font-medium">{mpOrder.buyer_username || '-'}</span>
            </span>
            <span className="flex gap-1.5">
              <span className="text-gray-500">เวลาชำระเงิน</span>
              <span className="text-slate-800 font-medium">
                {mpOrder.payment_time ? formatDateTime(mpOrder.payment_time) : '-'}
              </span>
            </span>
            {mpOrder.buyer_note && (
              <span className="flex gap-1.5">
                <span className="text-gray-500">หมายเหตุผู้ซื้อ</span>
                <span className="text-orange-700 font-semibold break-all bg-orange-50 px-2 rounded">
                  {mpOrder.buyer_note}
                </span>
              </span>
            )}
            <span className="flex gap-1.5">
              <span className="text-gray-500">ยอดรวมออเดอร์</span>
              <span className="text-slate-800 font-medium">
                {mpOrder.order_total != null ? `${mpOrder.order_total.toLocaleString('th-TH')} บาท` : '-'}
              </span>
            </span>
            {mpOrder.follow_up_note && (
              <span className="flex gap-1.5">
                <span className="text-gray-500">โน้ตติดตาม</span>
                <span className="text-purple-700 font-semibold break-all bg-purple-50 px-2 rounded">
                  {mpOrder.follow_up_note}
                </span>
              </span>
            )}
          </div>

          {/* ตัวเลือกบิล */}
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-semibold text-gray-700">
                  เลขพัสดุ <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={trackingNo}
                  onChange={(e) => setTrackingNo(e.target.value)}
                  placeholder="กรอกเลขพัสดุก่อนเปิดบิล"
                  className={`border rounded-lg px-3 py-1.5 text-sm w-64 ${
                    trackingNo.trim() ? 'border-gray-300' : 'border-red-300 bg-red-50/40'
                  }`}
                />
              </div>
              <button
                type="button"
                onClick={() => setRequiresConfirmDesign((v) => !v)}
                title={requiresConfirmDesign ? 'คลิกเพื่อยกเลิกเครื่องหมายออกแบบ' : 'ทำเครื่องหมายออกแบบสำหรับบิลนี้'}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  requiresConfirmDesign
                    ? 'bg-fuchsia-800 text-white border-fuchsia-800 shadow-sm hover:bg-fuchsia-900'
                    : 'bg-white text-fuchsia-700 border-fuchsia-300 hover:bg-fuchsia-50'
                }`}
              >
                ออกแบบ
              </button>
            </div>
          )}

          {/* รายการสินค้า — ตารางแบบเดียวกับหน้าเปิดบิล */}
          <div className="space-y-2">
            <h4 className="font-bold text-slate-800">รายการสินค้า ({items.length})</h4>
            {loading && <div className="text-center text-gray-400 py-8">กำลังโหลด...</div>}
            {!loading && (
              <div className="overflow-x-auto border border-surface-200 rounded-lg">
                <table className="w-full text-xs min-w-[1150px] border-collapse">
                  <thead>
                    <tr className="bg-gray-100 text-gray-700">
                      <th className="border p-1.5 w-8">#</th>
                      <th className="border p-1.5 min-w-[230px] text-left">ชื่อสินค้า</th>
                      <th className="border p-1.5 min-w-[100px]">สีหมึก</th>
                      <th className="border p-1.5 w-16">ชั้น</th>
                      <th className="border p-1.5 min-w-[90px]">ลาย</th>
                      <th className="border p-1.5 w-20">ฟอนต์</th>
                      <th className="border p-1.5 w-14">ไม่รับชื่อ</th>
                      <th className="border p-1.5 min-w-[110px]">บรรทัด 1</th>
                      <th className="border p-1.5 min-w-[110px]">บรรทัด 2</th>
                      <th className="border p-1.5 min-w-[110px]">บรรทัด 3</th>
                      <th className="border p-1.5 w-14">จำนวน</th>
                      <th className="border p-1.5 w-20">ราคา/หน่วย</th>
                      <th className="border p-1.5 min-w-[110px]">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      const dis = (key: string) => readOnly || !fieldEnabled(it, key)
                      const cls = (disabled: boolean, extra = '') =>
                        `w-full px-1.5 py-1 border rounded text-xs min-w-0 ${
                          disabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''
                        } ${extra}`
                      return (
                        <Fragment key={it.id}>
                        <tr className="align-middle">
                          <td className="border p-1.5 text-center text-gray-500">{idx + 1}</td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              list={`mp-product-list-${it.id}`}
                              value={productSearch[it.id] ?? ''}
                              disabled={readOnly}
                              onChange={(e) => {
                                const v = e.target.value
                                setProductSearch((prev) => ({ ...prev, [it.id]: v }))
                                const matched = matchProduct(v)
                                if (matched) {
                                  updateItem(it.id, { product_id: matched.id })
                                  setProductSearch((prev) => ({ ...prev, [it.id]: matched.product_name }))
                                } else if (!v.trim()) {
                                  updateItem(it.id, { product_id: null })
                                }
                              }}
                              onBlur={(e) => {
                                const matched = matchProduct(e.target.value)
                                if (!matched && it.product_id) {
                                  setProductSearch((prev) => ({
                                    ...prev,
                                    [it.id]: productById.get(it.product_id!)?.product_name || '',
                                  }))
                                }
                              }}
                              placeholder="ค้นหาหรือเลือกสินค้า..."
                              className={cls(readOnly, it.product_id ? '' : 'border-red-300 bg-red-50/40')}
                              autoComplete="off"
                            />
                            <datalist id={`mp-product-list-${it.id}`}>
                              {products
                                .filter((p) => {
                                  const q = (productSearch[it.id] || '').trim().toLowerCase()
                                  if (!q) return true
                                  return (
                                    p.product_name.toLowerCase().includes(q) ||
                                    p.product_code.toLowerCase().includes(q)
                                  )
                                })
                                .slice(0, 50)
                                .map((p) => (
                                  <option key={p.id} value={p.product_name}>
                                    {p.product_code}
                                  </option>
                                ))}
                            </datalist>
                          </td>
                          <td className="border p-1.5">
                            <select
                              value={it.ink_color || ''}
                              disabled={dis('ink_color')}
                              onChange={(e) => updateItem(it.id, { ink_color: e.target.value })}
                              className={cls(dis('ink_color'))}
                            >
                              <option value="">เลือกสี</option>
                              {inkTypes.map((ink) => (
                                <option key={ink.id} value={ink.ink_name}>
                                  {ink.ink_name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="border p-1.5">
                            <select
                              value={it.product_type || 'ชั้น1'}
                              disabled={dis('layer')}
                              onChange={(e) => updateItem(it.id, { product_type: e.target.value })}
                              className={cls(dis('layer'))}
                            >
                              {LAYERS.map((l) => (
                                <option key={l} value={l}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              list={`mp-pattern-list-${it.id}`}
                              value={it.cartoon_pattern || ''}
                              disabled={dis('cartoon_pattern')}
                              onChange={(e) => updateItem(it.id, { cartoon_pattern: e.target.value })}
                              placeholder="ลาย"
                              className={cls(dis('cartoon_pattern'), 'max-w-[12rem]')}
                              autoComplete="off"
                            />
                            <datalist id={`mp-pattern-list-${it.id}`}>
                              {patterns.map((p) => (
                                <option key={p.id} value={p.pattern_name} />
                              ))}
                            </datalist>
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              list={`mp-font-list-${it.id}`}
                              value={it.font || ''}
                              disabled={dis('font')}
                              onChange={(e) => updateItem(it.id, { font: e.target.value })}
                              placeholder="ฟอนต์"
                              className={cls(dis('font'))}
                              autoComplete="off"
                            />
                            <datalist id={`mp-font-list-${it.id}`}>
                              {fonts.map((f) => (
                                <option key={f.font_code} value={f.font_name} />
                              ))}
                            </datalist>
                          </td>
                          <td className="border p-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={!!it.no_name_line}
                              disabled={dis('line_1')}
                              onChange={(e) => updateItem(it.id, { no_name_line: e.target.checked })}
                              className="w-4 h-4"
                            />
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              value={it.line_1 || ''}
                              disabled={dis('line_1') || it.no_name_line}
                              onChange={(e) => updateItem(it.id, { line_1: e.target.value })}
                              className={cls(dis('line_1') || it.no_name_line)}
                            />
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              value={it.line_2 || ''}
                              disabled={dis('line_2') || it.no_name_line}
                              onChange={(e) => updateItem(it.id, { line_2: e.target.value })}
                              className={cls(dis('line_2') || it.no_name_line)}
                            />
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              value={it.line_3 || ''}
                              disabled={dis('line_3') || it.no_name_line}
                              onChange={(e) => updateItem(it.id, { line_3: e.target.value })}
                              className={cls(dis('line_3') || it.no_name_line)}
                            />
                          </td>
                          <td className="border p-1.5 text-center align-middle text-gray-700 font-medium">
                            {it.qty ?? '-'}
                          </td>
                          <td className="border p-1.5 text-right align-middle text-gray-600">
                            {it.unit_price != null ? Number(it.unit_price).toLocaleString('th-TH') : '-'}
                          </td>
                          <td className="border p-1.5">
                            <input
                              type="text"
                              value={it.notes || ''}
                              disabled={dis('notes')}
                              onChange={(e) => updateItem(it.id, { notes: e.target.value })}
                              placeholder="หมายเหตุเพิ่มเติม"
                              className={cls(dis('notes'))}
                            />
                          </td>
                        </tr>
                        {/* ปุ่มแยก/รวม — คลุมสองคอลัมน์ จำนวน + ราคา/หน่วย */}
                        {!readOnly && ((Number(it.qty) > 1 && splitFor !== it.id) || isSplitMember(it)) && (
                          <tr>
                            <td colSpan={10} className="border p-0" />
                            <td colSpan={2} className="border px-1 py-1 text-center">
                              {Number(it.qty) > 1 && splitFor !== it.id && (
                                <button
                                  type="button"
                                  onClick={() => openSplit(it)}
                                  title="แยกรายการนี้ออกเป็นหลายรายการตามจำนวนที่ต้องการ"
                                  className="w-full px-1 py-1 rounded text-[11px] font-medium border border-indigo-300 text-indigo-600 hover:bg-indigo-50"
                                >
                                  แยกรายการ
                                </button>
                              )}
                              {isSplitMember(it) && (
                                <button
                                  type="button"
                                  onClick={() => mergeRun(it.id)}
                                  title="รวมรายการที่แยกจากตัวเดียวกันกลับเป็นแถวเดียว"
                                  className="w-full mt-1 px-1 py-1 rounded text-[11px] font-medium border border-amber-300 text-amber-700 hover:bg-amber-50"
                                >
                                  รวมกลับ
                                </button>
                              )}
                            </td>
                            <td className="border p-0" />
                          </tr>
                        )}
                        {it.variation && (
                          <tr className="bg-blue-50/40">
                            <td className="border p-1.5" />
                            <td className="border p-1.5" />
                            <td colSpan={4} className="border px-1.5 py-1 text-[11px] text-gray-500" title="ชื่อตัวเลือกจากไฟล์">
                              ตัวเลือกจากไฟล์: <span className="font-semibold text-xs text-slate-700">{it.variation}</span>
                            </td>
                            <td colSpan={7} className="border p-1.5" />
                          </tr>
                        )}
                        {splitFor === it.id && (() => {
                          const total = Number(it.qty || 0)
                          const sum = splitQtys.reduce((s, q) => s + (Number(q) || 0), 0)
                          const hasZero = splitQtys.some((q) => !(Number(q) > 0))
                          const valid = splitQtys.length >= 2 && sum === total && !hasZero
                          return (
                            <tr className="bg-indigo-50/60">
                              <td className="border p-1.5" />
                              <td colSpan={12} className="border px-3 py-2.5">
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                                  <span className="font-semibold text-indigo-800">แยกรายการ</span>
                                  <span className="text-gray-500">
                                    จำนวนเดิม <span className="font-semibold text-slate-700">{total}</span>
                                  </span>
                                  <label className="flex items-center gap-1.5">
                                    <span className="text-gray-600">แยกเป็นกี่รายการ</span>
                                    <input
                                      type="number"
                                      min={2}
                                      max={total}
                                      value={splitQtys.length}
                                      onChange={(e) => changeSplitCount(total, Number(e.target.value))}
                                      className="w-16 border rounded px-1.5 py-1 text-center"
                                    />
                                  </label>
                                  <div className="flex flex-wrap items-center gap-2">
                                    {splitQtys.map((q, i) => (
                                      <label key={i} className="flex items-center gap-1">
                                        <span className="text-gray-500">#{i + 1}</span>
                                        <input
                                          type="number"
                                          min={1}
                                          value={q}
                                          onChange={(e) =>
                                            setSplitQtys((prev) =>
                                              prev.map((v, j) => (j === i ? Math.max(0, Math.floor(Number(e.target.value) || 0)) : v)),
                                            )
                                          }
                                          className={`w-16 border rounded px-1.5 py-1 text-center ${
                                            hasZero || sum !== total ? 'border-red-300 bg-red-50/40' : 'border-gray-300'
                                          }`}
                                        />
                                      </label>
                                    ))}
                                  </div>
                                  <span className={`font-medium ${sum === total ? 'text-green-600' : 'text-red-600'}`}>
                                    รวม {sum} / {total}
                                    {sum !== total && ' (ต้องเท่ากับจำนวนเดิม)'}
                                  </span>
                                  <div className="flex items-center gap-2 ml-auto">
                                    <button
                                      type="button"
                                      disabled={!valid}
                                      onClick={() => applySplit(it.id, splitQtys)}
                                      className="px-3 py-1 rounded bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                      ยืนยันแยก
                                    </button>
                                    <button
                                      type="button"
                                      onClick={closeSplit}
                                      className="px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                                    >
                                      ยกเลิก
                                    </button>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )
                        })()}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ฟอร์มขอใบกำกับภาษี */}
          {!readOnly && showTaxInvoice && (
            <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50 space-y-3">
              <h4 className="font-semibold text-blue-800">ข้อมูลสำหรับใบกำกับภาษี</h4>
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อลูกค้า/บริษัท</label>
                <input
                  type="text"
                  value={taxInvoiceData.company_name}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ที่อยู่</label>
                <textarea
                  value={taxInvoiceData.address}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, address: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">เลขประจำตัวผู้เสียภาษี (TAX ID)</label>
                <input
                  type="text"
                  value={taxInvoiceData.tax_id}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, tax_id: e.target.value })}
                  placeholder="เช่น 0-0000-00000-00-0"
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
            </div>
          )}

          {/* ปุ่มการทำงาน */}
          {!readOnly && (
            <div className="sticky bottom-0 bg-white border-t border-surface-200 pt-4 -mx-6 px-6 pb-1 space-y-3">
              {followUpMode && (
                <div className="flex gap-2 items-start">
                  <textarea
                    value={followUpNote}
                    onChange={(e) => setFollowUpNote(e.target.value)}
                    placeholder="โน้ตการติดตาม เช่น รอลูกค้าตอบชื่อทางแชท"
                    rows={2}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleFollowUp}
                    className="px-4 py-2 rounded-lg bg-purple-600 text-white font-bold hover:bg-purple-700 disabled:opacity-50"
                  >
                    ยืนยันรอติดตาม
                  </button>
                  <button
                    type="button"
                    onClick={() => setFollowUpMode(false)}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    ยกเลิก
                  </button>
                </div>
              )}
              {cancelMode && (
                <div className="flex gap-2 items-start">
                  <textarea
                    value={cancelNote}
                    onChange={(e) => setCancelNote(e.target.value)}
                    placeholder="เหตุผลการยกเลิกบิล เช่น ลูกค้ายกเลิกออเดอร์"
                    rows={2}
                    className="flex-1 border border-red-300 rounded-lg px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleCancel}
                    className="px-4 py-2 rounded-lg bg-red-600 text-white font-bold hover:bg-red-700 disabled:opacity-50"
                  >
                    ยืนยันยกเลิกบิล
                  </button>
                  <button
                    type="button"
                    onClick={() => setCancelMode(false)}
                    className="px-3 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    ปิด
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowTaxInvoice((v) => !v)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    showTaxInvoice ? 'bg-blue-600 text-white' : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
                  }`}
                >
                  ขอใบกำกับภาษี
                </button>
                {!cancelMode && (
                  <button
                    type="button"
                    disabled={saving || billing}
                    onClick={() => setCancelMode(true)}
                    className="px-4 py-2 rounded-lg border border-red-300 text-red-600 font-medium hover:bg-red-50 disabled:opacity-50"
                  >
                    ยกเลิกบิล
                  </button>
                )}
                <div className="flex flex-wrap justify-end gap-2 ml-auto">
                <button
                  type="button"
                  disabled={saving || billing}
                  onClick={handleSaveDraft}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {saving ? 'กำลังบันทึก...' : 'บันทึกร่าง'}
                </button>
                {!followUpMode && (
                  <button
                    type="button"
                    disabled={saving || billing}
                    onClick={() => setFollowUpMode(true)}
                    className="px-4 py-2 rounded-lg bg-purple-100 text-purple-700 font-bold hover:bg-purple-200 disabled:opacity-50"
                  >
                    รอติดตาม
                  </button>
                )}
                <button
                  type="button"
                  disabled={saving || billing || loading}
                  onClick={handleOpenBill}
                  className="px-6 py-2 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 disabled:opacity-50"
                >
                  {billing ? 'กำลังเปิดบิล...' : 'เปิดบิล'}
                </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>
      {MessageModal}
      {ConfirmModal}
    </>
  )
}
