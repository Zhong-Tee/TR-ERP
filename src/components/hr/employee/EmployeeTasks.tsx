import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { FiAlertCircle, FiCheck, FiChevronDown, FiChevronUp, FiClock, FiPlus, FiX } from 'react-icons/fi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { createHRTask, fetchEmployeeByUserId, fetchTaskCategories, fetchTaskTeams, fetchTasks, toggleTaskChecklist, updateTaskStatus } from '../../../lib/hrApi'
import type { HREmployee, HRTask, HRTaskCategory, HRTaskStatus } from '../../../types'

const labels: Record<HRTaskStatus, string> = { draft: 'แบบร่าง', new: 'งานใหม่', acknowledged: 'รับทราบแล้ว', in_progress: 'กำลังทำ', review: 'รอตรวจ', revision: 'ขอแก้ไข', completed: 'เสร็จแล้ว', paused: 'พักงาน', cancelled: 'ยกเลิก' }
const active: HRTaskStatus[] = ['new', 'acknowledged', 'in_progress', 'review', 'revision']

export default function EmployeeTasks() {
  const { user } = useAuthContext()
  const [me, setMe] = useState<HREmployee | null>(null)
  const [tasks, setTasks] = useState<HRTask[]>([])
  const [tab, setTab] = useState<'active' | 'completed'>('active')
  const [scope, setScope] = useState<'mine' | 'managed'>('mine')
  const [open, setOpen] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [submitTask, setSubmitTask] = useState<HRTask | null>(null)
  const [submitNote, setSubmitNote] = useState('')
  const [submitLink, setSubmitLink] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [canAssign, setCanAssign] = useState(false)
  const [assignableEmployees, setAssignableEmployees] = useState<HREmployee[]>([])
  const [categories, setCategories] = useState<HRTaskCategory[]>([])

  const load = async (employee: HREmployee) => setTasks(await fetchTasks({ employeeId: employee.id }))
  useEffect(() => {
    if (!user?.id) return
    fetchEmployeeByUserId(user.id).then((employee) => {
      setMe(employee)
      if (employee) {
        load(employee)
        Promise.all([fetchTaskTeams(),fetchTaskCategories()]).then(([teams,categoryRows])=>{
          type TeamMember={employee_id:string;role:'manager'|'member';employee?:HREmployee}
          type TeamRow={members?:TeamMember[]}
          const managed=(teams as unknown as TeamRow[]).filter(team=>team.members?.some(member=>member.role==='manager'&&member.employee_id===employee.id))
          const unique=new Map<string,HREmployee>()
          managed.flatMap(team=>team.members??[]).filter(member=>member.role==='member'&&member.employee).forEach(member=>unique.set(member.employee_id,member.employee!))
          setCanAssign(managed.length>0);setAssignableEmployees([...unique.values()]);setCategories(categoryRows)
        }).catch(()=>{})
      }
    }).catch((e) => setError(e.message))
  }, [user?.id])

  const isMine = (task: HRTask) => !!me && !!task.participants?.some((p) => p.role === 'assignee' && p.employee_id === me.id)
  const isManaged = (task: HRTask) => !!me && (task.created_by === me.id || !!task.participants?.some((p) => p.role === 'supervisor' && p.employee_id === me.id))
  const scopedTasks = useMemo(() => tasks.filter((task) => scope === 'mine' ? isMine(task) : isManaged(task)), [tasks, scope, me?.id])
  const shown = useMemo(() => scopedTasks.filter((task) => tab === 'completed' ? task.status === 'completed' : active.includes(task.status)), [scopedTasks, tab])
  const change = async (task: HRTask, status: HRTaskStatus, note?: string) => {
    if (!me) return
    setBusy(true); setError('')
    try { await updateTaskStatus(task.id, status, note); await load(me) }
    catch (e) { setError(e instanceof Error ? e.message : 'อัปเดตไม่สำเร็จ') }
    finally { setBusy(false) }
  }
  const sendForReview = async () => {
    if (!submitTask) return
    if (!me) return
    setBusy(true); setError('')
    try {
      await updateTaskStatus(submitTask.id, 'review', submitNote.trim() || undefined, submitLink.trim() || undefined)
      await load(me); setSubmitTask(null); setSubmitNote(''); setSubmitLink('')
    } catch (e) { setError(e instanceof Error ? e.message : 'ส่งงานไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  return <>
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-bold">งาน</h1><p className="text-sm text-gray-500">งานที่ได้รับมอบหมายและความคืบหน้า</p></div>{canAssign&&<button onClick={()=>setShowCreate(true)} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold"><FiPlus/> มอบหมายงาน</button>}</div>
      {error && <div className="bg-red-50 text-red-700 p-3 rounded-xl text-sm">{error}</div>}
      <div className="grid grid-cols-3 gap-2">
        {[
          ['งานใหม่', scopedTasks.filter((t) => t.status === 'new').length],
          ['กำลังทำ', scopedTasks.filter((t) => ['acknowledged', 'in_progress', 'revision'].includes(t.status)).length],
          ['เลยกำหนด', scopedTasks.filter((t) => t.due_at && active.includes(t.status) && new Date(t.due_at) < new Date()).length],
        ].map(([label, count]) => <div key={label} className="bg-white border rounded-xl p-3 text-center"><div className="text-xl font-bold text-emerald-600">{count}</div><div className="text-xs text-gray-500">{label}</div></div>)}
      </div>
      <div className="grid grid-cols-2 gap-2 bg-white border rounded-xl p-1">
        <button onClick={() => setScope('mine')} className={`py-2.5 px-2 rounded-lg text-sm font-medium ${scope === 'mine' ? 'bg-emerald-600 text-white' : 'text-gray-600'}`}>งานที่ฉันต้องทำ ({tasks.filter(isMine).length})</button>
        <button onClick={() => setScope('managed')} className={`py-2.5 px-2 rounded-lg text-sm font-medium ${scope === 'managed' ? 'bg-blue-600 text-white' : 'text-gray-600'}`}>งานที่ฉันติดตาม ({tasks.filter(isManaged).length})</button>
      </div>
      <div className="flex bg-white border rounded-xl p-1">
        <button onClick={() => setTab('active')} className={`flex-1 py-2 rounded-lg text-sm ${tab === 'active' ? 'bg-emerald-600 text-white' : ''}`}>กำลังดำเนินการ ({scopedTasks.filter((t) => active.includes(t.status)).length})</button>
        <button onClick={() => setTab('completed')} className={`flex-1 py-2 rounded-lg text-sm ${tab === 'completed' ? 'bg-emerald-600 text-white' : ''}`}>เสร็จแล้ว</button>
      </div>
      <div className="space-y-3">
        {shown.map((task) => {
          const late = !!task.due_at && active.includes(task.status) && new Date(task.due_at) < new Date()
          const expanded = open === task.id
          const mineTask = isMine(task)
          return <article key={task.id} className="bg-white border rounded-2xl overflow-hidden">
            <button onClick={() => setOpen(expanded ? undefined : task.id)} className="w-full text-left p-4">
              <div className="flex justify-between gap-2"><div><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{task.title}</span><span className={`text-[10px] px-2 py-0.5 rounded-full ${mineTask?'bg-emerald-50 text-emerald-700':'bg-blue-50 text-blue-700'}`}>{mineTask?'งานที่ฉันต้องทำ':'งานที่ติดตาม'}</span></div><div className="text-xs text-gray-500">{task.task_no} · {task.category?.name ?? 'งานทั่วไป'}</div></div>{expanded ? <FiChevronUp /> : <FiChevronDown />}</div>
              <div className="flex items-center justify-between mt-3"><span className={`text-xs px-2 py-1 rounded-full ${late ? 'bg-red-100 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{late ? 'เลยกำหนด' : labels[task.status]}</span><span className={`flex items-center gap-1 text-xs ${late ? 'text-red-600' : 'text-gray-500'}`}><FiClock />{task.due_at ? new Date(task.due_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : 'ไม่กำหนด'}</span></div>
              <div className="mt-3 h-2 rounded-full bg-gray-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${task.progress}%` }} /></div>
            </button>
            {expanded && <div className="border-t p-4 space-y-4">
              <p className="text-sm whitespace-pre-wrap text-gray-700">{task.description || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
              {!!task.checklist?.length && <div><h3 className="font-medium text-sm mb-2">รายการงาน</h3><div className="space-y-2">{task.checklist.sort((a, b) => a.sort_order - b.sort_order).map((item) => <label key={item.id} className="flex gap-3 p-2 rounded-lg bg-gray-50"><input type="checkbox" checked={item.is_completed} disabled={!mineTask || busy || task.status === 'completed' || task.status === 'review'} onChange={async (e) => { await toggleTaskChecklist(item.id, e.target.checked); if (me) await load(me) }} /><span className={`text-sm ${item.is_completed ? 'line-through text-gray-400' : ''}`}>{item.title}</span></label>)}</div></div>}
              <div className="grid gap-2">
                {mineTask && task.status === 'new' && <button disabled={busy} onClick={() => change(task, 'acknowledged')} className="py-3 rounded-xl bg-emerald-600 text-white font-semibold">รับทราบงาน</button>}
                {mineTask && task.status === 'acknowledged' && <button disabled={busy} onClick={() => change(task, 'in_progress')} className="py-3 rounded-xl bg-emerald-600 text-white font-semibold">เริ่มทำงาน</button>}
                {mineTask && ['in_progress', 'revision'].includes(task.status) && <button disabled={busy} onClick={() => { setSubmitNote(''); setSubmitLink(''); setSubmitTask(task) }} className="py-3 rounded-xl bg-emerald-600 text-white font-semibold">ส่งงานให้ตรวจ</button>}
                {task.status === 'review' && <div className="flex items-center gap-2 justify-center p-3 rounded-xl bg-amber-50 text-amber-700 text-sm"><FiAlertCircle />{mineTask?'รอหัวหน้าตรวจงาน':'ลูกทีมส่งงานแล้ว รอการตรวจ'}</div>}
                {mineTask && task.status === 'review' && <button disabled={busy} onClick={() => { setSubmitNote(task.completion_note??''); setSubmitLink(task.completion_link??''); setSubmitTask(task) }} className="py-3 rounded-xl border border-blue-300 bg-blue-50 text-blue-700 font-semibold">แก้ไขการส่งงาน</button>}
                {task.status === 'completed' && <div className="flex items-center gap-2 justify-center p-3 rounded-xl bg-emerald-50 text-emerald-700"><FiCheck />งานเสร็จสมบูรณ์</div>}
              </div>
            </div>}
          </article>
        })}
        {!shown.length && <div className="text-center py-12 text-gray-400">ยังไม่มีงานในรายการนี้</div>}
      </div>
    </div>
    {submitTask && createPortal(<div className="fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b"><div><h2 className="font-bold text-lg">{submitTask.status==='review'?'แก้ไขการส่งงาน':'ส่งงานให้ตรวจ'}</h2><p className="text-xs text-gray-500 mt-0.5">{submitTask.title}</p></div><button onClick={() => setSubmitTask(null)} className="p-2 rounded-lg hover:bg-gray-100" aria-label="ปิด"><FiX className="w-5 h-5" /></button></div>
        <div className="p-5 space-y-4"><label className="block"><span className="block text-sm font-medium mb-2">สรุปผลการทำงาน <span className="text-gray-400">(ถ้ามี)</span></span><textarea autoFocus rows={5} value={submitNote} onChange={(e) => setSubmitNote(e.target.value)} placeholder="ระบุผลงานที่ทำเสร็จหรือปัญหาที่พบ..." className="w-full resize-none border border-gray-300 rounded-xl p-3 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label><label className="block"><span className="block text-sm font-medium mb-2">ลิงก์ผลงาน <span className="text-gray-400">(ถ้ามี)</span></span><input type="url" inputMode="url" value={submitLink} onChange={(e) => setSubmitLink(e.target.value)} placeholder="https://..." className="w-full border border-gray-300 rounded-xl p-3 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" /></label><div className="grid grid-cols-2 gap-3"><button disabled={busy} onClick={() => setSubmitTask(null)} className="py-3 border rounded-xl font-semibold">ยกเลิก</button><button disabled={busy} onClick={sendForReview} className="py-3 bg-emerald-600 text-white rounded-xl font-semibold disabled:opacity-50">{busy ? 'กำลังบันทึก...' : submitTask.status==='review'?'บันทึกการแก้ไข':'ส่งงาน'}</button></div></div>
      </div>
    </div>, document.body)}
    {showCreate&&me&&<MobileCreateTaskModal me={me} employees={assignableEmployees} categories={categories} onClose={()=>setShowCreate(false)} onSaved={async()=>{setShowCreate(false);await load(me);setScope('managed')}}/>}
  </>
}

function MobileCreateTaskModal({me,employees,categories,onClose,onSaved}:{me:HREmployee;employees:HREmployee[];categories:HRTaskCategory[];onClose:()=>void;onSaved:()=>void}){
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[category,setCategory]=useState(''),[assignee,setAssignee]=useState(''),[priority,setPriority]=useState<'normal'|'high'|'urgent'>('normal'),[dueAt,setDueAt]=useState(''),[items,setItems]=useState(['']),[saving,setSaving]=useState(false),[error,setError]=useState('')
  const save=async()=>{if(!title.trim()||!assignee||!dueAt){setError('กรุณากรอกชื่องาน ผู้รับผิดชอบ และกำหนดส่ง');return}setSaving(true);setError('');try{await createHRTask({title:title.trim(),description:description.trim()||undefined,category_id:category||undefined,priority,start_date:new Date().toISOString().slice(0,10),due_at:new Date(dueAt).toISOString(),created_by:me.id,participants:[{employee_id:assignee,role:'assignee',is_primary:true},{employee_id:me.id,role:'supervisor',is_primary:true}],checklist:items.filter(i=>i.trim()).map((item,index)=>({title:item.trim(),assignee_id:assignee,sort_order:index}))});onSaved()}catch(e){setError(e instanceof Error?e.message:'มอบหมายงานไม่สำเร็จ')}finally{setSaving(false)}}
  return createPortal(<div className="fixed inset-0 z-[1000] bg-black/50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true"><div className="w-full sm:max-w-lg max-h-[92vh] bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"><div className="flex items-center justify-between px-4 py-3 border-b"><h2 className="text-lg font-bold">มอบหมายงาน</h2><button onClick={onClose} className="p-2"><FiX className="w-5 h-5"/></button></div><div className="overflow-y-auto p-4 space-y-4"><MobileField label="ชื่องาน *"><input value={title} onChange={e=>setTitle(e.target.value)} className="mobile-input"/></MobileField><MobileField label="รายละเอียด"><textarea rows={3} value={description} onChange={e=>setDescription(e.target.value)} className="mobile-input resize-none"/></MobileField><div className="grid grid-cols-2 gap-3"><MobileField label="ประเภทงาน"><select value={category} onChange={e=>setCategory(e.target.value)} className="mobile-input"><option value="">ไม่ระบุ</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></MobileField><MobileField label="ความสำคัญ"><select value={priority} onChange={e=>setPriority(e.target.value as typeof priority)} className="mobile-input"><option value="normal">ปกติ</option><option value="high">สำคัญ</option><option value="urgent">เร่งด่วน</option></select></MobileField></div><MobileField label="ผู้รับผิดชอบ *"><select value={assignee} onChange={e=>setAssignee(e.target.value)} className="mobile-input"><option value="">เลือกลูกทีม</option>{employees.map(e=><option key={e.id} value={e.id}>{e.position?.name||'ไม่ระบุตำแหน่ง'} · {e.nickname||e.first_name} ({e.employee_code})</option>)}</select></MobileField><MobileField label="วันและเวลาส่ง *"><input type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)} className="mobile-input"/></MobileField><div><div className="text-sm font-medium mb-2">Task ย่อย</div>{items.map((item,index)=><div key={index} className="flex gap-2 mb-2"><input value={item} onChange={e=>setItems(items.map((x,i)=>i===index?e.target.value:x))} placeholder={`ข้อที่ ${index+1}`} className="mobile-input"/>{items.length>1&&<button onClick={()=>setItems(items.filter((_,i)=>i!==index))}><FiX/></button>}</div>)}<button onClick={()=>setItems([...items,''])} className="text-sm text-emerald-600">+ เพิ่มข้อ</button></div>{error&&<p className="text-sm text-red-600">{error}</p>}<button disabled={saving||employees.length===0} onClick={save} className="w-full py-3 rounded-xl bg-emerald-600 text-white font-semibold disabled:opacity-50">{saving?'กำลังบันทึก...':'มอบหมายงาน'}</button>{employees.length===0&&<p className="text-xs text-center text-amber-600">ทีมนี้ยังไม่มีลูกทีมที่สามารถมอบหมายงานได้</p>}</div><style>{`.mobile-input{width:100%;border:1px solid #d1d5db;border-radius:.75rem;padding:.7rem .8rem;background:#fff}.mobile-input:focus{outline:none;border-color:#059669;box-shadow:0 0 0 3px #d1fae5}`}</style></div></div>,document.body)
}
function MobileField({label,children}:{label:string;children:React.ReactNode}){return <label className="block"><span className="block text-sm font-medium mb-1.5">{label}</span>{children}</label>}
