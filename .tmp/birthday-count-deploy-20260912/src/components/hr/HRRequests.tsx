import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiEye, FiFileText, FiPaperclip, FiSearch } from 'react-icons/fi'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchAllHRRequests, formatHRRequestDuration, HR_REQUEST_STATUS, openRequestAttachment, type HRRequest, type HRRequestStatus } from '../../lib/hrRequests'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'

const NEXT_STATUSES: HRRequestStatus[] = ['more_info', 'approved_waiting', 'in_progress', 'resolved', 'cannot_resolve', 'rejected']

export default function HRRequests() {
  const { user } = useAuthContext()
  const [items, setItems] = useState<HRRequest[]>([])
  const [selected, setSelected] = useState<HRRequest | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [activeTab, setActiveTab] = useState<'new' | 'all'>('new')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setError(''); setItems(await fetchAllHRRequests()) }
    catch (e) { setError(e instanceof Error ? e.message : 'โหลดคำร้องไม่สำเร็จ') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const channel = supabase.channel('hr-requests-admin').on('postgres_changes', { event: '*', schema: 'public', table: 'hr_requests' }, load).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const filtered = useMemo(() => items.filter((item) => {
    if (activeTab === 'new' && item.status !== 'submitted') return false
    if (filter && item.status !== filter) return false
    const q = search.trim().toLowerCase()
    if (!q) return true
    const employee = item.employee ? `${item.employee.first_name} ${item.employee.last_name} ${item.employee.nickname || ''} ${item.employee.employee_code} ${item.employee.department?.name || ''} ${item.employee.position?.name || ''}` : ''
    return `${item.problem_title} ${item.details} ${employee}`.toLowerCase().includes(q)
  }), [items, activeTab, filter, search])

  const newCount = useMemo(() => items.filter((item) => item.status === 'submitted').length, [items])

  function open(item: HRRequest) { setSelected(item); setNote(item.hr_note || '') }
  async function changeStatus(status: HRRequestStatus) {
    if (!selected || !user?.id) return
    setSaving(true)
    try {
      const patch: Record<string, unknown> = { status, hr_note: note.trim() || null, updated_by: user.id }
      if (status === 'accepted') { patch.received_by = user.id; patch.received_at = new Date().toISOString() }
      const { error: updateError } = await supabase.from('hr_requests').update(patch).eq('id', selected.id)
      if (updateError) throw updateError
      window.dispatchEvent(new CustomEvent('hr-requests-changed'))
      setSelected(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'อัปเดตสถานะไม่สำเร็จ') }
    finally { setSaving(false) }
  }

  const employeeName = (item: HRRequest) => item.employee
    ? `${item.employee.first_name} ${item.employee.last_name}${item.employee.nickname ? ` (${item.employee.nickname})` : ''}`
    : 'ไม่พบข้อมูลพนักงาน'

  return <div className="space-y-5">
    <div><h1 className="flex items-center gap-2 text-2xl font-bold text-slate-800"><FiFileText className="text-emerald-600" /> คำร้อง</h1><p className="mt-1 text-sm text-slate-500">รับเรื่องและติดตามข้อเสนอแนะจากพนักงาน</p></div>
    {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="flex gap-1 rounded-xl border bg-white p-1.5 shadow-sm">
      <button type="button" onClick={() => { setActiveTab('new'); setFilter('') }} className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === 'new' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}>คำร้องใหม่{newCount > 0 && <span className={`min-w-5 rounded-full px-1.5 py-0.5 text-xs font-bold ${activeTab === 'new' ? 'bg-white text-emerald-700' : 'bg-orange-500 text-white'}`}>{newCount > 99 ? '99+' : newCount}</span>}</button>
      <button type="button" onClick={() => { setActiveTab('all'); setFilter('') }} className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === 'all' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}>รายการคำร้อง</button>
    </div>
    <div className="flex flex-wrap gap-3 rounded-xl border bg-white p-4 shadow-sm">
      <div className="relative min-w-64 flex-1"><FiSearch className="absolute left-3 top-3 text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาหัวข้อหรือพนักงาน" className="w-full rounded-lg border py-2.5 pl-9 pr-3 text-sm" /></div>
      {activeTab === 'all' && <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border px-3 py-2 text-sm"><option value="">ทุกสถานะ</option>{Object.entries(HR_REQUEST_STATUS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select>}
    </div>
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
      {loading ? <p className="p-10 text-center text-slate-500">กำลังโหลด…</p> : filtered.length === 0 ? <p className="p-10 text-center text-slate-500">ไม่พบคำร้อง</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-3">วันที่</th><th className="p-3">ผู้ส่ง</th><th className="p-3">แผนก</th><th className="p-3">ตำแหน่งงาน</th><th className="p-3">หัวข้อปัญหา</th><th className="p-3">เวลาที่เสีย</th><th className="p-3">สถานะ</th><th className="p-3 text-center">ดู</th></tr></thead><tbody className="divide-y">{filtered.map((item) => { const status = HR_REQUEST_STATUS[item.status]; return <tr key={item.id} className="hover:bg-slate-50"><td className="whitespace-nowrap p-3">{new Date(item.created_at).toLocaleDateString('th-TH')}</td><td className="p-3">{employeeName(item)}</td><td className="p-3">{item.employee?.department?.name || '-'}</td><td className="p-3">{item.employee?.position?.name || '-'}</td><td className="max-w-md p-3 font-medium">{item.problem_title}</td><td className="whitespace-nowrap p-3">{formatHRRequestDuration(item.time_lost)}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${status.color}`}>{status.label}</span></td><td className="p-3 text-center"><button onClick={() => open(item)} className="rounded-lg p-2 text-blue-600 hover:bg-blue-50"><FiEye /></button></td></tr>})}</tbody></table></div>}
    </div>
    {selected && <Modal open onClose={() => setSelected(null)} contentClassName="max-w-5xl">
      <div className="flex items-center border-b px-5 py-4 pr-16"><h2 className="text-lg font-bold">รายละเอียดคำร้อง</h2></div>
      <div className="space-y-4 p-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-slate-500">ผู้ส่ง</p><p className="font-semibold">{employeeName(selected)}</p><p className="mt-1 text-xs text-slate-500">แผนก: {selected.employee?.department?.name || '-'} · ตำแหน่งงาน: {selected.employee?.position?.name || '-'}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${HR_REQUEST_STATUS[selected.status].color}`}>{HR_REQUEST_STATUS[selected.status].label}</span></div>
        <Detail label="ชื่อหัวข้อปัญหา" value={selected.problem_title} /><Detail label="การเสียเวลากับปัญหานี้" value={formatHRRequestDuration(selected.time_lost)} /><Detail label="รายละเอียดปัญหา" value={selected.details} /><Detail label="แนวทางที่แนะนำ" value={selected.suggested_solution} /><Detail label="ถ้างานนี้หายไป จะนำเวลาไปทำเรื่องไหนแทน" value={selected.time_reallocation} />
        {(selected.attachments || []).length > 0 && <div><p className="mb-2 font-semibold">ไฟล์แนบ</p><div className="flex flex-wrap gap-2">{selected.attachments.map((a) => <button key={a.path} onClick={() => openRequestAttachment(a.path)} className="flex items-center gap-1 rounded-lg bg-slate-100 px-3 py-2 text-blue-700"><FiPaperclip />{a.name}</button>)}</div></div>}
        <label className="block font-semibold">บันทึก/ข้อความถึงผู้ส่ง<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border p-3 font-normal" placeholder="ระบุข้อมูลเพิ่มเติมหรือเหตุผล (ถ้ามี)" /></label>
        {selected.status === 'submitted' ? <button disabled={saving} onClick={() => changeStatus('accepted')} className="w-full rounded-lg bg-blue-600 py-2.5 font-bold text-white disabled:opacity-50">รับเรื่อง</button> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{NEXT_STATUSES.map((status) => <button key={status} disabled={saving || selected.status === status} onClick={() => changeStatus(status)} className="rounded-lg border border-slate-300 px-3 py-2 font-semibold hover:bg-slate-50 disabled:opacity-40">{HR_REQUEST_STATUS[status].label}</button>)}</div>}
      </div>
    </Modal>}
  </div>
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-slate-50 p-3"><p className="mb-1 text-xs font-semibold text-slate-500">{label}</p><p className="whitespace-pre-wrap text-slate-800">{value}</p></div>
}
