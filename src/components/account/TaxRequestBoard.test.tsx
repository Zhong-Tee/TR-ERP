// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaxRequestBoard from './TaxRequestBoard'
const {rpc,auth}=vi.hoisted(()=>({rpc:vi.fn(),auth:{role:'account'}}))
vi.mock('../../contexts/AuthContext',()=>({useAuthContext:()=>({user:{role:auth.role,username:'seller',email:'seller@test'}})}))
vi.mock('../../lib/supabase',()=>({supabase:{rpc}}))
vi.mock('../order/TaxInvoiceFields',()=>({default:()=>null}))
const order={id:'order-1',bill_no:'FBTR26110001',total_amount:1070,customer_name:'ลูกค้าทดสอบ',billing_details:{request_tax_invoice:true,tax_customer_name:'บริษัททดสอบ',tax_customer_address:'ที่อยู่ทดสอบ',tax_id:'0103563005345'}}
beforeEach(()=>{rpc.mockReset();auth.role='account'})
afterEach(cleanup)
describe('tax review actions',()=>{
 it('shows Account approval failures inside the modal and allows a successful retry',async()=>{
  rpc.mockImplementation((name:string)=>Promise.resolve(name==='or_tax_queue'?{data:{rows:[{order_data:order,kind:'invoice',state:'pending',issued:false}],total:1,rejected_total:0},error:null}:{data:null,error:{message:'เลขตรวจสอบผู้เสียภาษีไม่ถูกต้อง'}}))
  render(<TaxRequestBoard mode="invoice"/>)
  fireEvent.click(await screen.findByRole('button',{name:'ตรวจและอนุมัติ'}))
  const modal=screen.getByRole('dialog')
  fireEvent.click(within(modal).getByRole('button',{name:'ยืนยัน'}))
  expect((await within(modal).findByRole('alert')).textContent).toContain('เลขตรวจสอบผู้เสียภาษีไม่ถูกต้อง')
  expect(rpc).toHaveBeenCalledWith('or_tax_action',expect.objectContaining({p_action:'approve',p_payload:expect.objectContaining({expected_details:order.billing_details})}))
  rpc.mockResolvedValue({data:{rows:[],total:0,rejected_total:0},error:null})
  fireEvent.click(within(modal).getByRole('button',{name:'ยืนยัน'}))
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('status').textContent).toContain('บันทึกเรียบร้อย')
 })
 it('navigates to a legacy request by bill and state, including repeated navigation',async()=>{
  rpc.mockResolvedValue({data:{rows:[],total:0,rejected_total:0},error:null})
  const {rerender}=render(<TaxRequestBoard mode="invoice" reviewRequest={{billNo:order.bill_no,state:'approved'}}/>)
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('or_tax_queue',{p_mode:'invoice',p_state:'approved',p_search:order.bill_no,p_offset:0}))
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'other'}})
  rerender(<TaxRequestBoard mode="invoice" reviewRequest={{billNo:order.bill_no,state:'pending'}}/>)
  await waitFor(()=>expect(rpc).toHaveBeenLastCalledWith('or_tax_queue',{p_mode:'invoice',p_state:'pending',p_search:order.bill_no,p_offset:0}))
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
 })
 it('requires rejection reason and sends the inspected snapshot',async()=>{
  rpc.mockImplementation((name:string)=>Promise.resolve(name==='or_tax_queue'?{data:{rows:[{order_data:order,kind:'invoice',state:'pending',issued:false}],total:1,rejected_total:0},error:null}:{data:null,error:null}))
  render(<TaxRequestBoard mode="invoice"/>)
  fireEvent.click(await screen.findByRole('button',{name:'ส่งกลับแก้ไข'}))
  const modal=screen.getByRole('dialog')
  expect((within(modal).getByRole('button',{name:'ยืนยัน'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(within(modal).getByLabelText('เหตุผลที่ส่งกลับ (จำเป็น)'),{target:{value:'กรุณาแก้ชื่อให้ตรงทะเบียน'}})
  fireEvent.click(within(modal).getByRole('button',{name:'ยืนยัน'}))
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('or_tax_action',{p_order_id:'order-1',p_kind:'invoice',p_action:'reject',p_payload:{reason:'กรุณาแก้ชื่อให้ตรงทะเบียน',expected_details:order.billing_details,expected_total:1070}}))
 })
 it('does not show accounting approval controls to admin viewers',async()=>{
  auth.role='admin'
  rpc.mockResolvedValue({data:{rows:[{order_data:order,kind:'invoice',state:'pending',issued:false}],total:1,rejected_total:0},error:null})
  render(<TaxRequestBoard mode="invoice"/>)
  await screen.findByText(/FBTR26110001/)
  expect(screen.queryByRole('button',{name:'ตรวจและอนุมัติ'})).toBeNull()
  expect(screen.queryByRole('button',{name:'ส่งกลับแก้ไข'})).toBeNull()
 })
 it('lets sales resubmit a rejected existing request without sending financial fields',async()=>{
  auth.role='sales-tr'
  rpc.mockImplementation((name:string)=>Promise.resolve(name==='or_tax_queue'?{data:{rows:[{order_data:order,kind:'invoice',state:'rejected',issued:false}],total:1,rejected_total:1},error:null}:{data:null,error:null}))
  render(<TaxRequestBoard mode="sales"/>)
  fireEvent.click(await screen.findByRole('button',{name:'แก้ไขและส่งใหม่'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'ยืนยัน'}))
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('or_tax_action',{p_order_id:'order-1',p_kind:'invoice',p_action:'resubmit',p_payload:{tax_customer_name:'บริษัททดสอบ',tax_customer_address:'ที่อยู่ทดสอบ',tax_id:'0103563005345',tax_branch:'00000',tax_address:null}}))
 })
})
