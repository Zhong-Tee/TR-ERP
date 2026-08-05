import { useCallback, useEffect, useRef, useState } from 'react'
import { FiEdit3, FiFileText, FiList, FiPaperclip, FiSend } from 'react-icons/fi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { fetchEmployeeByUserId } from '../../../lib/hrApi'
import { fetchMyHRRequests, formatHRRequestDuration, HR_REQUEST_STATUS, openRequestAttachment, uploadRequestFile, type HRRequest } from '../../../lib/hrRequests'
import { supabase } from '../../../lib/supabase'
import Modal from '../../ui/Modal'

const EMPTY = { problem_title: '', time_lost: '00:00:00', details: '', suggested_solution: '', time_reallocation: '' }

function durationParts(value: string): [number, number, number] {
  const [days, hours, minutes] = value.split(':').map((part) => Number(part) || 0)
  return [days, hours, minutes]
}

function formatDuration(days: number, hours: number, minutes: number) {
  return [Math.max(0, days), Math.min(23, Math.max(0, hours)), Math.min(59, Math.max(0, minutes))]
    .map((part) => String(Math.floor(part)).padStart(2, '0'))
    .join(':')
}

export default function EmployeeRequests() {
  const { user } = useAuthContext()
  const [form, setForm] = useState(EMPTY)
  const [files, setFiles] = useState<File[]>([])
  const [items, setItems] = useState<HRRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [activeView, setActiveView] = useState<'write' | 'list'>('write')
  const [selectedRequest, setSelectedRequest] = useState<HRRequest | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try { setItems(await fetchMyHRRequests()) }
    catch (e) { setMessage(e instanceof Error ? e.message : 'โหลดคำร้องไม่สำเร็จ') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!user?.id) return
    if (form.time_lost === '00:00:00') {
      setMessage('กรุณาระบุเวลาที่เสียไปกับปัญหานี้')
      return
    }
    setSaving(true); setMessage('')
    const requestId = crypto.randomUUID()
    const uploaded: Awaited<ReturnType<typeof uploadRequestFile>>[] = []
    try {
      const employee = await fetchEmployeeByUserId(user.id)
      for (const file of files) uploaded.push(await uploadRequestFile(user.id, requestId, file))
      const { error } = await supabase.from('hr_requests').insert({
        id: requestId, created_by_user: user.id, employee_id: employee?.id || null,
        ...form, attachments: uploaded,
      })
      if (error) throw error
      setForm(EMPTY); setFiles([]); if (fileRef.current) fileRef.current.value = ''
      setMessage('ส่งคำร้องเรียบร้อยแล้ว')
      await load()
      setActiveView('list')
    } catch (e) {
      for (const file of uploaded) await supabase.storage.from('hr-requests').remove([file.path]).catch(() => {})
      setMessage(e instanceof Error ? e.message : 'ส่งคำร้องไม่สำเร็จ')
    } finally { setSaving(false) }
  }

  const field = (key: keyof typeof EMPTY, label: string, rows = 1) => (
    <label className="block text-xs font-medium text-gray-600">{label}
      {rows > 1
        ? <textarea rows={rows} required value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" />
        : <input required value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm" />}
    </label>
  )

  const [lostDays, lostHours, lostMinutes] = durationParts(form.time_lost)
  const updateDuration = (index: 0 | 1 | 2, raw: string) => {
    const parts: [number, number, number] = [lostDays, lostHours, lostMinutes]
    parts[index] = Math.max(0, Number(raw) || 0)
    setForm((current) => ({ ...current, time_lost: formatDuration(...parts) }))
  }

  return <div className="space-y-4">
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-lg font-bold"><FiFileText className="text-emerald-600" /> คำร้อง</h2>
      <p className="mt-1 text-xs text-gray-500">เสนอปัญหาและแนวทางปรับปรุงบริษัท</p>
      <div className="mt-4 grid grid-cols-2 rounded-xl bg-gray-100 p-1">
        <button type="button" onClick={() => { setActiveView('write'); setMessage('') }} className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-sm font-semibold transition-colors ${activeView === 'write' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500'}`}><FiEdit3 />เขียนคำร้อง</button>
        <button type="button" onClick={() => { setActiveView('list'); setMessage('') }} className={`relative flex items-center justify-center gap-1.5 rounded-lg px-2 py-2.5 text-sm font-semibold transition-colors ${activeView === 'list' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500'}`}><FiList />รายการคำร้อง{items.length > 0 && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">{items.length}</span>}</button>
      </div>
      {message && <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</div>}
      {activeView === 'write' && (
      <form onSubmit={submit} className="mt-4 space-y-3">
        {field('problem_title', 'ชื่อหัวข้อปัญหา')}
        <fieldset>
          <legend className="text-xs font-medium text-gray-600">การเสียเวลากับปัญหานี้</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            <label className="text-center text-[11px] text-gray-500"><input type="number" min="0" value={lostDays} onFocus={(e) => e.currentTarget.select()} onChange={(e) => updateDuration(0, e.target.value)} className="mb-1 w-full rounded-xl border border-gray-200 px-2 py-2.5 text-center text-sm" />วัน (DD)</label>
            <label className="text-center text-[11px] text-gray-500"><input type="number" min="0" max="23" value={lostHours} onFocus={(e) => e.currentTarget.select()} onChange={(e) => updateDuration(1, e.target.value)} className="mb-1 w-full rounded-xl border border-gray-200 px-2 py-2.5 text-center text-sm" />ชั่วโมง (HH)</label>
            <label className="text-center text-[11px] text-gray-500"><input type="number" min="0" max="59" value={lostMinutes} onFocus={(e) => e.currentTarget.select()} onChange={(e) => updateDuration(2, e.target.value)} className="mb-1 w-full rounded-xl border border-gray-200 px-2 py-2.5 text-center text-sm" />นาที (MM)</label>
          </div>
          <p className="mt-1 text-right font-mono text-xs font-semibold text-emerald-700">เวลา {form.time_lost}</p>
        </fieldset>
        {field('details', 'รายละเอียดปัญหา', 5)}
        {field('suggested_solution', 'แนวทางที่แนะนำ', 4)}
        {field('time_reallocation', 'ถ้างานนี้หายไป จะนำเวลาไปทำเรื่องไหนแทน', 3)}
        <label className="block text-xs font-medium text-gray-600">รูปแนบ / ไฟล์แนบ
          <input ref={fileRef} type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} className="mt-1 block w-full text-sm" />
          {files.length > 0 && <span className="mt-1 block text-xs text-gray-500">เลือกแล้ว {files.length} ไฟล์</span>}
        </label>
        <button disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white disabled:opacity-50"><FiSend />{saving ? 'กำลังส่ง…' : 'ส่งคำร้อง'}</button>
      </form>
      )}
    </section>
    {activeView === 'list' && <section><h3 className="mb-2 font-bold">รายการคำร้องของฉัน</h3>
      {loading ? <p className="text-center text-sm text-gray-500">กำลังโหลด…</p> : <div className="space-y-3">{items.length === 0 ? <div className="rounded-2xl bg-white p-5 text-center text-sm text-gray-500">ยังไม่มีคำร้อง</div> : items.map((item) => {
        const status = HR_REQUEST_STATUS[item.status]
        return <article key={item.id} role="button" tabIndex={0} onClick={() => setSelectedRequest(item)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedRequest(item) }} className="cursor-pointer rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition-colors active:bg-gray-50">
          <div className="flex items-start justify-between gap-2"><h4 className="font-semibold text-gray-900">{item.problem_title}</h4><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${status.color}`}>{status.label}</span></div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{item.details}</p>
          {item.hr_note && <p className="mt-2 rounded-lg bg-blue-50 p-2 text-xs text-blue-700">ข้อความจากผู้รับเรื่อง: {item.hr_note}</p>}
          <div className="mt-2 flex flex-wrap gap-2">{(item.attachments || []).map((a) => <button key={a.path} onClick={(e) => { e.stopPropagation(); openRequestAttachment(a.path) }} className="flex items-center gap-1 text-xs text-emerald-700"><FiPaperclip />{a.name}</button>)}</div>
          <p className="mt-2 text-[11px] text-gray-400">{new Date(item.created_at).toLocaleString('th-TH')}</p>
        </article>
      })}</div>}
    </section>}
    {selectedRequest && <Modal open onClose={() => setSelectedRequest(null)} closeOnBackdropClick contentClassName="max-w-md">
      <div className="flex items-center justify-between border-b px-4 py-3"><h3 className="font-bold text-gray-900">รายละเอียดคำร้อง</h3><button type="button" onClick={() => setSelectedRequest(null)} className="p-1 text-2xl leading-none text-gray-400">×</button></div>
      <div className="space-y-3 overflow-y-auto p-4 text-sm">
        <div className="flex items-start justify-between gap-2"><h4 className="text-base font-bold text-gray-900">{selectedRequest.problem_title}</h4><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${HR_REQUEST_STATUS[selectedRequest.status].color}`}>{HR_REQUEST_STATUS[selectedRequest.status].label}</span></div>
        <RequestDetail label="การเสียเวลากับปัญหานี้" value={formatHRRequestDuration(selectedRequest.time_lost)} mono />
        <RequestDetail label="รายละเอียดปัญหา" value={selectedRequest.details} />
        <RequestDetail label="แนวทางที่แนะนำ" value={selectedRequest.suggested_solution} />
        <RequestDetail label="ถ้างานนี้หายไป จะนำเวลาไปทำเรื่องไหนแทน" value={selectedRequest.time_reallocation} />
        {selectedRequest.hr_note && <div className="rounded-xl bg-blue-50 p-3"><p className="text-xs font-semibold text-blue-600">ข้อความจากผู้รับเรื่อง</p><p className="mt-1 whitespace-pre-wrap text-blue-800">{selectedRequest.hr_note}</p></div>}
        {(selectedRequest.attachments || []).length > 0 && <div><p className="mb-2 text-xs font-semibold text-gray-500">ไฟล์แนบ</p><div className="flex flex-col gap-2">{selectedRequest.attachments.map((a) => <button key={a.path} type="button" onClick={() => openRequestAttachment(a.path)} className="flex items-center gap-2 rounded-xl bg-gray-100 px-3 py-2 text-left text-emerald-700"><FiPaperclip className="shrink-0" /><span className="truncate">{a.name}</span></button>)}</div></div>}
        <p className="text-xs text-gray-400">ส่งเมื่อ {new Date(selectedRequest.created_at).toLocaleString('th-TH')}</p>
      </div>
    </Modal>}
  </div>
}

function RequestDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-xl bg-gray-50 p-3"><p className="text-xs font-semibold text-gray-500">{label}</p><p className={`mt-1 whitespace-pre-wrap text-gray-800 ${mono ? 'font-mono font-semibold' : ''}`}>{value}</p></div>
}
