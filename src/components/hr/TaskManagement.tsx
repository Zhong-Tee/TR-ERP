import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiAlertTriangle, FiBarChart2, FiCheckCircle, FiClock, FiExternalLink, FiList, FiMenu, FiPlus, FiSearch, FiTrash2, FiX } from 'react-icons/fi'
import ModalCloseButton from '../ui/ModalCloseButton'
import { useAuthContext } from '../../contexts/AuthContext'
import TaskDashboard, { Avatar } from './TaskDashboard'
import { acknowledgeAndStartTask, completeMyTaskPart, createHRTask, deleteHRTask, fetchCompanyHolidays, fetchEmployeeByUserId, fetchEmployees, fetchLeaveRequests, fetchTask, fetchTaskAssignerPermissions, fetchTaskCategories, fetchTaskEvaluations, fetchTaskEvents, fetchTasks, fetchWorkCalendar, fetchWorkSchedules, saveTaskAssignerPermissions, saveTaskCategory, saveTaskCategoryOrder, saveTaskEvaluation, submitTeamTask, toggleTaskChecklist, updateTaskStatus } from '../../lib/hrApi'
import { addWorkingHours, localDateKey, recommendAssignees, type WorkingTimeData } from '../../lib/hrTaskMetrics'
import type { HREmployee, HRTask, HRTaskCategory, HRTaskEvaluation, HRTaskEvent, HRTaskStatus } from '../../types'

const STATUS: Record<HRTaskStatus, string> = { draft: 'แบบร่าง', new: 'งานใหม่', acknowledged: 'รับทราบแล้ว', in_progress: 'กำลังดำเนินการ', review: 'รอรีวิว', revision: 'ให้แก้ไข', completed: 'เสร็จแล้ว', paused: 'พักงาน', cancelled: 'ยกเลิก' }
const statusBadgeStyle = (status: HRTaskStatus) => status === 'completed'
  ? 'bg-emerald-100 text-emerald-700'
  : 'bg-gray-100 text-gray-700'
const ACTIVE = ['new', 'acknowledged', 'in_progress', 'review', 'revision'] as HRTaskStatus[]
const nameOf = (e?: HREmployee) => e ? `${e.first_name} ${e.last_name}${e.nickname ? ` (${e.nickname})` : ''}` : '-'
const overdue = (t: HRTask) => !!t.due_at && !t.first_submitted_at && !t.submitted_at && ACTIVE.includes(t.status) && new Date(t.due_at) < new Date()
const reviewed = (t: HRTask) => t.status === 'completed' && !!t.evaluations?.length
const displayedStatus = (t: HRTask) => overdue(t) ? 'เลยกำหนด' : reviewed(t) ? 'รีวิวแล้ว' : STATUS[t.status]
const displayedStatusStyle = (t: HRTask) => overdue(t)
  ? 'bg-red-100 text-red-700'
  : reviewed(t)
    ? 'bg-violet-100 text-violet-700'
    : statusBadgeStyle(t.status)
/** แปลง Date เป็นค่า input แบบ datetime-local (เวลาท้องถิ่น) */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const workLink = (value?: string) => {
  const link = value?.trim()
  if (!link) return ''
  return /^https?:\/\//i.test(link) ? link : `https://${link}`
}
const taskTime = (value?: string) => value
  ? new Date(value).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })
  : 'ยังไม่มี'
const minutesBetween = (start?: string, end?: string) => {
  if (!start || !end) return 'ยังไม่มี'
  const milliseconds = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'ข้อมูลเวลาไม่ถูกต้อง'
  return formatDuration(Math.floor(milliseconds / 60000))
}
const formatDuration = (totalMinutes: number) => {
  const minutes = Math.max(0, Math.floor(totalMinutes))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  return [days ? `${days} วัน` : '', hours ? `${hours} ชม.` : '', mins || (!days && !hours) ? `${mins} นาที` : ''].filter(Boolean).join(' ')
}
const acknowledgementResult = (t: HRTask) => {
  if (!t.acknowledged_at) return 'ยังไม่รับทราบ'
  const elapsedMinutes = Math.max(0, (new Date(t.acknowledged_at).getTime() - new Date(t.created_at).getTime()) / 60000)
  if (!Number.isFinite(elapsedMinutes)) return 'ข้อมูลเวลาไม่ถูกต้อง'
  if (elapsedMinutes <= 5) return 'รับทราบทันที'
  if (elapsedMinutes <= 30) return 'รับทราบภายใน 30 นาที'
  return `รับทราบช้า ${formatDuration(Math.ceil(elapsedMinutes))}`
}
const elapsedText = (t: HRTask) => {
  if (!t.started_at) return 'ยังไม่เริ่มงาน'
  const start = new Date(t.started_at).getTime()
  // เวลาทำงานของพนักงานหยุดทันทีเมื่อส่งตรวจ ไม่รวมช่วงที่หัวหน้ากำลังตรวจงาน
  const end = (t.first_submitted_at || t.submitted_at)
    ? new Date(t.first_submitted_at || t.submitted_at!).getTime()
    : t.completed_at
      ? new Date(t.completed_at).getTime()
      : Date.now()
  return formatDuration((end - start) / 60000)
}
const submissionTime = (t: HRTask) => t.first_submitted_at || t.submitted_at || (t.status === 'completed' ? t.completed_at : undefined)
const dueResult = (t: HRTask) => {
  if (!t.due_at) return null
  const submitted = submissionTime(t)
  const end = submitted ? new Date(submitted).getTime() : Date.now()
  const difference = end - new Date(t.due_at).getTime()
  if (Math.abs(difference) < 60000) return { text: 'ตรงเวลา', tone: 'text-emerald-600' }
  if (difference > 0) return { text: `${submitted ? 'ล่าช้า' : 'เกินกำหนด'} ${formatDuration(difference / 60000)}`, tone: 'text-red-600' }
  return { text: `${submitted ? 'ก่อนกำหนด' : 'เหลือ'} ${formatDuration(-difference / 60000)}`, tone: submitted ? 'text-emerald-600' : 'text-gray-500' }
}

export default function TaskManagement() {
  const { user } = useAuthContext()
  const [me, setMe] = useState<HREmployee | null>(null)
  const [tasks, setTasks] = useState<HRTask[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [categories, setCategories] = useState<HRTaskCategory[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [dueSort, setDueSort] = useState<'' | 'asc' | 'desc'>('')
  const [scope, setScope] = useState<'global' | 'managed' | 'mine' | 'all' | 'completed'>('managed')
  const [view, setView] = useState<'list' | 'dashboard'>('list')
  const [showCreate, setShowCreate] = useState(false)
  const [showCategory, setShowCategory] = useState(false)
  const [showAssigners, setShowAssigners] = useState(false)
  const [taskAssignerIds, setTaskAssignerIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [detailTask, setDetailTask] = useState<HRTask | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<HRTask | null>(null)
  const [evaluationTask, setEvaluationTask] = useState<HRTask | null>(null)
  const [submitTask, setSubmitTask] = useState<HRTask | null>(null)
  const [submitMode, setSubmitMode] = useState<'part'|'team'>('part')
  const [, setTimeTick] = useState(0)

  const load = async () => {
    const [taskRows, employeeRows, categoryRows, assignerRows] = await Promise.all([fetchTasks(), fetchEmployees({ status: 'active' }), fetchTaskCategories(), fetchTaskAssignerPermissions()])
    setTasks(taskRows); setEmployees(employeeRows); setCategories(categoryRows); setTaskAssignerIds(assignerRows.map((row) => row.employee_id))
  }
  useEffect(() => { load().catch((e) => setError(e.message)); if (user?.id) fetchEmployeeByUserId(user.id).then((employee)=>{setMe(employee);setScope(user.role==='superadmin'?'global':employee?'managed':'all')}).catch(() => setScope(user.role==='superadmin'?'global':'all')) }, [user?.id, user?.role])
  useEffect(() => { const timer = window.setInterval(() => setTimeTick((n) => n + 1), 60000); return () => window.clearInterval(timer) }, [])

  const isMine = (t: HRTask) => !!me && !!t.participants?.some((p) => p.role === 'assignee' && p.employee_id === me.id)
  const isManaged = (t: HRTask) => !!me && (t.created_by === me.id || !!t.participants?.some((p) => p.role === 'supervisor' && p.employee_id === me.id))
  const isRelated = (t: HRTask) => !!me && (t.created_by === me.id || !!t.participants?.some((p) => p.employee_id === me.id))
  const canManageAssigners = ['superadmin', 'admin', 'hr', 'account'].includes(user?.role ?? '')
  const canAssignTasks = canManageAssigners || (!!me && taskAssignerIds.includes(me.id))
  const canDelete = (t: HRTask) => ['superadmin', 'admin', 'hr', 'account'].includes(user?.role ?? '') || isManaged(t)
  const removeTask = async (task: HRTask) => {
    setBusy(true); setError('')
    try {
      await deleteHRTask(task.id)
      if (detailTask?.id === task.id) setDetailTask(null)
      setDeleteTarget(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบงานไม่สำเร็จ')
    } finally { setBusy(false) }
  }
  const scopedTasks = useMemo(() => tasks.filter((task) => {
    if (scope === 'global') return user?.role === 'superadmin'
    if (scope === 'completed') return task.status === 'completed'
    if (task.status === 'completed') return false
    if (scope === 'all') return !!me && (task.created_by === me.id || !!task.participants?.some((participant) => participant.employee_id === me.id))
    if (!me) return false
    if (scope === 'mine') return task.participants?.some((participant) => participant.role === 'assignee' && participant.employee_id === me.id)
    return task.created_by === me.id || task.participants?.some((participant) => participant.role === 'supervisor' && participant.employee_id === me.id)
  }), [tasks, scope, me, user?.role])
  const visible = useMemo(() => scopedTasks.filter((t) => {
    const q = search.trim().toLowerCase()
    const people = t.participants?.map((p) => nameOf(p.employee)).join(' ') ?? ''
    const matchesStatus = !status || (status === 'overdue' ? overdue(t) : status === 'reviewed' ? reviewed(t) : t.status === status)
    return matchesStatus && (!q || `${t.task_no} ${t.title} ${t.description ?? ''} ${people}`.toLowerCase().includes(q))
  }).sort((a, b) => {
    if (!dueSort) return 0
    if (!a.due_at && !b.due_at) return 0
    if (!a.due_at) return 1
    if (!b.due_at) return -1
    const difference = new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
    return dueSort === 'asc' ? difference : -difference
  }), [scopedTasks, search, status, dueSort])
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
          {([['list', 'รายการงาน', FiList], ['dashboard', 'KPI & SLA ทีม', FiBarChart2]] as const).map(([key, label, Icon]) => <button key={key} onClick={() => setView(key)} className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium ${view === key ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}><Icon /> {label}</button>)}
        </div>
        {canManageAssigners&&<button onClick={() => setShowAssigners(true)} className="px-4 py-2 border rounded-xl text-sm">รายชื่อผู้มอบหมายงานได้</button>}<button onClick={() => setShowCategory(true)} className="px-4 py-2 border rounded-xl text-sm">ประเภทงาน</button>{canAssignTasks&&<button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white"><FiPlus /> มอบหมายงาน</button>}
      </div>
    </div>
    {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm">{error}</div>}
    {view === 'dashboard' && <TaskDashboard tasks={tasks} />}
    {view === 'list' && <>
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{cards.map(([label, value, color, Icon]) => <div key={label} className="bg-white border rounded-2xl p-4"><div className={`flex items-center gap-2 text-sm ${color}`}><Icon />{label}</div><div className="text-2xl font-bold mt-2">{value}</div></div>)}</div>
    <div className="bg-white border rounded-2xl overflow-hidden">
      <div className="p-4 pb-0 flex flex-wrap gap-2">
        {([...(user?.role==='superadmin'?[['global','งานทั้งหมด',tasks.length] as const]:[]),['managed','งานที่ฉันติดตาม',tasks.filter((task)=>isManaged(task)&&task.status!=='completed').length] as const,['mine','งานที่ฉันต้องทำ',tasks.filter((task)=>isMine(task)&&task.status!=='completed').length] as const,['all','ทั้งหมดที่เกี่ยวข้อง',tasks.filter((task)=>isRelated(task)&&task.status!=='completed').length] as const,['completed','เสร็จแล้ว',tasks.filter((task)=>task.status==='completed').length] as const]).map(([key,label,count])=><button key={key} onClick={()=>{setScope(key);setStatus('')}} className={`px-4 py-2 rounded-xl text-sm font-medium border ${scope===key?'bg-emerald-600 border-emerald-600 text-white':'bg-white text-gray-600 hover:bg-gray-50'}`}>{label} ({count})</button>)}
      </div>
      <div className="p-4 flex flex-col md:flex-row gap-3"><label className="relative flex-1"><FiSearch className="absolute left-3 top-3 text-gray-400"/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหารหัส ชื่องาน หรือพนักงาน..." className="w-full border rounded-xl py-2.5 pl-10 pr-3"/></label><select value={status} onChange={(e) => setStatus(e.target.value)} className="border rounded-xl px-3"><option value="">ทุกสถานะ</option>{Object.entries(STATUS).filter(([key])=>scope==='completed'?key==='completed':scope==='global'||key!=='completed').map(([k,v]) => <option key={k} value={k}>{v}</option>)}{scope!=='completed'&&<option value="overdue">เลยกำหนด</option>}{(scope==='global'||scope==='completed')&&<option value="reviewed">รีวิวแล้ว</option>}</select><select value={dueSort} onChange={(e) => setDueSort(e.target.value as typeof dueSort)} className="border rounded-xl px-3" aria-label="เรียงตามกำหนดส่ง"><option value="">กำหนดส่ง: ค่าเดิม</option><option value="asc">กำหนดส่ง: น้อยไปมาก</option><option value="desc">กำหนดส่ง: มากไปน้อย</option></select></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600"><tr><th className="text-left p-3">งาน</th><th className="text-left p-3">ผู้รับผิดชอบ</th><th className="text-left p-3">ผู้ประสานงาน / ที่ปรึกษา</th><th className="text-left p-3">กำหนดส่ง</th><th className="text-left p-3">เวลาที่ใช้</th><th className="text-left p-3">ความคืบหน้า</th><th className="text-left p-3">ลิงก์ผลงาน</th><th className="text-left p-3">สถานะ</th><th className="p-3"></th></tr></thead>
          <tbody>{visible.map((t) => <tr key={t.id} onClick={()=>setDetailTask(t)} className="border-t cursor-pointer hover:bg-emerald-50/40">
            <td className="p-3"><div className="font-semibold">{t.title}</div><div className="flex items-center gap-1.5 text-xs text-gray-500"><span>{t.task_no} ·</span><span className="w-2.5 h-2.5 rounded-full shrink-0 border border-black/10" style={{backgroundColor:t.category?.color??'#9ca3af'}}/><span>{t.category?.name ?? 'ไม่ระบุประเภท'}</span></div></td>
            <td className="p-3">{t.participants?.filter((p) => p.role === 'assignee').map((p) => nameOf(p.employee)).join(', ') || '-'}</td>
            <td className="p-3 min-w-48"><div className="space-y-1">{t.participants?.filter((p)=>p.role==='coordinator'||p.role==='advisor').map((p)=><div key={p.id} className="flex items-center gap-1.5 text-xs"><span className={`px-1.5 py-0.5 rounded ${p.role==='coordinator'?'bg-blue-50 text-blue-700':'bg-violet-50 text-violet-700'}`}>{p.role==='coordinator'?'ประสานงาน':'ที่ปรึกษา'}</span><span className="text-gray-700">{nameOf(p.employee)}</span></div>)}{!t.participants?.some((p)=>p.role==='coordinator'||p.role==='advisor')&&<span className="text-gray-400">-</span>}</div></td>
            <td className="p-3 min-w-48">{t.due_at ? <><div className="whitespace-nowrap">{new Date(t.due_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</div>{dueResult(t) && <div className={`mt-1 text-xs font-medium ${dueResult(t)!.tone}`}>{dueResult(t)!.text}</div>}</> : '-'}</td>
            <td className="p-3 min-w-36"><div className="font-medium whitespace-nowrap">{elapsedText(t)}</div></td>
            <td className="p-3 min-w-36"><div className="h-2 bg-gray-100 rounded-full"><div className="h-full bg-emerald-500 rounded-full" style={{width:`${t.progress}%`}}/></div><span className="text-xs">{t.progress}%</span></td>
            <td className="p-3">{workLink(t.completion_link)?<a href={workLink(t.completion_link)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} className="inline-flex items-center gap-1.5 text-blue-600 hover:underline whitespace-nowrap"><FiExternalLink/> เปิดลิงก์</a>:<span className="text-gray-400">-</span>}</td>
            <td className="p-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${displayedStatusStyle(t)}`}>{displayedStatus(t)}</span></td>
            <td className="p-3"><div className="flex items-center justify-end gap-3">{t.status === 'review' && isManaged(t) && <button disabled={busy} onClick={(e)=>{e.stopPropagation();setEvaluationTask(t)}} className="text-emerald-600 font-semibold whitespace-nowrap">ประเมิน</button>}{canDelete(t) && <button type="button" disabled={busy} onClick={(e)=>{e.stopPropagation();setDeleteTarget(t)}} className="inline-flex items-center gap-1 text-red-600 font-semibold whitespace-nowrap hover:text-red-700 disabled:opacity-40" title="ลบงาน"><FiTrash2 />ลบ</button>}</div></td>
          </tr>)}</tbody>
        </table>
        {!visible.length && <div className="text-center py-12 text-gray-400">ไม่พบงาน</div>}
      </div>
    </div>
    </>}
    {showCreate && me && <CreateTaskModal me={me} employees={employees} categories={categories} tasks={tasks} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false); await load()}} />}
    {showCategory && <CategoryModal onClose={()=>setShowCategory(false)} onChanged={async()=>setCategories(await fetchTaskCategories())} />}
    {showAssigners && <TaskAssignerModal employees={employees} selectedIds={taskAssignerIds} onClose={()=>setShowAssigners(false)} onSaved={async(ids)=>{setTaskAssignerIds(ids);setShowAssigners(false)}} />}
    {detailTask && <TaskDetailModal task={detailTask} employee={me} onClose={()=>setDetailTask(null)} onEvaluate={()=>{setDetailTask(null);setEvaluationTask(detailTask)}} onAcknowledgeAndStart={async()=>{await acknowledgeAndStartTask(detailTask.id);setDetailTask(null);await load()}} onChecklist={async(id,completed)=>{await toggleTaskChecklist(id,completed);setDetailTask(await fetchTask(detailTask.id));await load()}} onSubmit={(mode)=>{setSubmitMode(mode);setSubmitTask(detailTask);setDetailTask(null)}} />}
    {evaluationTask && me && <EvaluationModal task={evaluationTask} evaluator={me} onClose={()=>setEvaluationTask(null)} onSaved={async()=>{setEvaluationTask(null);await load()}} />}
    {submitTask && <SubmitWorkModal task={submitTask} mode={submitMode} onClose={()=>setSubmitTask(null)} onSaved={async()=>{setSubmitTask(null);await load()}} />}
    {deleteTarget && <Modal title="ยืนยันลบงาน" onClose={()=>{if(!busy)setDeleteTarget(null)}}><div className="space-y-5">
      <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4"><div className="mt-0.5 rounded-full bg-red-100 p-2 text-red-600"><FiTrash2 className="h-5 w-5" /></div><div><p className="font-semibold text-red-900">ต้องการลบงานนี้หรือไม่?</p><p className="mt-1 text-sm text-red-800">“{deleteTarget.title}” <span className="text-red-600">({deleteTarget.task_no})</span></p></div></div>
      <p className="text-sm leading-6 text-gray-600">ข้อมูลผู้รับผิดชอบ เช็กลิสต์ และผลประเมินที่เกี่ยวข้องกับงานนี้จะถูกลบออกจากฐานข้อมูล และไม่สามารถเรียกคืนได้</p>
      <div className="flex justify-end"><button type="button" disabled={busy} onClick={()=>void removeTask(deleteTarget)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-50"><FiTrash2 />{busy?'กำลังลบ...':'ลบงาน'}</button></div>
    </div></Modal>}
  </div>
}

const REASON_TONE = { good: 'bg-emerald-100 text-emerald-700', warn: 'bg-amber-100 text-amber-700', bad: 'bg-red-100 text-red-700', muted: 'bg-gray-100 text-gray-600' } as const
function CreateTaskModal({ me, employees, categories, tasks, onClose, onSaved }: { me:HREmployee; employees:HREmployee[]; categories:HRTaskCategory[]; tasks:HRTask[]; onClose:()=>void; onSaved:()=>void }) {
  const [form,setForm]=useState({title:'',description:'',category_id:'',priority:'normal' as 'normal'|'high'|'urgent',start_date:new Date().toISOString().slice(0,10),due_at:'',duration_hours:'',assignee:'',coordinator:'',advisor:''})
  const [assigneeIds,setAssigneeIds]=useState<string[]>([])
  const [items,setItems]=useState(['']); const [saving,setSaving]=useState(false); const [error,setError]=useState('')
  const [evaluations,setEvaluations]=useState<HRTaskEvaluation[]>([])
  useEffect(()=>{fetchTaskEvaluations().then(setEvaluations).catch(()=>{})},[])
  const suggestions=useMemo(()=>recommendAssignees({employees,tasks,evaluations,categoryId:form.category_id||undefined,dueAt:form.due_at||undefined}).slice(0,10),[employees,tasks,evaluations,form.category_id,form.due_at])
  // ข้อมูลสำหรับคำนวณ "ให้เวลาทำ (ชม.)" แบบข้ามนอกเวลางาน/วันหยุด/วันลา — โหลดพลาดก็แค่คำนวณแบบบวกตรง ๆ
  const [workData,setWorkData]=useState<WorkingTimeData>({schedules:[],calendar:[],holidays:[],leaves:[]})
  useEffect(()=>{
    const to=new Date();to.setDate(to.getDate()+180)
    Promise.all([fetchWorkSchedules(true),fetchCompanyHolidays(localDateKey(new Date()),localDateKey(to))])
      .then(([schedules,holidays])=>setWorkData(w=>({...w,schedules,holidays}))).catch(()=>{})
  },[])
  useEffect(()=>{
    if(!form.assignee){setWorkData(w=>({...w,calendar:[],leaves:[]}));return}
    const to=new Date();to.setDate(to.getDate()+180)
    Promise.all([fetchWorkCalendar(localDateKey(new Date()),localDateKey(to),[form.assignee]),fetchLeaveRequests({status:'approved',employee_id:form.assignee})])
      .then(([calendar,leaves])=>setWorkData(w=>({...w,calendar,leaves}))).catch(()=>{})
  },[form.assignee])
  useEffect(()=>{
    const h=parseFloat(form.duration_hours)
    if(!(h>0))return
    const base=form.start_date>localDateKey(new Date())?new Date(`${form.start_date}T00:00:00`):new Date()
    const due=toLocalInput(addWorkingHours(base,h,employees.find(e=>e.id===form.assignee),workData))
    setForm(prev=>prev.due_at===due?prev:{...prev,due_at:due})
  },[form.duration_hours,form.assignee,form.start_date,workData,employees])
  const selectPrimary=(employeeId:string)=>{setForm({...form,assignee:employeeId});setAssigneeIds(ids=>[employeeId,...ids.filter(id=>id!==employeeId)]);setError('')}
  const toggleMember=(employeeId:string)=>setAssigneeIds(ids=>ids.includes(employeeId)?ids.filter(id=>id!==employeeId):[...ids,employeeId])
  const save=async()=>{ const checklistItems=items.map(item=>item.trim()).filter(Boolean); const selected=[...new Set([form.assignee,...assigneeIds].filter(Boolean))]; if(!form.title.trim()||!form.category_id||!form.assignee||!form.due_at){setError('กรุณากรอกชื่องาน ประเภทงาน ผู้รับผิดชอบหลัก และกำหนดส่ง');return} if(!checklistItems.length){setError('กรุณากรอก Task ย่อยอย่างน้อย 1 ข้อ');return} setSaving(true); try { await createHRTask({title:form.title.trim(),description:form.description.trim()||undefined,category_id:form.category_id,priority:form.priority,start_date:form.start_date,due_at:new Date(form.due_at).toISOString(),created_by:me.id,participants:[...selected.map(employee_id=>({employee_id,role:'assignee' as const,is_primary:employee_id===form.assignee})),{employee_id:me.id,role:'supervisor',is_primary:true},...(form.coordinator?[{employee_id:form.coordinator,role:'coordinator' as const}]:[]),...(form.advisor?[{employee_id:form.advisor,role:'advisor' as const}]:[])],checklist:checklistItems.map((title,i)=>({title,assignee_id:form.assignee,sort_order:i}))}); await onSaved() } catch(e){setError(e instanceof Error?e.message:'บันทึกไม่สำเร็จ')} finally{setSaving(false)} }
  return <Modal title="มอบหมายงาน" onClose={onClose}><div className="space-y-4"><Field label="ชื่องาน *"><input className="input" value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></Field><Field label="รายละเอียด"><textarea rows={3} className="input" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/></Field><div className="grid md:grid-cols-2 gap-3"><Field label="ประเภทงาน *"><select required aria-required="true" className={`input ${!form.category_id?'border-red-300 bg-red-50/40':''}`} value={form.category_id} onChange={e=>{setForm({...form,category_id:e.target.value});setError('')}}><option value="">เลือกประเภทงาน</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="ความสำคัญ"><select className="input" value={form.priority} onChange={e=>setForm({...form,priority:e.target.value as typeof form.priority})}><option value="normal">ปกติ</option><option value="high">สำคัญ</option><option value="urgent">เร่งด่วน</option></select></Field><Field label="ผู้รับผิดชอบหลัก *"><EmployeeSelect required value={form.assignee} employees={employees} onChange={selectPrimary}/></Field><Field label="หัวหน้างาน"><input className="input bg-gray-50" disabled value={nameOf(me)}/></Field><Field label="ผู้ประสานงาน"><EmployeeSelect value={form.coordinator} employees={employees} onChange={v=>setForm({...form,coordinator:v})}/></Field><Field label="ที่ปรึกษางาน"><EmployeeSelect value={form.advisor} employees={employees} onChange={v=>setForm({...form,advisor:v})}/></Field></div>
  <Field label="สมาชิกผู้รับผิดชอบ (เลือกได้มากกว่า 1 คน)"><div className="max-h-44 overflow-y-auto rounded-xl border p-2 grid gap-1 sm:grid-cols-2">{employees.map(employee=>{const checked=assigneeIds.includes(employee.id)||form.assignee===employee.id;return <label key={employee.id} className={`flex items-center gap-2 rounded-lg p-2 text-sm ${checked?'bg-emerald-50 text-emerald-800':'hover:bg-gray-50'}`}><input type="checkbox" checked={checked} disabled={form.assignee===employee.id} onChange={()=>toggleMember(employee.id)}/><span className="truncate">{nameOf(employee)}{form.assignee===employee.id?' · หลัก':''}</span></label>})}</div><p className="mt-1 text-xs text-gray-500">ผู้รับผิดชอบหลักเป็นผู้รวบรวมและส่งงานให้ตรวจ</p></Field>
  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
    <Field label="วันเริ่ม"><input type="date" className="input" value={form.start_date} onChange={e=>setForm({...form,start_date:e.target.value})}/></Field>
    <Field label="ให้เวลาทำ (ชม.)"><input type="number" min="0.5" step="0.5" className="input" placeholder="เช่น 4" value={form.duration_hours} onWheel={e=>e.currentTarget.blur()} onChange={e=>setForm({...form,duration_hours:e.target.value})}/></Field>
    <Field label="วันและเวลาส่ง *"><input type="datetime-local" className="input" value={form.due_at} onChange={e=>setForm({...form,due_at:e.target.value,duration_hours:''})}/></Field>
  </div>
  <p className="text-xs text-gray-500 -mt-2">กรอกจำนวนชั่วโมงเพื่อคำนวณ “วันและเวลาส่ง” อัตโนมัติ โดยนับเฉพาะเวลางานของผู้รับผิดชอบ — ข้ามนอกเวลางาน วันหยุดประจำสัปดาห์ วันหยุดบริษัทฯ และวันลาที่อนุมัติแล้ว (เลือกผู้รับผิดชอบก่อนเพื่อใช้ตารางเวลาของคนนั้น)</p>
  <div className="border border-emerald-100 bg-emerald-50/50 rounded-xl p-3">
    <div className="flex flex-wrap items-center justify-between gap-1 mb-2">
      <span className="text-sm font-semibold text-emerald-800">✦ แนะนำผู้รับผิดชอบสำหรับงานนี้</span>
      <span className="text-[11px] text-gray-500">อิงความถนัดประเภทงาน · คะแนนประเมิน · ภาระงาน · การส่งตรงเวลา</span>
    </div>
    {suggestions.length?<div className="space-y-1.5">{suggestions.map((s,i)=>{
      const selected=form.assignee===s.employee.id
      return <button key={s.employee.id} type="button" onClick={()=>selectPrimary(s.employee.id)}
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
  <div><div className="font-medium mb-2">Task ย่อย <span className="text-red-500">*</span></div>{items.map((x,i)=><div key={i} className="flex gap-2 mb-2"><input className="input" placeholder={`ข้อที่ ${i+1}`} value={x} onChange={e=>setItems(items.map((v,j)=>j===i?e.target.value:v))}/>{items.length>1&&<button onClick={()=>setItems(items.filter((_,j)=>j!==i))}><FiX/></button>}</div>)}<button onClick={()=>setItems([...items,''])} className="text-sm text-emerald-600">+ เพิ่มข้อ</button></div>{error&&<p className="text-red-600 text-sm">{error}</p>}<button disabled={saving||!form.title.trim()||!form.category_id||!form.assignee||!form.due_at||!items.some(item=>item.trim())} onClick={save} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:cursor-not-allowed disabled:opacity-50">{saving?'กำลังบันทึก...':'มอบหมายงาน'}</button></div></Modal>
}

function TaskDetailModal({task,employee,onClose,onEvaluate,onAcknowledgeAndStart,onChecklist,onSubmit}:{task:HRTask;employee:HREmployee|null;onClose:()=>void;onEvaluate:()=>void;onAcknowledgeAndStart:()=>Promise<void>;onChecklist:(id:string,completed:boolean)=>Promise<void>;onSubmit:(mode:'part'|'team')=>void}){
  const roleLabel={assignee:'ผู้รับผิดชอบ',supervisor:'หัวหน้างาน',coordinator:'ผู้ประสานงาน',advisor:'ที่ปรึกษา'} as const
  const link=task.completion_link?.trim()
  const safeLink=workLink(link)
  const isAssignee=!!employee&&!!task.participants?.some(p=>p.role==='assignee'&&p.employee_id===employee.id)
  const assignees=task.participants?.filter(p=>p.role==='assignee')??[]
  const myParticipant=assignees.find(p=>p.employee_id===employee?.id)
  const allPartsComplete=assignees.length>0&&assignees.every(p=>p.work_status==='completed')
  const canEvaluate=!!employee&&(task.created_by===employee.id||!!task.participants?.some(p=>p.role==='supervisor'&&p.employee_id===employee.id))
  const [checkBusy,setCheckBusy]=useState(false)
  const [events,setEvents]=useState<HRTaskEvent[]>([])
  const [eventsLoading,setEventsLoading]=useState(true)
  const [eventsError,setEventsError]=useState('')
  useEffect(()=>{let active=true;setEventsLoading(true);fetchTaskEvents(task.id).then(rows=>{if(active)setEvents(rows)}).catch(()=>{if(active)setEventsError('โหลดประวัติการส่งงานไม่สำเร็จ')}).finally(()=>{if(active)setEventsLoading(false)});return()=>{active=false}},[task.id])
  const submissionEvents=events.filter(event=>event.event_type==='submitted')
  const submissionHistory=submissionEvents.length?submissionEvents:(submissionTime(task)?[{id:'current-submission',task_id:task.id,event_type:'submitted',event_at:submissionTime(task)!,details:{}} as HRTaskEvent]:[])
  const checklistComplete=!task.checklist?.length||task.checklist.every(item=>item.is_completed)
  const canCheck=isAssignee&&['in_progress','revision'].includes(task.status)&&!checkBusy
  return <Modal title="รายละเอียดงาน" onClose={onClose}><div className="space-y-5">
    <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-bold">{task.title}</h3><span className={`px-2 py-1 rounded-full text-xs font-medium ${statusBadgeStyle(task.status)}`}>{STATUS[task.status]}</span></div><p className="text-xs text-gray-500 mt-1">{task.task_no} · {task.category?.name??'ไม่ระบุประเภท'}</p><p className="mt-1.5 text-xs text-slate-600">มอบหมายงานเมื่อ <span className="font-medium text-slate-700">{taskTime(task.created_at)}</span></p></div>
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3"><Info label="กำหนดส่ง" value={task.due_at?new Date(task.due_at).toLocaleString('th-TH'):'ไม่กำหนด'}/><Info label="เวลาทำงาน" value={elapsedText(task)}/><Info label="ความคืบหน้า" value={`${task.progress}%`}/></div>
    <section><h4 className="font-semibold mb-2">ประวัติเวลาและ SLA</h4><div className="grid gap-2 sm:grid-cols-2"><Info label="รับทราบงาน" value={`${taskTime(task.acknowledged_at)} · ${acknowledgementResult(task)}`}/><Info label="ส่งงานครั้งแรก" value={`${taskTime(submissionTime(task))} · ใช้เวลาทำงาน ${minutesBetween(task.started_at, submissionTime(task))}`}/></div>{dueResult(task)&&<div className={`mt-2 rounded-xl bg-gray-50 px-3 py-2 text-sm font-medium ${dueResult(task)!.tone}`}>ผลกำหนดส่ง: {dueResult(task)!.text}</div>}</section>
    <section><div className="mb-2 flex items-center justify-between gap-2"><h4 className="font-semibold">ประวัติการส่งงาน</h4>{submissionHistory.length>0&&<span className="text-xs text-gray-500">{submissionHistory.length} ครั้ง</span>}</div>{eventsLoading?<div className="rounded-xl bg-gray-50 px-3 py-4 text-center text-sm text-gray-400">กำลังโหลดประวัติ...</div>:submissionHistory.length?<div className="overflow-hidden rounded-xl border">{submissionHistory.map((event,index)=><div key={event.id} className="flex items-start gap-3 border-b p-3 last:border-b-0"><div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${index===0?'bg-emerald-100 text-emerald-700':'bg-blue-100 text-blue-700'}`}>{index+1}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{index===0?'ส่งงานครั้งแรก':`ส่งงานแก้ไขครั้งที่ ${index+1}`}</span>{index===0&&<span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">ใช้วัด SLA</span>}</div><div className="mt-0.5 text-sm text-gray-600">{taskTime(event.event_at)}</div>{event.actor&&<div className="mt-0.5 text-xs text-gray-400">โดย {nameOf(event.actor as HREmployee)}</div>}</div></div>)}</div>:<div className="rounded-xl bg-gray-50 px-3 py-4 text-center text-sm text-gray-400">ยังไม่มีประวัติการส่งงาน</div>}{eventsError&&<p className="mt-2 text-xs text-amber-600">{eventsError}</p>}</section>
    <section><h4 className="font-semibold mb-2">ผู้เกี่ยวข้อง</h4><div className="grid md:grid-cols-2 gap-2">{task.participants?.map(p=><div key={p.id} className="p-3 border rounded-xl"><div className="flex items-center justify-between gap-2"><div className="text-xs text-gray-500">{roleLabel[p.role]}{p.role==='assignee'&&p.is_primary?'หลัก':''}</div>{p.role==='assignee'&&<span className={`rounded-full px-2 py-0.5 text-[11px] ${p.work_status==='completed'?'bg-emerald-100 text-emerald-700':p.work_status==='in_progress'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>{p.work_status==='completed'?'เสร็จส่วนของตน':p.work_status==='in_progress'?'กำลังทำ':'รอรับทราบ'}</span>}</div><div className="font-medium">{nameOf(p.employee)}</div>{p.employee?.phone?<a href={`tel:${p.employee.phone.replace(/[^\d+]/g,'')}`} className="inline-flex items-center gap-1 mt-1 text-sm text-blue-600 hover:underline">โทร {p.employee.phone}</a>:<div className="mt-1 text-xs text-gray-400">ไม่มีเบอร์โทร</div>}{p.role==='assignee'&&p.submission_note&&<p className="mt-2 whitespace-pre-wrap text-xs text-gray-600">{p.submission_note}</p>}{p.role==='assignee'&&workLink(p.submission_link)&&<a href={workLink(p.submission_link)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-600"><FiExternalLink/> เปิดผลงานส่วนบุคคล</a>}</div>)}</div></section>
    <section><h4 className="font-semibold mb-2">รายละเอียด</h4><div className="p-3 rounded-xl bg-gray-50 whitespace-pre-wrap text-sm">{task.description||'ไม่มีรายละเอียดเพิ่มเติม'}</div></section>
    <section><div className="flex items-center justify-between mb-2"><h4 className="font-semibold">Task ย่อย</h4><span className="text-sm text-gray-500">{task.checklist?.filter(i=>i.is_completed).length??0}/{task.checklist?.length??0} ข้อ</span></div><div className="space-y-2">{task.checklist?.sort((a,b)=>a.sort_order-b.sort_order).map(i=><label key={i.id} className={`flex gap-2 p-3 rounded-xl bg-gray-50 ${canCheck?'cursor-pointer':'cursor-not-allowed opacity-70'}`}><input type="checkbox" checked={i.is_completed} disabled={!canCheck} onChange={async e=>{setCheckBusy(true);try{await onChecklist(i.id,e.target.checked)}finally{setCheckBusy(false)}}}/><span className={i.is_completed?'line-through text-gray-400':''}>{i.title}</span></label>)}{!task.checklist?.length&&<p className="text-sm text-gray-400">ไม่มี Task ย่อย</p>}</div>{isAssignee&&!['in_progress','revision'].includes(task.status)&&task.status!=='review'&&task.status!=='completed'&&<p className="mt-2 text-xs text-amber-600">ต้องเริ่มทำงานก่อนจึงจะเช็กรายการได้</p>}</section>
    {(task.completion_note||link)&&<section className="p-4 rounded-xl bg-blue-50 border border-blue-100"><h4 className="font-semibold text-blue-900">ข้อความส่งงานจากผู้รับผิดชอบ</h4>{task.completion_note&&<p className="mt-2 text-sm whitespace-pre-wrap">{task.completion_note}</p>}{safeLink&&<a href={safeLink} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-blue-700 font-medium text-sm"><FiExternalLink/> เปิดลิงก์ผลงาน</a>}</section>}
    <div className="grid gap-2">{isAssignee&&myParticipant?.work_status==='pending'&&!['completed','cancelled'].includes(task.status)&&<button onClick={onAcknowledgeAndStart} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">รับทราบและเริ่มงาน</button>}{isAssignee&&myParticipant?.work_status==='in_progress'&&['in_progress','revision'].includes(task.status)&&<button onClick={()=>onSubmit('part')} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">เสร็จส่วนของฉัน</button>}{isAssignee&&myParticipant?.work_status==='completed'&&myParticipant.is_primary&&allPartsComplete&&['in_progress','revision'].includes(task.status)&&<button disabled={!checklistComplete} onClick={()=>onSubmit('team')} className="w-full py-3 rounded-xl bg-blue-600 text-white font-semibold disabled:opacity-50">ส่งงานรวมให้ตรวจ</button>}{isAssignee&&myParticipant?.work_status==='completed'&&(!myParticipant.is_primary||!allPartsComplete)&&['in_progress','revision'].includes(task.status)&&<div className="rounded-xl bg-blue-50 p-3 text-center text-sm text-blue-700">{myParticipant.is_primary?'รอสมาชิกทำส่วนงานให้ครบ':'ทำส่วนของคุณเสร็จแล้ว รอผู้รับผิดชอบหลักส่งงานรวม'}</div>}{canEvaluate&&task.status==='review'&&<button onClick={onEvaluate} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold">ประเมิน</button>}</div>
  </div></Modal>
}

function SubmitWorkModal({task,mode,onClose,onSaved}:{task:HRTask;mode:'part'|'team';onClose:()=>void;onSaved:()=>void}){
  const [note,setNote]=useState(task.completion_note??'')
  const [link,setLink]=useState(task.completion_link??'')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const hasSubmission=!!note.trim()||!!link.trim()
  const save=async()=>{if(!hasSubmission){setError('กรุณาแนบลิงก์ผลงาน หรือกรอกข้อความส่งงานอย่างน้อย 1 รายการ');return}setSaving(true);setError('');try{if(mode==='part')await completeMyTaskPart(task.id,note.trim()||undefined,link.trim()||undefined);else await submitTeamTask(task.id,note.trim()||undefined,link.trim()||undefined);onSaved()}catch(e){setError(e instanceof Error?e.message:'ส่งงานไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title={mode==='part'?'เสร็จส่วนของฉัน':'ส่งงานรวมให้ตรวจ'} onClose={onClose}><div className="space-y-4"><div className="p-3 rounded-xl bg-gray-50"><div className="font-semibold">{task.title}</div><div className="text-xs text-gray-500">{task.task_no}</div></div><p className="text-sm text-amber-700">กรุณาแนบลิงก์ผลงาน หรือกรอกข้อความส่งงานอย่างน้อย 1 รายการ</p><Field label="ข้อความส่งงาน"><textarea autoFocus rows={5} className="input" value={note} onChange={e=>{setNote(e.target.value);setError('')}} placeholder="สรุปผลงานที่ทำเสร็จ หรือปัญหาที่พบ..."/></Field><Field label="ลิงก์ผลงาน"><input type="url" className="input" value={link} onChange={e=>{setLink(e.target.value);setError('')}} placeholder="https://..."/></Field>{error&&<p className="text-sm text-red-600">{error}</p>}<div className="flex justify-end"><button onClick={save} disabled={saving||!hasSubmission} className="rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving?'กำลังบันทึก...':mode==='part'?'ยืนยันว่าเสร็จส่วนของฉัน':'ส่งงานรวม'}</button></div></div></Modal>
}

function Info({label,value}:{label:string;value:string}){return <div className="p-3 border rounded-xl"><div className="text-xs text-gray-500">{label}</div><div className="font-semibold mt-1">{value}</div></div>}

function EvaluationModal({task,evaluator,onClose,onSaved}:{task:HRTask;evaluator:HREmployee;onClose:()=>void;onSaved:()=>void}){
  const [scores,setScores]=useState({speed:3,responsibility:3,quality:3,communication:3,problem_solving:3,teamwork:3})
  const [comment,setComment]=useState('')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const assignees=task.participants?.filter(p=>p.role==='assignee')??[]
  const save=async()=>{if(!assignees.length){setError('ไม่พบผู้รับผิดชอบงาน');return}setSaving(true);setError('');try{await Promise.all(assignees.map(assignee=>saveTaskEvaluation({task_id:task.id,employee_id:assignee.employee_id,evaluator_id:evaluator.id,...scores,comment:comment.trim()||undefined,visibility:'employee_visible'})));await updateTaskStatus(task.id,'completed');onSaved()}catch(e){setError(e instanceof Error?e.message:'บันทึกการประเมินไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title="ประเมินผลงาน" onClose={onClose}><div className="space-y-4"><div className="p-3 rounded-xl bg-gray-50"><div className="font-semibold">{task.title}</div><div className="text-sm text-gray-500">คะแนนทีมใช้ร่วมกัน: {assignees.map(assignee=>nameOf(assignee.employee)).join(', ')}</div></div>{([['speed','ความเร็ว'],['responsibility','ความรับผิดชอบ'],['quality','คุณภาพ'],['communication','การสื่อสาร'],['problem_solving','การแก้ปัญหา'],['teamwork','การทำงานเป็นทีม']] as const).map(([key,label])=><div key={key}><div className="flex justify-between mb-2"><span className="font-medium">{label}</span><span className="font-bold text-emerald-600">{scores[key]}/5</span></div><div className="grid grid-cols-5 gap-2">{[1,2,3,4,5].map(n=><button key={n} onClick={()=>setScores({...scores,[key]:n})} className={`py-2 rounded-lg border ${scores[key]===n?'bg-emerald-600 border-emerald-600 text-white':'hover:bg-gray-50'}`}>{n}</button>)}</div></div>)}<Field label="หมายเหตุการรีวิว"><textarea rows={3} className="input" value={comment} onChange={e=>setComment(e.target.value)} placeholder="คะแนนและหมายเหตุจะแสดงแก่ผู้รับผิดชอบทุกคน"/></Field>{error&&<p className="text-sm text-red-600">{error}</p>}<div className="flex justify-end"><button onClick={save} disabled={saving||!assignees.length} className="rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white disabled:opacity-50">{saving?'กำลังบันทึก...':'บันทึกคะแนนทีมและผ่านงาน'}</button></div></div></Modal>
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
function TaskAssignerModal({employees,selectedIds,onClose,onSaved}:{employees:HREmployee[];selectedIds:string[];onClose:()=>void;onSaved:(ids:string[])=>Promise<void>}){
  const [selected,setSelected]=useState<string[]>(selectedIds)
  const [search,setSearch]=useState('')
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const visible=employees.filter((employee)=>`${employee.employee_code} ${nameOf(employee)}`.toLowerCase().includes(search.trim().toLowerCase()))
  const save=async()=>{setSaving(true);setError('');try{await saveTaskAssignerPermissions(selected);await onSaved(selected)}catch(e){setError(e instanceof Error?e.message:'บันทึกรายชื่อผู้มอบหมายงานไม่สำเร็จ')}finally{setSaving(false)}}
  return <Modal title="รายชื่อผู้มอบหมายงานได้" onClose={onClose}><div className="space-y-4">
    <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4"><h3 className="font-semibold text-emerald-900">สิทธิ์มอบหมายและรีวิวงาน</h3><p className="mt-1 text-sm text-emerald-800">พนักงานที่เลือกจะสามารถมอบหมายงานให้พนักงานคนอื่น และรีวิวงานที่ตนมอบหมายเมื่อผู้รับผิดชอบส่งงานเสร็จ</p></div>
    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-semibold">เลือกพนักงาน</div><div className="text-xs text-gray-500">เลือกแล้ว {selected.length} คน</div></div><div className="flex gap-2"><button type="button" onClick={()=>setSelected(employees.map(employee=>employee.id))} className="rounded-lg border px-3 py-1.5 text-xs text-emerald-700">เลือกทั้งหมด</button><button type="button" onClick={()=>setSelected([])} className="rounded-lg border px-3 py-1.5 text-xs text-gray-600">ล้างทั้งหมด</button></div></div>
    <label className="relative block"><FiSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="ค้นหารหัสหรือชื่อพนักงาน..." className="w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-10 pr-3 focus:border-emerald-600 focus:outline-none focus:ring-4 focus:ring-emerald-100"/></label>
    <div className="max-h-[48vh] overflow-y-auto rounded-xl border p-2">{visible.map(employee=><label key={employee.id} className={`flex cursor-pointer items-center gap-3 rounded-lg p-3 ${selected.includes(employee.id)?'bg-emerald-50':'hover:bg-gray-50'}`}><input type="checkbox" checked={selected.includes(employee.id)} onChange={event=>setSelected(event.target.checked?[...selected,employee.id]:selected.filter(id=>id!==employee.id))} className="h-4 w-4 accent-emerald-600"/><div className="min-w-0"><div className="font-medium text-gray-900">{nameOf(employee)}</div><div className="text-xs text-gray-500">{employee.employee_code}{employee.position?.name?` · ${employee.position.name}`:''}</div></div>{selected.includes(employee.id)&&<span className="ml-auto rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700">มอบหมายและรีวิวได้</span>}</label>)}{!visible.length&&<div className="py-10 text-center text-gray-400">ไม่พบพนักงาน</div>}</div>
    {error&&<p className="text-sm text-red-600">{error}</p>}
    <button disabled={saving} onClick={save} className="w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white disabled:opacity-50">{saving?'กำลังบันทึก...':'บันทึกรายชื่อ'}</button>
  </div></Modal>
}
function EmployeeSelect({value,employees,onChange,required=false}:{value:string;employees:HREmployee[];onChange:(v:string)=>void;required?:boolean}){return <select required={required} aria-required={required} className={`input ${required&&!value?'border-red-300 bg-red-50/40':''}`} value={value} onChange={e=>onChange(e.target.value)}><option value="">เลือกพนักงาน</option>{employees.map(e=><option key={e.id} value={e.id}>{e.employee_code} · {nameOf(e)}</option>)}</select>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label className="block"><span className="block text-sm font-medium mb-1">{label}</span>{children}</label>}
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="relative bg-white rounded-2xl w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-hidden flex flex-col shadow-2xl">
        <ModalCloseButton onClick={onClose} className="absolute right-3 top-3 z-20" />
        <div className="sticky top-0 z-10 flex items-center px-5 py-4 pr-16 border-b bg-white">
          <h2 className="text-xl font-bold">{title}</h2>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
