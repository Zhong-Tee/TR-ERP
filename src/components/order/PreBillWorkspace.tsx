import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import type { PreBillDocument, PreBillDocumentType } from '../../types/prebill'
import { PREBILL_STATUS_LABEL, PREBILL_TYPE_LABEL } from '../../types/prebill'
import PreBillForm from './PreBillForm'

type View = 'mine' | 'pending' | 'approved' | 'converted' | 'expired' | 'cancelled'
type Props = {
  onOpenBill: (document: PreBillDocument) => void
  onViewConvertedOrder: (document: PreBillDocument) => void
}

const firstDayOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` }
const today = () => new Date().toISOString().slice(0, 10)
const money = (value: unknown) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const statusClass: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700', active: 'bg-blue-100 text-blue-700', pending_discount: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-700', rejected: 'bg-red-100 text-red-700', expired: 'bg-orange-100 text-orange-700',
  converted: 'bg-violet-100 text-violet-700', cancelled: 'bg-slate-200 text-slate-500',
}

export default function PreBillWorkspace({ onOpenBill, onViewConvertedOrder }: Props) {
  const { user } = useAuthContext()
  const [documentType, setDocumentType] = useState<PreBillDocumentType>('quotation')
  const [view, setView] = useState<View>('mine')
  const [documents, setDocuments] = useState<PreBillDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<PreBillDocument | null | 'new'>(null)
  const [renewing, setRenewing] = useState<PreBillDocument | null>(null)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState(firstDayOfMonth())
  const [dateTo, setDateTo] = useState(today())
  const [ownerFilter, setOwnerFilter] = useState('')
  const [users, setUsers] = useState<Array<{ id: string; username: string | null; seller_name: string | null; email: string }>>([])
  const [message, setMessage] = useState('')
  const [reviewing, setReviewing] = useState<PreBillDocument | null>(null)
  const [review, setReview] = useState({ approve: true, amount: '', note: '' })
  const [cancelling, setCancelling] = useState<PreBillDocument | null>(null)
  const [selectedCancelledIds, setSelectedCancelledIds] = useState<string[]>([])
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    let query = supabase.from('or_prebill_documents').select('*, or_prebill_items(*), converted_order:or_orders!converted_order_id(bill_no)').eq('document_type', documentType).order('created_at', { ascending: false })
    if (dateFrom) query = query.gte('created_at', `${dateFrom}T00:00:00+07:00`)
    if (dateTo) query = query.lte('created_at', `${dateTo}T23:59:59+07:00`)
    if (ownerFilter && ['superadmin', 'sales-tr'].includes(user?.role || '')) query = query.eq('owner_id', ownerFilter)
    const { data, error } = await query
    if (error) setMessage(error.message)
    setDocuments(((data || []) as PreBillDocument[]).map(doc => ({ ...doc, or_prebill_items: [...(doc.or_prebill_items || [])].sort((a, b) => a.sort_order - b.sort_order) })))
    setLoading(false)
  }, [dateFrom, dateTo, documentType, ownerFilter, user?.role])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!['superadmin', 'sales-tr'].includes(user?.role || '')) return
    let query = supabase.from('us_users').select('id, username, seller_name, email').eq('is_active', true).order('username')
    query = user?.role === 'sales-tr' ? query.eq('role', 'sales-tr') : query.in('role', ['sales-tr','sales-pump','superadmin'])
    query.then(({ data }) => setUsers((data || []) as typeof users))
  }, [user?.role])
  useEffect(() => {
    const channel = supabase.channel(`prebill-workspace-${documentType}`).on('postgres_changes', { event: '*', schema: 'public', table: 'or_prebill_documents' }, () => load()).subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [documentType, load])

  const counts = useMemo(() => ({
    mine: documents.filter(d => d.valid_until >= today() && ['draft','active','rejected'].includes(d.status)).length,
    pending: documents.filter(d => d.valid_until >= today() && d.status === 'pending_discount').length,
    approved: documents.filter(d => d.valid_until >= today() && d.status === 'approved').length,
    converted: documents.filter(d => d.status === 'converted').length,
    expired: documents.filter(d => d.valid_until < today() && !['converted','cancelled'].includes(d.status)).length,
    cancelled: documents.filter(d => d.status === 'cancelled').length,
  }), [documents])

  const filtered = useMemo(() => documents.filter(doc => {
    const isExpired = doc.valid_until < today() && !['converted','cancelled'].includes(doc.status)
    if (view === 'expired' && !isExpired) return false
    if (view !== 'expired' && isExpired) return false
    if (view === 'mine' && !['draft','active','rejected'].includes(doc.status)) return false
    if (view === 'pending' && doc.status !== 'pending_discount') return false
    if (view === 'approved' && doc.status !== 'approved') return false
    if (view === 'converted' && doc.status !== 'converted') return false
    if (view === 'cancelled' && doc.status !== 'cancelled') return false
    if (view !== 'cancelled' && doc.status === 'cancelled') return false
    const q = search.trim().toLowerCase()
    return !q || [doc.document_no, doc.customer_name, doc.channel_code, doc.owner_name, ...(doc.or_prebill_items || []).map(i => i.product_name)].some(v => String(v || '').toLowerCase().includes(q))
  }), [documents, search, view])
  const visibleCancelledIds = useMemo(
    () => filtered.filter(doc => doc.status === 'cancelled').map(doc => doc.id),
    [filtered],
  )
  const selectedVisibleCancelledIds = selectedCancelledIds.filter(id => visibleCancelledIds.includes(id))
  const allVisibleCancelledSelected = visibleCancelledIds.length > 0
    && visibleCancelledIds.every(id => selectedVisibleCancelledIds.includes(id))

  function toggleAllVisibleCancelled() {
    setSelectedCancelledIds(current => allVisibleCancelledSelected
      ? current.filter(id => !visibleCancelledIds.includes(id))
      : Array.from(new Set([...current, ...visibleCancelledIds])))
  }

  async function reviewDiscount() {
    if (!reviewing) return
    const { error } = await supabase.rpc('rpc_review_prebill_discount', {
      p_document_id: reviewing.id, p_approve: review.approve,
      p_approved_discount: review.approve ? Number(review.amount || reviewing.special_discount) : 0,
      p_note: review.note || null,
    })
    if (error) { setMessage(error.message); return }
    setReviewing(null); setReview({ approve: true, amount: '', note: '' }); await load()
  }

  async function cancelDocument() {
    if (!cancelling || deleteBusy) return
    setDeleteBusy(true); setMessage('')
    const { error } = await supabase.rpc('rpc_cancel_prebill_document', { p_document_id: cancelling.id })
    setDeleteBusy(false)
    if (error) { setMessage(error.message); setCancelling(null); return }
    setCancelling(null)
    await load()
  }

  async function deleteSelectedCancelled() {
    if (user?.role !== 'superadmin' || selectedVisibleCancelledIds.length === 0 || deleteBusy) return
    setDeleteBusy(true); setMessage('')
    const { error } = await supabase.rpc('rpc_delete_cancelled_prebill_documents', { p_document_ids: selectedVisibleCancelledIds })
    setDeleteBusy(false)
    if (error) { setMessage(error.message); setDeleteConfirmOpen(false); return }
    setSelectedCancelledIds([]); setDeleteConfirmOpen(false)
    await load()
  }

  if (editing || renewing) return <PreBillForm
    documentType={renewing?.document_type || (editing !== 'new' && editing ? editing.document_type : documentType)}
    document={editing === 'new' ? null : editing}
    sourceDocument={renewing}
    onSaved={() => { setEditing(null); setRenewing(null); void load() }}
    onCancel={() => { setEditing(null); setRenewing(null) }}
    onOpenBill={onOpenBill}
  />

  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-2xl bg-white p-2 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {(['quotation','production_confirmation'] as PreBillDocumentType[]).map(type => <button key={type} onClick={() => { setDocumentType(type); setView('mine') }} className={`rounded-xl px-5 py-3 font-bold ${documentType === type ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{PREBILL_TYPE_LABEL[type]}</button>)}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {([
            ['mine', `${['superadmin', 'sales-tr'].includes(user?.role || '') ? 'รายการทั้งหมด' : 'รายการของฉัน'} (${counts.mine})`], ['pending', `รออนุมัติส่วนลด (${counts.pending})`],
            ['approved', `อนุมัติแล้ว (${counts.approved})`], ['converted', `เปิดบิลแล้ว (${counts.converted})`], ['expired', `หมดอายุ (${counts.expired})`],
            ['cancelled', `ยกเลิก (${counts.cancelled})`],
          ] as [View,string][]).map(([key,label]) => <button key={key} onClick={() => setView(key)} className={`rounded-xl border px-4 py-2 text-sm font-bold ${view === key ? 'border-blue-600 bg-blue-50 text-blue-700' : 'bg-white text-slate-600'}`}>{label}</button>)}
        </div>
        <button onClick={() => setEditing('new')} className="rounded-xl bg-blue-600 px-5 py-2.5 font-bold text-white">+ สร้าง{PREBILL_TYPE_LABEL[documentType]}</button>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-2xl bg-white p-4 shadow-sm md:grid-cols-2 lg:grid-cols-5">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาเลขเอกสาร ลูกค้า สินค้า..." className="rounded-xl border p-2.5 lg:col-span-2" />
        {['superadmin', 'sales-tr'].includes(user?.role || '') && <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} className="rounded-xl border p-2.5 bg-white"><option value="">ผู้เปิดเอกสารทั้งหมด</option>{users.map(u => <option key={u.id} value={u.id}>{u.seller_name || u.username || u.email}</option>)}</select>}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="rounded-xl border p-2.5" />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="rounded-xl border p-2.5" />
      </div>

      {message && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700">{message}</div>}
      {view === 'cancelled' && user?.role === 'superadmin' && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 p-4">
          <span className="text-sm font-semibold text-red-800">เลือกแล้ว {selectedVisibleCancelledIds.length} รายการ</span>
          <button
            disabled={selectedVisibleCancelledIds.length === 0 || deleteBusy}
            onClick={() => setDeleteConfirmOpen(true)}
            className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50"
          >ลบถาวร</button>
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm">
        <table className="w-full min-w-[1050px] text-sm">
          <thead><tr className="bg-slate-100 text-left">
            {view === 'cancelled' && user?.role === 'superadmin' && <th className="w-12 p-3 text-center"><input type="checkbox" aria-label="เลือกเอกสารที่ยกเลิกทั้งหมด" checked={allVisibleCancelledSelected} onChange={toggleAllVisibleCancelled} /></th>}
            <th className="p-3">เลขเอกสาร</th><th className="p-3">วันที่</th><th className="p-3">ผู้เปิดเอกสาร</th><th className="p-3">ลูกค้า</th><th className="p-3">ช่องทาง</th><th className="p-3 text-right">ยอดสุทธิ</th><th className="p-3">ยืนราคาถึง</th><th className="p-3">สถานะ</th><th className="p-3">จัดการ</th>
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={view === 'cancelled' && user?.role === 'superadmin' ? 10 : 9} className="p-10 text-center text-slate-500">กำลังโหลด...</td></tr> : filtered.length === 0 ? <tr><td colSpan={view === 'cancelled' && user?.role === 'superadmin' ? 10 : 9} className="p-10 text-center text-slate-500">ไม่พบเอกสาร</td></tr> : filtered.map(doc => {
              const displayStatus = doc.valid_until < today() && !['converted','cancelled'].includes(doc.status) ? 'expired' : doc.status
              const canCancel = !['converted','cancelled'].includes(doc.status)
              const selected = selectedCancelledIds.includes(doc.id)
              return <tr key={doc.id} className="border-t hover:bg-slate-50">
                {view === 'cancelled' && user?.role === 'superadmin' && <td className="p-3 text-center"><input type="checkbox" aria-label={`เลือก ${doc.document_no}`} checked={selected} onChange={() => setSelectedCancelledIds(current => selected ? current.filter(id => id !== doc.id) : [...current, doc.id])} /></td>}
                <td className="p-3 font-bold text-blue-700">{doc.document_no}</td><td className="p-3">{new Date(doc.created_at).toLocaleDateString('th-TH')}</td><td className="p-3">{doc.owner_name}</td><td className="p-3"><div className="font-semibold">{doc.customer_name}</div><div className="text-xs text-slate-500">{doc.or_prebill_items?.length || 0} รายการ</div></td><td className="p-3">{doc.channel_code}</td><td className="p-3 text-right font-bold">{money(doc.total_amount)}</td><td className="p-3">{new Date(`${doc.valid_until}T00:00:00`).toLocaleDateString('th-TH')}</td><td className="p-3"><span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass[displayStatus]}`}>{PREBILL_STATUS_LABEL[displayStatus as keyof typeof PREBILL_STATUS_LABEL]}</span>{doc.status === 'converted' && <div className="mt-1.5 whitespace-nowrap text-xs font-bold text-violet-700">เลขบิล: {doc.converted_order?.bill_no ? <button type="button" onClick={() => onViewConvertedOrder(doc)} className="underline decoration-violet-300 underline-offset-2 hover:text-violet-900 hover:decoration-violet-700" title="ดูรายละเอียดบิล">{doc.converted_order.bill_no}</button> : '-'}</div>}</td><td className="p-3"><div className="flex flex-wrap gap-2"><button onClick={() => setEditing(doc)} className="rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700">{['converted','cancelled'].includes(doc.status) ? 'ดู' : 'แก้ไข'}</button>{displayStatus === 'expired' && <button onClick={() => setRenewing(doc)} className="rounded-lg bg-orange-500 px-3 py-1.5 font-semibold text-white hover:bg-orange-600">สร้างใหม่</button>}{user?.role === 'superadmin' && doc.status === 'pending_discount' && <button onClick={() => { setReviewing(doc); setReview({ approve: true, amount: String(doc.special_discount), note: '' }) }} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700">อนุมัติ</button>}{!['converted','cancelled'].includes(doc.status) && displayStatus !== 'expired' && ['active','approved'].includes(doc.status) && <button onClick={() => onOpenBill(doc)} className="rounded-lg bg-violet-600 px-3 py-1.5 font-semibold text-white hover:bg-violet-700">เปิดบิล</button>}{canCancel && <button onClick={() => setCancelling(doc)} className="rounded-lg bg-orange-600 px-3 py-1.5 font-semibold text-white hover:bg-orange-700">ยกเลิก</button>}</div></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>

      {reviewing && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><div className="w-full max-w-lg rounded-2xl bg-white p-6"><h3 className="text-xl font-bold">พิจารณาส่วนลด {reviewing.document_no}</h3><div className="mt-3 rounded-xl bg-amber-50 p-3"><div>ผู้ขอ: {reviewing.owner_name}</div><div>ขอส่วนลด: <b>{money(reviewing.special_discount)} บาท</b></div><div>หมายเหตุ: {reviewing.discount_request_note || '-'}</div></div><div className="mt-4 flex gap-3"><label><input type="radio" checked={review.approve} onChange={() => setReview(v => ({ ...v, approve: true }))} /> อนุมัติ</label><label><input type="radio" checked={!review.approve} onChange={() => setReview(v => ({ ...v, approve: false }))} /> ไม่อนุมัติ</label></div>{review.approve && <label className="mt-3 block text-sm font-semibold">จำนวนที่อนุมัติ<input type="number" min="0" value={review.amount} onChange={e => setReview(v => ({ ...v, amount: e.target.value }))} className="mt-1 w-full rounded-xl border p-2.5" /></label>}<textarea value={review.note} onChange={e => setReview(v => ({ ...v, note: e.target.value }))} placeholder="หมายเหตุผู้อนุมัติ" rows={3} className="mt-3 w-full rounded-xl border p-3" /><div className="mt-4 flex justify-end gap-2"><button onClick={() => setReviewing(null)} className="rounded-xl border px-4 py-2">ยกเลิก</button><button onClick={reviewDiscount} className={`rounded-xl px-4 py-2 font-bold text-white ${review.approve ? 'bg-emerald-600' : 'bg-red-600'}`}>ยืนยัน</button></div></div></div>}
      {cancelling && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h3 className="text-xl font-bold text-slate-900">ยืนยันการยกเลิกเอกสาร</h3><p className="mt-3 text-slate-600">ต้องการยกเลิก <b>{cancelling.document_no}</b> ของลูกค้า <b>{cancelling.customer_name}</b> ใช่หรือไม่?</p><p className="mt-2 text-sm text-orange-700">เอกสารจะย้ายไปแถบยกเลิกและไม่สามารถแก้ไขหรือเปิดบิลได้</p><div className="mt-5 flex justify-end gap-2"><button disabled={deleteBusy} onClick={() => setCancelling(null)} className="rounded-xl border px-4 py-2 font-semibold disabled:opacity-50">กลับ</button><button disabled={deleteBusy} onClick={cancelDocument} className="rounded-xl bg-orange-600 px-4 py-2 font-bold text-white hover:bg-orange-700 disabled:opacity-50">{deleteBusy ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิก'}</button></div></div></div>}
      {deleteConfirmOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h3 className="text-xl font-bold text-red-700">ยืนยันการลบถาวร</h3><p className="mt-3 text-slate-600">ต้องการลบเอกสารที่เลือก <b>{selectedVisibleCancelledIds.length} รายการ</b> ออกจากฐานข้อมูลใช่หรือไม่?</p><p className="mt-2 text-sm font-semibold text-red-600">เมื่อลบแล้วจะไม่สามารถเรียกคืนได้</p><div className="mt-5 flex justify-end gap-2"><button disabled={deleteBusy} onClick={() => setDeleteConfirmOpen(false)} className="rounded-xl border px-4 py-2 font-semibold disabled:opacity-50">กลับ</button><button disabled={deleteBusy || selectedVisibleCancelledIds.length === 0} onClick={deleteSelectedCancelled} className="rounded-xl bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50">{deleteBusy ? 'กำลังลบ...' : 'ลบถาวร'}</button></div></div></div>}
    </div>
  )
}
