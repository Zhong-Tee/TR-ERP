import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import { Order, OrderItem, IssueType } from '../../types'
import { parseAddressText, ParsedAddress } from '../../lib/thaiAddress'
import { e164ToLocal } from '../../lib/thaiPhone'
import * as XLSX from 'xlsx'
import { buildProductionLikeExport } from '../../lib/orderProductionExcel'
import { useAuthContext } from '../../contexts/AuthContext'
import { useMenuAccess } from '../../contexts/MenuAccessContext'
import Modal from '../ui/Modal'
import { sortOrderItemsForExport } from '../../lib/orderItemExportSort'
import { STOP_PRODUCTION_ISSUE_SLUG } from '../../lib/issueTypeSlugs'

/** Helper: แสดงเฉพาะฟิลด์ที่มีค่า */
function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className="flex gap-2 py-1.5">
      <dt className="text-gray-500 text-sm shrink-0 w-28">{label}</dt>
      <dd className="text-sm text-gray-900 font-medium select-all break-all">{value}</dd>
    </div>
  )
}

export default function OrderDetailView({
  order: initialOrder,
  onClose,
  readOnly = false,
}: {
  order: Order
  onClose: () => void
  readOnly?: boolean
}) {
  const { user } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const [fullOrder, setFullOrder] = useState<Order | null>(null)
  const [loadedItems, setLoadedItems] = useState<OrderItem[] | null>(null)
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([])
  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketTypeId, setTicketTypeId] = useState('')
  const [ticketPreferStopProduction, setTicketPreferStopProduction] = useState(false)
  const [ticketTitle, setTicketTitle] = useState('')
  const [ticketCreating, setTicketCreating] = useState(false)
  const [ticketSuccessOpen, setTicketSuccessOpen] = useState(false)
  const [ticketWorkOrderName, setTicketWorkOrderName] = useState<string | null>(null)
  const [ticketWorkOrderLoading, setTicketWorkOrderLoading] = useState(false)
  const [feedbackModal, setFeedbackModal] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  })

  /* ── Right-click context menu & edit link ── */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; itemIdx: number } | null>(null)
  const [editLinkItem, setEditLinkItem] = useState<{ idx: number; value: string } | null>(null)
  const [editLinkSaving, setEditLinkSaving] = useState(false)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  // Close context menu on outside click / scroll
  useEffect(() => {
    if (!ctxMenu) return
    const handleClose = () => setCtxMenu(null)
    window.addEventListener('click', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      window.removeEventListener('click', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [ctxMenu])

  function handleContextMenu(e: React.MouseEvent, idx: number) {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, itemIdx: idx })
  }

  function handleEditLinkOpen() {
    if (readOnly) return
    if (ctxMenu == null) return
    const item = items[ctxMenu.itemIdx]
    setEditLinkItem({ idx: ctxMenu.itemIdx, value: item?.file_attachment || '' })
    setCtxMenu(null)
  }

  async function handleEditLinkSave() {
    if (readOnly) return
    if (!editLinkItem) return
    const item = items[editLinkItem.idx]
    if (!item?.id) return
    setEditLinkSaving(true)
    try {
      const { error } = await supabase
        .from('or_order_items')
        .update({ file_attachment: editLinkItem.value.trim() || null })
        .eq('id', item.id)
      if (error) throw error
      // Update local state
      if (loadedItems) {
        setLoadedItems(prev => prev!.map((it) => {
          if (it.id === item.id) return { ...it, file_attachment: editLinkItem.value.trim() || null } as OrderItem
          return it
        }))
      }
      // Also update inline if present
      const inl = ((order as any).or_order_items || []) as OrderItem[]
      if (inl.length > 0) {
        const updated = inl.map(it => it.id === item.id ? { ...it, file_attachment: editLinkItem.value.trim() || null } : it)
        ;(order as any).or_order_items = updated
      }
      setEditLinkItem(null)
    } catch (err) {
      console.error('Error saving link:', err)
      alert('ไม่สามารถบันทึกลิงค์ได้')
    } finally {
      setEditLinkSaving(false)
    }
  }

  // โหลดบิลเต็มเมื่อ payload ไม่ครบ — รวมกรณี WorkOrderManageList (มี status/ที่อยู่ แต่ไม่ select billing_details)
  const isPartial =
    (!initialOrder.status && !initialOrder.customer_address) ||
    initialOrder.billing_details === undefined

  const order = (isPartial && fullOrder) ? fullOrder : initialOrder

  const inlineItems = ((order as any).or_order_items || []) as OrderItem[]
  const billing = order.billing_details
  const billingPhone =
    (typeof billing?.mobile_phone === 'string' && billing.mobile_phone.trim()) ||
    (billing && typeof (billing as { mobilePhone?: unknown }).mobilePhone === 'string'
      ? String((billing as { mobilePhone?: string }).mobilePhone).trim()
      : '')

  // Parse ที่อยู่เพื่อดึงเบอร์จากข้อความเมื่อยังไม่มี mobile_phone ใน billing (เช่น billing มีแต่จังหวัดจากบิลอ้างอิง)
  const [parsedAddr, setParsedAddr] = useState<ParsedAddress | null>(null)
  useEffect(() => {
    if (!order.customer_address?.trim() || billingPhone) {
      setParsedAddr(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const parsed = await parseAddressText(order.customer_address, supabase)
      if (!cancelled) setParsedAddr(parsed)
    })()
    return () => {
      cancelled = true
    }
  }, [order.customer_address, billingPhone])

  // ค่าที่จะแสดง: ใช้ billing ก่อน ถ้าไม่มีให้ใช้ parsed
  const displaySubDistrict = billing?.sub_district || parsedAddr?.subDistrict || null
  const displayDistrict = billing?.district || parsedAddr?.district || null
  const displayProvince = billing?.province || parsedAddr?.province || null
  const displayPostalCode = billing?.postal_code || parsedAddr?.postalCode || null
  const displayPhone =
    billingPhone ||
    (parsedAddr?.mobilePhoneCandidates?.[0]
      ? e164ToLocal(parsedAddr.mobilePhoneCandidates[0])
      : parsedAddr?.mobilePhone) ||
    null

  useEffect(() => {
    setFullOrder(null)
    setLoadedItems(null)
  }, [initialOrder.id])

  // Lazy-load full order เมื่อได้ข้อมูลไม่ครบ
  useEffect(() => {
    if (!isPartial || !initialOrder.id) return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', initialOrder.id)
        .single()
      if (!cancelled && data) {
        setFullOrder(data as Order)
        setLoadedItems(((data as any).or_order_items || []) as OrderItem[])
      }
    })()
    return () => { cancelled = true }
  }, [initialOrder.id, isPartial])

  // Lazy-load items เมื่อ order ไม่มี or_order_items
  useEffect(() => {
    if (inlineItems.length > 0 || !order.id || isPartial) {
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('or_order_items')
        .select('*')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true })
      if (!cancelled) setLoadedItems((data || []) as OrderItem[])
    })()
    return () => { cancelled = true }
  }, [order.id, inlineItems.length, isPartial])

  const items = inlineItems.length > 0 ? inlineItems : (loadedItems || [])
  const displayItems = useMemo(() => sortOrderItemsForExport(items as any[]), [items])
  const canOpenTicket = !!user && (hasAccess('orders-issue') || hasAccess('plan-issue'))

  const stopProductionTicketTypeId = useMemo(
    () => issueTypes.find((t) => (t.slug || '').trim() === STOP_PRODUCTION_ISSUE_SLUG)?.id ?? '',
    [issueTypes]
  )

  useEffect(() => {
    if (!ticketOpen) setTicketPreferStopProduction(false)
  }, [ticketOpen])

  const fmt = (n: number | null | undefined) =>
    Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  useEffect(() => {
    if (!ticketOpen) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('or_issue_types')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
      if (!cancelled && !error) setIssueTypes((data || []) as IssueType[])
    })()
    return () => { cancelled = true }
  }, [ticketOpen])

  useEffect(() => {
    if (!ticketOpen) return
    let cancelled = false
    ;(async () => {
      setTicketWorkOrderLoading(true)
      try {
        let wo = order.work_order_name || null
        if (!wo && order.id) {
          const { data } = await supabase
            .from('or_orders')
            .select('work_order_name')
            .eq('id', order.id)
            .single()
          wo = (data as { work_order_name?: string | null } | null)?.work_order_name || null
        }
        if (!cancelled) setTicketWorkOrderName(wo)
      } finally {
        if (!cancelled) setTicketWorkOrderLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [ticketOpen, order.id, order.work_order_name])

  async function handleCreateTicket() {
    if (!user) return
    if (!ticketWorkOrderName) {
      alert('ไม่พบเลขใบงานของบิลนี้ กรุณาตรวจสอบใบงานก่อนเปิด Ticket')
      return
    }
    if (!ticketTitle.trim()) {
      alert('กรุณากรอกหัวข้อ')
      return
    }
    if (ticketPreferStopProduction && !stopProductionTicketTypeId) {
      alert('ไม่พบประเภท "หยุดผลิต" ในระบบ กรุณารัน migration หรือติดต่อผู้ดูแล')
      return
    }
    setTicketCreating(true)
    try {
      const { error } = await supabase.from('or_issues').insert({
        order_id: order.id,
        work_order_name: ticketWorkOrderName,
        type_id: ticketTypeId || null,
        title: ticketTitle.trim(),
        status: 'On',
        created_by: user.id,
      })
      if (error) throw error
      setTicketOpen(false)
      setTicketTitle('')
      setTicketTypeId('')
      setTicketPreferStopProduction(false)
      setTicketSuccessOpen(true)
    } catch (error: any) {
      console.error('Error creating issue:', error)
      alert('เกิดข้อผิดพลาด: ' + (error?.message || error))
    } finally {
      setTicketCreating(false)
    }
  }

  /* ── Excel Download (หัวตารางร่วมกับ lib/orderProductionExcel) ── */
  async function handleCopyProductionData() {
    try {
      const { dataRows } = await buildProductionLikeExport(supabase, order, items)
      const clipboardText = dataRows
        .map((row) => row.map((value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ')).join('\t'))
        .join('\n')
      await navigator.clipboard.writeText(clipboardText)
      setFeedbackModal({
        open: true,
        title: 'คัดลอกสำเร็จ',
        message: `คัดลอกข้อมูลเรียบร้อย ${dataRows.length} แถว (ไม่รวมหัวตาราง)`,
      })
    } catch (error: any) {
      console.error('Error copying production-like data:', error)
      setFeedbackModal({
        open: true,
        title: 'คัดลอกไม่สำเร็จ',
        message: 'คัดลอกไม่สำเร็จ: ' + (error?.message || error),
      })
    }
  }

  async function handleDownloadExcel() {
    try {
      const { headers, dataRows } = await buildProductionLikeExport(supabase, order, items)
      const wsItems = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, wsItems, 'ProductionData')
      XLSX.writeFile(wb, `${order.bill_no || 'order'}.xlsx`)
    } catch (error: any) {
      console.error('Error downloading production-like excel:', error)
      setFeedbackModal({
        open: true,
        title: 'ดาวน์โหลดไม่สำเร็จ',
        message: 'ดาวน์โหลด Excel ไม่สำเร็จ: ' + (error?.message || error),
      })
    }
  }

  return (
    <div className="flex flex-col max-h-[85vh]">
      {/* Header */}
      <div className="p-4 border-b bg-gradient-to-r from-blue-600 to-blue-700 text-white flex items-center justify-between shrink-0">
        <div>
          <h3 className="text-lg font-bold">รายละเอียดบิล</h3>
          <p className="text-sm text-blue-200 select-all">{order.bill_no}</p>
        </div>
        <div className="flex items-center gap-2">
          {canOpenTicket && (
            <button
              type="button"
              onClick={() => setTicketOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/90 hover:bg-emerald-500 border border-emerald-200/40 rounded-lg text-sm font-medium text-white transition-colors"
            >
              เปิด Ticket
            </button>
          )}
          <button
            type="button"
            onClick={handleCopyProductionData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg text-sm font-medium text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8M8 12h8m-8-4h5m-5 12h8a2 2 0 002-2V6a2 2 0 00-2-2h-8a2 2 0 00-2 2v12a2 2 0 002 2zm-4-4V8a2 2 0 012-2h2" />
            </svg>
            คัดลอก
          </button>
          <button
            type="button"
            onClick={handleDownloadExcel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg text-sm font-medium text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            ดาวน์โหลด Excel
          </button>
          <button type="button" onClick={onClose} className="px-3 py-1.5 border border-white/30 rounded-lg text-sm font-medium text-white hover:bg-white/15 transition-colors">
            ปิดหน้าต่าง
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5 select-text">
        {/* ── ข้อมูลลูกค้า ── */}
        <section>
          <h4 className="text-sm font-bold text-gray-800 border-b border-gray-200 pb-1.5 mb-2">ข้อมูลลูกค้า</h4>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
            <InfoRow label="เลขบิล" value={order.bill_no} />
            <InfoRow label="ช่องทาง" value={order.channel_code} />
            <InfoRow label="สถานะ" value={order.status} />
            <InfoRow label="ชื่อลูกค้า" value={order.customer_name} />
            <InfoRow label="ชื่อผู้รับ" value={order.recipient_name} />
            <InfoRow label="เลขคำสั่งซื้อ" value={order.channel_order_no} />
            <div className="md:col-span-2">
              <InfoRow label="ที่อยู่" value={order.customer_address} />
            </div>
            <InfoRow label="แขวง/ตำบล" value={displaySubDistrict} />
            <InfoRow label="เขต/อำเภอ" value={displayDistrict} />
            <InfoRow label="จังหวัด" value={displayProvince} />
            <InfoRow label="รหัสไปรษณีย์" value={displayPostalCode} />
            <InfoRow label="เบอร์โทร" value={displayPhone} />
            <InfoRow label="โปรโมชั่น" value={order.promotion} />
            <InfoRow label="ผู้ลงออเดอร์" value={order.admin_user} />
            <InfoRow label="วันที่สร้าง" value={order.created_at ? formatDateTime(order.created_at) : null} />
          </dl>
        </section>

        {/* ── ยอดเงิน ── */}
        <section>
          <h4 className="text-sm font-bold text-gray-800 border-b border-gray-200 pb-1.5 mb-2">ยอดเงิน</h4>
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-8">
            <InfoRow label="ราคาสินค้า" value={`฿${fmt(order.price)}`} />
            <InfoRow label="ค่าส่ง" value={`฿${fmt(order.shipping_cost)}`} />
            <InfoRow label="ส่วนลด" value={`฿${fmt(order.discount)}`} />
            <div className="py-1.5 flex gap-2">
              <dt className="text-gray-500 text-sm shrink-0 w-28">ยอดรวม</dt>
              <dd className="text-sm font-bold text-emerald-600 select-all">฿{fmt(order.total_amount)}</dd>
            </div>
          </dl>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 mt-1">
            <InfoRow label="ชำระโดย" value={order.payment_method} />
            <InfoRow label="วันที่ชำระ" value={order.payment_date ? `${order.payment_date}${order.payment_time ? ` ${order.payment_time}` : ''}` : null} />
          </dl>
        </section>

        {/* ── หมายเหตุ ── */}
        {order.confirm_note && (
          <section>
            <h4 className="text-sm font-bold text-gray-800 border-b border-gray-200 pb-1.5 mb-2">หมายเหตุ</h4>
            <p className="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 whitespace-pre-wrap select-all">{order.confirm_note}</p>
          </section>
        )}

        {/* ── รายการสินค้า ── */}
        {displayItems.length > 0 && (() => {
          const SHOW_TIER_PRODUCTS = ['ตรายางคอนโด TWP ชมพู', 'ตรายางคอนโด TWB ฟ้า']
          const hasAnyTierProduct = displayItems.some((item) => SHOW_TIER_PRODUCTS.includes(item.product_name || ''))
          const hasAnyFileAttachment = displayItems.some((item) => item.file_attachment && item.file_attachment.trim() !== '')
          return (
          <section>
            <h4 className="text-sm font-bold text-gray-800 border-b border-gray-200 pb-1.5 mb-3">
              รายการสินค้า <span className="text-gray-400 font-normal">({displayItems.length} รายการ)</span>
            </h4>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-gray-600 text-xs">
                    <th className="px-3 py-2 text-left font-semibold w-8">#</th>
                    <th className="px-3 py-2 text-left font-semibold">ชื่อสินค้า</th>
                    <th className="px-3 py-2 text-left font-semibold">สีหมึก</th>
                    {hasAnyTierProduct && <th className="px-3 py-2 text-left font-semibold">ชั้น</th>}
                    <th className="px-3 py-2 text-left font-semibold">ลาย</th>
                    <th className="px-3 py-2 text-left font-semibold">เส้น</th>
                    <th className="px-3 py-2 text-left font-semibold">ฟอนต์</th>
                    <th className="px-3 py-2 text-left font-semibold">บรรทัด 1</th>
                    <th className="px-3 py-2 text-left font-semibold">บรรทัด 2</th>
                    <th className="px-3 py-2 text-left font-semibold">บรรทัด 3</th>
                    <th className="px-3 py-2 text-right font-semibold">จำนวน</th>
                    <th className="px-3 py-2 text-right font-semibold">ราคา/หน่วย</th>
                    <th className="px-3 py-2 text-left font-semibold">หมายเหตุ</th>
                    {hasAnyFileAttachment && <th className="px-3 py-2 text-center font-semibold">ไฟล์แนบ</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {displayItems.map((item, idx) => {
                    const isTierProduct = SHOW_TIER_PRODUCTS.includes(item.product_name || '')
                    const hasFile = item.file_attachment && item.file_attachment.trim() !== ''
                    return (
                    <tr
                      key={item.id}
                      className={`hover:bg-blue-50/40 transition-colors ${readOnly ? '' : 'cursor-context-menu'}`}
                      onContextMenu={readOnly ? undefined : (e) => handleContextMenu(e, idx)}
                    >
                      <td className="px-3 py-2 text-gray-400">{idx + 1}</td>
                      <td className="px-3 py-2 font-medium text-gray-900 select-all">{item.product_name}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.ink_color || '-'}</td>
                      {hasAnyTierProduct && <td className="px-3 py-2 text-gray-700 select-all">{isTierProduct ? (item.product_type || '-') : '-'}</td>}
                      <td className="px-3 py-2 text-gray-700 select-all">{item.cartoon_pattern || '-'}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.line_pattern || '-'}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.font || '-'}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.line_1 || '-'}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.line_2 || '-'}</td>
                      <td className="px-3 py-2 text-gray-700 select-all">{item.line_3 || '-'}</td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">{item.quantity}</td>
                      <td className="px-3 py-2 text-right text-gray-700">฿{fmt(item.unit_price)}</td>
                      <td className="px-3 py-2 text-gray-600 text-xs">
                        {item.no_name_line ? <span className="text-red-500 font-medium">ไม่รับชื่อ</span> : (item.notes || '-')}
                      </td>
                      {hasAnyFileAttachment && (
                        <td className="px-3 py-2 text-center">
                          {hasFile ? (
                            <a
                              href={item.file_attachment!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-cyan-50 text-cyan-600 hover:bg-cyan-100 hover:text-cyan-700 transition-colors"
                              title="เปิดไฟล์แนบ"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                            </a>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                      )}
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
          )
        })()}

        {/* ── ข้อมูลใบกำกับภาษี ── */}
        {billing && billing.request_tax_invoice && (
          <section>
            <h4 className="text-sm font-bold text-gray-800 border-b border-gray-200 pb-1.5 mb-2">
              ใบกำกับภาษี
            </h4>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <InfoRow label="ชื่อ" value={billing.tax_customer_name} />
              <InfoRow label="เลข Tax ID" value={billing.tax_id} />
              <div className="md:col-span-2">
                <InfoRow label="ที่อยู่" value={billing.tax_customer_address} />
              </div>
              <InfoRow label="เบอร์โทร" value={billing.tax_customer_phone} />
            </dl>
          </section>
        )}
      </div>

      {/* ── Right-click Context Menu ── */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[160px] animate-in fade-in"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            type="button"
            className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 flex items-center gap-2 transition-colors"
            onClick={handleEditLinkOpen}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
            </svg>
            แก้ไขลิงค์ไฟล์แนบ
          </button>
        </div>
      )}

      {/* ── Edit Link Dialog ── */}
      {editLinkItem && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={() => !editLinkSaving && setEditLinkItem(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-5" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-bold text-gray-800 mb-1">แก้ไขลิงค์ไฟล์แนบ</h4>
            <p className="text-xs text-gray-500 mb-3">
              รายการที่ {editLinkItem.idx + 1}: {items[editLinkItem.idx]?.product_name || ''}
            </p>
            <input
              type="url"
              autoFocus
              value={editLinkItem.value}
              onChange={(e) => setEditLinkItem({ ...editLinkItem, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') handleEditLinkSave() }}
              placeholder="https://..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setEditLinkItem(null)}
                disabled={editLinkSaving}
                className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleEditLinkSave}
                disabled={editLinkSaving}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {editLinkSaving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Ticket Dialog ── */}
      {ticketOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40" onClick={() => !ticketCreating && setTicketOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-bold text-gray-800">เปิด Ticket</h4>
            <div className="text-xs text-gray-500 bg-gray-50 border rounded-lg p-2">
              บิล: <span className="font-semibold text-gray-700">{order.bill_no || '-'}</span>
                <span className="ml-2">
                  ใบงาน:{' '}
                  <span className="font-semibold text-gray-700">
                    {ticketWorkOrderLoading ? 'กำลังโหลด...' : (ticketWorkOrderName || 'ไม่มีเลขใบงาน')}
                  </span>
                </span>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ประเภท</label>
              {ticketPreferStopProduction ? (
                <div className="w-full px-3 py-2 border rounded-lg bg-amber-50 border-amber-200 text-amber-950 text-sm font-medium">
                  หยุดผลิต
                  {!stopProductionTicketTypeId && (
                    <span className="block text-xs text-red-600 font-normal mt-1">ยังไม่มีประเภทนี้ในฐานข้อมูล</span>
                  )}
                </div>
              ) : (
                <select
                  value={ticketTypeId}
                  onChange={(e) => setTicketTypeId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg bg-white"
                >
                  <option value="">-- ไม่ระบุ --</option>
                  {issueTypes.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หัวข้อ</label>
              <input
                value={ticketTitle}
                onChange={(e) => setTicketTitle(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="เช่น งานด่วน/ต้องแก้ไข"
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTicket() }}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setTicketPreferStopProduction((prev) => {
                    const next = !prev
                    if (next) setTicketTypeId(stopProductionTicketTypeId || '')
                    else setTicketTypeId('')
                    return next
                  })
                }}
                disabled={ticketCreating}
                title="ตั้งประเภท Ticket เป็น หยุดผลิต (แสดงป้ายบน Plan)"
                className={`px-4 py-1.5 text-sm font-semibold rounded-lg border transition-colors disabled:opacity-50 ${
                  ticketPreferStopProduction
                    ? 'bg-amber-800 text-white border-amber-950 ring-2 ring-amber-400'
                    : 'bg-white text-amber-900 border-amber-700 hover:bg-amber-50'
                }`}
              >
                หยุดผลิต
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTicketOpen(false)}
                  disabled={ticketCreating}
                  className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  ยกเลิก
                </button>
                <button
                  type="button"
                  onClick={handleCreateTicket}
                  disabled={
                    ticketCreating ||
                    ticketWorkOrderLoading ||
                    !ticketWorkOrderName ||
                    (ticketPreferStopProduction && !stopProductionTicketTypeId)
                  }
                  className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                >
                  {ticketCreating ? 'กำลังบันทึก...' : 'บันทึก'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <Modal
        open={ticketSuccessOpen}
        onClose={() => setTicketSuccessOpen(false)}
        contentClassName="max-w-sm"
      >
        <div className="p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h4 className="text-base font-bold text-gray-800 mb-1">เปิด Ticket สำเร็จ</h4>
          <p className="text-sm text-gray-500 mb-4">ระบบได้บันทึก Ticket เรียบร้อยแล้ว</p>
          <button
            type="button"
            onClick={() => setTicketSuccessOpen(false)}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            ตกลง
          </button>
        </div>
      </Modal>

      <Modal
        open={feedbackModal.open}
        onClose={() => setFeedbackModal({ open: false, title: '', message: '' })}
        contentClassName="max-w-sm"
      >
        <div className="p-6 text-center">
          <h4 className="text-base font-bold text-gray-800 mb-2">{feedbackModal.title}</h4>
          <p className="text-sm text-gray-600 mb-4">{feedbackModal.message}</p>
          <button
            type="button"
            onClick={() => setFeedbackModal({ open: false, title: '', message: '' })}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
          >
            ตกลง
          </button>
        </div>
      </Modal>
    </div>
  )
}
