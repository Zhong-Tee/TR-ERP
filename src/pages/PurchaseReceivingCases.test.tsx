// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {ReactNode} from 'react'
import PurchaseReceivingCases from './PurchaseReceivingCases'
const {fixture,action}=vi.hoisted(()=>({fixture:{method:'cancel_unpaid',status:'adjustment_pending'},action:vi.fn()}))
vi.mock('../contexts/AuthContext',()=>({useAuthContext:()=>({user:{id:'tee',role:'superadmin'}})}))
vi.mock('react-router-dom',()=>({Link:({children,to}:{children:ReactNode;to:string})=><a href={to}>{children}</a>}))
vi.mock('../lib/receivingCases',async()=>({
 ...await vi.importActual<typeof import('../lib/receivingCases')>('../lib/receivingCases'),
 loadReceivingCases:async()=>[{id:'case2',case_no:2,po_id:'po',method:fixture.method,status:fixture.status,reason:'ซื้อได้รายการละ 48 ชิ้น',assigned_to:'tee',created_by:'tee',created_at:'2026-10-26T04:00:00Z',inv_po:{po_no:'PO-20261024-001',supplier_name:'HE XIN'},inv_receiving_case_items:[],inv_receiving_case_events:[]}],
 loadCaseUsers:async()=>({tee:'TEE'}),caseAction:action,
}))
vi.mock('../lib/supabase',()=>({supabase:{
 from:()=>({select:()=>({eq:()=>({
  maybeSingle:async()=>({data:{expected_amount:156,settled_amount:0,currency:'THB'},error:null}),
  order:async()=>({data:[],error:null}),
 })})}),
 storage:{from:()=>({list:async()=>({data:[],error:null})})},
}}))
beforeEach(()=>{fixture.method='cancel_unpaid';fixture.status='adjustment_pending';action.mockReset();action.mockResolvedValue(undefined)})
afterEach(cleanup)
async function openCase(){
 render(<PurchaseReceivingCases/>)
 fireEvent.click(await screen.findByRole('button',{name:/รอปรับยอดชำระ \(1\)|รอคืนเงิน \(1\)/}))
 fireEvent.click(await screen.findByRole('button',{name:'ดู / ดำเนินการ'}))
 await waitFor(()=>expect((screen.getByRole('button',{name:'บันทึกผลติดตาม'}).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false))
 return within(screen.getByRole('dialog'))
}
it('records an unpaid adjustment without inventing a transfer or requiring a document number',async()=>{
 const modal=await openCase()
 fireEvent.change(modal.getByLabelText(/จำนวนเงิน.*ปรับยอดชำระ/),{target:{value:'156'}})
 fireEvent.click(modal.getByRole('checkbox'))
 fireEvent.click(modal.getByRole('button',{name:'บันทึกปรับยอดชำระ'}))
 await waitFor(()=>expect(action).toHaveBeenCalledWith('case2','settle',expect.objectContaining({amount:156,reference:'ปรับยอดชำระตามข้อตกลง RC-2 (ไม่ระบุเลขเอกสาร)'})))
 expect(modal.queryByText(/ที่ได้รับคืน \/ ปรับยอด/)).toBeNull()
})
it('requires a real refund reference and shows the validation beside the action',async()=>{
 fixture.method='refund';fixture.status='refund_pending'
 const modal=await openCase()
 fireEvent.change(modal.getByLabelText(/จำนวนเงิน.*รับเงินคืน/),{target:{value:'156'}})
 fireEvent.click(modal.getByRole('checkbox'))
 fireEvent.click(modal.getByRole('button',{name:'บันทึกรับเงินคืน'}))
 expect((await modal.findByRole('alert')).textContent).toBe('กรอกเลขอ้างอิงการรับเงินคืน')
 expect(action).not.toHaveBeenCalled()
 fireEvent.change(modal.getByLabelText('เลขอ้างอิงการรับเงินคืน (จำเป็น)'),{target:{value:'TRANSFER-1'}})
 fireEvent.click(modal.getByRole('button',{name:'บันทึกรับเงินคืน'}))
 await waitFor(()=>expect(action).toHaveBeenCalledWith('case2','settle',expect.objectContaining({reference:'TRANSFER-1'})))
})
it('rejects an adjustment larger than the approved outstanding amount',async()=>{
 const modal=await openCase()
 fireEvent.change(modal.getByLabelText(/จำนวนเงิน.*ปรับยอดชำระ/),{target:{value:'157'}})
 fireEvent.click(modal.getByRole('checkbox'))
 fireEvent.click(modal.getByRole('button',{name:'บันทึกปรับยอดชำระ'}))
 expect((await modal.findByRole('alert')).textContent).toContain('เกินยอดคงเหลือ')
 expect(action).not.toHaveBeenCalled()
})
