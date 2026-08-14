export type ResponsibilityLevel = 'supervisor' | 'lead' | 'operator' | 'assistant' | 'trainee'
export type QualificationStatus = 'qualified' | 'training' | 'blocked'
export interface ManpowerEmployee { id:string; employee_code:string; first_name:string; last_name:string; nickname?:string|null; employment_status:string; department?:{name?:string|null}|null; position?:{name?:string|null}|null }
export interface EmployeeProfile { employee_id:string; responsibility_level:ResponsibilityLevel; is_available_for_planning:boolean; note?:string|null }
export interface EmployeeSkill { id?:string; employee_id:string; department_name:string; process_name:string; proficiency:number; efficiency_percent:number; qualification_status:QualificationStatus; is_primary:boolean; assessed_at?:string|null; valid_until?:string|null }
export interface OperationRequirement { id?:string; department_name:string; process_name:string; required_workers:number; minimum_proficiency:number; required_supervisors:number; allow_supervisor_as_worker?:boolean }
export const RESPONSIBILITY_LABELS: Record<ResponsibilityLevel,string> = { supervisor:'หัวหน้า', lead:'ผู้เชี่ยวชาญ', operator:'ฝ่ายผลิต', assistant:'ผู้ช่วย', trainee:'ฝึกหัด' }
export function manpowerScore(s:EmployeeSkill) { if(s.qualification_status==='blocked') return -1; return s.proficiency*10 + Math.min(Number(s.efficiency_percent),150)*.25 + (s.qualification_status==='qualified'?10:-15) + (s.is_primary?5:0) }
export function isSkillUsable(s:EmployeeSkill,date:string) { return s.qualification_status!=='blocked' && (!s.valid_until || s.valid_until>=date) }
export function effectiveOperatorCount(requiredSupervisors:number,operatorCount:number,supervisorCount:number,allowSupervisorAsWorker:boolean) {
  return operatorCount+(allowSupervisorAsWorker&&requiredSupervisors>0?supervisorCount:0)
}
export function effectiveRequiredHeadcount(requiredWorkers:number,requiredSupervisors:number,allowSupervisorAsWorker:boolean) {
  return allowSupervisorAsWorker&&requiredSupervisors>0?Math.max(requiredWorkers,requiredSupervisors):requiredWorkers+requiredSupervisors
}
