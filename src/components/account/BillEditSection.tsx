import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderStatus } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import { formatDateTime } from '../../lib/utils'
import OrderForm from '../order/OrderForm'
import Modal from '../ui/Modal'

const ALL_STATUSES: OrderStatus[] = [
  'รอลงข้อมูล',
  'รอตรวจคำสั่งซื้อ',
  'ลงข้อมูลเสร็จสิ้น',
  'ลงข้อมูลผิด',
  'ตรวจสอบไม่ผ่าน',
  'ตรวจสอบไม่สำเร็จ',
  'ตรวจสอบแล้ว',
  'รอออกแบบ',
  'ออกแบบแล้ว',
  'รอคอนเฟิร์ม',
  'คอนเฟิร์มแล้ว',
  'เสร็จสิ้น',
  'ใบสั่งงาน',
  'ใบงานกำลังผลิต',
  'จัดส่งแล้ว',
  'ยกเลิก',
]

type BillEditLog = {
  id: string
  order_id: string
  bill_no: string | null
  edited_by: string
  edited_at: string
  changes: { field: string; label: string; before: string; after: string }[]
  snapshot_before: Record<string, unknown> | null
  snapshot_after: Record<string, unknown> | null
}

type Revision = {
  id: string
  order_id: string
  revision_no: number
  change_source: string
  created_by: string | null
  created_at: string
}

type EditEligibility = {
  can_direct_edit?: boolean
  needs_amendment?: boolean
  needs_credit_note?: boolean
  has_wms_activity?: boolean
  has_pending_amendment?: boolean
  is_locked?: boolean
  wms_picked?: number
  wms_correct?: number
  order_status?: string
  reason?: string
  error?: string
}

type SearchResult = {
  id: string
  bill_no: string
  channel_code: string
  customer_name: string
  customer_address: string
  status: OrderStatus
  total_amount: number
  created_at: string
  entry_date: string
  billing_details: Record<string, unknown> | null
  has_edit_log?: boolean
  revision_no?: number
}

type Props = {
  onRequestAmendment?: (order: Order) => void
}

export default function BillEditSection({ onRequestAmendment }: Props) {
  const { user } = useAuthContext()

  const [searchQuery, setSearchQuery] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [filterDateTo, setFilterDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [filterChannel, setFilterChannel] = useState('')
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const [selectedOrder, setSelectedOrder] = useState<(Order & { order_items?: any[] }) | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [snapshotBefore, setSnapshotBefore] = useState<Record<string, unknown> | null>(null)
  const [statusOverride, setStatusOverride] = useState<OrderStatus | ''>('')

  // Guard modal
  const [guardModal, setGuardModal] = useState<{ open: boolean; eligibility: EditEligibility | null; orderId: string }>({ open: false, eligibility: null, orderId: '' })

  // Edit logs
  const [editLogs, setEditLogs] = useState<BillEditLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [showLogsModal, setShowLogsModal] = useState(false)
  const [logsOrderBillNo, setLogsOrderBillNo] = useState('')

  // Revision history
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [revisionsLoading, setRevisionsLoading] = useState(false)
  const [showRevisionsModal, setShowRevisionsModal] = useState(false)
  const [revisionsOrderBillNo, setRevisionsOrderBillNo] = useState('')

  const [saveResultModal, setSaveResultModal] = useState<{ open: boolean; success: boolean; message: string }>({ open: false, success: false, message: '' })

  useEffect(() => {
    supabase.from('channels').select('channel_code, channel_name').order('channel_code').then(({ data }) => {
      if (data) setChannels(data)
    })
  }, [])

  const handleSearch = useCallback(async () => {
    setSearching(true)
    setHasSearched(true)
    try {
      let query = supabase
        .from('or_orders')
        .select('id, bill_no, channel_code, customer_name, customer_address, status, total_amount, created_at, entry_date, billing_details, revision_no')
        .order('created_at', { ascending: false })
        .limit(50)

      if (searchQuery.trim()) {
        const q = searchQuery.trim()
        query = query.or(`bill_no.ilike.%${q}%,customer_name.ilike.%${q}%,customer_address.ilike.%${q}%`)
      }
      if (filterChannel) query = query.eq('channel_code', filterChannel)
      if (filterDateFrom) query = query.gte('entry_date', filterDateFrom)
      if (filterDateTo) query = query.lte('entry_date', filterDateTo)

      const { data, error } = await query
      if (error) throw error
      const results = (data || []) as SearchResult[]

      if (results.length > 0) {
        const orderIds = results.map((r) => r.id)
        const { data: logData } = await supabase
          .from('ac_bill_edit_logs')
          .select('order_id')
          .in('order_id', orderIds)
        const editedIds = new Set((logData || []).map((l: { order_id: string }) => l.order_id))
        results.forEach((r) => { r.has_edit_log = editedIds.has(r.id) })
      }

      setSearchResults(results)
    } catch (e: any) {
      console.error('Search error:', e)
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }, [searchQuery, filterChannel, filterDateFrom, filterDateTo])

  // Guard check before opening edit
  const handleSelectOrder = async (orderId: string) => {
    setOrderLoading(true)
    try {
      const { data: eligibility, error: eligErr } = await supabase.rpc('rpc_check_order_edit_eligibility', { p_order_id: orderId })
      if (eligErr) throw eligErr

      const elig = eligibility as EditEligibility

      if (elig.can_direct_edit) {
        await loadOrderForEdit(orderId)
      } else {
        setGuardModal({ open: true, eligibility: elig, orderId })
      }
    } catch (e: any) {
      console.error('Error checking eligibility:', e)
      setSaveResultModal({ open: true, success: false, message: 'ตรวจสอบสิทธิ์ล้มเหลว: ' + (e?.message || e) })
    } finally {
      setOrderLoading(false)
    }
  }

  const loadOrderForEdit = async (orderId: string) => {
    setOrderLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      const order = data as Order & { order_items?: any[] }
      if ((data as any).or_order_items) {
        order.order_items = (data as any).or_order_items
      }
      setSelectedOrder(order)
      setStatusOverride(order.status)
      setSnapshotBefore(structuredClone(data) as Record<string, unknown>)
    } catch (e) {
      console.error('Error loading order:', e)
    } finally {
      setOrderLoading(false)
    }
  }

  const handleGuardAction = async () => {
    const orderId = guardModal.orderId
    setGuardModal({ open: false, eligibility: null, orderId: '' })

    setOrderLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      const order = data as Order & { order_items?: any[] }
      if ((data as any).or_order_items) {
        order.order_items = (data as any).or_order_items
      }

      if (onRequestAmendment) {
        onRequestAmendment(order)
      }
    } catch (e: any) {
      console.error('Error loading order:', e)
      setSaveResultModal({ open: true, success: false, message: 'โหลดข้อมูลบิลล้มเหลว' })
    } finally {
      setOrderLoading(false)
    }
  }

  const handleSaveBillEdit = async () => {
    if (!selectedOrder || !snapshotBefore) return

    try {
      if (statusOverride && statusOverride !== selectedOrder.status) {
        const { error: statusErr } = await supabase
          .from('or_orders')
          .update({ status: statusOverride })
          .eq('id', selectedOrder.id)
        if (statusErr) throw statusErr
      }

      const { data: afterData, error: afterErr } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', selectedOrder.id)
        .single()
      if (afterErr) throw afterErr

      const snapshotAfter = afterData as Record<string, unknown>
      const changes = computeChanges(snapshotBefore, snapshotAfter)

      if (changes.length > 0) {
        const { error: logErr } = await supabase.from('ac_bill_edit_logs').insert({
          order_id: selectedOrder.id,
          bill_no: selectedOrder.bill_no,
          edited_by: user?.username || user?.email || 'unknown',
          changes,
          snapshot_before: snapshotBefore,
          snapshot_after: snapshotAfter,
        })
        if (logErr) console.error('Error saving edit log:', logErr)
      }

      setSaveResultModal({ open: true, success: true, message: changes.length > 0 ? `บันทึกสำเร็จ — มีการเปลี่ยนแปลง ${changes.length} รายการ` : 'บันทึกสำเร็จ — ไม่มีการเปลี่ยนแปลง' })
      setSelectedOrder(null)
      setSnapshotBefore(null)
      if (hasSearched) handleSearch()
    } catch (e: any) {
      setSaveResultModal({ open: true, success: false, message: 'บันทึกไม่สำเร็จ: ' + (e?.message || e) })
    }
  }

  const handleViewLogs = async (orderId: string, billNo?: string) => {
    setLogsLoading(true)
    setShowLogsModal(true)
    setLogsOrderBillNo(billNo || '')
    try {
      const { data, error } = await supabase
        .from('ac_bill_edit_logs')
        .select('*')
        .eq('order_id', orderId)
        .order('edited_at', { ascending: false })
      if (error) throw error
      setEditLogs((data || []) as BillEditLog[])
    } catch (e) {
      console.error('Error loading logs:', e)
      setEditLogs([])
    } finally {
      setLogsLoading(false)
    }
  }

  const handleViewRevisions = async (orderId: string, billNo?: string) => {
    setRevisionsLoading(true)
    setShowRevisionsModal(true)
    setRevisionsOrderBillNo(billNo || '')
    try {
      const { data, error } = await supabase
        .from('or_order_revisions')
        .select('id, order_id, revision_no, change_source, created_by, created_at')
        .eq('order_id', orderId)
        .order('revision_no', { ascending: false })
      if (error) throw error
      setRevisions((data || []) as Revision[])
    } catch (e) {
      console.error('Error loading revisions:', e)
      setRevisions([])
    } finally {
      setRevisionsLoading(false)
    }
  }

  function computeChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
    const LABEL_MAP: Record<string, string> = {
      status: 'สถานะ', customer_name: 'ชื่อลูกค้า', customer_address: 'ที่อยู่',
      channel_code: 'ช่องทางขาย', total_amount: 'ยอดรวม', price: 'ราคา',
      shipping_cost: 'ค่าขนส่ง', discount: 'ส่วนลด', payment_method: 'วิธีชำระเงิน',
      payment_date: 'วันที่ชำระ', payment_time: 'เวลาชำระ', promotion: 'โปรโมชั่น',
      tracking_number: 'เลข Tracking', recipient_name: 'ชื่อผู้รับ',
      channel_order_no: 'เลขคำสั่งซื้อ', confirm_note: 'หมายเหตุคอนเฟิร์ม',
    }
    const changes: { field: string; label: string; before: string; after: string }[] = []
    for (const field of Object.keys(LABEL_MAP)) {
      const bVal = String(before[field] ?? '')
      const aVal = String(after[field] ?? '')
      if (bVal !== aVal) {
        changes.push({ field, label: LABEL_MAP[field] || field, before: bVal || '(ว่าง)', after: aVal || '(ว่าง)' })
      }
    }
    return changes
  }

  function getEditZoneBadge(status: string): { label: string; color: string } {
    if (status === 'จัดส่งแล้ว') return { label: 'เคลม', color: 'bg-red-100 text-red-700' }
    if (status === 'ยกเลิก') return { label: 'ปิด', color: 'bg-gray-200 text-gray-500' }
    if (['ใบสั่งงาน', 'ใบงานกำลังผลิต'].includes(status)) return { label: 'ขอยกเลิก', color: 'bg-amber-100 text-amber-700' }
    return { label: 'แก้ไขได้', color: 'bg-green-100 text-green-700' }
  }

  const SOURCE_LABELS: Record<string, string> = {
    direct_edit: 'แก้ไขตรง',
    amendment: 'ใบขอแก้ไข',
    credit_note: 'Credit Note',
    system: 'ระบบ',
  }

  // ──────────── Editing View ────────────
  if (selectedOrder) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-xl border shadow-sm p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="font-bold text-gray-700 whitespace-nowrap">บิล:</span>
            <span className="font-mono text-blue-600 font-bold">{selectedOrder.bill_no}</span>
            {(selectedOrder as any).revision_no > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold">
                Rev.{(selectedOrder as any).revision_no}
              </span>
            )}
            <span className="text-gray-400 mx-1">|</span>
            <span className="font-bold text-gray-700 whitespace-nowrap">เปลี่ยนสถานะ:</span>
            <select
              value={statusOverride}
              onChange={(e) => setStatusOverride(e.target.value as OrderStatus)}
              className="border rounded-lg px-3 py-2 text-sm bg-white font-semibold min-w-[180px]"
            >
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleViewRevisions(selectedOrder.id, selectedOrder.bill_no || '')}
              className="px-4 py-2 border border-purple-300 rounded-lg text-sm font-semibold text-purple-600 hover:bg-purple-50 transition"
            >
              <i className="fas fa-code-branch mr-1"></i> Revisions
            </button>
            <button
              onClick={() => handleViewLogs(selectedOrder.id, selectedOrder.bill_no || '')}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
            >
              <i className="fas fa-history mr-1"></i> ประวัติการแก้ไข
            </button>
            <button
              onClick={() => { setSelectedOrder(null); setSnapshotBefore(null) }}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
            >
              ยกเลิก
            </button>
            <button
              onClick={handleSaveBillEdit}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition"
            >
              <i className="fas fa-save mr-1"></i> บันทึกการแก้ไข
            </button>
          </div>
        </div>

        <OrderForm
          order={selectedOrder}
          onSave={() => { handleSaveBillEdit() }}
          onCancel={() => { setSelectedOrder(null); setSnapshotBefore(null) }}
        />

        {renderLogsModal()}
        {renderRevisionsModal()}
        {renderSaveResultModal()}
      </div>
    )
  }

  // ──────────── Search & Filter View ────────────
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <h3 className="text-lg font-bold text-gray-800 mb-4">
          <i className="fas fa-search mr-2 text-blue-500"></i>
          ค้นหาบิล
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">วันที่เริ่มต้น</label>
            <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">วันที่สิ้นสุด</label>
            <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">ช่องทางขาย</label>
            <select value={filterChannel} onChange={(e) => setFilterChannel(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm bg-white">
              <option value="">ทั้งหมด</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>{ch.channel_code} - {ch.channel_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-600 mb-1">ค้นหา</label>
            <div className="flex gap-2">
              <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="เลขบิล, ชื่อ, ที่อยู่, เบอร์โทร..." className="flex-1 border rounded-lg px-3 py-2 text-sm" />
              <button onClick={handleSearch} disabled={searching}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition disabled:opacity-50 shrink-0">
                {searching ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> : <i className="fas fa-search"></i>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {hasSearched && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <h3 className="font-semibold text-gray-800">
              ผลการค้นหา
              <span className="text-sm font-normal text-gray-500 ml-2">({searchResults.length} รายการ)</span>
            </h3>
          </div>
          {searching ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <i className="fas fa-inbox text-4xl mb-3 block"></i>
              <p>ไม่พบบิลที่ค้นหา</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-600">
                    <th className="px-4 py-3 font-semibold">เลขบิล</th>
                    <th className="px-4 py-3 font-semibold">ช่องทาง</th>
                    <th className="px-4 py-3 font-semibold">ลูกค้า</th>
                    <th className="px-4 py-3 font-semibold">ยอดรวม</th>
                    <th className="px-4 py-3 font-semibold">สถานะ</th>
                    <th className="px-4 py-3 font-semibold">โซนแก้ไข</th>
                    <th className="px-4 py-3 font-semibold">วันที่</th>
                    <th className="px-4 py-3 font-semibold text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {searchResults.map((r) => {
                    const zone = getEditZoneBadge(r.status)
                    return (
                      <tr key={r.id} className="hover:bg-blue-50/50 cursor-pointer transition-colors"
                        onClick={() => handleSelectOrder(r.id)}>
                        <td className="px-4 py-3">
                          <span className="font-mono font-bold text-blue-600">{r.bill_no}</span>
                          {(r.revision_no ?? 0) > 0 && (
                            <span className="ml-1 text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 font-semibold">
                              R{r.revision_no}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">{r.channel_code}</span>
                        </td>
                        <td className="px-4 py-3 max-w-[200px] truncate">{r.customer_name}</td>
                        <td className="px-4 py-3 font-semibold tabular-nums">{r.total_amount?.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                        <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${zone.color}`}>{zone.label}</span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{r.entry_date || formatDateTime(r.created_at)}</td>
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          <button onClick={(e) => { e.stopPropagation(); handleSelectOrder(r.id) }}
                            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 transition">
                            <i className="fas fa-edit mr-1"></i> แก้ไข
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleViewLogs(r.id, r.bill_no) }}
                            className="ml-1 px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs font-semibold hover:bg-gray-50 transition">
                            <i className="fas fa-history mr-1"></i> ประวัติ
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); handleViewRevisions(r.id, r.bill_no) }}
                            className="ml-1 px-3 py-1.5 border border-purple-300 text-purple-600 rounded-lg text-xs font-semibold hover:bg-purple-50 transition">
                            <i className="fas fa-code-branch mr-1"></i>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {orderLoading && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl p-8 flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500"></div>
            <p className="text-gray-600 font-semibold">กำลังตรวจสอบ...</p>
          </div>
        </div>
      )}

      {/* Guard Modal */}
      {guardModal.open && guardModal.eligibility && (
        <Modal open={guardModal.open} onClose={() => setGuardModal({ open: false, eligibility: null, orderId: '' })} contentClassName="max-w-md">
          <div className="p-6">
            <div className="text-center mb-4">
              {(guardModal.eligibility as any).is_shipped ? (
                <div className="text-5xl text-red-500 mb-3"><i className="fas fa-truck"></i></div>
              ) : guardModal.eligibility.needs_amendment ? (
                <div className="text-5xl text-amber-500 mb-3"><i className="fas fa-ban"></i></div>
              ) : (
                <div className="text-5xl text-gray-400 mb-3"><i className="fas fa-lock"></i></div>
              )}
              <h3 className="text-lg font-bold text-gray-800">ไม่สามารถแก้ไขโดยตรงได้</h3>
              <p className="text-sm text-gray-500 mt-2">{guardModal.eligibility.reason}</p>
            </div>

            {guardModal.eligibility.has_wms_activity && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm">
                <p className="font-semibold text-amber-800">WMS Activity:</p>
                <p className="text-amber-700">
                  หยิบแล้ว: {guardModal.eligibility.wms_picked || 0} รายการ,
                  ตรวจแล้ว: {guardModal.eligibility.wms_correct || 0} รายการ
                </p>
              </div>
            )}

            {guardModal.eligibility.needs_amendment && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm">
                <p className="text-blue-800">
                  <i className="fas fa-info-circle mr-1"></i>
                  ระบบจะยกเลิกบิลเดิม แล้วคุณสามารถสร้างบิลใหม่ได้ในหน้าออเดอร์
                </p>
              </div>
            )}

            {(guardModal.eligibility as any).is_shipped && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm">
                <p className="text-red-800">
                  <i className="fas fa-info-circle mr-1"></i>
                  บิลที่จัดส่งแล้วไม่สามารถแก้ไขได้ กรุณาใช้ระบบเคลมในหน้าออเดอร์แทน
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setGuardModal({ open: false, eligibility: null, orderId: '' })}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition">
                ปิด
              </button>
              {guardModal.eligibility.needs_amendment && onRequestAmendment && (
                <button onClick={() => handleGuardAction()}
                  className="flex-1 px-4 py-2.5 bg-amber-500 text-white rounded-lg text-sm font-bold hover:bg-amber-600 transition">
                  <i className="fas fa-ban mr-1"></i> ขอยกเลิกบิลนี้
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {renderLogsModal()}
      {renderRevisionsModal()}
      {renderSaveResultModal()}
    </div>
  )

  // ──────── Shared Modals ────────
  function renderLogsModal() {
    if (!showLogsModal) return null
    return (
      <Modal open={showLogsModal} onClose={() => setShowLogsModal(false)} contentClassName="max-w-3xl">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4">
            <i className="fas fa-history mr-2 text-blue-500"></i>
            ประวัติการแก้ไข {logsOrderBillNo && `— ${logsOrderBillNo}`}
          </h3>
          {logsLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div></div>
          ) : editLogs.length === 0 ? (
            <p className="text-center text-gray-400 py-8">ยังไม่มีประวัติการแก้ไข</p>
          ) : (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              {editLogs.map((log) => (
                <div key={log.id} className="border rounded-xl p-4 bg-gray-50">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <i className="fas fa-user-edit text-blue-500"></i>
                      <span className="font-bold text-gray-700">{log.edited_by}</span>
                    </div>
                    <span className="text-sm text-gray-500">{formatDateTime(log.edited_at)}</span>
                  </div>
                  {log.changes && log.changes.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead><tr className="text-left text-gray-500 border-b">
                        <th className="py-1 pr-3 font-semibold">ฟิลด์</th>
                        <th className="py-1 pr-3 font-semibold">ก่อนแก้ไข</th>
                        <th className="py-1 font-semibold">หลังแก้ไข</th>
                      </tr></thead>
                      <tbody>
                        {log.changes.map((c, i) => (
                          <tr key={i} className="border-b border-gray-100">
                            <td className="py-1.5 pr-3 font-medium text-gray-700">{c.label}</td>
                            <td className="py-1.5 pr-3 text-red-600 bg-red-50 rounded px-1">{c.before}</td>
                            <td className="py-1.5 text-green-600 bg-green-50 rounded px-1">{c.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-gray-400 text-sm">ไม่มีรายละเอียดการเปลี่ยนแปลง</p>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 text-right">
            <button onClick={() => setShowLogsModal(false)} className="px-4 py-2 border rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50">ปิด</button>
          </div>
        </div>
      </Modal>
    )
  }

  function renderRevisionsModal() {
    if (!showRevisionsModal) return null
    return (
      <Modal open={showRevisionsModal} onClose={() => setShowRevisionsModal(false)} contentClassName="max-w-2xl">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-800 mb-4">
            <i className="fas fa-code-branch mr-2 text-purple-500"></i>
            ประวัติ Revision {revisionsOrderBillNo && `— ${revisionsOrderBillNo}`}
          </h3>
          {revisionsLoading ? (
            <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500"></div></div>
          ) : revisions.length === 0 ? (
            <p className="text-center text-gray-400 py-8">ยังไม่มี revision</p>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto">
              {revisions.map((rev) => (
                <div key={rev.id} className="border rounded-xl p-4 bg-gray-50 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center justify-center w-10 h-10 rounded-full bg-purple-100 text-purple-700 font-bold text-sm">
                      R{rev.revision_no}
                    </span>
                    <div>
                      <p className="font-semibold text-gray-800">
                        {SOURCE_LABELS[rev.change_source] || rev.change_source}
                      </p>
                      <p className="text-sm text-gray-500">
                        โดย {rev.created_by || 'ระบบ'} — {formatDateTime(rev.created_at)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 text-right">
            <button onClick={() => setShowRevisionsModal(false)} className="px-4 py-2 border rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50">ปิด</button>
          </div>
        </div>
      </Modal>
    )
  }

  function renderSaveResultModal() {
    if (!saveResultModal.open) return null
    return (
      <Modal open={saveResultModal.open} onClose={() => setSaveResultModal({ open: false, success: false, message: '' })} contentClassName="max-w-sm">
        <div className="p-6 text-center">
          <div className={`text-5xl mb-4 ${saveResultModal.success ? 'text-green-500' : 'text-red-500'}`}>
            <i className={`fas ${saveResultModal.success ? 'fa-check-circle' : 'fa-times-circle'}`}></i>
          </div>
          <p className="text-gray-700 font-semibold mb-4">{saveResultModal.message}</p>
          <button onClick={() => setSaveResultModal({ open: false, success: false, message: '' })}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 transition">ตกลง</button>
        </div>
      </Modal>
    )
  }
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    'รอลงข้อมูล': 'bg-gray-100 text-gray-700',
    'รอตรวจคำสั่งซื้อ': 'bg-yellow-100 text-yellow-800',
    'ลงข้อมูลเสร็จสิ้น': 'bg-blue-100 text-blue-700',
    'ลงข้อมูลผิด': 'bg-red-100 text-red-700',
    'ตรวจสอบไม่ผ่าน': 'bg-red-100 text-red-700',
    'ตรวจสอบไม่สำเร็จ': 'bg-red-100 text-red-700',
    'ตรวจสอบแล้ว': 'bg-green-100 text-green-700',
    'รอออกแบบ': 'bg-purple-100 text-purple-700',
    'ออกแบบแล้ว': 'bg-purple-100 text-purple-800',
    'รอคอนเฟิร์ม': 'bg-orange-100 text-orange-700',
    'คอนเฟิร์มแล้ว': 'bg-teal-100 text-teal-700',
    'เสร็จสิ้น': 'bg-green-100 text-green-800',
    'ใบสั่งงาน': 'bg-indigo-100 text-indigo-700',
    'ใบงานกำลังผลิต': 'bg-amber-100 text-amber-800',
    'จัดส่งแล้ว': 'bg-emerald-100 text-emerald-700',
    'ยกเลิก': 'bg-gray-200 text-gray-500',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${colorMap[status] || 'bg-gray-100 text-gray-700'}`}>
      {status}
    </span>
  )
}
