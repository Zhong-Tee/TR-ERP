import { useCallback, useEffect, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import TaxInvoiceFields, { type TaxInvoiceFieldsValue } from '../order/TaxInvoiceFields'
import { calculateWithholding, taxInvoiceErrors } from '../../lib/taxInvoice'
import type { Order } from '../../types'

type Kind = 'invoice' | 'withholding'
type State = { status?: string; reason?: string }
type Details = NonNullable<Order['billing_details']> & { tax_workflow?: Partial<Record<Kind,State>>; account_confirmed_tax?: boolean; withholding_receipt?: { reference: string; date: string; file_path: string } }
type Props = { mode: 'sales' | Kind; onIssue?: (order: Order) => void; onCount?: (count: number) => void }
const states = { pending: 'รออนุมัติ', rejected: 'ต้องแก้ไข', approved: 'อนุมัติแล้ว', issued: 'ออกเอกสารแล้ว' }
export default function TaxRequestBoard({ mode, onIssue, onCount }: Props) {
  const { user } = useAuthContext()
  const requestVersion=useRef(0)
  const [entries,setEntries] = useState<{order:Order;bd:Details;kind:Kind;state:string;issued:boolean}[]>([])
  const [filter,setFilter] = useState(mode==='sales'?'rejected':'pending')
  const [counts,setCounts] = useState<Record<string,number>>({})
  const [page,setPage] = useState(0)
  const [more,setMore] = useState(false)
  const [search,setSearch] = useState('')
  const [message,setMessage] = useState('')
  const [loading,setLoading] = useState(false)
  const [busy,setBusy] = useState(false)
  const [dialog,setDialog] = useState<{order: Order; kind: Kind; action: string} | null>(null)
  const [history,setHistory] = useState<{id:string;action:string;reason?:string;created_at:string;actor_id:string}[]>([])
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
  function open(order: Order,kind: Kind,action: string) {
    const bd=order.billing_details
    setHistory([])
    if(action==='history') void supabase.from('or_tax_audit').select('id,action,reason,created_at,actor_id').eq('order_id',order.id).eq('kind',kind).order('created_at',{ascending:false}).then(({data,error})=>{if(error)setMessage(error.message);else setHistory(data || [])})
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
    setBusy(true)
    try {
      let payload: Record<string,unknown>={reason,expected_details:dialog.order.billing_details,expected_total:dialog.order.total_amount}
      if(dialog.action==='resubmit' && taxInvoiceErrors(tax).length) throw new Error(taxInvoiceErrors(tax).join(' · '))
      if(dialog.action==='resubmit') payload={tax_customer_name:tax.company_name,tax_id:tax.tax_id,tax_customer_address:tax.address,tax_branch:tax.branch || '00000',tax_address:tax.tax_address || null}
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
    } catch(e) {setMessage(e instanceof Error?e.message:(e as {message?:string})?.message || 'บันทึกไม่สำเร็จ')}
    finally{setBusy(false)}
  }
  return <section className="space-y-4 rounded-xl border bg-white p-4">
    <div className="flex flex-wrap gap-2">{Object.entries(mode==='withholding'?{...states,awaiting_receipt:'รอรับเอกสาร',received:'ได้รับแล้ว'}:states).filter(([key])=>mode!=='withholding'||key!=='issued').map(([key,label])=><button key={key} type="button" onClick={()=>{setFilter(key);setPage(0)}} className={`rounded px-3 py-2 ${filter===key?'bg-blue-600 text-white':'bg-gray-100'}`}>{label} ({counts[key] || 0})</button>)}<button type="button" onClick={()=>void load()} className="rounded border px-3">รีเฟรช</button></div>
    <label className="block">ค้นหาเลขบิล<input className="ml-2 rounded border p-2" value={search} onChange={e=>{setSearch(e.target.value);setPage(0)}} /></label>
    {loading?<p>กำลังโหลด…</p>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['เลขบิล / ลูกค้า','คำขอ','ยอดบิล / รับชำระ','ผลตรวจ / เอกสาร','ดำเนินการ'].map(h=><th className="p-2 text-left" key={h}>{h}</th>)}</tr></thead><tbody>{entries.map(({order,bd,kind,state,issued})=>{
      const amounts=calculateWithholding(Number(order.total_amount),bd?.withholding_requested===true,bd?.vat_rate ?? 7)
      return <tr key={`${order.id}:${kind}`} className="border-t"><td className="p-2">{order.bill_no}<br/>{order.customer_name}</td><td>{kind==='invoice'?'ใบกำกับภาษี':'หัก ณ ที่จ่าย 3%'}<br/>{kind==='withholding'&&`ยอดหัก ${amounts.withheld.toFixed(2)}`}</td><td>{amounts.gross.toFixed(2)} / {amounts.receivable.toFixed(2)}</td><td className="max-w-sm whitespace-pre-wrap p-2">{bd?.tax_workflow?.[kind]?.reason}{kind==='withholding'&&<p>{bd?.withholding_receipt?`ได้รับแล้ว · ${bd.withholding_receipt.reference}`:'รอรับเอกสาร'}</p>}{issued&&<p>ออกเอกสารแล้ว · {(order as Order & {tax_document?:{invoice_no:string;flow_account_reference:string}}).tax_document?.invoice_no}<br/>FlowAccount: {(order as Order & {tax_document?:{flow_account_reference:string}}).tax_document?.flow_account_reference || '—'}</p>}</td><td className="space-x-2 p-2">
        {mode==='sales'&&state==='rejected'&&<button type="button" onClick={()=>open(order,kind,'resubmit')} className="text-blue-700">แก้ไขและส่งใหม่</button>}
        {mode!=='sales'&&canApprove&&state==='pending'&&<><button type="button" onClick={()=>open(order,kind,'approve')} className="text-green-700">ตรวจและอนุมัติ</button><button type="button" onClick={()=>open(order,kind,'reject')} className="text-red-700">ส่งกลับแก้ไข</button></>}
        {mode==='invoice'&&state==='approved'&&<button type="button" onClick={()=>onIssue?.(order)} className="text-blue-700">{issued?'ดูเอกสาร / เลขอ้างอิง':'ออกใบกำกับภาษี ERP'}</button>}
        {mode!=='sales'&&canApprove&&state==='approved'&&!issued&&!order.work_order_id&&!order.work_order_name&&!bd?.withholding_receipt&&<button type="button" onClick={()=>open(order,kind,'reject')} className="text-red-700">ส่งกลับแก้ไข</button>}
        {mode==='withholding'&&canApprove&&state==='approved'&&!bd?.withholding_receipt&&<button type="button" onClick={()=>open(order,kind,'received')} className="text-blue-700">ได้รับแล้ว</button>}
        <button type="button" onClick={()=>open(order,kind,'history')} className="text-gray-700 underline">ประวัติ</button>
        {bd?.withholding_receipt && <button type="button" onClick={()=>void openEvidence(bd.withholding_receipt!.file_path)} className="text-blue-700">ดูไฟล์หนังสือรับรอง</button>}
      </td></tr>
    })}</tbody></table>{!entries.length&&<p className="p-4 text-gray-500">ไม่มีรายการในหน้านี้</p>}</div>}
    <div className="flex gap-3"><button type="button" disabled={!page} onClick={()=>setPage(p=>p-1)}>ก่อนหน้า</button><span>หน้าข้อมูล {page+1}</span><button type="button" disabled={!more} onClick={()=>setPage(p=>p+1)}>ถัดไป</button></div>
    <Modal open={!!dialog} onClose={()=>{if(!busy)setDialog(null)}} contentClassName="max-w-3xl"><div className="space-y-4 p-5"><h3 className="text-lg font-bold">{dialog?.order.bill_no} · {dialog?.action==='resubmit'?'แก้ข้อมูลและส่งใหม่':dialog?.action==='received'?'บันทึกรับหนังสือรับรอง':'ตรวจคำขอ'}</h3>
      {dialog?.action==='history'?<div className="space-y-2">{history.map(log=><p key={log.id}>{new Date(log.created_at).toLocaleString('th-TH')} · {log.action} · {log.reason || '—'} · ผู้ทำรายการ {log.actor_id}</p>)}{!history.length&&<p>ยังไม่มีประวัติในระบบใหม่</p>}</div>:dialog?.action==='resubmit'?<TaxInvoiceFields value={tax} onChange={setTax} disabled={busy}/>:dialog?.action==='received'?<><label className="block">เลขหนังสือรับรอง<input value={receipt.reference} onChange={e=>setReceipt({...receipt,reference:e.target.value})} className="w-full rounded border p-2"/></label><label>วันที่เอกสาร<input type="date" value={receipt.date} onChange={e=>setReceipt({...receipt,date:e.target.value})} className="rounded border p-2"/></label><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={e=>setFile(e.target.files?.[0] || null)}/></>:<><p>{dialog?.order.billing_details?.tax_customer_name} · {dialog?.order.billing_details?.tax_id} · สาขา {dialog?.order.billing_details?.tax_branch || '00000'}</p><p>{dialog?.order.billing_details?.tax_customer_address}</p>{dialog && <p className="rounded bg-amber-50 p-3">ยอดบิล {Number(dialog.order.total_amount).toFixed(2)} บาท · ฐานก่อน VAT {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).base.toFixed(2)} บาท · หัก ณ ที่จ่าย {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).withheld.toFixed(2)} บาท · รับชำระ {calculateWithholding(Number(dialog.order.total_amount),dialog.order.billing_details?.withholding_requested===true,dialog.order.billing_details?.vat_rate ?? 7).receivable.toFixed(2)} บาท</p>}{dialog?.order.billing_details?.tax_items?.map((item,index)=><p key={index}>{item.product_name} · {item.quantity} × {item.unit_price}</p>)}<label className="block">{dialog?.action==='reject'?'เหตุผลที่ส่งกลับ (จำเป็น)':'หมายเหตุ'}<textarea className="w-full rounded border p-2" value={reason} onChange={e=>setReason(e.target.value)}/></label></>}
      {dialog?.action!=='history' && <button type="button" disabled={busy || dialog?.action==='reject'&&!reason.trim()} onClick={()=>void submit()} className="rounded bg-blue-600 px-4 py-2 text-white">{busy?'กำลังบันทึก…':'ยืนยัน'}</button>}<button type="button" disabled={busy} onClick={()=>setDialog(null)} className="ml-3">ปิด</button>
    </div></Modal>
    {message&&<div role="status" className="rounded border bg-blue-50 p-3">{message}<button type="button" onClick={()=>setMessage('')} className="ml-4 underline">ปิด</button></div>}
  </section>
}
