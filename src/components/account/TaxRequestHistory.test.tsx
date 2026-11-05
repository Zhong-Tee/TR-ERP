// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import TaxRequestHistory from './TaxRequestHistory'
const {from,logs,users}=vi.hoisted(()=>({from:vi.fn(),logs:{value:[] as unknown[],error:null as unknown},users:{value:[{id:'actor-uuid',username:'Nan',email:'nan@test'}] as unknown[],error:null as unknown}}))
vi.mock('../../lib/supabase',()=>({supabase:{from}}))
const base={id:'1',actor_id:'actor-uuid',created_at:'2026-11-05T04:19:06Z',reason:null,before_data:null,after_data:null}
beforeEach(()=>{
 logs.error=null;users.error=null;users.value=[{id:'actor-uuid',username:'Nan',email:'nan@test'}]
 from.mockImplementation(table=>{
  if(table==='us_users') return {select:()=>({in:()=>Promise.resolve({data:users.value,error:users.error})})}
  const chain={eq:()=>chain,order:()=>Promise.resolve({data:logs.value,error:logs.error})}
  return {select:()=>chain}
 })
})
afterEach(cleanup)
it('shows Thai actions, names, changed references and original invoice details',async()=>{
 logs.value=[
  {...base,action:'flow_reference',before_data:{reference:'FA-OLD'},after_data:{reference:'INV2026110001'}},
  {...base,id:'2',action:'recover_legacy',after_data:{invoice_no:'TRIV26110001'}},
  {...base,id:'3',action:'initialize_series',after_data:{period:'2611',last_number:1},reason:'ตรวจทะเบียนเดิมแล้ว'},
 ]
 render(<TaxRequestHistory orderId="order" kind="invoice"/>)
 await screen.findAllByText('ผู้ทำรายการ: Nan')
 expect(screen.getByText('บันทึกเลขอ้างอิง FlowAccount')).toBeTruthy()
 expect(screen.getByText('FA-OLD')).toBeTruthy()
 expect(screen.getByText('INV2026110001')).toBeTruthy()
 expect(screen.getByText('TRIV26110001')).toBeTruthy()
 expect(screen.getByText('11/2026')).toBeTruthy()
 expect(screen.getByText(/ตรวจทะเบียนเดิมแล้ว/)).toBeTruthy()
 expect(screen.queryByText(/actor-uuid/)).toBeNull()
 expect(document.querySelector('time')?.textContent).toContain('11:19:06')
})
it('keeps repeated events and displays a fallback if the user cannot be read',async()=>{
 users.value=[];users.error={message:'permission denied'}
 logs.value=[{...base,action:'flow_reference',before_data:{reference:'FA'},after_data:{reference:'FA'}},{...base,id:'2',action:'reject',reason:'ชื่อไม่ตรง'}]
 render(<TaxRequestHistory orderId="order" kind="invoice"/>)
 await screen.findByText('FA (ไม่มีการเปลี่ยนแปลง)')
 expect(screen.getAllByText('ผู้ทำรายการ: ไม่พบชื่อผู้ทำรายการ')).toHaveLength(2)
 expect(screen.getByText(/ชื่อไม่ตรง/)).toBeTruthy()
})
it('shows load failures instead of claiming no history exists',async()=>{
 logs.error={message:'โหลดประวัติไม่ได้'}
 render(<TaxRequestHistory orderId="order" kind="invoice"/>)
 expect((await screen.findByRole('alert')).textContent).toBe('โหลดประวัติไม่ได้')
 expect(screen.queryByText('ยังไม่มีประวัติในระบบใหม่')).toBeNull()
})
