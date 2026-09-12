export type ResponsibilityLevel = 'supervisor' | 'lead' | 'operator' | 'assistant' | 'trainee'
export type QualificationStatus = 'qualified' | 'training' | 'blocked'
export type SkillLevel = 0 | 1 | 2 | 3

export interface ManpowerEmployee { id:string; employee_code:string; first_name:string; last_name:string; nickname?:string|null; employment_status:string; department?:{name?:string|null}|null; position?:{name?:string|null}|null }
export interface EmployeeProfile { employee_id:string; responsibility_level:ResponsibilityLevel; is_available_for_planning:boolean; max_concurrent_jobs:number; note?:string|null }
export interface EmployeeSkill {
  id?:string
  employee_id:string
  department_name:string
  process_name:string
  /** ฟิลด์ใหม่สำหรับ Skill Matrix แบบ 4 ระดับ */
  skill_level?:SkillLevel
  is_supervisor?:boolean
  primary_queue_order?:number|null
  /** ฟิลด์เดิมเก็บไว้เพื่อรองรับข้อมูลก่อน migration 516 */
  proficiency:number
  efficiency_percent:number
  qualification_status:QualificationStatus
  is_primary:boolean
  max_concurrent_jobs:number
  assessed_at?:string|null
  valid_until?:string|null
}
export interface OperationRequirement { id?:string; department_name:string; process_name:string; required_workers:number; minimum_proficiency:number; required_supervisors:number; allow_supervisor_as_worker?:boolean }

export const RESPONSIBILITY_LABELS: Record<ResponsibilityLevel,string> = { supervisor:'หัวหน้า', lead:'ผู้เชี่ยวชาญ', operator:'ฝ่ายผลิต', assistant:'ผู้ช่วย', trainee:'ฝึกหัด' }
export const SKILL_LEVEL_LABELS:Record<SkillLevel,string>={0:'ทำไม่ได้',1:'ฝึกงาน',2:'ทำได้',3:'เชี่ยวชาญ'}

/** แปลงข้อมูลเก่าให้ทำงานได้ระหว่าง rollout migration */
export function skillLevelOf(skill:EmployeeSkill):SkillLevel {
  if(skill.skill_level!==undefined&&skill.skill_level!==null)return skill.skill_level
  if(skill.qualification_status==='blocked')return 0
  if(skill.qualification_status==='training')return 1
  return skill.proficiency>=4?3:2
}

/** คะแนนใช้เก็บประวัติเท่านั้น การเลือกคนใช้ลำดับคิวและระดับความสามารถ */
export function manpowerScore(skill:EmployeeSkill) {
  const level=skillLevelOf(skill)
  if(level===0)return -1
  return level*100+(skill.is_primary?1000:0)
}

/** งานหลักเรียงตามคิวที่กำหนด จากนั้นคนสำรองเรียง เชี่ยวชาญ > ทำได้ > ฝึกงาน */
export function compareManpowerSkills(a:EmployeeSkill,b:EmployeeSkill) {
  const primaryDifference=Number(b.is_primary)-Number(a.is_primary)
  if(primaryDifference)return primaryDifference
  if(a.is_primary&&b.is_primary){
    const orderDifference=(a.primary_queue_order??Number.MAX_SAFE_INTEGER)-(b.primary_queue_order??Number.MAX_SAFE_INTEGER)
    if(orderDifference)return orderDifference
  }
  return skillLevelOf(b)-skillLevelOf(a)||a.employee_id.localeCompare(b.employee_id)
}

/** หมุนคิวงานหลักให้คนถัดจากผู้ที่ได้รับงานล่าสุดขึ้นก่อน */
export function rotatePrimaryQueue(skills:EmployeeSkill[],lastEmployeeId?:string|null) {
  const ordered=[...skills].sort(compareManpowerSkills)
  if(!lastEmployeeId)return ordered
  const index=ordered.findIndex(skill=>skill.employee_id===lastEmployeeId)
  return index<0?ordered:[...ordered.slice(index+1),...ordered.slice(0,index+1)]
}

/** จัดผู้สมัครตามกติกา: งานหลักแบบ Round-robin ก่อน แล้วค่อยระดับสูงลงต่ำ */
export function assignmentCandidates(skills:EmployeeSkill[],lastPrimaryEmployeeId?:string|null) {
  const primary=rotatePrimaryQueue(skills.filter(skill=>skill.is_primary),lastPrimaryEmployeeId)
  const reserve=skills.filter(skill=>!skill.is_primary).sort(compareManpowerSkills)
  return [...primary,...reserve]
}

export function operatorSkillCandidates(skills:EmployeeSkill[],allowSupervisorAsWorker:boolean) {
  const operators=skills.filter(skill=>!skill.is_supervisor)
  if(!allowSupervisorAsWorker)return operators.sort(compareManpowerSkills)
  return [...operators,...skills.filter(skill=>skill.is_supervisor)].sort(compareManpowerSkills)
}

export function isSkillUsable(skill:EmployeeSkill,date:string) { return skillLevelOf(skill)>0&&(!skill.valid_until||skill.valid_until>=date) }
export function effectiveOperatorCount(requiredSupervisors:number,operatorCount:number,supervisorCount:number,allowSupervisorAsWorker:boolean) {
  return operatorCount+(allowSupervisorAsWorker&&requiredSupervisors>0?supervisorCount:0)
}
export function effectiveRequiredHeadcount(requiredWorkers:number,requiredSupervisors:number,allowSupervisorAsWorker:boolean) {
  return allowSupervisorAsWorker&&requiredSupervisors>0?Math.max(requiredWorkers,requiredSupervisors):requiredWorkers+requiredSupervisors
}
