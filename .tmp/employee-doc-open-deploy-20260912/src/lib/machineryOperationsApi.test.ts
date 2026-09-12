import { describe, expect, it } from 'vitest'
import { buildReadiness, overlapHours, type ChecklistItem, type Inspection, type InspectionResult } from './machineryOperationsApi'

const item=(id:string,machine_id='m1'):ChecklistItem=>({id,machine_id,label:id,description:null,input_type:'boolean',min_value:null,max_value:null,unit:null,requires_photo:false,is_required:true,frequency:'daily',sort_order:0,is_active:true})
const inspection:Inspection={id:'i1',machine_id:'m1',inspection_date:'2026-08-20',shift_key:'day',status:'passed',note:null,inspected_at:'2026-08-20T01:00:00Z'}
const result=(checklist_item_id:string,passed:boolean):InspectionResult=>({inspection_id:'i1',checklist_item_id,passed,value_text:null,value_number:null,photo_url:null,note:null})

describe('machinery readiness',()=>{
  it('is ready only when every required item passes',()=>{expect(buildReadiness(['m1'],[item('a'),item('b')],[inspection],[result('a',true),result('b',true)])[0].status).toBe('ready')})
  it('is failed when a required item fails',()=>{expect(buildReadiness(['m1'],[item('a')],[{...inspection,status:'failed'}],[result('a',false)])[0].status).toBe('failed')})
  it('keeps a missing checklist explicit',()=>{expect(buildReadiness(['m1'],[],[],[])[0].status).toBe('no_checklist')})
})

describe('downtime overlap',()=>{it('counts only downtime inside the plan window',()=>{expect(overlapHours(new Date('2026-08-20T09:00:00Z'),new Date('2026-08-20T12:00:00Z'),new Date('2026-08-20T10:00:00Z'),new Date('2026-08-20T11:30:00Z'))).toBe(1.5)})})
