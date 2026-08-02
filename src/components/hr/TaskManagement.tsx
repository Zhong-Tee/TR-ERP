import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiAlertTriangle, FiBarChart2, FiCheckCircle, FiClock, FiExternalLink, FiList, FiMenu, FiPlus, FiSearch, FiX } from 'react-icons/fi'
import { useAuthContext } from '../../contexts/AuthContext'
import TaskDashboard, { Avatar } from './TaskDashboard'
import { createHRTask, createTaskTeam, fetchEmployeeByUserId, fetchEmployees, fetchTaskCategories, fetchTaskEvaluations, fetchTaskTeams, fetchTasks, saveTaskCategory, saveTaskCategoryOrder, saveTaskEvaluation, updateTaskStatus, updateTaskTeam } from '../../lib/hrApi'
import { recommendAssignees } from '../../lib/hrTaskMetrics'
import type { HREmployee, HRTask, HRTaskCategory, HRTaskEvaluation, HRTaskStatus } from '../../types'

const STATUS: Record<HRTaskStatus, string> = { draft: 'แบบร่าง', new: 'งานใหม่', acknowledged: 'รับทราบแล้ว', in_progress: 'กำลังทำ', review: 'รอตรวจ', revision: 'ขอแก้ไข', completed: 'เสร็จแล้ว', paused: 'พักงาน', cancelled: 'ยกเลิก' }
const ACTIVE = ['new', 'acknowledged', 'in_progress', 'review', 'revision'] as HRTaskStatus[]
const nameOf = (e?: HREmployee) => e ? `${e.first_name} ${e.last_name}${e.nickname ? ` (${e.nickname})` : ''}` : '-'
const overdue = (t: HRTask) => !!t.due_at && ACTIVE.includes(t.status) && new Date(t.due_at) < new Date()
const workLink = (value?: string) => {
  const link = value?.trim()
  if (!link) return ''
  return /^https?:\/\//i.test(link) ? link : `https://${link}`
}
const elapsedText = (t: HRTask) => {
  const start = new Date(t.started_at || t.acknowledged_at || t.created_at).getTime()
  const end = t.completed_at ? new Date(t.completed_at).getTime() : Date.now()
  const minutes = Math.max(0, Math.floor((end - start) / 60000))
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60
  return `${days ? `${days} วัน ` : ''}${hours ? `${hours} ชม. ` : ''}${mins} นาที`
}

export default function TaskManagement() {
  const { user } = useAuthContext()
  const [me, setMe] = useState<HREmployee | null>(null)
  const [tasks, setTasks] = useState<HRTask[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [categories, setCategories] = useState<HRTaskCategory[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [scope, setScope] = useState<'managed' | 'mine' | 'all'>('managed')
  const [view, setView] = useState<'list' | 'dashboard'>('list')
  const [showCreate, setShowCreate] = useState(false)
  const [showCategory, setShowCategory] = useState(false)
  const [showTeam, setShowTeam] = useState(false)
  const [busy] = useState(false)
  const [error, setError] = useState('')
  const [detailTask, setDetailTask] = useState<HRTask | null>(null)
  const [evaluationTask, setEvaluationTask] = useState<HRTask | null>(null)
  const [submitTask, setSubmitTask] = useState<HRTask | null>(null)
  const [, setTimeTick] = useState(0)

  const load = async () => {
    const [taskRows, employeeRows, categoryRows] = await Promise.all([fetchTasks(), fetchEmployees({ status: 'active' }), fetchTaskCategories()])
    setTasks(taskRows); setEmployees(employeeRows); setCategories(categoryRows)
  }
  useEffect(() => { load().catch((e) => setError(e.message)); if (user?.id) fetchEmployeeByUserId(user.id).then((employee)=>{setMe(employee);if(!employee)setScope('all')}).catch(() => setScope('all')) }, [user?.id])
  useEffect(() => { const timer = window.setInterval(() => setTimeTick((n) => n + 1), 60000); return () => window.clearInterval(timer) }, [])

  const isMine = (t: HRTask) => !!me && !!t.participants?.some((p) => p.role === 'assignee' && p.employee_id === me.id)
  const isManaged = (t: HRTask) => !!me && (t.created_by === me.id || !!t.participants?.some((p) => p.role === 'supervisor' && p.employee_id === me.id))
  const scopedTasks = useMemo(() => tasks.filter((t) => scope === 'all' || (scope === 'mine' ? isMine(t) : isManaged(t))), [tasks, scope, me?.id])
  const visible = useMemo(() => scopedTasks.filter((t) => {
    const q = search.trim().toLowerCase()
    const people = t.participants?.map((p) => nameOf(p.employee)).join(' ') ?? ''
    return (!status || t.status === status) && (!q || `${t.task_no} ${t.title} ${t.description ?? ''} ${people}`.toLowerCase().includes(q))
  }), [scopedTasks, search, status])
  const cards = [
    ['ทั้งหมด', scopedTasks.length, 'text-slate-700', FiClock],
    ['กำลังดำเนินการ', scopedTasks.filter((t) => ACTIVE.includes(t.status)).length, 'text-blue-600', FiClock],
    ['รอตรวจ', scopedTasks.filter((t) => t.status === 'review').length, 'text-amber-600', FiAlertTriangle],
    ['เลยกำหนด', scopedTasks.filter(overdue).length, 'text-red-600', FiAlertTriangle],
    ['เสร็จแล้ว', scopedTasks.filter((t) => t.status === 'completed').length, 'text-emerald-600', FiCheckCircle],
  ] as const

  return <div className="space-y-5"><style>{`.input{width:100%;border:1px solid #d1d5db;border-radius:.75rem;padding:.625rem .75rem;background:white}.input:focus{outline:none;border-color:#059669;box-shadow:0 0 0 3px #d1fae5}`}</style>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-gray-900">งาน</h1><p className="text-sm text-gray-500">มอบหมาย ติดตาม และประเมินผลงานของทีม</p></div>
      <div className="flex flex-wrap gap-2">
        <div className="flex rounded-xl border overflow-hidden">
          {([['list', 'รายการงาน', FiList], ['dashboard', 'Dashboard ทีม', FiBarChart2]] as const).map(([key, label, Icon]) => <button key={key} onClick={() => setView(key)} className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium ${view === key ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}><Icon /> {label}</button>)}
        </div>
        <button onClick={() => setShowTeam(true)} className="px-4 py-2 border rounded-xl text-sm">จัดการทีม</button><button onClick={() => setShowCategory(true)} className="px-4 py-2 border rounded-xl text-sm">ประเภทงาน</button><button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white"><FiPlus /> มอบหมายงาน</button>
      </div>
    </div>
    {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm">{error}</div>}
    {view === 'dashboard' && <TaskDashboard tasks={tasks} />}
    {view === 'list' && <>
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{cards.map(([label, value, color, Icon]) => <div key={label} className="bg-white border rounded-2xl p-4"><div className={`flex items-center gap-2 text-sm ${color}`}><Icon />{label}</div><div className="text-2xl font-bold mt-2">{value}</div></div>)}</div>
    <div className="bg-white border rounded-2xl overflow-hidden">
      <div className="p-4 pb-0 flex flex-wrap gap-2">
        {([['managed','งานที่ฉันติดตาม',tasks.filter(isManaged).length],['mine','งานที่ฉันต้องทำ',tasks.filter(isMine).length],['all','ทั้งหมดที่เกี่ยวข้อง',tasks.length]] as const).map(([key,label,count])=><button key={key} onClick={()=>setScope(key)} className={`px-4 py-2 rounded-xl text-sm font-medium border ${scope===key?'bg-emerald-600 border-emerald-600 text-white':'bg-white text-gray-600 hover:bg-gray-50'}`}>{label} ({count})</button>)}
      </div>
      <div className="p-4 flex flex-col md:flex-row gap-3"><label className="relative flex-1"><FiSearch className="absolute left-3 top-3 text-gray-400"/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหารหัส ชื่องาน หรือพนักงาน..." className="w-full border rounded-xl py-2.5 pl-10 pr-3"/></label><select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded-xl px-3"><option value="">ทุกสถานะ</option>{Object.entries(STATUS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left p-3">งาน</th><th className="text-left p-3">ผู้รับผิดชอบ</th><th className="text-left p-3">ผู้ประสานงาน / ที่ปรึกษา</th><th className="text-left p-3">กำหนดส่ง</th><th className="text-left p-3">เวลาที่ใช้</th><th className="text-left p-3">ความคืบหน้า</th><th className="text-left p-3">ลิงก์ผลงาน</th><th className="text-left p-3">สถานะ</th><th className="p-3"></th></tr></thead>
          <tbody>{visible.map((t) => <tr key={t.id} onClick={()=>setDetailTask(t)} className="border-t cursor-pointer hover:bg-emerald-50/40">
            <td className="p-3"><div className="font-semibold">{t.title}</div><div className="flex items-center gap-1.5 text-xs text-gray-500"><span>{t.task_no} ·</span><span className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/10" style={{backgroundColor:t.category?.color??'#9ca3af'}}/><span>{t.category?.name ?? 'ไม่ระบุประเภท'}</span></div></td>
            <td className="p-3">{t.participants?.filter((p) => p.role === 'assignee').map((p) => nameOf(p.employee)).join(', ') || '-'}</td>
            <td className="p-3 min-w-48"><div className="space-y-1">{t.participants?.filter((p)=>p.role==='coordinator'||p.role==='advisor').map((p)=><div key={p.id} className="flex items-center gap-1.5 text-xs"><span className={`px-1.5 py-0.5 rounded ${p.role==='coordinator'?'bg-blue-50 text-blue-700':'bg-violet-50 text-violet-700'}`}>{p.role==='coordinator'?'ประสานงาน':'ที่ปรึกษา'}</span><span className="text-gray-700">{nameOf(p.employee)}</span></div>)}{!t.participants?.some((p)=>p.role==='coordinator'||p.role==='advisor')&&<span className="text-gray-400">-</span>}</div></td>
            <td className={`p-3 ${overdue(t) ? 'text-red-600 font-semibold' : ''}`}>{t.due_at ? new Date(t.due_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-'}</td>
            <td className="p-3 whitespace-nowrap"><div className="font-medium">{elapsedText(t)}</div><div className="text-xs text-gray-400">{t.completed_at?'ใช้เวลารวม':'กำลังนับเวลา'}</div></td>
            <td className="p-3 min-w-36"><div className="h-2 bg-gray-100 rounded-full"><div className="h-full bg-emerald-500 rounded-full" style={{width:`${t.progress}%`}}/></div><span className="text-xs">{t.progress}%</span></td>
            <td className="p-3">{workLink(t.completion_link)?<a href={workLink(t.completion_link)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} className="inline-flex items-center gap-1.5 text-blue-600 hover:underline whitespace-nowrap"><FiExternalLink/> เปิดลิงก์</a>:<span className="text-gray-400">-</span>}</td>
            <td className="p-3"><span className={`px-2 py-1 rounded-full text-xs ${overdue(t) ? 'bg-red-100 text-red-700' : 'bg-gray-100'}`}>{overdue(t) ? 'เลยกำหนด' : STATUS[t.status]}</span></td>
            <td className="p-3">{t.status === 'review' && isManaged(t) && <button disabled={busy} onClick={(e)=>{e.stopPropagation();setEvaluationTask(t)}} className="text-emerald-600 font-semibold whitespace-nowrap">ประเมิน</button>}</td>
          </tr>)}</tbody>
        </table>
        {!visible.length && <div className="text-center py-12 text-gray-400">ไม่พบงาน</div>}
      </div>
    </div>
    </>}
    {showCreate && me && <CreateTaskModal me={me} employees={employees} categories={categories} tasks={tasks} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false); await load()}} />}
    {showCategory && <CategoryModal onClose={()=>setShowCategory(false)} onChanged={async()=>setCategories(await fetchTaskCategories())} />}
    {showTeam && me && <TeamModal me={me} employees={employees} onClose={()=>setShowTeam(false)} />}
    {detailTask && <TaskDetailModal task={detailTask} employee={me} onClose={()=>setDetailTask(null)} onEvaluate={()=>{setDetailTask(null);setEvaluationTask(detailTask)}} onStatus={async(status)=>{await updateTaskStatus(detailTask.id,status);setDetailTask(null);await load()}} onSubmit={()=>{setSubmitTask(detailTask);setDetailTask(null)}} />}
    {evaluationTask && me && <EvaluationModal task={evaluationTask} evaluator={me} onClose={()=>setEvaluationTask(null)} onSaved={async()=>{setEvaluationTask(null);await load()}} />}
    {submitTask && <SubmitWorkModal task={submitTask} onClose={()=>setSubmitTask(null)} onSaved={async()=>{setSubmitTask(null);await load()}} />}
  </div>
}

const REASON_TONE = { good: 'bg-emerald-100 text-emerald-700', warn: 'bg-amber-100 text-amber-700', bad: 'bg-red-100 text-red-700', muted: 'bg-gray-100 text-gray-600' } as const
function CreateTaskModal({ me, employees, categories, tasks, onClose, onSaved }: { me:HREmployee; employees:HREmployee[]; categories:HRTaskCategory[]; tasks:HRTask[]; onClose:()=>void; onSaved:()=>void }) {
  const [form,setForm]=useState({title:'',description:'',category_id:'',priority:'normal' as 'normal'|'high'|'urgent',start_date:new Date().toISOString().slice(0,10),due_at:'',assignee:'',coordinator:'',advisor:''})
  const [items,setItems]=useState(['']); const [saving,setSaving]=useState(false); const [error,setError]=useState('')
  const [evaluations,setEvaluations]=useState<HRTaskEvaluation[]>([])
  useEffect(()=>{fetchTaskEvaluations().then(setEvaluations).catch(()=>{})},[])
  const suggestions=useMemo(()=>recommendAssignees({employees,tasks,evaluations,categoryId:form.category_id||undefined,dueAt:form.due_at||undefined}).slice(0,5),[employees,tasks,evaluations,form.category_id,form.due_at])
  const save=async()=>{ if(!form.title.trim()||!form.assignee||!form.due_at){setError('กรุณากรอกชื่องาน ผู้รับผิดชอบ และกำหนดส่ง');return} setSaving(true); try { await createHRTask({title:form.title.trim(),description:form.description.trim()||undefined,category_id:form.category_id||undefined,priority:form.priority,start_date:form.start_date,due_at:new Date(form.due_at).toISOString(),created_by:me.id,participants:[{employee_id:form.assignee,role:'assignee',is_primary:true},{employee_id:me.id,role:'supervisor',is_primary:true},...(form.coordinator?[{employee_id:form.coordinator,role:'coordinator' as const}]:[]),...(form.advisor?[{employee_id:form.advisor,role:'advisor' as const}]:[])],checklist:items.filter(x=>x.trim()).map((title,i)=>({title:title.trim(),assignee_id:form.assignee,sort_order:i}))}); await onSaved() } catch(e){setError(e instanceof Error?e.message:'บันทึกไม่สำเร็จ')} finally{setSaving(false)} }
  return <Modal title="มอบหมายงาน" onClose={onClose}><div className="space-y-4"><Field label="ชื่องาน *"><input className="input" value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></Field><Field label="รายละเอียด"><textarea rows={3} className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field><div className="grid md:grid-cols-2 gap-3"><Field label="ประเภทงาน"><select className="input" value={form.category_id} onChange={e=>setForm({...form,category_id:e.target.value})}><option value="">ไม่ระบุ</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="ความสำคัญ"><select className="input" value={form.priority} onChange={e=>setForm({...form,priority:e.target.value as typeof form.priority})}><option value="normal">ปกติ</option><option value="high">สำคัญ</option><option value="urgent">เร่งด่วน</option></select></Field><Field label="ผู้รับผิดชอบ *"><EmployeeSelect value={form.assignee} employees={employees} onChange={v=>setForm({...form,assignee:v})}/></Field><Field label="หัวหน้างาน"><input className="input bg-gray-50" disabled value={nameOf(me)}/></Field><Field label="ผู้ประสานงาน"><EmployeeSelect value={form.coordinator} employees={employees} onChange={v=>setForm({...form,coordinator:v})}/></Field><Field label="ที่ปรึกษางาน"><EmployeeSelect value={form.advisor} employees={employees} onChange={v=>setForm({...form,advisor:v})}/></Field><Field label="วันเริ่ม"><input type="date" className="input" value={form.start_date} onChange={e=>setForm({...form,start_date:e.target.value})}/></Field><Field label="วันและเวลาส่ง *"><input type="datetime-local" className="input" value={form.due_at} onChange={e=>setForm({...form,due_at:e.target.value})}/></Field></div>
  <div className="border border-emerald-100 bg-emerald-50/50 rounded-xl p-3">
    <div className="flex flex-wrap items-center justify-between gap-1 mb-2">
      <span className="text-sm font-semibold text-emerald-800">✦ แนะนำผู้รับผิดชอบสำหรับงานนี้</span>
      <span className="text-[11px] text-gray-500">อิงความถนัดประเภทงาน · คะแนนประเมิน · ภาระงาน · การส่งตรงเวลา</span>
    </div>
    {suggestions.length?<div className="space-y-1.5">{suggestions.map((s,i)=>{
      const selected=form.assignee===s.employee.id
      return <button key={s.employee.id} type="button" onClick={()=>setForm({...form,assignee:s.employee.id})}
        className={`w-full flex items-center gap-2.5 p-2 rounded-xl border text-left transition-colors ${selected?'border-emerald-500 bg-white ring-2 ring-emerald-200':'border-transparent bg-white/70 hover:bg-white hover:border-emerald-200'}`}>
        <span className="text-xs font-bold text-gray-400 w-4 text-center shrink-0">{i+1}</span>
        <Avatar employee={s.employee} size="w-9 h-9"/>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{nameOf(s.employee)}</div>
          <div className="flex flex-wrap gap-1 mt-0.5">{s.reasons.slice(0,4).map((r,j)=><span key={j} className={`px-1.5 py-px rounded text-[10px] ${REASON_TONE[r.tone]}`}>{r.text}</span>)}</div>
        </div>
        <div className="text-right shrink-0"><div className={`text-sm font-bold ${s.score>=70?'text-emerald-600':s.score>=50?'text-blue-600':'text-gray-400'}`}>{s.score}%</div><div className="text-[10px] text-gray-400">เหมาะสม</div></div>
      </button>})}</div>
    :<p className="text-xs text-gray-400">ยังไม่มีข้อมูลเพียงพอสำหรับแนะนำ</p>}
    {(!form.category_id||!form.due_at)&&<p className="mt-2 text-[11px] text-gray-500">เลือก “ประเภทงาน” และ “วันและเวลาส่ง” เพื่อให้คำแนะนำแม่นยำขึ้น</p>}
  </div>
  <div><div className="font-medium mb-2">Task ย่อย</div>{items.map((x,i)=><div key={i} className="flex gap-2 mb-2"><input className="input" placeholder={`ข้อที่ ${i+1}`} value={x} onChange={e=>setItems(items.map((v,j)=>j===i?e.target.value:v))}/>{items.length>1&&<button onClick={()=>setItems(items.filter((_,j)=>j!==i))}><FiX/></button>}</div>)}<button onClick={()=>setItems([...items,''])} className="text-sm text-emerald-600">+ เพิ่มข้อ</button></div>{error&&<p className="text-red-600 text-sm">{error}</p>}<button disabled={saving} onClick={save} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-50">{saving?'กำลังบันทึก...':'มอบหมายงาน'}</button></div></Modal>
}

function TaskDetailModal({task,employee,onClose,onEvaluate,onStatus,onSubmit}:{task:HRTask;employee:HREmployee|null;onClose:()=>void;onEvaluate:()=>void;onStatus:(status:HRTaskStatus)=>Promise<void>;onSubmit:()=>void}){
  const roleLabel={assignee:'ผู้รับผิดชอบ',supervisor:'หัวหน้างาน',coordinator:'ผู้ประสานงาน',advisor:'ที่ปรึกษา'} as const
  const link=task.completion_link?.trim()
  const safeLink=workLink(link)
  const isAssignee=!!employee&&!!task.participants?.some(p=>p.role==='assignee'&&p.employee_id===employee.id)
  const canEvaluate=!!employee&&(task.created_by===employee.id||!!task.participants?.some(p=>p.role==='supervisor'&&p.employee_id===employee.id))
  return <Modal title="รายละเอียดงาน" onClose={onClose}><div className="space-y-5">
    <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{task.title}</h3><span className="px-2 py-1 rounded-full bg-gray-100 text-xs">{STATUS[task.status]}</span></div><p className="text-xs text-gray-500 mt-1">{task.task_no} · {task.category?.name??'ไม่ระบุประเภท'}</p></div>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3"><Info label="เริ่มงาน" value={task.started_at?new Date(task.started_at).toLocaleString('th-TH'):'ยังไม่เริ่ม'}/><Info label="กำหนดส่ง" value={task.due_at?new Date(task.due_at).toLocaleString('th-TH'):'ไม่กำหนด'}/><Info label="เวลาที่ใช้" value={elapsedText(task)}/><Info label="ความคืบหน้า" value={`${task.progress}%`}/></div>
    <section><h4 className="font-semibold mb-2">ผู้เกี่ยวข้อง</h4><div className="grid md:grid-cols-2 gap-2">{task.participants?.map(p=><div key={p.id} className="p-3 border rounded-xl"><div className="text-xs text-gray-500">{roleLabel[p.role]}</div><div className="font-medium">{nameOf(p.employee)}</div>{p.employee?.phone?<a href={`tel:${p.employee.phone.replace(/[^\d+]/g,'')}`} className="inline-flex items-center gap-1 mt-1 text-sm text-blue-600 hover:underline">โทร {p.employee.phone}</a>:<div className="mt-1 text-xs text-gray-400">ไม่มีเบอร์โทร</div>}</div>)}</div></section>
    <section><h4 className="font-semibold mb-2">รายละเอียด</h4><div className="p-3 rounded-xl bg-gray-50 whitespace-pre-wrap text-sm">{task.description||'ไม่มีรายละเอียดเพิ่มเติม'}</div></section>
    <section><div className="flex items-center justify-between mb-2"><h4 className="font-semibold">Task ย่อย</h4><span className="text-sm text-gray-500">{task.checklist?.filter(i=>i.is_completed).length??0}/{task.checklist?.length??0} ข้อ</span></div><div className="space-y-2">{task.checklist?.sort((a,b)=>a.sort_order-b.sort_order).map(i=><div key={i.id} className="flex gap-2 p-3 rounded-xl bg-gray-50"><FiCheckCircle className={i.is_completed?'text-emerald-600':'text-gray-300'}/><span className={i.is_completed?'line-through text-gray-400':''}>{i.title}</span></div>)}{!task.checklist?.length&&<p className="text-sm text-gray-400">ไม่มี Task ย่อย</p>}</div></section>
    {(task.completion_note||link)&&<section className="p-4 rounded-xl bg-blue-50 border border-blue-100"><h4 className="font-semibold text-blue-900">ข้อความส่งงานจากผู้รับผิดชอบ</h4>{task.completion_note&&<p className="mt-2 text-sm whitespace-pre-wrap">{task.completion_note}</p>}{safeLink&&<a href={safeLink} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-blue-700 font-medium text-sm"><FiExternalLink/> เปิดลิงก์ผลงาน</a>}</section>}
    <div className="grid gap-2">{isAssignee&&task.status==='new'&&<button onClick={()=>onStatus('acknowledged')} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">รับทราบงาน</button>}{isAssignee&&task.status==='acknowledged'&&<button onClick={()=>onStatus('in_progress')} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">เริ่มทำงาน</button>}{isAssignee&&['in_progress','revision'].includes(task.status)&&<button onClick={onSubmit} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">ส่งงานให้ตรวจ</button>}{isAssignee&&task.status==='review'&&<button onClick={onSubmit} className="w-full py-3 rounded-xl border border-blue-300 text-blue-700 bg-blue-50 font-semibold">แก้ไขการส่งงาน</button>}{canEvaluate&&task.status==='review'&&<button onClick={onEvaluate} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">ประเมิน</button>}</div>
  </div></Modal>
}

function SubmitWorkModal({task,onClose,onSaved}:{task:HRTask;onClose:()=>void;onSaved:()=>void}){
  const [note,setNote]=useState(task.completion_note??'')
  const [link,setLink]=useState(task.completion_link??'')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const save=async()=>{setSaving(true);setError('');try{await updateTaskStatus(task.id,'review',note.trim()||undefined,link.trim()||undefined);onSaved()}catch(e){setError(e instanceof Error?e.message:'ส่งงานไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title={task.status==='review'?'แก้ไขการส่งงาน':'ส่งงานให้ตรวจ'} onClose={onClose}><div className="space-y-4"><div className="p-3 rounded-xl bg-gray-50"><div className="font-semibold">{task.title}</div><div className="text-xs text-gray-500">{task.task_no}</div></div><Field label="สรุปผลการทำงาน (ถ้ามี)"><textarea autoFocus rows={5} className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="ระบุผลงานที่ทำเสร็จหรือปัญหาที่พบ..."/></Field><Field label="ลิงก์ผลงาน (ถ้ามี)"><input type="url" className="input" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://..."/></Field>{error&&<p className="text-sm text-red-600">{error}</p>}<div className="grid grid-cols-2 gap-3"><button onClick={onClose} disabled={saving} className="py-3 rounded-xl border">ยกเลิก</button><button onClick={save} disabled={saving} className="py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-50">{saving?'กำลังบันทึก...':task.status==='review'?'บันทึกการแก้ไข':'ส่งงาน'}</button></div></div></Modal>
}

function Info({label,value}:{label:string;value:string}){return <div className="p-3 border rounded-xl"><div className="text-xs text-gray-500">{label}</div><div className="font-semibold mt-1">{value}</div></div>}

function EvaluationModal({task,evaluator,onClose,onSaved}:{task:HRTask;evaluator:HREmployee;onClose:()=>void;onSaved:()=>void}){
  const [scores,setScores]=useState({speed:3,responsibility:3,quality:3,communication:3,problem_solving:3,teamwork:3})
  const [comment,setComment]=useState('')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const assignee=task.participants?.find(p=>p.role==='assignee')
  const save=async()=>{if(!assignee){setError('ไม่พบผู้รับผิดชอบงาน');return}setSaving(true);setError('');try{await saveTaskEvaluation({task_id:task.id,employee_id:assignee.employee_id,evaluator_id:evaluator.id,...scores,comment:comment.trim()||undefined,visibility:'manager_only'});await updateTaskStatus(task.id,'completed');onSaved()}catch(e){setError(e instanceof Error?e.message:'บันทึกการประเมินไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title="ประเมินผลงาน" onClose={onClose}><div className="space-y-4"><div className="p-3 rounded-xl bg-gray-50"><div className="font-semibold">{task.title}</div><div className="text-sm text-gray-500">ผู้รับการประเมิน: {nameOf(assignee?.employee)}</div></div>{([['speed','ความเร็ว'],['responsibility','ความรับผิดชอบ'],['quality','คุณภาพ'],['communication','การสื่อสาร'],['problem_solving','การแก้ปัญหา'],['teamwork','การทำงานเป็นทีม']] as const).map(([key,label])=><div key={key}><div className="flex justify-between mb-2"><span className="font-medium">{label}</span><span className="font-bold text-emerald-600">{scores[key]}/5</span></div><div className="grid grid-cols-5 gap-2">{[1,2,3,4,5].map(n=><button key={n} onClick={()=>setScores({...scores,[key]:n})} className={`py-2 rounded-lg border ${scores[key]===n?'bg-emerald-600 border-emerald-600 text-white':'hover:bg-gray-50'}`}>{n}</button>)}</div></div>)}<Field label="หมายเหตุสำหรับหัวหน้า"><textarea rows={3} className="input" value={comment} onChange={e=>setComment(e.target.value)} placeholder="พนักงานจะยังไม่เห็นผลประเมินนี้"/></Field>{error&&<p className="text-sm text-red-600">{error}</p>}<div className="grid grid-cols-2 gap-3"><button onClick={onClose} disabled={saving} className="py-3 rounded-xl border">ยกเลิก</button><button onClick={save} disabled={saving||!assignee} className="py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-50">{saving?'กำลังบันทึก...':'บันทึกและผ่านงาน'}</button></div></div></Modal>
}

function CategoryModal({onClose,onChanged}:{onClose:()=>void;onChanged:()=>Promise<void>}){
  const [rows,setRows]=useState<HRTaskCategory[]>([])
  const [editing,setEditing]=useState<HRTaskCategory|null>(null)
  const [showForm,setShowForm]=useState(false)
  const [name,setName]=useState('')
  const [color,setColor]=useState('#059669')
  const [isActive,setIsActive]=useState(true)
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const [dragIndex,setDragIndex]=useState<number|null>(null)
  const loadRows=async()=>{setLoading(true);try{setRows(await fetchTaskCategories(false))}catch(e){setError(e instanceof Error?e.message:'โหลดประเภทงานไม่สำเร็จ')}finally{setLoading(false)}}
  useEffect(()=>{loadRows()},[])
  const reset=()=>{setEditing(null);setName('');setColor('#059669');setIsActive(true);setShowForm(false);setError('')}
  const startEdit=(row:HRTaskCategory)=>{setEditing(row);setName(row.name);setColor(row.color||'#059669');setIsActive(row.is_active);setShowForm(true);setError('')}
  const save=async()=>{if(!name.trim())return;setSaving(true);setError('');try{await saveTaskCategory({id:editing?.id,name:name.trim(),color,is_active:isActive,...(editing?{}:{sort_order:rows.length+1})});await Promise.all([loadRows(),onChanged()]);reset()}catch(e){setError(e instanceof Error?e.message:'บันทึกประเภทงานไม่สำเร็จ')}finally{setSaving(false)}}
  const moveRow=async(from:number,to:number)=>{
    if(from===to)return
    const next=[...rows];const [moved]=next.splice(from,1);next.splice(to,0,moved)
    setRows(next);setError('')
    try{await saveTaskCategoryOrder(next.map(r=>r.id));await onChanged()}
    catch(e){setError(e instanceof Error?e.message:'บันทึกลำดับไม่สำเร็จ');await loadRows()}
  }
  return <Modal title="จัดการประเภทงาน" onClose={onClose}><div className="space-y-4">
    {!showForm&&<><div className="flex items-center justify-between"><div><h3 className="font-semibold">รายชื่อประเภทงาน</h3><p className="text-xs text-gray-500">ทั้งหมด {rows.length} ประเภท · ลาก <FiMenu className="inline align-[-2px]"/> เพื่อจัดลำดับ</p></div><button onClick={()=>setShowForm(true)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ เพิ่มประเภทงาน</button></div>
    {loading?<div className="py-10 text-center text-gray-400">กำลังโหลด...</div>:<div className="space-y-2 max-h-[55vh] overflow-y-auto">{rows.map((row,idx)=><div key={row.id}
      onDragOver={(e)=>{if(dragIndex!==null)e.preventDefault()}}
      onDrop={(e)=>{e.preventDefault();if(dragIndex!==null)moveRow(dragIndex,idx);setDragIndex(null)}}
      className={`flex items-center justify-between gap-3 border rounded-xl p-3 transition-opacity ${dragIndex===idx?'opacity-40':''}`}>
      <div className="flex items-center gap-3 min-w-0">
        <button type="button" draggable aria-label={`ลากจัดลำดับ ${row.name}`}
          onDragStart={(e)=>{setDragIndex(idx);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(idx))}}
          onDragEnd={()=>setDragIndex(null)}
          className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 cursor-grab active:cursor-grabbing"><FiMenu/></button>
        <span className="w-5 h-5 rounded-md shrink-0 border" style={{backgroundColor:row.color}}/><div className="min-w-0"><div className="font-medium truncate">{row.name}</div><div className={`text-xs ${row.is_active?'text-emerald-600':'text-gray-400'}`}>{row.is_active?'เปิดใช้งาน':'ปิดใช้งาน'}</div></div>
      </div>
      <button onClick={()=>startEdit(row)} className="shrink-0 px-3 py-1.5 rounded-lg border text-sm text-emerald-700 hover:bg-emerald-50">แก้ไข</button>
    </div>)}{!rows.length&&<div className="py-10 text-center text-gray-400">ยังไม่มีประเภทงาน</div>}</div>}</>}
    {showForm&&<><div className="flex items-center justify-between"><h3 className="font-semibold">{editing?'แก้ไขประเภทงาน':'เพิ่มประเภทงาน'}</h3><button onClick={reset} className="text-sm text-gray-500">← กลับไปรายการ</button></div><Field label="ชื่อประเภทงาน"><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="สี"><div className="flex items-center gap-3"><input type="color" value={color} onChange={e=>setColor(e.target.value)} className="w-14 h-10 border rounded-lg p-1"/><span className="text-sm text-gray-500">{color.toUpperCase()}</span></div></Field>{editing&&<label className="flex items-center gap-2 p-3 border rounded-xl"><input type="checkbox" checked={isActive} onChange={e=>setIsActive(e.target.checked)}/><span className="text-sm">เปิดใช้งานประเภทงานนี้</span></label>}<button disabled={saving||!name.trim()} onClick={save} className="w-full py-3 rounded-xl bg-emerald-600 text-white disabled:opacity-50">{saving?'กำลังบันทึก...':editing?'บันทึกการแก้ไข':'บันทึกประเภทงาน'}</button></>}
    {error&&<p className="text-sm text-red-600">{error}</p>}
  </div></Modal>
}
type TaskTeamRow = { id: string; name: string; members?: Array<{ employee_id: string; role: 'manager' | 'member'; employee?: HREmployee }> }
function TeamModal({me,employees,onClose}:{me:HREmployee;employees:HREmployee[];onClose:()=>void}){
  const [teams,setTeams]=useState<TaskTeamRow[]>([])
  const [editingId,setEditingId]=useState<string|null>(null)
  const [showForm,setShowForm]=useState(false)
  const [name,setName]=useState('')
  const [manager,setManager]=useState('')
  const [members,setMembers]=useState<string[]>([])
  const [loading,setLoading]=useState(true)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const loadTeams=async()=>{setLoading(true);try{setTeams(await fetchTaskTeams() as unknown as TaskTeamRow[])}catch(e){setError(e instanceof Error?e.message:'โหลดรายชื่อทีมไม่สำเร็จ')}finally{setLoading(false)}}
  useEffect(()=>{loadTeams()},[])
  const reset=()=>{setEditingId(null);setName('');setManager('');setMembers([]);setShowForm(false);setError('')}
  const edit=(team:TaskTeamRow)=>{setEditingId(team.id);setName(team.name);setManager(team.members?.find(m=>m.role==='manager')?.employee_id??'');setMembers(team.members?.filter(m=>m.role==='member').map(m=>m.employee_id)??[]);setShowForm(true);setError('')}
  const save=async()=>{if(!name.trim()||!manager)return;setSaving(true);setError('');try{if(editingId)await updateTaskTeam(editingId,name.trim(),manager,members);else await createTaskTeam(name.trim(),manager,members,me.id);await loadTeams();reset()}catch(e){setError(e instanceof Error?e.message:'บันทึกทีมไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title="จัดการทีม" onClose={onClose}><div className="space-y-4">
    {!showForm&&<><div className="flex items-center justify-between"><div><h3 className="font-semibold">รายชื่อทีมที่สร้างแล้ว</h3><p className="text-xs text-gray-500">ทั้งหมด {teams.length} ทีม</p></div><button onClick={()=>setShowForm(true)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm">+ เพิ่มทีม</button></div>
    {loading?<div className="py-10 text-center text-gray-400">กำลังโหลด...</div>:<div className="space-y-3 max-h-[55vh] overflow-y-auto">{teams.map(team=>{const head=team.members?.find(m=>m.role==='manager');const staff=team.members?.filter(m=>m.role==='member')??[];return <div key={team.id} className="border rounded-xl p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-semibold text-base">{team.name}</div><div className="text-sm text-gray-600 mt-1">หัวหน้า: {head?.employee?nameOf(head.employee):'-'}</div><div className="text-xs text-gray-500 mt-1">ลูกทีม {staff.length} คน{staff.length>0?` · ${staff.map(m=>m.employee?.nickname||m.employee?.first_name||'-').join(', ')}`:''}</div></div><button onClick={()=>edit(team)} className="shrink-0 px-3 py-1.5 rounded-lg border text-sm text-emerald-700 hover:bg-emerald-50">แก้ไข</button></div></div>})}{!teams.length&&<div className="py-10 text-center text-gray-400">ยังไม่มีทีม กด “เพิ่มทีม” เพื่อเริ่มสร้าง</div>}</div>}</>}
    {showForm&&<><div className="flex items-center justify-between"><h3 className="font-semibold">{editingId?'แก้ไขทีม':'เพิ่มทีมใหม่'}</h3><button onClick={reset} className="text-sm text-gray-500">← กลับไปรายชื่อทีม</button></div><Field label="ชื่อทีม"><input className="input" value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="หัวหน้าทีม"><EmployeeSelect value={manager} employees={employees} onChange={setManager}/></Field><div><div className="text-sm font-medium mb-2">ลูกทีมที่มอบหมายงานได้</div><div className="max-h-64 overflow-auto border rounded-xl p-2">{employees.filter(e=>e.id!==manager).map(e=><label key={e.id} className="flex gap-2 p-2"><input type="checkbox" checked={members.includes(e.id)} onChange={x=>setMembers(x.target.checked?[...members,e.id]:members.filter(id=>id!==e.id))}/><span>{e.employee_code} · {nameOf(e)}</span></label>)}</div></div><button disabled={saving||!name.trim()||!manager} onClick={save} className="w-full py-3 rounded-xl bg-emerald-600 text-white disabled:opacity-50">{saving?'กำลังบันทึก...':editingId?'บันทึกการแก้ไข':'บันทึกทีม'}</button></>}
    {error&&<p className="text-sm text-red-600">{error}</p>}
  </div></Modal>
}
function EmployeeSelect({value,employees,onChange}:{value:string;employees:HREmployee[];onChange:(v:string)=>void}){return <select className="input" value={value} onChange={e=>onChange(e.target.value)}><option value="">เลือกพนักงาน</option>{employees.map(e=><option key={e.id} value={e.id}>{e.employee_code} · {nameOf(e)}</option>)}</select>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="block"><span className="block text-sm font-medium mb-1">{label}</span>{children}</label>}
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b bg-white">
          <h2 className="text-xl font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100" aria-label="ปิด"><FiX className="w-6 h-6"/></button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
