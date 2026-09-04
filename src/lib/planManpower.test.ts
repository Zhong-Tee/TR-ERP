import { describe, expect, it } from 'vitest'
import {
  assignmentCandidates,
  effectiveOperatorCount,
  effectiveRequiredHeadcount,
  operatorSkillCandidates,
  rotatePrimaryQueue,
  skillLevelOf,
  type EmployeeSkill,
  type SkillLevel,
} from './planManpower'

const skill=(employee_id:string,skill_level:SkillLevel,is_primary=false,primary_queue_order:number|null=null,is_supervisor=false):EmployeeSkill=>({
  employee_id,department_name:'STAMP',process_name:'เตรียมไฟล์',skill_level,is_supervisor,primary_queue_order,
  proficiency:skill_level===3?4:skill_level===2?3:1,efficiency_percent:100,
  qualification_status:skill_level===0?'blocked':skill_level===1?'training':'qualified',is_primary,max_concurrent_jobs:1,
})

describe('Skill Matrix 4 ระดับ',()=>{
  it('รองรับการแปลงข้อมูลเดิม',()=>{
    const legacy=skill('legacy',2)
    delete legacy.skill_level
    legacy.proficiency=4
    expect(skillLevelOf(legacy)).toBe(3)
  })

  it('ห้ามระดับทำไม่ได้เข้าสู่รายการที่ใช้งานได้',()=>{
    expect(skillLevelOf(skill('blocked',0))).toBe(0)
  })
})

describe('คิวงานหลักแบบ Round-robin',()=>{
  const queue=[skill('B',2,true,2),skill('A',2,true,1),skill('C',3,true,3)]

  it('เริ่มตามลำดับคิวที่ผู้ใช้กำหนด',()=>{
    expect(rotatePrimaryQueue(queue).map(row=>row.employee_id)).toEqual(['A','B','C'])
  })

  it('เริ่มจากคนถัดจากผู้รับงานล่าสุด',()=>{
    expect(rotatePrimaryQueue(queue,'B').map(row=>row.employee_id)).toEqual(['C','A','B'])
  })

  it('ให้งานหลักทุกคนก่อน แล้วจึงไล่คนสำรองจากระดับสูงลงต่ำ',()=>{
    const rows=assignmentCandidates([...queue,skill('capable',2),skill('expert',3),skill('trainee',1)],'A')
    expect(rows.map(row=>row.employee_id)).toEqual(['B','C','A','expert','capable','trainee'])
  })
})

describe('หัวหน้ารายกระบวนการ',()=>{
  it('ไม่ให้หัวหน้าลงผลิตเมื่อปิดตัวเลือก',()=>{
    expect(operatorSkillCandidates([skill('operator',2),skill('head',3,false,null,true)],false).map(row=>row.employee_id)).toEqual(['operator'])
  })

  it('ให้หัวหน้าลงผลิตตามระดับได้เมื่อเปิดตัวเลือก',()=>{
    expect(operatorSkillCandidates([skill('operator',2),skill('head',3,false,null,true)],true).map(row=>row.employee_id)).toEqual(['head','operator'])
  })

  it('คำนวณโควตาหัวหน้าที่ลงผลิตได้เหมือนเดิม',()=>{
    expect(effectiveOperatorCount(1,0,1,true)).toBe(1)
    expect(effectiveRequiredHeadcount(3,1,true)).toBe(3)
    expect(effectiveRequiredHeadcount(3,1,false)).toBe(4)
  })
})
