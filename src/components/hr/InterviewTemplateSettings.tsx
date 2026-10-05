import { useEffect, useState } from 'react'
import type { HRDepartment, HRPosition } from '../../types'
import { assignInterviewTemplate, inheritDepartmentInterviewTemplate, interviewTemplateDisplayName, loadInterviewTemplateLibrary, resolveInterviewTemplate, saveNamedInterviewTemplate, type InterviewCriterion, type InterviewTemplate, type InterviewTemplateAssignment } from '../../lib/hrInterviewTemplates'

export default function InterviewTemplateSettings({ departments, positions }: { departments: HRDepartment[]; positions: HRPosition[] }) {
  const [department, setDepartment] = useState('')
  const [position, setPosition] = useState('')
  const [templates, setTemplates] = useState<InterviewTemplate[]>([])
  const [assignments, setAssignments] = useState<InterviewTemplateAssignment[]>([])
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [criteria, setCriteria] = useState<InterviewCriterion[]>([{ name: '', max_score: 10 }])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const reload = async () => { const library = await loadInterviewTemplateLibrary(); setTemplates(library.templates); setAssignments(library.assignments); return library }
  useEffect(() => { void reload().catch(e => setError(e.message)) }, [])
  const choose = (id: string) => {
    setSelected(id); const template = templates.find(t => t.id === id)
    setName(template ? interviewTemplateDisplayName(template.name) : ''); setCriteria(template?.criteria.map(c => ({ ...c })) ?? [{ name: '', max_score: 10 }])
  }
  const active = resolveInterviewTemplate(templates, assignments, position, department || positions.find(p => p.id === position)?.department_id)
  const selectedTemplate = templates.find(t => t.id === selected)
  const dirty = !selectedTemplate || name !== interviewTemplateDisplayName(selectedTemplate.name)
    || JSON.stringify(criteria) !== JSON.stringify(selectedTemplate.criteria)
  const describeError = (e: unknown) => e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
  const save = async (copy: boolean) => {
    if (!name.trim() || !criteria.length || criteria.some(c => !c.name.trim() || !Number.isInteger(c.max_score) || c.max_score < 1)) {
      setError('ระบุชื่อ Template และหัวข้อทุกข้อ พร้อมคะแนนเต็มเป็นจำนวนเต็มมากกว่า 0'); return
    }
    setBusy(true); setError(''); setMessage('')
    try {
      const savedName = !copy && selectedTemplate && name === interviewTemplateDisplayName(selectedTemplate.name)
        ? selectedTemplate.name : copy && selectedTemplate && name === interviewTemplateDisplayName(selectedTemplate.name) ? `${name.trim()} (สำเนา)` : name.trim()
      const saved = await saveNamedInterviewTemplate({ ...(selected && !copy ? { id: selected } : {}), name: savedName, criteria: criteria.map(c => ({ ...c, name: c.name.trim() })) })
      await reload(); setSelected(saved.id); setName(interviewTemplateDisplayName(saved.name)); setCriteria(saved.criteria); setMessage('บันทึก Template แล้ว')
    } catch (e) { setError(describeError(e)) } finally { setBusy(false) }
  }
  const apply = async () => {
    if (!selected || (!position && !department)) return
    setBusy(true); setError(''); setMessage('')
    try { await assignInterviewTemplate(selected, position, department); await reload(); setMessage('กำหนด Template แล้ว — ใช้เป็นค่าเริ่มต้นในการให้คะแนนครั้งใหม่') }
    catch (e) { setError(describeError(e)) } finally { setBusy(false) }
  }
  const input = 'w-full border border-surface-300 rounded-lg p-2 bg-white'
  const inherit = async () => {
    setBusy(true); setError('')
    try { await inheritDepartmentInterviewTemplate(position); await reload(); setMessage('ตำแหน่งนี้ใช้ Template ของแผนกแล้ว') }
    catch (e) { setError(describeError(e)) } finally { setBusy(false) }
  }
  return <div className="rounded-xl border border-surface-200 bg-white p-5 space-y-5">
    <div><h3 className="font-semibold text-lg">Template เกณฑ์คะแนนสัมภาษณ์</h3><p className="text-sm text-gray-500 mt-1">ตำแหน่งใช้ Template ของตำแหน่งก่อน หากไม่ได้กำหนดจะใช้ของแผนก คะแนนที่บันทึกแล้วคงหัวข้อเดิม</p></div>
    {error && <p className="bg-red-50 text-red-700 p-3 rounded-lg">{error}</p>}{message && <p className="bg-emerald-50 text-emerald-700 p-3 rounded-lg">{message}</p>}
    <div className="grid md:grid-cols-2 gap-4">
      <label>กรองแผนก<select className={input} value={department} onChange={e => { setDepartment(e.target.value); setPosition('') }}><option value="">ทุกแผนก</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>ตำแหน่ง<select className={input} value={position} onChange={e => setPosition(e.target.value)}><option value="">ทุกตำแหน่ง / กำหนดให้ทั้งแผนก</option>{positions.filter(p => !department || p.department_id === department).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap gap-3 items-center text-sm"><span>Template ที่ใช้อยู่: <strong>{active ? interviewTemplateDisplayName(active.name) : 'ยังไม่ได้กำหนด'}</strong></span>{active && <button onClick={() => choose(active.id)} className="text-blue-700 underline">เปิด Template นี้</button>}{position && <button disabled={busy} onClick={() => void inherit()} className="text-blue-700 underline">ใช้ Template ของแผนก</button>}</div>
    <div className="grid md:grid-cols-2 gap-4">
      <label>เลือก Template<select className={input} value={selected} onChange={e => choose(e.target.value)}><option value="">สร้าง Template ใหม่</option>{templates.map(t => <option key={t.id} value={t.id}>{interviewTemplateDisplayName(t.name)}</option>)}</select></label>
      <label>ชื่อ Template<input className={input} value={name} onChange={e => setName(e.target.value)} placeholder="เช่น สัมภาษณ์เจ้าหน้าที่คลังสินค้า" /></label>
    </div>
    <p className="text-sm text-gray-500">ชุดมาตรฐานเป็นจุดเริ่มต้นสำหรับสัมภาษณ์ ปรับหัวข้อและน้ำหนักให้ตรงงานจริงก่อนใช้ การแก้ Template ที่ใช้ร่วมกันมีผลกับทุกแผนก/ตำแหน่งที่เลือกชุดนี้</p>
    <div className="max-w-4xl space-y-3">{criteria.map((c, index) => <div key={index} className="flex gap-3 items-start">
      <span className="pt-3 text-gray-400">{index + 1}</span><label className="flex-1 min-w-0 text-sm">หัวข้อเกณฑ์<textarea className={`${input} min-h-20`} value={c.name} onChange={e => setCriteria(rows => rows.map((row, i) => i === index ? { ...row, name: e.target.value } : row))} /></label>
      <label className="w-24 shrink-0 text-sm">คะแนนเต็ม<input className={input} type="number" min={1} step={1} value={c.max_score} onChange={e => setCriteria(rows => rows.map((row, i) => i === index ? { ...row, max_score: Number(e.target.value) } : row))} /></label>
      <button className="mt-6 text-red-600 p-2" onClick={() => setCriteria(rows => rows.filter((_, i) => i !== index))}>ลบ</button>
    </div>)}</div>
    <div className="flex flex-wrap gap-3 items-center"><button className="border rounded-lg p-2" onClick={() => setCriteria(rows => [...rows, { name: '', max_score: 10 }])}>+ เพิ่มหัวข้อ</button><strong>คะแนนเต็มรวม {criteria.reduce((sum, c) => sum + c.max_score, 0)}</strong></div>
    {dirty && <p className="text-sm text-amber-700">บันทึก Template ก่อนเลือกใช้กับแผนกหรือตำแหน่ง</p>}
    <div className="flex flex-wrap gap-3"><button disabled={busy} onClick={() => void save(false)} className="bg-emerald-600 text-white rounded-lg px-4 py-2 disabled:opacity-50">บันทึก Template</button>{selected && <button disabled={busy} onClick={() => void save(true)} className="border rounded-lg px-4 py-2">บันทึกเป็นชุดใหม่</button>}<button disabled={busy || dirty || !selected || (!department && !position)} onClick={() => void apply()} className="bg-blue-600 text-white rounded-lg px-4 py-2 disabled:opacity-50">ใช้กับ{position ? 'ตำแหน่งนี้' : 'แผนกนี้'}</button></div>
  </div>
}
