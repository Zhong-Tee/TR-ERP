// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaxInvoiceFields, { type TaxInvoiceFieldsValue } from './TaxInvoiceFields'
const { invoke, zipLookup, parseAddress } = vi.hoisted(()=>({invoke:vi.fn(),zipLookup:vi.fn(),parseAddress:vi.fn()}))
vi.mock('../../lib/supabase',()=>({supabase:{functions:{invoke}}}))
vi.mock('../../lib/thaiAddress',()=>({getAddressByZip:zipLookup,parseAddressText:parseAddress}))
function Harness() {
 const [value,setValue]=React.useState<TaxInvoiceFieldsValue>({company_name:'ชื่อที่กรอกเอง',address:'ที่อยู่เดิม',tax_id:'',branch:'00000'})
 return <TaxInvoiceFields value={value} onChange={setValue}/>
}
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const record={tax_id:'0103563005345',company_name:'ชื่อทะเบียน VAT',branch:'00000',tax_address:{house_number:'1641',building:'',floor:'',room:'',moo:'',village:'',soi:'',road:'',sub_district:'หลักสอง',district:'บางแค',province:'กรุงเทพมหานคร',postal_code:'10160'}}
describe('automatic registry lookup',()=>{
 beforeEach(()=>{vi.useFakeTimers();invoke.mockReset();zipLookup.mockReset();parseAddress.mockReset();zipLookup.mockResolvedValue({options:[]})})
 afterEach(()=>{cleanup();vi.useRealTimers()})
 it('debounces, preserves user data, and applies only on explicit selection',async()=>{
  invoke.mockResolvedValue({data:{status:'found',records:[record]},error:null})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('เลขประจำตัวผู้เสียภาษี'),{target:{value:'0-1035-63005-34-5'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(999)})
  expect(invoke).not.toHaveBeenCalled()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1)})
  expect(invoke).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('ชื่อลูกค้า / บริษัท') as HTMLInputElement).value).toBe('ชื่อที่กรอกเอง')
  fireEvent.click(screen.getByRole('button',{name:'ใช้ข้อมูลจากกรมสรรพากร'}))
  expect((screen.getByLabelText('ชื่อลูกค้า / บริษัท') as HTMLInputElement).value).toBe('ชื่อทะเบียน VAT')
 })
 it('ignores a stale response after changing the ID and looks up a new branch',async()=>{
  const old=deferred()
  invoke.mockReturnValueOnce(old.promise).mockResolvedValue({data:{status:'not_found'},error:null})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('เลขประจำตัวผู้เสียภาษี'),{target:{value:'0103563005345'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  fireEvent.change(screen.getByLabelText('เลขประจำตัวผู้เสียภาษี'),{target:{value:'0107537002443'}})
  await act(async()=>{old.resolve({data:{status:'found',records:[record]},error:null});await Promise.resolve()})
  expect(screen.queryByRole('button',{name:'ใช้ข้อมูลจากกรมสรรพากร'})).toBeNull()
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(screen.getByText(/ไม่พบข้อมูลในทะเบียน VAT/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText(/สำนักงานใหญ่ \/ เลขสาขา/),{target:{value:'00001'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(invoke.mock.calls.at(-1)?.[1].body).toEqual({taxId:'0107537002443',branch:'00001'})
 })
 it('distinguishes a service failure from not found and offers retry',async()=>{
  invoke.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({data:{status:'not_found'},error:null})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('เลขประจำตัวผู้เสียภาษี'),{target:{value:'0103563005345'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(screen.getByText(/ยังตรวจสอบไม่ได้/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'ตรวจสอบอีกครั้ง'}))
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(screen.getByText(/ไม่พบข้อมูลในทะเบียน VAT/)).toBeTruthy()
 })
 it('fills the explicitly provided locality even when a postcode has several choices',async()=>{
  const options=['บางแค','บางแคเหนือ','บางไผ่','หลักสอง'].map(subDistrict=>({subDistrict,district:'บางแค',province:'กรุงเทพมหานคร'}))
  zipLookup.mockResolvedValue({options})
  parseAddress.mockResolvedValue({addressLine:'1641,1643 ชั้นที่3 ถ.เพชรเกษม',postalCode:'10160',recipientName:'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป (สำนักงานใหญ่)',subDistrict:'หลักสอง',district:'บางแค',province:'กรุงเทพมหานคร',subDistrictOptions:options})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('วางข้อมูลเต็มเพื่อ Auto Fill'),{target:{value:'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป (สำนักงานใหญ่)\n1641,1643 ชั้นที่3\nถ.เพชรเกษม แขวงหลักสอง เขตบางแค\nกทม. 10160\nTAX ID : 0103563005345'}})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'แยกข้อมูล'}));await Promise.resolve()})
  expect((screen.getByLabelText('อำเภอ / เขต') as HTMLInputElement).value).toBe('บางแค')
  expect((screen.getByLabelText('จังหวัด') as HTMLInputElement).value).toBe('กรุงเทพมหานคร')
  expect((screen.getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toContain('หลักสอง')
  expect(screen.getByLabelText('ที่อยู่สำหรับใบกำกับภาษี').textContent).toContain('แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160')
 })
 it('retains the original locality text if it still needs a user choice',async()=>{
  const options=['บางแค','หลักสอง'].map(subDistrict=>({subDistrict,district:'บางแค',province:'กรุงเทพมหานคร'}))
  zipLookup.mockResolvedValue({options})
  parseAddress.mockResolvedValue({addressLine:'99 ถนนเพชรเกษม',postalCode:'10160',subDistrict:'บางแค',district:'บางแค',province:'กรุงเทพมหานคร',subDistrictOptions:options})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('วางข้อมูลเต็มเพื่อ Auto Fill'),{target:{value:'99 ถนนเพชรเกษม กทม. 10160'}})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'แยกข้อมูล'}));await Promise.resolve()})
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('-1')
  expect(screen.getByLabelText('ที่อยู่สำหรับใบกำกับภาษี').textContent).toContain('กทม. 10160')
 })
 it('reports a missing registry function separately from an invalid tax ID',async()=>{
  invoke.mockResolvedValue({data:null,error:{context:new Response('',{status:404})}})
  render(<Harness/>);
  fireEvent.change(screen.getByLabelText('เลขประจำตัวผู้เสียภาษี'),{target:{value:'0103563005345'}})
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
  expect(screen.queryByText('เลขภาษีต้องเป็นตัวเลข 13 หลักและเลขตรวจสอบถูกต้อง')).toBeNull()
  expect(screen.getByText(/ยังไม่พบบริการ rd-vat-lookup/)).toBeTruthy()
 })

 it('retains a legacy full-text address without replacing it with empty structured fields',()=>{
  render(<Harness/>);
  const address=screen.getByLabelText('ที่อยู่สำหรับใบกำกับภาษี') as HTMLTextAreaElement
  expect(address.tagName).toBe('TEXTAREA')
  expect(address.value).toBe('ที่อยู่เดิม')
  fireEvent.change(address,{target:{value:'ที่อยู่เดิมที่ตรวจแก้แล้ว'}})
  expect(address.value).toBe('ที่อยู่เดิมที่ตรวจแก้แล้ว')
  expect(screen.queryByText('ที่อยู่เต็ม / ที่อยู่เดิม (คงข้อมูลบิลเก่า)')).toBeNull()
 })

})
