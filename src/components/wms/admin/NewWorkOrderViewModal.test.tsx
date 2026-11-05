// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import NewWorkOrderViewModal from './NewWorkOrderViewModal'
const {from,fixture}=vi.hoisted(()=>({from:vi.fn(),fixture:{orders:[] as unknown[]}}))
vi.mock('../../../lib/supabase',()=>({supabase:{from}}))
const workOrder={id:'wo',work_order_name:'FSPTR-051169-R2'}
const bill={id:'bill',bill_no:'FSPTR26110105',customer_name:'prawzzz',recipient_name:null,source_marketplace_order_id:'mp',status:'ใบสั่งงาน',or_order_items:[]}
beforeEach(()=>{
 fixture.orders=[bill];from.mockReset()
 from.mockImplementation(()=>{
  let sorts=0
  const chain={eq:()=>chain,not:()=>chain,neq:()=>chain,order:()=>++sorts===2?Promise.resolve({data:fixture.orders,error:null}):chain}
  return {select:()=>chain}
 })
})
afterEach(cleanup)
it('shows the bill and buyer account while omitting recipient information',async()=>{
 fixture.orders=[{...bill,recipient_name:'ชื่อผู้รับที่ต้องซ่อน'}]
 render(<NewWorkOrderViewModal workOrder={workOrder} onClose={()=>{}}/>)
 expect(await screen.findByRole('heading',{name:'FSPTR26110105'})).toBeTruthy()
 expect(screen.getByText('บัญชีผู้ซื้อ: prawzzz')).toBeTruthy()
 expect(screen.queryByText(/ชื่อผู้รับ/)).toBeNull()
 expect(from).not.toHaveBeenCalledWith('mp_orders')
})
it('shows a dash if the buyer account is missing',async()=>{
 fixture.orders=[{...bill,customer_name:'   '}]
 render(<NewWorkOrderViewModal workOrder={workOrder} onClose={()=>{}}/>)
 expect(await screen.findByText('บัญชีผู้ซื้อ: —')).toBeTruthy()
 expect(screen.queryByText('ไม่ระบุชื่อผู้รับ')).toBeNull()
})
