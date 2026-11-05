import { useCallback, useEffect, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import TaxRequestHistory from './TaxRequestHistory'
import TaxInvoiceFields, { type TaxInvoiceFieldsValue } from '../order/TaxInvoiceFields'
import { calculateWithholding, normalizeTaxId, taxInvoiceErrors } from '../../lib/taxInvoice'
import type { Order } from '../../types'

type Kind = 'invoice' | 'withholding'
type State = { status?: string; reason?: string }
type Details = NonNullable<Order['billing_details']> & { tax_workflow?: Partial<Record<Kind,State>>; account_confirmed_tax?: boolean; withholding_receipt?: { reference: string; date: string; file_path: string } }
type Props = { reviewRequest?: {billNo:string;state:string}; mode: 'sales' | Kind; onIssue?: (order: Order) => void; onCount?: (count: number) => void }
const states = { pending: 'รออนุมัติ', rejected: 'ต้องแก้ไข', approved: 'อนุมัติแล้ว', issued: 'ออกเอกสารแล้ว' }
export default function TaxRequestBoard({ mode, onIssue, onCount, reviewRequest }: Props) {
  const { user } = useAuthContext()
  const requestVersion=useRef(0)
  const searchInput=useRef<HTMLInputElement>(null)
  const [entries,setEntries] = useState<{order:Order;bd:Details;kind:Kind;state:string;issued:boolean}[]>([])
  const [filter,setFilter] = useState(mode==='sales'?'rejected':'pending')
  const [counts,setCounts] = useState<Record<string,number>>({})
  const [page,setPage] = useState(0)
  const [more,setMore] = useState(false)
  const [search,setSearch] = useState('')
  const [message,setMessage] = useState('')
  const [dialogMessage,setDialogMessage] = useState('')
  const [addressDetail,setAddressDetail] = useState<{billNo:string;name:string;address:string} | null>(null)
  const [loading,setLoading] = useState(false)
  const [busy,setBusy] = useState(false)
  const [dialog,setDialog] = useState<{order: Order; kind: Kind; action: string} | null>(null)
  const [reason,setReason] = useState('')
  const [receipt,setReceipt] = useState({reference:'',date:'',file_path:''})
  const [file,setFile] = useState<File | null>(null)
  const [tax,setTax] = useState<TaxInvoiceFieldsValue>({company_name:'',tax_id:'',address:''})
  const canApprove = user?.role==='account' || user?.role==='superadmin'
  const load = useCallback(async () => {
    const version=++requestVersion.current
    setLoading(true)
    try {
      const {data,error}=await supabase.rpc('or_tax_queue',{p_mode:mode,p_state:filter,p_search:search.trim(),p_offset:page*50})
      if(error) throw error
      if(version!==requestVersion.current) return
      setCounts(data.counts || {})
      setMore(Number(data.total)>(page+1)*50)
      setEntries((data.rows || []).map((entry: {order_data:Order;kind:Kind;state:string;issued:boolean})=>({order:entry.order_data,bd:entry.order_data.billing_details as Details,kind:entry.kind,state:entry.state,issued:entry.issued})))
      onCount?.(Number(data.rejected_total))
    } catch(e) {if(version===requestVersion.current)setMessage(e instanceof Error?e.message:'โหลดรายการไม่ได้')}
    finally {if(version===requestVersion.current)setLoading(false)}
  },[mode,filter,page,search,onCount])
  useEffect(()=>{void load();const refresh=()=>void load();window.addEventListener('sidebar-refresh-counts',refresh);return()=>window.removeEventListener('sidebar-refresh-counts',refresh)},[load])
  useEffect(()=>{
    if(!reviewRequest) return
    setSearch(reviewRequest.billNo);setFilter(reviewRequest.state);setPage(0)
    searchInput.current?.focus({preventScroll:true})
  },[reviewRequest])
  function open(order: Order,kind: Kind,action: string) {
    const bd=order.billing_details
    setDialogMessage('')
    setDialog({order,kind,action});setReason('');setFile(null);setReceipt({reference:'',date:'',file_path:''})
    setTax({company_name:bd?.tax_customer_name || '',tax_id:bd?.tax_id || '',address:bd?.tax_customer_address || '',branch:bd?.tax_branch || '00000',tax_address:bd?.tax_address || undefined})
  }
  async function openEvidence(path: string) {
    const {data,error}=await supabase.storage.from('tax-evidence').createSignedUrl(path,300)
    if(error) setMessage(error.message)
    else if(data?.signedUrl) window.open(data.signedUrl,'_blank','noopener,noreferrer')
  }
  async function submit() {
    if(!dialog) return
    setBusy(true);setDialogMessage('')
    try {
      let payload: Record<string,unknown>={reason,expected_details:dialog.order.billing_details,expected_total:dialog.order.total_amount}
      if(dialog.action==='resubmit' && taxInvoiceErrors(tax).length) throw new Error(taxInvoiceErrors(tax).join(' · '))
      if(dialog.action==='resubmit') payload={tax_customer_name:tax.company_name,tax_id:normalizeTaxId(tax.tax_id),tax_customer_address:tax.address,tax_branch:tax.branch || '00000',tax_address:tax.tax_address || null}
      if(dialog.action==='received') {
        if(!file || !receipt.reference.trim() || !receipt.date) throw new Error('กรอกเลขเอกสาร วันที่ และเลือกไฟล์')
        const path=`${dialog.order.id}/${crypto.randomUUID()}.${file.name.split('.').pop()?.replace(/[^a-z0-9]/gi,'') || 'bin'}`
        const {error}=await supabase.storage.from('tax-evidence').upload(path,file,{upsert:false})
        if(error) throw error
        payload={...receipt,file_path:path}
      }
      const {error}=await supabase.rpc('or_tax_action',{p_order_id:dialog.order.id,p_kind:dialog.kind,p_action:dialog.action,p_payload:payload})
      if(error) throw error
      setDialog(null);setMessage('บันทึกเรียบร้อย');await load()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch(e) {setDialogMessage(e instanceof Error?e.message:(e as {message?:string})?.message || 'บันทึกไม่สำเร็จ')}
    finally{setBusy(false)}
  }
  return <section className="space-y-4 rounded-xl border bg-white p-4">
    <div className="flex flex-wrap gap-2">{Object.entries(mode==='withholding'?{...states,awaiting_receipt:'รอรับเอกสาร',received:'ได้รับแล้ว'}:states).filter(([key])=>mode!=='withholding'||key!=='issued').map(([key,label])=><button key={key} type="button" onClick={()=>{setFilter(key);setPage(0)}} className={`rounded px-3 py-2 ${filter===key?'bg-blue-600 text-white':'bg-gray-100'}`}>{label} ({counts[key] || 0})</button>)}<button type="button" onClick={()=>void load()} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-200 bg-white text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-400">รีเฟรช</button></div>
    <label className="flex flex-wrap items-center gap-2">ค้นหาเลขบิล / ผู้รับใบกำกับภาษี / เลขผู้เสียภาษี<input className="w-full rounded border p-2 sm:w-80" ref={searchInput} placeholder="เลขบิล ชื่อผู้รับ หรือเลขผู้เสียภาษี" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}} /></label>
    {loading?<p>กำลังโหลด…</p>:<div className="overflow-x-auto"><table className="w-full min-w-[1400px] text-sm"><thead><tr>{['เลขบิล / ลูกค้า','ผู้รับใบกำกับภาษี','เลขผู้เสียภาษี / สาขา','ที่อยู่ออกใบกำกับภาษี',...(mode==='invoice'?[]:['คำขอ']),'ยอดเงิน','ผลตรวจ / เอกสาร','ดำเนินการ'].map(h=><th className="whitespace-nowrap p-2 text-left" key={h}>{h}</th>)}</tr></thead><tbody>{entries.map(({order,bd,kind,state,issued})=>{
      const amounts=calculateWithholding(Number(order.total_amount),bd?.withholding_requested===true,bd?.vat_rate ?? 7)
      const branch=bd?.tax_branch?.trim() || '00000'
      const address=bd?.tax_customer_address?.trim() || ''
      const money=(value:number)=>value.toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})
      return <tr key={`${order.id}:${kind}`} className="border-t">
        <td className="p-2"><p className="whitespace-nowrap font-medium">{order.bill_no}</p><p className="mt-1">{order.customer_name || '—'}</p></td>
        <td className="min-w-40 max-w-56 break-words p-2">{bd?.tax_customer_name || '—'}</td>
        <td className="p-2"><p className="whitespace-nowrap tabular-nums">{bd?.tax_id || '—'}</p><p className="mt-1 text-gray-500">{branch==='00000'?'สำนักงานใหญ่':`สาขา ${branch}`}</p></td>
        <td className="w-60 min-w-52 p-2"><p className="line-clamp-2 break-words whitespace-pre-wrap">{address || '—'}</p>{address&&<button type="button" className="mt-1 text-blue-600 underline hover:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" onClick={()=>setAddressDetail({billNo:order.bill_no,name:bd?.tax_customer_name || '—',address})}>ดูที่อยู่เต็ม</button>}</td>
        {mode!=='invoice'&&<td className="whitespace-nowrap p-2">{kind==='invoice'?'ใบกำกับภาษี':'หัก ณ ที่จ่าย 3%'}</td>}
        <td className="whitespace-nowrap p-2 tabular-nums"><p>ยอดบิล {money(amounts.gross)} บาท</p>{bd?.withholding_requested&&<p className="mt-1 text-gray-500">หัก ณ ที่จ่าย {money(amounts.withheld)} บาท</p>}<p className="mt-1 font-medium">ยอดที่ต้องชำระ {money(amounts.receivable)} บาท</p></td>
        <td className="max-w-sm whitespace-pre-wrap p-2">{bd?.tax_workflow?.[kind]?.reason}{kind==='withholding'&&<p>{bd?.withholding_receipt?`ได้รับแล้ว · ${bd.withholding_receipt.reference}`:'รอรับเอกสาร'}</p>}{issued&&<p>ออกเอกสารแล้ว · {(order as Order & {tax_document?:{invoice_no:string;flow_account_reference:string}}).tax_document?.invoice_no}<br/>FlowAccount: {(order as Order & {tax_document?:{flow_account_reference:string}}).tax_document?.flow_account_reference || '—'}</p>}</td><td className="p-2"><div className="flex flex-wrap items-center gap-2">
        {mode==='sales'&&state==='rejected'&&<button type="button" onClick={()=>open(order,kind,'resubmit')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:ring-blue-500">แก้ไขและส่งใหม่</button>}
        {mode!=='sales'&&canApprove&&state==='pending'&&<><button type="button" onClick={()=>open(order,kind,'approve')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-2 font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2">ตรวจและอนุมัติ</button><button type="button" onClick={()=>open(order,kind,'reject')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2">ส่งกลับแก้ไข</button></>}
        {mode==='invoice'&&state==='approved'&&<button type="button" onClick={()=>onIssue?.(order)} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:ring-blue-500">{issued?'ดูเอกสาร / เลขอ้างอิง':'ออกใบกำกับภาษี ERP'}</button>}
        {mode!=='sales'&&canApprove&&state==='approved'&&!issued&&!order.work_order_id&&!order.work_order_name&&!bd?.withholding_receipt&&<button type="button" onClick={()=>open(order,kind,'reject')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border border-red-200 bg-red-50 px-3 py-2 font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2">ส่งกลับแก้ไข</button>}
        {mode==='withholding'&&canApprove&&state==='approved'&&!bd?.withholding_receipt&&<button type="button" onClick={()=>open(order,kind,'received')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:ring-blue-500">ได้รับแล้ว</button>}
        <button type="button" onClick={()=>open(order,kind,'history')} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-200 bg-white text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-400">ประวัติ</button>
        {bd?.withholding_receipt && <button type="button" onClick={()=>void openEvidence(bd.withholding_receipt!.file_path)} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 focus-visible:ring-blue-500">ดูไฟล์หนังสือรับรอง</button>}
      </div></td></tr>
    })}</tbody></table>{!entries.length&&<p className="p-4 text-gray-500">ไม่มีรายการในหน้านี้</p>}</div>}
    <div className="flex items-center gap-3"><button type="button" className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-200 bg-white text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-400" disabled={!page} onClick={()=>setPage(p=>p-1)}>ก่อนหน้า</button><span>หน้าข้อมูล {page+1}</span><button type="button" className="inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-200 bg-white text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-400" disabled={!more} onClick={()=>setPage(p=>p+1)}>ถัดไป</button></div>
    <Modal open={!!addressDetail} onClose={()=>setAddressDetail(null)} contentClassName="max-w-xl" ariaLabelledby="tax-address-title">
      <div className="space-y-3 p-5"><h3 id="tax-address-title" className="pr-10 text-lg font-bold">ที่อยู่ออกใบกำกับภาษี</h3><p>{addressDetail?.billNo} · {addressDetail?.name}</p><p className="break-words whitespace-pre-wrap">{addressDetail?.address}</p><button type="button" className="rounded-lg border px-3 py-2 hover:bg-gray-100" onClick={()=>setAddressDetail(null)}>ปิด</button></div>
    </Modal>
    <Modal open={!!dialog} onClose={()=>{if(!busy)setDialog(null)}} contentClassName="max-w-3xl"><div className="space-y-4 p-5"><h3 className="text-lg font-bold">{dialog?.order.bill_no} · {dialog?.action==='resubmit'?'แก้ข้อมูลและส่งใหม่':dialog?.action==='received'?'บันทึกรับหนังสือรับรอง':dialog?.action==='history'?'ประวัติคำขอ':'ตรวจคำขอ'}</h3>
      {dialog?.action==='history'?<TaxRequestHistory orderId={dialog.order.id} kind={dialog.kind}/>:dialog?.action==='resubmit'?<TaxInvoiceFields value={tax} onChange={setTax} disabled={busy}/>:dialog?.action==='received'?<><label className="block">เลขหนังสือรับรอง<input value={receipt.reference} onChange={e=>setReceipt({...receipt,reference:e.target.value})} className="w-full rounded border p-2"/></label><label>วันที่เอกสาร<input type="date" value={receipt.date} onChange={e=>setReceipt({...receipt,date:e.target.value})} className="rounded border p-2"/></label><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={e=>setFile(e.target.files?.[0] || null)}/></>:<><p>{dialog?.order.billing_details?.tax_customer_name} · {dialog?.order.billing_details?.tax_id} · สาขา {dialog?.order.billing_details?.tax_branch || '00000'}</p><p>{dialog?.order.billing_details?.tax_customer_address}</p>{dialog && <p className="rounded bg-amber-50 p-3">ยอดบิล {Number(dialog.order.total_amount).toFixed(2)} บาท · ฐานก่อน VAT {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).base.toFixed(2)} บาท · หัก ณ ที่จ่าย {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).withheld.toFixed(2)} บาท · ยอดที่ต้องชำระ {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).receivable.toFixed(2)} บาท</p>}{dialog?.order.billing_details?.tax_items?.map((item,index)=><p key={index}>{item.product_name} · {item.quantity} × {item.unit_price}</p>)}<label className="block">{dialog?.action==='reject'?'เหตุผลที่ส่งกลับ (จำเป็น)':'หมายเหตุ'}<textarea className="w-full rounded border p-2" value={reason} onChange={e=>setReason(e.target.value)}/></label></>}
      {dialogMessage&&<p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-red-700">{dialogMessage}</p>}
      {dialog?.action!=='history' && <button type="button" disabled={busy || dialog?.action==='reject'&&!reason.trim()} onClick={()=>void submit()} className="rounded bg-blue-600 px-4 py-2 text-white">{busy?'กำลังบันทึก…':'ยืนยัน'}</button>}<button type="button" disabled={busy} onClick={()=>setDialog(null)} className="ml-3 inline-flex items-center justify-center whitespace-nowrap rounded-lg border px-3 py-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 border-gray-200 bg-white text-gray-700 hover:bg-gray-100 focus-visible:ring-gray-400">ปิด</button>
    </div></Modal>
    {message&&<div role="status" className="rounded border bg-blue-50 p-3">{message}<button type="button" onClick={()=>setMessage('')} className="ml-4 underline">ปิด</button></div>}
  </section>
}
