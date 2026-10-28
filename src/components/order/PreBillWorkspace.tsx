import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import type { PreBillDocument, PreBillDocumentType } from '../../types/prebill'
import { PREBILL_STATUS_LABEL, PREBILL_TYPE_LABEL } from '../../types/prebill'
import Modal from '../ui/Modal'
import PreBillForm from './PreBillForm'
import { loadPreBillCounts, loadPreBillDetail, loadPreBillPage, PREBILL_PAGE_SIZE, type PreBillSummary, type PreBillView as View } from '../../lib/prebillWorkspace'

type Props = {
  onOpenBill: (document: Pick<PreBillDocument, 'id'>) => void | Promise<void>
  onViewConvertedOrder: (document: Pick<PreBillDocument, 'converted_order_id'>) => void | Promise<void>
  onReviewDiscounts: () => void
  pendingCounts: Record<PreBillDocumentType, number>
}

const firstDayOfMonth = () => `${today().slice(0, 7)}-01`
const today = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
const money = (value: unknown) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const statusClass: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700', active: 'bg-blue-100 text-blue-700', pending_discount: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700', rejected: 'bg-red-100 text-red-700', expired: 'bg-orange-100 text-orange-700',
  converted: 'bg-violet-100 text-violet-700', cancelled: 'bg-slate-200 text-slate-500',
}

export default function PreBillWorkspace({ onOpenBill, onViewConvertedOrder, pendingCounts, onReviewDiscounts }: Props) {
  const { user } = useAuthContext()
  const [documentType, setDocumentType] = useState<PreBillDocumentType>('quotation')
  const [view, setView] = useState<View>('mine')
  const [documents, setDocuments] = useState<PreBillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<PreBillDocument | null | 'new'>(null)
  const [renewing, setRenewing] = useState<PreBillDocument | null>(null)
  const [search, setSearch] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<View, number> | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [detailBusy, setDetailBusy] = useState(false)
  const detailLock = useRef(false)
  const [dateFrom, setDateFrom] = useState(firstDayOfMonth())
  const [dateTo, setDateTo] = useState(today())
  const [ownerFilter, setOwnerFilter] = useState('')
  const [users, setUsers] = useState<Array<{ id: string; username: string | null; seller_name: string | null; email: string }>>([])
  const [message, setMessage] = useState('')
  const [cancelling, setCancelling] = useState<PreBillSummary | null>(null)
  const [selectedCancelledIds, setSelectedCancelledIds] = useState<string[]>([])
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const businessDate = today()
  const filters = useMemo(() => ({ documentType, dateFrom, dateTo,
    ownerId: ['superadmin', 'sales-tr'].includes(user?.role || '') ? ownerFilter : '', today: businessDate,
  }), [documentType, dateFrom, dateTo, ownerFilter, user?.role, businessDate])
  const refresh = useCallback(() => setRefreshKey(value => value + 1), [])
  const resetPage = () => { setPage(1); setSelectedCancelledIds([]) }
  const totalPages = Math.max(1, Math.ceil(total / PREBILL_PAGE_SIZE))
  const busy = loading || detailBusy || deleteBusy || search.trim() !== searchTerm

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearchTerm(search.trim()); setPage(1); setSelectedCancelledIds([]) }, 300)
    return () => window.clearTimeout(timer)
  }, [search])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    void loadPreBillPage(filters, view, page, searchTerm, controller.signal).then(result => {
      if (!active) return
      const lastPage = Math.max(1, Math.ceil(result.total / PREBILL_PAGE_SIZE))
      if (page > lastPage) { setPage(lastPage); return }
      setDocuments(result.documents)
      setTotal(result.total)
    }).catch(error => {
      if (!active) return
      setDocuments([]); setTotal(0)
      setMessage(`โหลดรายการเอกสารไม่สำเร็จ: ${error.message}`)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [filters, view, page, searchTerm, refreshKey])
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setCounts(null)
    void loadPreBillCounts(filters, controller.signal).then(value => { if (active) setCounts(value) }).catch(error => {
      if (active) setMessage(`โหลดจำนวนเอกสารไม่สำเร็จ: ${error.message}`)
    })
    return () => { active = false; controller.abort() }
  }, [filters, refreshKey])
  useEffect(() => {
    if (!['superadmin', 'sales-tr'].includes(user?.role || '')) return
    let query = supabase.from('us_users').select('id, username, seller_name, email').eq('is_active', true).order('username')
    query = user?.role === 'sales-tr' ? query.eq('role', 'sales-tr') : query.in('role', ['sales-tr','sales-pump','superadmin'])
    query.then(({ data }) => setUsers((data || []) as typeof users))
  }, [user?.role])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const channel = supabase.channel(`prebill-workspace-${documentType}`).on('postgres_changes', { event: '*', schema: 'public', table: 'or_prebill_documents' }, () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 300)
    }).subscribe()
    return () => { clearTimeout(timer); void supabase.removeChannel(channel) }
  }, [documentType, refresh])

  async function openDocument(document: PreBillSummary, renewal = false) {
    if (detailLock.current) return
    detailLock.current = true; setDetailBusy(true)
    try {
      const detail = await loadPreBillDetail(document.id)
      if (renewal) setRenewing(detail)
      else setEditing(detail)
    } catch (error) {
      setMessage(`เปิดเอกสารไม่สำเร็จ: ${(error as Error).message}`)
    } finally { detailLock.current = false; setDetailBusy(false) }
  }
  const visibleCancelledIds = useMemo(
    () => documents.filter(doc => doc.status === 'cancelled').map(doc => doc.id),
    [documents],
  )
  const selectedVisibleCancelledIds = selectedCancelledIds.filter(id => visibleCancelledIds.includes(id))
  const allVisibleCancelledSelected = visibleCancelledIds.length > 0
    && visibleCancelledIds.every(id => selectedVisibleCancelledIds.includes(id))

  function toggleAllVisibleCancelled() {
    setSelectedCancelledIds(current => allVisibleCancelledSelected
      ? current.filter(id => !visibleCancelledIds.includes(id))
      : Array.from(new Set([...current, ...visibleCancelledIds])))
  }

  async function cancelDocument() {
    if (!cancelling || deleteBusy) return
    setDeleteBusy(true); setMessage('')
    const { error } = await supabase.rpc('rpc_cancel_prebill_document', { p_document_id: cancelling.id })
    setDeleteBusy(false)
    if (error) { setMessage(error.message); setCancelling(null); return }
    setCancelling(null)
    refresh()
  }

  async function deleteSelectedCancelled() {
    if (user?.role !== 'superadmin' || selectedVisibleCancelledIds.length === 0 || deleteBusy) return
    setDeleteBusy(true); setMessage('')
    const { error } = await supabase.rpc('rpc_delete_cancelled_prebill_documents', { p_document_ids: selectedVisibleCancelledIds })
    setDeleteBusy(false)
    if (error) { setMessage(error.message); setDeleteConfirmOpen(false); return }
    setSelectedCancelledIds([]); setDeleteConfirmOpen(false)
    refresh()
  }

  if (editing || renewing) return <PreBillForm
    documentType={renewing?.document_type || (editing !== 'new' && editing ? editing.document_type : documentType)}
    document={editing === 'new' ? null : editing}
    sourceDocument={renewing}
    onSaved={() => { setEditing(null); setRenewing(null); refresh() }}
    onCancel={() => { setEditing(null); setRenewing(null) }}
    onOpenBill={onOpenBill}
  />

  return (
    <div className="space-y-4 pb-10">
      <Modal
        open={!!message}
        onClose={() => setMessage('')}
        closeOnBackdropClick
        stackClassName="z-[80]"
        contentClassName="max-w-md w-full"
        ariaLabelledby="prebill-workspace-alert-title"
      >
        <div className="p-6">
          <h3 id="prebill-workspace-alert-title" className="pr-10 text-lg font-bold text-slate-900">แจ้งเตือน</h3>
          <p className="mt-3 whitespace-pre-wrap text-slate-700">{message}</p>
          <div className="mt-6 flex justify-end">
            <button type="button" onClick={() => setMessage('')} className="rounded-xl bg-blue-600 px-5 py-2 font-bold text-white hover:bg-blue-700">ตกลง</button>
          </div>
        </div>
      </Modal>
      <div className="rounded-2xl bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {(['quotation','production_confirmation'] as PreBillDocumentType[]).map(type => <button key={type} disabled={detailBusy || deleteBusy} onClick={() => { setDocumentType(type); setView('mine'); resetPage() }} className={`rounded-xl px-5 py-3 font-bold ${documentType === type ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{PREBILL_TYPE_LABEL[type]}{pendingCounts[type] > 0 ? ` (${pendingCounts[type]})` : ''}</button>)}
        </div>
      </div>


      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {([
            ['mine', `${['superadmin', 'sales-tr'].includes(user?.role || '') ? 'รายการทั้งหมด' : 'รายการของฉัน'} (${counts?.mine ?? '…'})`], ['pending', `รออนุมัติส่วนลด (${counts?.pending ?? '…'})`],
            ['approved', `อนุมัติแล้ว (${counts?.approved ?? '…'})`], ['converted', `เปิดบิลแล้ว (${counts?.converted ?? '…'})`], ['expired', `หมดอายุ (${counts?.expired ?? '…'})`],
            ['cancelled', `ยกเลิก (${counts?.cancelled ?? '…'})`],
          ] as [View,string][]).map(([key,label]) => <button key={key} disabled={detailBusy || deleteBusy} onClick={() => { setView(key); resetPage() }} className={`rounded-xl border px-4 py-2 text-sm font-bold ${view === key ? 'border-blue-600 bg-blue-50 text-blue-700' : 'bg-white text-slate-600'}`}>{label}</button>)}
        </div>
        <button disabled={busy} onClick={() => setEditing('new')} className="rounded-xl bg-blue-600 px-5 py-2.5 font-bold text-white">+ สร้าง{PREBILL_TYPE_LABEL[documentType]}</button>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-2xl bg-white p-4 shadow-sm md:grid-cols-2 lg:grid-cols-6">
        <input type="search" disabled={detailBusy || deleteBusy} value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาเลขเอกสาร ลูกค้า สินค้า..." className="rounded-xl border p-2.5 lg:col-span-2" />
        {['superadmin', 'sales-tr'].includes(user?.role || '') && <select disabled={detailBusy || deleteBusy} value={ownerFilter} onChange={e => { setOwnerFilter(e.target.value); resetPage() }} className="rounded-xl border p-2.5 bg-white"><option value="">ผู้เปิดเอกสารทั้งหมด</option>{users.map(u => <option key={u.id} value={u.id}>{u.seller_name || u.username || u.email}</option>)}</select>}
        <input type="date" disabled={detailBusy || deleteBusy} value={dateFrom} onChange={e => { setDateFrom(e.target.value); resetPage() }} className="rounded-xl border p-2.5" />
        <input type="date" disabled={detailBusy || deleteBusy} value={dateTo} onChange={e => { setDateTo(e.target.value); resetPage() }} className="rounded-xl border p-2.5" />
        <button type="button" disabled={detailBusy || deleteBusy} aria-pressed={view === 'draft'} onClick={() => { setView(view === 'draft' ? 'mine' : 'draft'); resetPage() }} className={`rounded-xl border px-4 py-2.5 font-bold ${view === 'draft' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'bg-white text-slate-600'}`}>ร่าง ({counts?.draft ?? '…'})</button>
      </div>

      {view === 'cancelled' && user?.role === 'superadmin' && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 p-4">
          <span className="text-sm font-semibold text-red-800">เลือกแล้ว {selectedVisibleCancelledIds.length} รายการ</span>
          <button
            disabled={selectedVisibleCancelledIds.length === 0 || deleteBusy || busy}
            onClick={() => setDeleteConfirmOpen(true)}
            className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50"
          >ลบถาวร</button>
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[1050px] text-sm">
          <thead><tr className="bg-slate-100 text-left">
            {view === 'cancelled' && user?.role === 'superadmin' && <th className="w-12 p-3 text-center"><input type="checkbox" aria-label="เลือกเอกสารที่ยกเลิกทั้งหมดในหน้านี้" disabled={busy} checked={allVisibleCancelledSelected} onChange={toggleAllVisibleCancelled} /></th>}
            <th className="p-3">เลขเอกสาร</th><th className="p-3">วันที่</th><th className="p-3">ผู้เปิดเอกสาร</th><th className="p-3">ลูกค้า</th><th className="p-3">ช่องทาง</th><th className="p-3 text-right">ยอดสุทธิ</th><th className="p-3">ยืนราคาถึง</th><th className="p-3">สถานะ</th><th className="p-3">จัดการ</th>
          </tr></thead>
          <tbody>
            {busy ? <tr><td colSpan={view === 'cancelled' && user?.role === 'superadmin' ? 10 : 9} className="p-10 text-center text-slate-500">กำลังโหลด...</td></tr> : documents.length === 0 ? <tr><td colSpan={view === 'cancelled' && user?.role === 'superadmin' ? 10 : 9} className="p-10 text-center text-slate-500">ไม่พบเอกสาร</td></tr> : documents.map(doc => {
              const displayStatus = doc.valid_until < today() && !['converted','cancelled'].includes(doc.status) ? 'expired' : doc.status
              const canCancel = !['converted','cancelled'].includes(doc.status)
              const selected = selectedCancelledIds.includes(doc.id)
              return <tr key={doc.id} className="border-t hover:bg-slate-50">
                {view === 'cancelled' && user?.role === 'superadmin' && <td className="p-3 text-center"><input type="checkbox" aria-label={`เลือก ${doc.document_no}`} disabled={busy} checked={selected} onChange={() => setSelectedCancelledIds(current => selected ? current.filter(id => id !== doc.id) : [...current, doc.id])} /></td>}
                <td className="p-3 font-bold text-blue-700">{doc.document_no}</td><td className="p-3">{new Date(doc.created_at).toLocaleDateString('th-TH')}</td><td className="p-3">{doc.owner_name}</td><td className="p-3"><div className="font-semibold">{doc.customer_name}</div></td><td className="p-3">{doc.channel_code}</td><td className="p-3 text-right font-bold">{money(doc.total_amount)}</td><td className="p-3">{new Date(`${doc.valid_until}T00:00:00`).toLocaleDateString('th-TH')}</td><td className="p-3"><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass[displayStatus]}`}>{PREBILL_STATUS_LABEL[displayStatus as keyof typeof PREBILL_STATUS_LABEL]}</span>{doc.status === 'converted' && <div className="mt-1.5 whitespace-nowrap text-xs font-bold text-violet-700">เลขบิล: {doc.converted_order?.bill_no ? <button type="button" disabled={busy} onClick={() => void onViewConvertedOrder(doc)} className="underline decoration-violet-300 underline-offset-2 hover:text-violet-900 hover:decoration-violet-700" title="ดูรายละเอียดบิล">{doc.converted_order.bill_no}</button> : '-'}</div>}</td><td className="p-3"><div className="flex flex-wrap gap-2"><button disabled={busy} onClick={() => void openDocument(doc)} className="rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700">{['converted','cancelled'].includes(doc.status) ? 'ดู' : 'แก้ไข'}</button>{displayStatus === 'expired' && <button disabled={busy} onClick={() => void openDocument(doc, true)} className="rounded-lg bg-orange-500 px-3 py-1.5 font-semibold text-white hover:bg-orange-600">สร้างใหม่</button>}{user?.role === 'superadmin' && doc.status === 'pending_discount' && <button onClick={onReviewDiscounts} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700">อนุมัติ</button>}{!['converted','cancelled'].includes(doc.status) && displayStatus !== 'expired' && ['active','approved'].includes(doc.status) && <button disabled={busy} onClick={() => void onOpenBill(doc)} className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700">เปิดบิล</button>}{canCancel && <button disabled={busy} onClick={() => setCancelling(doc)} className="rounded-lg bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-700">ยกเลิก</button>}</div></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600" aria-live="polite">
        <span>{busy ? 'กำลังโหลด...' : `ทั้งหมด ${total.toLocaleString('th-TH')} รายการ${total ? ` · แสดง ${(page - 1) * PREBILL_PAGE_SIZE + 1}–${Math.min(page * PREBILL_PAGE_SIZE, total)}` : ''}`}</span>
        <div className="flex items-center gap-3">
          <button type="button" disabled={busy || deleteBusy || page <= 1} onClick={() => { setPage(value => value - 1); setSelectedCancelledIds([]) }} className="rounded-xl border bg-white px-4 py-2 font-semibold disabled:opacity-50">ก่อนหน้า</button>
          <span>หน้า {page} / {totalPages}</span>
          <button type="button" disabled={busy || deleteBusy || page >= totalPages} onClick={() => { setPage(value => value + 1); setSelectedCancelledIds([]) }} className="rounded-xl border bg-white px-4 py-2 font-semibold disabled:opacity-50">ถัดไป</button>
        </div>
      </div>

      {cancelling && <Modal open onClose={() => { if (!deleteBusy) setCancelling(null) }} contentClassName="max-w-md" ariaLabelledby="prebill-cancel-title" showCloseButton={!deleteBusy}><div className="p-6"><h3 id="prebill-cancel-title" className="pr-10 text-xl font-bold text-slate-900">ยืนยันการยกเลิกเอกสาร</h3><p className="mt-3 text-slate-600">ต้องการยกเลิก <b>{cancelling.document_no}</b> ของลูกค้า <b>{cancelling.customer_name}</b> ใช่หรือไม่?</p><p className="mt-2 text-sm text-orange-700">เอกสารจะย้ายไปแถบยกเลิกและไม่สามารถแก้ไขหรือเปิดบิลได้</p><div className="mt-5 flex justify-end gap-2"><button disabled={deleteBusy} onClick={() => setCancelling(null)} className="rounded-xl border px-4 py-2 font-semibold disabled:opacity-50">กลับ</button><button disabled={deleteBusy} onClick={cancelDocument} className="rounded-xl bg-orange-600 px-4 py-2 font-bold text-white hover:bg-orange-700 disabled:opacity-50">{deleteBusy ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิก'}</button></div></div></Modal>}
      {deleteConfirmOpen && <Modal open onClose={() => { if (!deleteBusy) setDeleteConfirmOpen(false) }} contentClassName="max-w-md" ariaLabelledby="prebill-delete-title" showCloseButton={!deleteBusy}><div className="p-6"><h3 id="prebill-delete-title" className="pr-10 text-xl font-bold text-red-700">ยืนยันการลบถาวร</h3><p className="mt-3 text-slate-600">ต้องการลบเอกสารที่เลือก <b>{selectedVisibleCancelledIds.length} รายการ</b> ออกจากฐานข้อมูลใช่หรือไม่?</p><p className="mt-2 text-sm font-semibold text-red-600">เมื่อลบแล้วจะไม่สามารถเรียกคืนได้</p><div className="mt-5 flex justify-end gap-2"><button disabled={deleteBusy} onClick={() => setDeleteConfirmOpen(false)} className="rounded-xl border px-4 py-2 font-semibold disabled:opacity-50">กลับ</button><button disabled={deleteBusy || selectedVisibleCancelledIds.length === 0} onClick={deleteSelectedCancelled} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50">{deleteBusy ? 'กำลังลบ...' : 'ลบถาวร'}</button></div></div></Modal>}
    </div>
  )
}
