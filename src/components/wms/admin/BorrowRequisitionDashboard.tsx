import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { useWmsModal } from '../useWmsModal'
import { getProductImageUrl } from '../wmsUtils'
import Modal from '../../ui/Modal'
import type { ProductType } from '../../../types'

function ZoomImage({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const handleEnter = () => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.top, left: rect.right + 8 })
  }
  const handleLeave = () => setPos(null)

  return (
    <div ref={ref} className="w-12 h-12 flex-shrink-0 cursor-pointer inline-block" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className="w-12 h-12 rounded-lg bg-gray-100 overflow-hidden">
        <img src={src} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
      </div>
      {pos && (
        <img
          src={src}
          alt=""
          className="fixed w-48 h-48 object-cover rounded-xl shadow-2xl border-2 border-white pointer-events-none"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}

interface BorrowRequisition {
  id: string
  borrow_no: string
  topic?: string | null
  status: string
  due_date: string
  created_by?: string | null
  created_at: string
  approved_by?: string | null
  approved_at?: string | null
  returned_at?: string | null
  note?: string | null
  created_by_user?: { username: string } | null
  approved_by_user?: { username: string } | null
}

interface BorrowItem {
  id: string
  product_id: string
  qty: number
  returned_qty: number
  written_off_qty: number
  topic?: string | null
  pr_products?: { product_code: string; product_name: string } | null
}

const STATUS_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'pending', label: 'รออนุมัติ' },
  { value: 'approved', label: 'อนุมัติแล้ว' },
  { value: 'partial_returned', label: 'คืนบางส่วน' },
  { value: 'overdue', label: 'เลยกำหนด' },
  { value: 'returned', label: 'คืนแล้ว' },
  { value: 'written_off', label: 'ตัดเป็นของเสีย' },
  { value: 'rejected', label: 'ไม่อนุมัติ' },
]

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  approved: 'bg-blue-100 text-blue-800',
  partial_returned: 'bg-cyan-100 text-cyan-800',
  returned: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  written_off: 'bg-gray-200 text-gray-800',
  rejected: 'bg-red-200 text-red-800',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว',
  partial_returned: 'คืนบางส่วน',
  returned: 'คืนแล้ว',
  overdue: 'เลยกำหนด',
  written_off: 'ตัดของเสีย',
  rejected: 'ไม่อนุมัติ',
}

export default function BorrowRequisitionDashboard() {
  const { user } = useAuthContext()
  const [borrows, setBorrows] = useState<BorrowRequisition[]>([])
  const [loading, setLoading] = useState(true)
  const [filterDateStart, setFilterDateStart] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [filterDateEnd, setFilterDateEnd] = useState(() => new Date().toISOString().split('T')[0])
  const [filterStatus, setFilterStatus] = useState('')
  const [detailModal, setDetailModal] = useState<{ open: boolean; bor: BorrowRequisition | null; items: BorrowItem[] }>({
    open: false, bor: null, items: [],
  })
  const [processing, setProcessing] = useState<string | null>(null)
  const [actionMode, setActionMode] = useState<'view' | 'return' | 'writeoff'>('view')
  const [actionQtys, setActionQtys] = useState<Record<string, number>>({})
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const canManage = ['superadmin', 'admin'].includes(user?.role || '')
  const canCreate = ['superadmin', 'admin', 'store', 'production'].includes(user?.role || '')

  // --- Create borrow state ---
  const [showCreate, setShowCreate] = useState(false)
  const [crSearchTerm, setCrSearchTerm] = useState('')
  const [crProducts, setCrProducts] = useState<any[]>([])
  const [crAllProducts, setCrAllProducts] = useState<any[]>([])
  const [crSelectedItems, setCrSelectedItems] = useState<{ product_code: string; product_name: string; qty: number; topic: string }[]>([])
  const [crBorrowNo, setCrBorrowNo] = useState('')
  const [crDueDate, setCrDueDate] = useState('')
  const [crNotes, setCrNotes] = useState('')
  const [crTopics, setCrTopics] = useState<any[]>([])
  const [crSearching, setCrSearching] = useState(false)
  const [crLoadingProducts, setCrLoadingProducts] = useState(false)
  const [crProductType, setCrProductType] = useState<ProductType>('FG')
  const [crSubmitting, setCrSubmitting] = useState(false)

  const loadBorrows = useCallback(async () => {
    setLoading(true)
    try {
      let q = supabase
        .from('wms_borrow_requisitions')
        .select('*, created_by_user:created_by(username), approved_by_user:approved_by(username)')
        .gte('created_at', filterDateStart + 'T00:00:00')
        .lte('created_at', filterDateEnd + 'T23:59:59')
        .order('created_at', { ascending: false })
      if (filterStatus) q = q.eq('status', filterStatus)
      const { data, error } = await q
      if (error) throw error
      setBorrows((data || []) as BorrowRequisition[])
    } catch (e: any) {
      showMessage({ message: 'โหลดข้อมูลไม่สำเร็จ: ' + e.message })
    } finally {
      setLoading(false)
    }
  }, [filterDateStart, filterDateEnd, filterStatus])

  useEffect(() => { loadBorrows() }, [loadBorrows])

  useEffect(() => {
    const ch = supabase.channel('borrow-req-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_borrow_requisitions' }, () => loadBorrows())
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [loadBorrows])

  const openDetail = async (bor: BorrowRequisition) => {
    const { data } = await supabase
      .from('wms_borrow_requisition_items')
      .select('*, pr_products(product_code, product_name)')
      .eq('borrow_requisition_id', bor.id)
    setDetailModal({ open: true, bor, items: (data || []) as BorrowItem[] })
    setActionMode('view')
    setActionQtys({})
  }

  const handleApprove = async (borId: string) => {
    const ok = await showConfirm({ title: 'อนุมัติใบยืม', message: 'ยืนยันอนุมัติรายการยืมนี้? (สต๊อกจะถูกจอง)' })
    if (!ok) return
    setProcessing(borId)
    try {
      const { error } = await supabase.rpc('approve_borrow_requisition', { p_borrow_id: borId, p_user_id: user?.id })
      if (error) throw error
      showMessage({ message: 'อนุมัติสำเร็จ' })
      setDetailModal({ open: false, bor: null, items: [] })
      loadBorrows()
    } catch (e: any) {
      showMessage({ message: 'อนุมัติไม่สำเร็จ: ' + e.message })
    } finally {
      setProcessing(null)
    }
  }

  const handleReject = async (borId: string) => {
    const ok = await showConfirm({ title: 'ปฏิเสธใบยืม', message: 'ยืนยันปฏิเสธรายการยืมนี้?' })
    if (!ok) return
    setProcessing(borId)
    try {
      const { error } = await supabase.rpc('reject_borrow_requisition', { p_borrow_id: borId, p_user_id: user?.id })
      if (error) throw error
      showMessage({ message: 'ปฏิเสธสำเร็จ' })
      setDetailModal({ open: false, bor: null, items: [] })
      loadBorrows()
    } catch (e: any) {
      showMessage({ message: 'ปฏิเสธไม่สำเร็จ: ' + e.message })
    } finally {
      setProcessing(null)
    }
  }

  const handleReturnItems = async (borId: string) => {
    const items = Object.entries(actionQtys)
      .filter(([, qty]) => qty > 0)
      .map(([product_id, return_qty]) => ({ product_id, return_qty }))
    if (items.length === 0) { showMessage({ message: 'กรุณาระบุจำนวนที่คืน' }); return }

    const ok = await showConfirm({ title: 'รับคืนสินค้า', message: `ยืนยันรับคืน ${items.length} รายการ?` })
    if (!ok) return
    setProcessing(borId)
    try {
      const { error } = await supabase.rpc('return_borrow_requisition', {
        p_borrow_id: borId, p_items: items, p_user_id: user?.id,
      })
      if (error) throw error
      showMessage({ message: 'รับคืนสำเร็จ' })
      setDetailModal({ open: false, bor: null, items: [] })
      loadBorrows()
    } catch (e: any) {
      showMessage({ message: 'รับคืนไม่สำเร็จ: ' + e.message })
    } finally {
      setProcessing(null)
    }
  }

  const handleWriteOff = async (borId: string) => {
    const items = Object.entries(actionQtys)
      .filter(([, qty]) => qty > 0)
      .map(([product_id, write_off_qty]) => ({ product_id, write_off_qty }))
    if (items.length === 0) { showMessage({ message: 'กรุณาระบุจำนวนที่ตัดเป็นของเสีย' }); return }

    const ok = await showConfirm({ title: 'ตัดเป็นของเสีย', message: `ยืนยันตัดเป็นของเสีย ${items.length} รายการ? (สต๊อกจะถูกตัดจริง)` })
    if (!ok) return
    setProcessing(borId)
    try {
      const { error } = await supabase.rpc('write_off_borrow_requisition', {
        p_borrow_id: borId, p_items: items, p_user_id: user?.id,
      })
      if (error) throw error
      showMessage({ message: 'ตัดเป็นของเสียสำเร็จ' })
      setDetailModal({ open: false, bor: null, items: [] })
      loadBorrows()
    } catch (e: any) {
      showMessage({ message: 'ตัดเป็นของเสียไม่สำเร็จ: ' + e.message })
    } finally {
      setProcessing(null)
    }
  }

  const isOverdue = (due: string, status: string) => {
    if (['returned', 'written_off', 'rejected'].includes(status)) return false
    return new Date(due) < new Date(new Date().toISOString().slice(0, 10))
  }

  // --- Create borrow helpers ---
  const openCreateBorrow = async () => {
    setShowCreate(true)
    setCrSelectedItems([])
    setCrNotes('')
    setCrSearchTerm('')
    setCrProducts([])
    const d = new Date(); d.setDate(d.getDate() + 7)
    setCrDueDate(d.toISOString().slice(0, 10))
    setCrProductType('FG')
    const date = new Date()
    const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const { count } = await supabase
      .from('wms_borrow_requisitions')
      .select('*', { count: 'exact', head: true })
      .like('borrow_no', `BOR-${dateStr}-%`)
    setCrBorrowNo(`BOR-${dateStr}-${((count || 0) + 1).toString().padStart(3, '0')}`)
    const { data: topics } = await supabase.from('wms_requisition_topics').select('*').order('topic_name')
    setCrTopics(topics || [])
    loadCrAllProducts('FG')
  }

  const loadCrAllProducts = async (pt: ProductType) => {
    setCrLoadingProducts(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', pt)
        .order('product_name')
      setCrAllProducts(data || [])
    } catch {} finally { setCrLoadingProducts(false) }
  }

  const crSearch = async () => {
    if (!crSearchTerm.trim()) { setCrProducts([]); return }
    setCrSearching(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', crProductType)
        .or(`product_code.ilike.%${crSearchTerm}%,product_name.ilike.%${crSearchTerm}%`)
        .limit(20)
      setCrProducts(data || [])
    } catch {} finally { setCrSearching(false) }
  }

  const crAddItem = (p: any) => {
    const existing = crSelectedItems.find((i) => i.product_code === p.product_code)
    if (existing) {
      setCrSelectedItems(crSelectedItems.map((i) => i.product_code === p.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setCrSelectedItems([...crSelectedItems, { product_code: p.product_code, product_name: p.product_name, qty: 1, topic: '' }])
    }
  }

  const crSubmit = async () => {
    if (crSelectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (crSelectedItems.some((i) => !i.topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อยืมให้ครบทุกรายการ' }); return }
    if (!crDueDate) { showMessage({ message: 'กรุณากำหนดวันคืน' }); return }
    if (!crNotes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    setCrSubmitting(true)
    try {
      const { error: borErr } = await supabase
        .from('wms_borrow_requisitions')
        .insert({ borrow_no: crBorrowNo, topic: null, status: 'pending', due_date: crDueDate, created_by: user?.id, note: crNotes.trim() || null })
        .select().single()
      if (borErr) throw borErr

      const { data: borData } = await supabase.from('wms_borrow_requisitions').select('id').eq('borrow_no', crBorrowNo).single()
      if (!borData) throw new Error('ไม่พบใบยืมที่สร้าง')

      const codes = crSelectedItems.map((i) => i.product_code)
      const { data: prods } = await supabase.from('pr_products').select('id, product_code').in('product_code', codes)
      const codeToId = (prods || []).reduce<Record<string, string>>((acc, p) => { acc[p.product_code] = p.id; return acc }, {})

      const items = crSelectedItems.filter((i) => codeToId[i.product_code]).map((i) => ({
        borrow_requisition_id: borData.id, product_id: codeToId[i.product_code], qty: i.qty, topic: i.topic || null,
      }))
      if (items.length > 0) {
        const { error: itemErr } = await supabase.from('wms_borrow_requisition_items').insert(items)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `สร้างใบยืม ${crBorrowNo} สำเร็จ` })
      setShowCreate(false)
      loadBorrows()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      showMessage({ message: `สร้างใบยืมไม่สำเร็จ: ${e.message}` })
    } finally {
      setCrSubmitting(false)
    }
  }

  const stats = {
    total: borrows.length,
    pending: borrows.filter((b) => b.status === 'pending').length,
    active: borrows.filter((b) => ['approved', 'partial_returned', 'overdue'].includes(b.status)).length,
    overdue: borrows.filter((b) => isOverdue(b.due_date, b.status)).length,
    returned: borrows.filter((b) => b.status === 'returned').length,
  }

  return (
    <div className="space-y-4">
      {/* Header + Create button */}
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-black text-slate-800">รายการยืม</h2>
        {canCreate && (
          <button onClick={openCreateBorrow}
            className="bg-cyan-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-cyan-700 transition flex items-center gap-2 shadow-md">
            <i className="fas fa-plus-circle" />
            สร้างใบยืม
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'ทั้งหมด', value: stats.total, color: 'bg-gray-50 text-gray-700 border-gray-200' },
          { label: 'รออนุมัติ', value: stats.pending, color: 'bg-amber-50 text-amber-700 border-amber-200' },
          { label: 'กำลังยืม', value: stats.active, color: 'bg-blue-50 text-blue-700 border-blue-200' },
          { label: 'เลยกำหนด', value: stats.overdue, color: 'bg-red-50 text-red-700 border-red-200' },
          { label: 'คืนแล้ว', value: stats.returned, color: 'bg-green-50 text-green-700 border-green-200' },
        ].map((s) => (
          <div key={s.label} className={`rounded-xl border p-3 ${s.color}`}>
            <div className="text-xs font-medium opacity-75">{s.label}</div>
            <div className="text-2xl font-bold mt-0.5">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" value={filterDateStart} onChange={(e) => setFilterDateStart(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        <span className="text-gray-400">ถึง</span>
        <input type="date" value={filterDateEnd} onChange={(e) => setFilterDateEnd(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-16"><i className="fas fa-spinner fa-spin text-2xl text-blue-500" /></div>
      ) : borrows.length === 0 ? (
        <div className="text-center text-gray-400 py-16">ไม่มีรายการ</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                <th className="px-4 py-3 text-left font-semibold">เลขที่ใบยืม</th>
                <th className="px-4 py-3 text-left font-semibold">ผู้ยืม</th>
                <th className="px-4 py-3 text-left font-semibold">วันที่ยืม</th>
                <th className="px-4 py-3 text-left font-semibold">กำหนดคืน</th>
                <th className="px-4 py-3 text-left font-semibold">หมายเหตุ</th>
                <th className="px-4 py-3 text-center font-semibold">สถานะ</th>
                <th className="px-4 py-3 text-center font-semibold">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {borrows.map((b) => {
                const overdue = isOverdue(b.due_date, b.status)
                return (
                  <tr key={b.id} className={`hover:bg-gray-50/50 ${overdue ? 'bg-red-50/40' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs font-semibold">{b.borrow_no}</td>
                    <td className="px-4 py-3 text-gray-700">{b.created_by_user?.username || '-'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{new Date(b.created_at).toLocaleDateString('th-TH')}</td>
                    <td className={`px-4 py-3 text-xs font-semibold ${overdue ? 'text-red-600' : 'text-gray-700'}`}>
                      {new Date(b.due_date).toLocaleDateString('th-TH')}
                      {overdue && <i className="fas fa-exclamation-triangle text-red-500 ml-1.5" />}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-[200px] truncate">{b.note || '-'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${STATUS_COLORS[overdue && !['returned','written_off','rejected'].includes(b.status) ? 'overdue' : b.status] || 'bg-gray-100 text-gray-600'}`}>
                        {overdue && !['returned','written_off','rejected'].includes(b.status) ? 'เลยกำหนด' : STATUS_LABELS[b.status] || b.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button type="button" onClick={() => openDetail(b)}
                        className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100">
                        ดู
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail modal */}
      <Modal open={detailModal.open} onClose={() => setDetailModal({ open: false, bor: null, items: [] })} closeOnBackdropClick contentClassName="max-w-4xl">
        {detailModal.bor && (
          <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-cyan-600 to-cyan-700">
              <div>
                <h3 className="text-xl font-bold text-white">ใบยืม {detailModal.bor.borrow_no}</h3>
                <span className={`mt-1 inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${STATUS_COLORS[detailModal.bor.status] || 'bg-white/20 text-white'}`}>
                  {STATUS_LABELS[detailModal.bor.status] || detailModal.bor.status}
                </span>
              </div>
              <button onClick={() => setDetailModal({ open: false, bor: null, items: [] })} className="text-white hover:text-red-200 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/20 transition-all">
                <i className="fas fa-times" style={{ fontSize: '1.5rem' }} />
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">ผู้ยืม:</span> <strong>{detailModal.bor.created_by_user?.username || '-'}</strong></div>
                <div><span className="text-gray-500">วันที่ยืม:</span> {new Date(detailModal.bor.created_at).toLocaleDateString('th-TH')}</div>
                <div>
                  <span className="text-gray-500">กำหนดคืน:</span>{' '}
                  <span className={isOverdue(detailModal.bor.due_date, detailModal.bor.status) ? 'text-red-600 font-bold' : ''}>
                    {new Date(detailModal.bor.due_date).toLocaleDateString('th-TH')}
                    {isOverdue(detailModal.bor.due_date, detailModal.bor.status) && <span className="ml-1 text-red-500 text-xs">(เลยกำหนด)</span>}
                  </span>
                </div>
                {detailModal.bor.approved_by_user && (
                  <div><span className="text-gray-500">ผู้อนุมัติ:</span> <strong>{detailModal.bor.approved_by_user.username}</strong></div>
                )}
                {detailModal.bor.note && (
                  <div className="col-span-2"><span className="text-gray-500">หมายเหตุ:</span> {detailModal.bor.note}</div>
                )}
              </div>

              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50 text-gray-600">
                    <th className="px-3 py-2 text-center w-16">รูป</th>
                    <th className="px-3 py-2 text-left">สินค้า</th>
                    <th className="px-3 py-2 text-right">ยืม</th>
                    <th className="px-3 py-2 text-right">คืนแล้ว</th>
                    <th className="px-3 py-2 text-right">ตัดเสีย</th>
                    <th className="px-3 py-2 text-right">คงเหลือ</th>
                    {(actionMode === 'return' || actionMode === 'writeoff') && (
                      <th className="px-3 py-2 text-right">{actionMode === 'return' ? 'จำนวนคืน' : 'จำนวนตัด'}</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {detailModal.items.map((item) => {
                    const remaining = item.qty - item.returned_qty - item.written_off_qty
                    return (
                      <tr key={item.id}>
                        <td className="px-3 py-2 text-center">
                          <ZoomImage src={getProductImageUrl(item.pr_products?.product_code)} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-mono text-xs text-gray-500">{item.pr_products?.product_code}</div>
                          <div className="text-gray-800 text-xs">{item.pr_products?.product_name}</div>
                          {item.topic && <div className="text-xs text-blue-500 font-semibold">{item.topic}</div>}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">{item.qty}</td>
                        <td className="px-3 py-2 text-right text-green-600">{item.returned_qty || 0}</td>
                        <td className="px-3 py-2 text-right text-red-500">{item.written_off_qty || 0}</td>
                        <td className={`px-3 py-2 text-right font-bold ${remaining > 0 ? 'text-blue-600' : 'text-gray-400'}`}>{remaining}</td>
                        {(actionMode === 'return' || actionMode === 'writeoff') && (
                          <td className="px-3 py-2 text-right">
                            {remaining > 0 ? (
                              <input type="number" min={0} max={remaining}
                                value={actionQtys[item.product_id] || 0}
                                onChange={(e) => {
                                  const v = Math.min(Math.max(0, Number(e.target.value) || 0), remaining)
                                  setActionQtys((prev) => ({ ...prev, [item.product_id]: v }))
                                }}
                                className="w-20 border border-gray-300 rounded px-2 py-1 text-right text-sm" />
                            ) : <span className="text-gray-300">-</span>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Action buttons */}
            {canManage && (
              <div className="p-4 border-t bg-white flex flex-wrap gap-2">
                {detailModal.bor.status === 'pending' && (
                  <>
                    <button type="button" onClick={() => handleApprove(detailModal.bor!.id)} disabled={!!processing}
                      className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 disabled:opacity-50">
                      <i className="fas fa-check mr-1" /> อนุมัติ
                    </button>
                    <button type="button" onClick={() => handleReject(detailModal.bor!.id)} disabled={!!processing}
                      className="px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 disabled:opacity-50">
                      <i className="fas fa-times mr-1" /> ปฏิเสธ
                    </button>
                  </>
                )}
                {['approved', 'partial_returned', 'overdue'].includes(detailModal.bor.status) && (
                  <>
                    {actionMode === 'view' && (
                      <>
                        <button type="button" onClick={() => { setActionMode('return'); setActionQtys({}) }}
                          className="px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700">
                          <i className="fas fa-undo mr-1" /> รับคืน
                        </button>
                        <button type="button" onClick={() => { setActionMode('writeoff'); setActionQtys({}) }}
                          className="px-5 py-2.5 bg-gray-600 text-white rounded-lg text-sm font-bold hover:bg-gray-700">
                          <i className="fas fa-trash-alt mr-1" /> ตัดเป็นของเสีย
                        </button>
                      </>
                    )}
                    {actionMode === 'return' && (
                      <>
                        <button type="button" onClick={() => handleReturnItems(detailModal.bor!.id)} disabled={!!processing}
                          className="px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700 disabled:opacity-50">
                          <i className="fas fa-check mr-1" /> ยืนยันรับคืน
                        </button>
                        <button type="button" onClick={() => setActionMode('view')}
                          className="px-5 py-2.5 bg-gray-300 text-gray-700 rounded-lg text-sm font-bold hover:bg-gray-400">ยกเลิก</button>
                      </>
                    )}
                    {actionMode === 'writeoff' && (
                      <>
                        <button type="button" onClick={() => handleWriteOff(detailModal.bor!.id)} disabled={!!processing}
                          className="px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 disabled:opacity-50">
                          <i className="fas fa-exclamation-triangle mr-1" /> ยืนยันตัดเป็นของเสีย
                        </button>
                        <button type="button" onClick={() => setActionMode('view')}
                          className="px-5 py-2.5 bg-gray-300 text-gray-700 rounded-lg text-sm font-bold hover:bg-gray-400">ยกเลิก</button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Create Borrow Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} closeOnBackdropClick={false} contentClassName="max-w-5xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-cyan-600 to-cyan-700">
            <div>
              <h3 className="text-xl font-bold text-white">สร้างใบยืม</h3>
              <span className="text-sm font-bold text-cyan-200">{crBorrowNo}</span>
            </div>
            <button onClick={() => setShowCreate(false)} className="text-white hover:text-red-200 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/20 transition-all">
              <i className="fas fa-times" style={{ fontSize: '1.5rem' }} />
            </button>
          </div>

          <div className="p-6 space-y-4 overflow-y-auto flex-1">
            {/* Due date */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">วันกำหนดคืน <span className="text-red-500">*</span></label>
                <input type="date" value={crDueDate} onChange={(e) => setCrDueDate(e.target.value)}
                  className={`w-full border rounded-lg px-3 py-2 text-sm ${crDueDate ? 'border-gray-300' : 'border-red-400'}`} />
                <div className="flex gap-2 mt-1">
                  {[7, 14, 30].map((d) => (
                    <button key={d} type="button" onClick={() => { const dt = new Date(); dt.setDate(dt.getDate() + d); setCrDueDate(dt.toISOString().slice(0, 10)) }}
                      className="px-3 py-1 rounded bg-gray-100 text-xs text-gray-600 hover:bg-gray-200 font-bold">{d} วัน</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">ประเภทสินค้า</label>
                <div className="flex gap-2">
                  {(['FG', 'RM', 'PP'] as ProductType[]).map((pt) => (
                    <button key={pt} type="button" onClick={() => { setCrProductType(pt); loadCrAllProducts(pt); setCrProducts([]); setCrSearchTerm('') }}
                      className={`flex-1 py-2 rounded-lg text-sm font-bold ${crProductType === pt ? 'bg-cyan-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      {pt === 'FG' ? 'สินค้าสำเร็จรูป' : pt === 'RM' ? 'วัตถุดิบ' : 'สินค้าแปรรูป'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Search */}
            <div className="flex gap-2">
              <input type="text" value={crSearchTerm} onChange={(e) => setCrSearchTerm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && crSearch()}
                placeholder="ค้นหาสินค้า..." className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <button type="button" onClick={crSearch} className="px-4 py-2 bg-cyan-600 text-white rounded-lg text-sm font-bold hover:bg-cyan-700">ค้นหา</button>
            </div>

            {/* Dropdown */}
            {!crLoadingProducts && crAllProducts.length > 0 && (
              <select value="" onChange={(e) => { if (e.target.value) { const p = crAllProducts.find((x) => x.product_code === e.target.value); if (p) crAddItem(p) } }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">-- เลือกสินค้าจากรายการ ({crAllProducts.length}) --</option>
                {crAllProducts.map((p) => <option key={p.product_code} value={p.product_code}>{p.product_code} - {p.product_name}</option>)}
              </select>
            )}

            {/* Search results */}
            {crSearching && <div className="text-center text-gray-400 text-xs py-2">กำลังค้นหา...</div>}
            {crProducts.length > 0 && (
              <div className="space-y-1 max-h-40 overflow-y-auto border rounded-lg p-2">
                {crProducts.map((p) => (
                  <button key={p.product_code} type="button" onClick={() => crAddItem(p)}
                    className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 text-left">
                    <img src={getProductImageUrl(p.product_code)} alt="" className="w-10 h-10 rounded object-cover bg-gray-100"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-gray-800 truncate">{p.product_code}</div>
                      <div className="text-[10px] text-gray-500 truncate">{p.product_name}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected items */}
            {crSelectedItems.length > 0 && (
              <div className="border rounded-xl p-3 space-y-2">
                <div className="text-sm font-bold text-gray-800">รายการยืม ({crSelectedItems.length})</div>
                {crSelectedItems.map((item) => (
                  <div key={item.product_code} className="bg-gray-50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-3">
                      <ZoomImage src={getProductImageUrl(item.product_code)} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-gray-800">{item.product_code}</div>
                        <div className="text-xs text-gray-500 truncate">{item.product_name}</div>
                      </div>
                      <button type="button" onClick={() => setCrSelectedItems(crSelectedItems.filter((i) => i.product_code !== item.product_code))}
                        className="text-red-400 hover:text-red-600 flex-shrink-0"><i className="fas fa-trash text-sm" /></button>
                    </div>
                    <div className="flex items-center gap-3">
                      <select value={item.topic || ''} onChange={(e) => setCrSelectedItems(crSelectedItems.map((i) => i.product_code === item.product_code ? { ...i, topic: e.target.value } : i))}
                        className={`flex-1 border rounded-lg px-3 py-1.5 text-sm ${item.topic ? 'border-gray-300' : 'border-red-400'}`}>
                        <option value="">-- หัวข้อยืม * --</option>
                        {crTopics.map((t) => <option key={t.id} value={t.topic_name}>{t.topic_name}</option>)}
                      </select>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => { const q = item.qty - 1; if (q < 1) return; setCrSelectedItems(crSelectedItems.map((i) => i.product_code === item.product_code ? { ...i, qty: q } : i)) }}
                          className="w-8 h-8 rounded bg-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-300">-</button>
                        <input type="number" value={item.qty} min={1}
                          onChange={(e) => { const q = Number(e.target.value) || 1; setCrSelectedItems(crSelectedItems.map((i) => i.product_code === item.product_code ? { ...i, qty: Math.max(1, q) } : i)) }}
                          className="w-14 text-center border border-gray-300 rounded text-sm py-1" />
                        <button type="button" onClick={() => setCrSelectedItems(crSelectedItems.map((i) => i.product_code === item.product_code ? { ...i, qty: i.qty + 1 } : i))}
                          className="w-8 h-8 rounded bg-gray-200 text-gray-700 font-bold text-sm hover:bg-gray-300">+</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-1">หมายเหตุ <span className="text-red-500">*</span></label>
              <textarea value={crNotes} onChange={(e) => setCrNotes(e.target.value)} rows={2}
                className={`w-full border rounded-lg px-3 py-2 text-sm ${crNotes.trim() ? 'border-gray-300' : 'border-red-400'}`}
                placeholder="กรุณาระบุหมายเหตุ (จำเป็น)" />
            </div>
          </div>

          <div className="p-4 border-t bg-white flex justify-end gap-3">
            <button onClick={() => setShowCreate(false)} className="px-6 py-3 rounded-xl font-bold text-gray-600 hover:bg-gray-100 transition">ยกเลิก</button>
            <button onClick={crSubmit} disabled={crSubmitting || crSelectedItems.length === 0 || crSelectedItems.some((i) => !i.topic) || !crDueDate || !crNotes.trim()}
              className="bg-cyan-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-cyan-700 disabled:opacity-50 transition flex items-center gap-2">
              {crSubmitting ? <><i className="fas fa-spinner fa-spin" /> กำลังบันทึก...</> : <><i className="fas fa-check" /> ยืนยันสร้างใบยืม</>}
            </button>
          </div>
        </div>
      </Modal>

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
