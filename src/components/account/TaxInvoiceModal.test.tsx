// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaxInvoiceModal from './TaxInvoiceModal'
const {doc,query}=vi.hoisted(()=>({doc:{value:null as unknown},query:vi.fn()}))
vi.mock('../../contexts/AuthContext',()=>({useAuthContext:()=>({user:{role:'account'}})}))
vi.mock('@react-pdf/renderer',()=>({pdf:vi.fn(),PDFViewer:()=>null}))
vi.mock('./pdf/TaxInvoicePDF',()=>({default:()=>null}))
vi.mock('../../lib/supabase',()=>({supabase:{from:query}}))
const header={id:'header-1',bill_code:'TR',company_name:'บริษัททดสอบ'}
const order={id:'order-1',bill_no:'BILL1',customer_name:'ลูกค้าเดิม',total_amount:1070,billing_details:{tax_customer_name:'ชื่อใหม่ในบิล',tax_customer_address:'ที่อยู่ใหม่ในบิล',tax_id:'0103563005345'}}
beforeEach(()=>{doc.value=null;query.mockImplementation((table:string)=>table==='bill_header_settings'?{select:()=>({order:()=>Promise.resolve({data:[header]})})}:{select:()=>({eq:()=>({maybeSingle:()=>Promise.resolve({data:doc.value,error:null})})})})})
afterEach(cleanup)
describe('persisted ERP invoice',()=>{
 it('restores the issued number and buyer snapshot rather than rebuilding 0001',async()=>{
  doc.value={invoice_no:'TRIV26110042',invoice_date:'2026-11-04',header_id:'header-1',flow_account_reference:'FA-123',snapshot:{companyData:header,customerName:'ชื่อในเอกสารที่ออกแล้ว',customerAddress:'ที่อยู่ในเอกสาร',customerTaxId:'0103563005345',customerBranch:'สำนักงานใหญ่',customerPhone:'',items:[{description:'สินค้า',quantity:1,unitPrice:1070,amount:1070}],discount:0,shippingCost:0,subtotal:1070,netAmount:1000,vatAmount:70,grandTotal:1070,refDocNo:'BILL1'}}
  render(<TaxInvoiceModal open order={order} onClose={()=>{}} onConfirm={()=>{}}/>)
  await screen.findByDisplayValue('TRIV26110042')
  expect(screen.getByDisplayValue('ชื่อในเอกสารที่ออกแล้ว')).toBeTruthy()
  expect(screen.queryByDisplayValue('ชื่อใหม่ในบิล')).toBeNull()
  expect((screen.getByDisplayValue('TRIV26110042') as HTMLInputElement).readOnly).toBe(true)
  expect(screen.getByDisplayValue('FA-123')).toBeTruthy()
  expect(screen.queryByRole('button',{name:'ยืนยันออกเลขใบกำกับ ERP'})).toBeNull()
 })
 it('does not export an unissued preview as a numbered invoice',async()=>{
  render(<TaxInvoiceModal open order={order} onClose={()=>{}} onConfirm={()=>{}}/>)
  await waitFor(()=>expect(screen.queryByText('กำลังโหลดเอกสาร…')).toBeNull())
  expect((screen.getByRole('button',{name:'Export PDF'}) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/ระบบจะรันเลขจริงเมื่อยืนยัน/)).toBeTruthy()
 })
})
