import { supabase } from './supabase'

export type ReadinessStatus = 'ready' | 'pending' | 'failed' | 'no_checklist'
export type IncidentStatus = 'reported' | 'accepted' | 'repairing' | 'testing' | 'ready' | 'closed' | 'cancelled'

export interface ChecklistItem { id:string; machine_id:string; label:string; description:string|null; input_type:'boolean'|'number'|'text'; min_value:number|null; max_value:number|null; unit:string|null; requires_photo:boolean; is_required:boolean; frequency:'daily'|'shift'|'job'; sort_order:number; is_active:boolean }
export interface Inspection { id:string; machine_id:string; inspection_date:string; shift_key:string; status:'in_progress'|'passed'|'failed'; note:string|null; inspected_at:string|null }
export interface InspectionResult { id?:string; inspection_id:string; checklist_item_id:string; passed:boolean|null; value_text:string|null; value_number:number|null; photo_url:string|null; note:string|null }
export interface MachineryIncident { id:string; ticket_no:string; machine_id:string; title:string; symptom:string|null; severity:'low'|'medium'|'high'|'critical'; status:IncidentStatus; plan_job_id:string|null; reported_at:string; accepted_at:string|null; repair_started_at:string|null; repair_completed_at:string|null; ready_at:string|null; closed_at:string|null; expected_ready_at:string|null; root_cause:string|null; resolution:string|null; note:string|null }
export interface MachineReadiness { machine_id:string; status:ReadinessStatus; inspection:Inspection|null; required_count:number; passed_count:number; failed_count:number }
export interface MachineryInspectionUser { id:string; username:string|null; email:string|null; role:string; is_active:boolean|null }

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus,string> = { reported:'แจ้งเสีย', accepted:'ช่างรับงาน', repairing:'กำลังซ่อม', testing:'รอทดสอบ', ready:'พร้อมใช้งาน', closed:'ปิดใบงาน', cancelled:'ยกเลิก' }

export async function fetchChecklistItems(machineId?:string):Promise<ChecklistItem[]> {
  let q = supabase.from('pr_machinery_checklist_items').select('*').eq('is_active',true).order('sort_order')
  if (machineId) q = q.eq('machine_id',machineId)
  const {data,error}=await q; if(error) throw error; return (data||[]) as ChecklistItem[]
}
export async function saveChecklistItem(row:Partial<ChecklistItem>&{machine_id:string;label:string}) {
  const payload={...row,label:row.label.trim()}; const {data,error}=row.id
    ? await supabase.from('pr_machinery_checklist_items').update(payload).eq('id',row.id).select().single()
    : await supabase.from('pr_machinery_checklist_items').insert(payload).select().single()
  if(error) throw error; return data as ChecklistItem
}
export async function disableChecklistItem(id:string){const {error}=await supabase.from('pr_machinery_checklist_items').update({is_active:false}).eq('id',id);if(error)throw error}

export async function fetchInspectionAccessUserIds(machineId:string):Promise<string[]> {
  const {data,error}=await supabase.from('pr_machinery_inspection_machine_users').select('user_id').eq('machine_id',machineId)
  if(error) throw error
  return (data||[]).map((row:{user_id:string})=>row.user_id)
}
export async function fetchInspectionAccessMachineIds(userId:string):Promise<string[]> {
  const {data,error}=await supabase.from('pr_machinery_inspection_machine_users').select('machine_id').eq('user_id',userId)
  if(error) throw error
  return (data||[]).map((row:{machine_id:string})=>row.machine_id)
}
export async function fetchInspectionAccessCandidates():Promise<MachineryInspectionUser[]> {
  const {data,error}=await supabase.rpc('get_machinery_inspection_access_candidates')
  if(error) throw error
  return (data||[]) as MachineryInspectionUser[]
}
export async function saveInspectionAccessUserIds(machineId:string,userIds:string[]):Promise<void> {
  const {data:{user}}=await supabase.auth.getUser()
  const currentIds=await fetchInspectionAccessUserIds(machineId)
  const desiredIds=[...new Set(userIds)]
  const desiredSet=new Set(desiredIds)
  const currentSet=new Set(currentIds)
  const removed=currentIds.filter(id=>!desiredSet.has(id))
  const added=desiredIds.filter(id=>!currentSet.has(id))
  if(removed.length){const {error}=await supabase.from('pr_machinery_inspection_machine_users').delete().eq('machine_id',machineId).in('user_id',removed);if(error)throw error}
  if(added.length){const {error}=await supabase.from('pr_machinery_inspection_machine_users').insert(added.map(user_id=>({machine_id:machineId,user_id,created_by:user?.id||null})));if(error)throw error}
}

export async function fetchTodayInspections(date:string):Promise<{inspections:Inspection[];results:InspectionResult[]}> {
  const {data:inspections,error}=await supabase.from('pr_machinery_inspections').select('*').eq('inspection_date',date)
  if(error) throw error; const ids=(inspections||[]).map(x=>x.id); if(!ids.length)return {inspections:[],results:[]}
  const {data:results,error:re}=await supabase.from('pr_machinery_inspection_results').select('*').in('inspection_id',ids);if(re)throw re
  return {inspections:(inspections||[]) as Inspection[],results:(results||[]) as InspectionResult[]}
}
export function buildReadiness(machineIds:string[],items:ChecklistItem[],inspections:Inspection[],results:InspectionResult[]):MachineReadiness[]{
  return machineIds.map(machine_id=>{const required=items.filter(i=>i.machine_id===machine_id&&i.is_required);const inspection=inspections.find(i=>i.machine_id===machine_id)||null
    if(!required.length)return{machine_id,status:'no_checklist',inspection,required_count:0,passed_count:0,failed_count:0}
    const rr=inspection?results.filter(r=>r.inspection_id===inspection.id&&required.some(i=>i.id===r.checklist_item_id)):[];const passed=rr.filter(r=>r.passed===true).length;const failed=rr.filter(r=>r.passed===false).length
    return{machine_id,status:failed?'failed':passed===required.length&&inspection?.status==='passed'?'ready':'pending',inspection,required_count:required.length,passed_count:passed,failed_count:failed}
  })
}
export async function submitInspection(machineId:string,date:string,values:Record<string,{passed:boolean;value_text?:string;value_number?:number;note?:string}>){
  const {data:u}=await supabase.auth.getUser();const items=await fetchChecklistItems(machineId);const required=items.filter(i=>i.is_required);const failed=required.some(i=>values[i.id]?.passed!==true);const status=failed?'failed':'passed';
  const {data:inspection,error}=await supabase.from('pr_machinery_inspections').upsert({machine_id:machineId,inspection_date:date,shift_key:'day',status,inspected_by:u.user?.id||null,inspected_at:new Date().toISOString()},{onConflict:'machine_id,inspection_date,shift_key'}).select().single();if(error)throw error
  const rows=items.map(i=>({inspection_id:inspection.id,checklist_item_id:i.id,passed:values[i.id]?.passed??null,value_text:values[i.id]?.value_text||null,value_number:values[i.id]?.value_number??null,note:values[i.id]?.note||null}))
  if(rows.length){const {error:e}=await supabase.from('pr_machinery_inspection_results').upsert(rows,{onConflict:'inspection_id,checklist_item_id'});if(e)throw e}return inspection as Inspection
}
export async function fetchIncidents(includeClosed=true):Promise<MachineryIncident[]>{let q=supabase.from('pr_machinery_incidents').select('*').order('reported_at',{ascending:false});if(!includeClosed)q=q.not('status','in','(closed,cancelled)');const{data,error}=await q;if(error)throw error;return(data||[])as MachineryIncident[]}
export async function createIncident(row:{machine_id:string;title:string;symptom?:string;severity:MachineryIncident['severity'];expected_ready_at?:string|null;plan_job_id?:string|null}){const{data:u}=await supabase.auth.getUser();const{data,error}=await supabase.from('pr_machinery_incidents').insert({...row,reported_by:u.user?.id||null}).select().single();if(error)throw error;return data as MachineryIncident}
export async function updateIncidentStatus(id:string,status:IncidentStatus,extra:Partial<MachineryIncident>={}){const now=new Date().toISOString();const stamps:Record<string,string>={accepted:'accepted_at',repairing:'repair_started_at',testing:'repair_completed_at',ready:'ready_at',closed:'closed_at'};const payload:Record<string,unknown>={...extra,status};if(stamps[status])payload[stamps[status]]=now;const{data,error}=await supabase.from('pr_machinery_incidents').update(payload).eq('id',id).select().single();if(error)throw error;return data as MachineryIncident}

export function overlapHours(startA:Date,endA:Date,startB:Date,endB:Date){return Math.max(0,Math.min(endA.getTime(),endB.getTime())-Math.max(startA.getTime(),startB.getTime()))/3600000}
