import { useCallback, useEffect, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import Modal from '../ui/Modal'
import type { HRCompany } from '../../types'
import { type PayrollItem, type PayrollRun } from '../../lib/payrollApi'
import { cancelPayrollAdjustment, createPayrollAdjustment, fetchPayrollAdjustments, fetchPayrollPayments, financialValues, recordPayrollPayment, payrollFinancialYtd, type PayrollAdjustment, type PayrollPayment } from '../../lib/payrollPaymentApi'
import { FINANCIAL_FIELDS, lastDateOfMonth, payrollAmounts, roundMoney, type FinancialField } from '../../lib/payrollSchedule'
import PayrollSlipPDF from './pdf/PayrollSlipPDF'

const fmt=(value:number)=>Number(value||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const field='mt-1 w-full rounded-lg border px-3 py-2'
const labels:Record<FinancialField,string>={base_salary:'เงินเดือน/ค่าจ้าง',position_allowance:'เงินพิเศษ/ตำแหน่ง',overtime_pay:'OT',other_income:'รายได้อื่น',personal_tax:'ภาษี',social_security:'สปส.',ewf:'EWF',savings:'เงินสะสม',student_loan:'กยศ.',company_loan:'กู้บริษัทฯ',leave_deduction:'ลาเกินสิทธิ์',other_deduction:'หักอื่น'}
type Target={id:string;name:string;amount:number;adjustment:boolean}
export default function PayrollPaymentsPanel({company,run,items}:{company:HRCompany;run:PayrollRun;items:PayrollItem[]}) {
  const [payments,setPayments]=useState<PayrollPayment[]>([]),[adjustments,setAdjustments]=useState<PayrollAdjustment[]>([])
  const [selected,setSelected]=useState<Set<string>>(new Set()),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const [pay,setPay]=useState<{targets:Target[];key:string;date:string;channel:string;reference:string;evidence:string;review:boolean;ack:boolean}|null>(null)
  const [correct,setCorrect]=useState<{item:PayrollItem;values:Record<FinancialField,number>;previous:Record<FinancialField,number>;reason:string;key:string}|null>(null)
  const [cancel,setCancel]=useState<{id:string;reason:string}|null>(null)
  const [preview,setPreview]=useState<string|null>(null)
  const refresh=useCallback(async()=>{const [p,a]=await Promise.all([fetchPayrollPayments(company.id),fetchPayrollAdjustments(company.id)]);setPayments(p);setAdjustments(a)},[company.id])
  useEffect(()=>{refresh().catch(error=>setMessage(error.message))},[refresh])
  useEffect(()=>{setSelected(new Set());setPay(null);setCorrect(null)},[run.id])
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview)},[preview])
  const paid=new Map(payments.filter(row=>row.payroll_item_id).map(row=>[row.payroll_item_id!,row]))
  const settled=new Map(payments.filter(row=>row.adjustment_id).map(row=>[row.adjustment_id!,row]))
  const itemIds=new Set(items.map(item=>item.id))
  const related=adjustments.filter(row=>itemIds.has(row.source_item_id))
  const pending=items.filter(item=>item.id&&!paid.has(item.id))
  const targets=items.filter(item=>item.id&&selected.has(item.id)&&!paid.has(item.id)).map(item=>({id:item.id!,name:`${item.employee_code} ${item.employee_name}`,amount:payrollAmounts(item).net,adjustment:false}))
  const paidCount=items.filter(item=>item.id&&paid.has(item.id)).length
  const legacy=run.payment_tracking_state==='legacy_unknown'
  const history=payments.filter(row=>itemIds.has(row.payroll_item_id||'') || related.some(adjustment=>adjustment.id===row.adjustment_id))
  const openPay=(chosen:Target[])=>{setMessage('');setPay({targets:chosen,key:crypto.randomUUID(),date:today(),channel:chosen.every(row=>row.amount===0)?'offset':'bank',reference:'',evidence:'',review:false,ack:false})}
  const changePay=(patch:Partial<NonNullable<typeof pay>>)=>setPay(value=>value?{...value,...patch,key:crypto.randomUUID(),review:false}:value)
  const submitPayment=async()=>{
    if(!pay)return
    if(!pay.reference.trim()||!pay.date||pay.date>today()||(pay.evidence&&!pay.evidence.startsWith('https://'))||!pay.ack){setMessage('กรุณาตรวจวันจ่าย เลขอ้างอิง/หลักฐาน และยืนยันว่าจ่ายจริงแล้ว');return}
    if(!pay.review){setMessage('');setPay({...pay,review:true});return}
    setBusy(true);setMessage('')
    try {
      await recordPayrollPayment({requestKey:pay.key,runId:pay.targets.some(row=>!row.adjustment)?run.id:null,
        items:pay.targets.filter(row=>!row.adjustment).map(row=>({id:row.id,net_pay:row.amount})),adjustmentIds:pay.targets.filter(row=>row.adjustment).map(row=>row.id),
        paidDate:pay.date,channel:pay.channel,reference:pay.reference,evidenceUrl:pay.evidence})
      await refresh();setPay(null);setSelected(new Set());setMessage('บันทึกการจ่ายเรียบร้อย สามารถดูหลักฐานและสลิปจากประวัติได้')
    }catch(error){setMessage(error instanceof Error?error.message:'บันทึกไม่สำเร็จ ใช้คำขอเดิมเพื่อตรวจสอบ/ลองบันทึกอีกครั้งได้')}
    finally{setBusy(false)}
  }
  const openCorrection=(item:PayrollItem)=>{
    const values=financialValues(item)
    for(const adjustment of related.filter(row=>row.source_item_id===item.id&&row.status==='approved')) for(const key of FINANCIAL_FIELDS) values[key]=roundMoney(values[key]+Number(adjustment.deltas[key]||0))
    setCorrect({item,values,previous:{...values},reason:'',key:crypto.randomUUID()});setMessage('')
  }
  const saveCorrection=async()=>{
    if(!correct?.reason.trim()){setMessage('กรุณาระบุเหตุผลและหลักฐานของยอดที่ถูกต้อง');return}
    setBusy(true);setMessage('')
    try{await createPayrollAdjustment(correct.key,correct.item.id!,correct.values,correct.reason,correct.previous);await refresh();setCorrect(null);setMessage('สร้างรายการส่วนต่างแล้ว กรุณาบันทึกการจ่ายเพิ่มหรือรับคืนเฉพาะส่วนต่าง')}
    catch(error){setMessage(error instanceof Error?error.message:'สร้างรายการปรับปรุงไม่สำเร็จ')}finally{setBusy(false)}
  }
  const confirmCancel=async()=>{
    if(!cancel?.reason.trim()){setMessage('กรุณาระบุเหตุผลยกเลิก');return}
    setBusy(true)
    try{await cancelPayrollAdjustment(cancel.id,cancel.reason);await refresh();setCancel(null);setMessage('ยกเลิกรายการปรับปรุงที่ยังไม่จ่ายแล้ว')}
    catch(error){setMessage(error instanceof Error?error.message:'ยกเลิกไม่สำเร็จ')}finally{setBusy(false)}
  }
  const previewReceipt=async(item:PayrollItem,payment?:PayrollPayment,adjustment?:PayrollAdjustment)=>{
    setBusy(true);setMessage('')
    try {
      const ytd=await payrollFinancialYtd(company.id,item,run.period_end?.slice(0,7)||run.payroll_month.slice(0,7))
      const receiptItem=adjustment?{...item,...Object.fromEntries(FINANCIAL_FIELDS.map(key=>[key,Number(adjustment.deltas[key]||0)])),base_salary:Number(adjustment.deltas.base_salary||0),monthly_rate:null,monthly_payable_days:null,other_income:Number(adjustment.deltas.other_income||0),net_pay:adjustment.net_delta,gross_income:adjustment.income_delta,total_deduction:adjustment.deduction_delta}:item
      const date=payment?.batch?.paid_date||run.payment_date||''
      const blob=await pdf(<PayrollSlipPDF company={item.company_snapshot||company} item={receiptItem} monthLabel={`${adjustment?'รายการปรับปรุง · ':''}${run.period_start||run.payroll_month} – ${run.period_end||lastDateOfMonth(run.payroll_month.slice(0,7))}`} paymentDate={date||'ยังไม่ได้บันทึกจ่าย'} ytd={ytd}/>).toBlob()
      setPreview(URL.createObjectURL(blob))
    }catch(error){setMessage(error instanceof Error?error.message:'สร้างสลิปไม่สำเร็จ')}finally{setBusy(false)}
  }
  return <section className="space-y-4 rounded-xl border border-emerald-200 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">บันทึกผลการจ่ายเงินจริง</h3><p className="text-sm text-gray-600">{paidCount===items.length&&items.length?'จ่ายครบแล้ว':paidCount?`จ่ายบางส่วน ${paidCount}/${items.length} คน`:`${legacy?'รอตรวจประวัติการจ่ายเดิม':'รอจ่าย'} ${pending.length} คน`} · ขั้นตอนนี้บันทึกผลใน ERP การโอน/จ่ายเงินทำผ่านช่องทางจริงของบริษัท</p></div><div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>refresh().catch(error=>setMessage(error.message))} className="rounded-lg border px-3 py-2">โหลดสถานะล่าสุด</button><button type="button" disabled={busy||!targets.length} onClick={()=>openPay(targets)} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">{legacy?'บันทึกประวัติการจ่ายเดิม':'บันทึกการจ่าย'} ({targets.length})</button></div></div>
    {legacy&&pending.length>0&&<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">งวดนี้ยืนยันก่อนเริ่มระบบติดตามการจ่าย สถานะเดิมยังบอกไม่ได้ว่าโอนแล้วหรือยัง ให้ตรวจธนาคาร/เอกสารก่อน แล้วบันทึกวันที่และหลักฐานจริง ห้ามจ่ายใหม่จากสถานะนี้เพียงอย่างเดียว</p>}
    {message&&<p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{message}</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="bg-gray-50"><th className="p-2"><input type="checkbox" aria-label="เลือกผู้ที่ยังไม่บันทึกจ่ายทั้งหมด" checked={pending.length>0&&pending.every(item=>selected.has(item.id!))} onChange={event=>setSelected(event.target.checked?new Set(pending.map(item=>item.id!)):new Set())}/></th><th className="p-2 text-left">พนักงาน</th><th className="p-2 text-right">ยอดสุทธิ</th><th className="p-2 text-left">สถานะ / หลักฐาน</th><th className="p-2 text-right">รายการ</th></tr></thead><tbody>{items.map(item=>{const payment=paid.get(item.id!);const waiting=related.some(row=>row.source_item_id===item.id&&row.status==='approved'&&!settled.has(row.id));return <tr key={item.id} className="border-t"><td className="p-2"><input type="checkbox" aria-label={`เลือก ${item.employee_code}`} disabled={busy||!!payment} checked={!!item.id&&selected.has(item.id)&&!payment} onChange={event=>setSelected(value=>{const next=new Set(value);if(event.target.checked)next.add(item.id!);else next.delete(item.id!);return next})}/></td><td className="p-2">{item.employee_code} {item.employee_name}</td><td className="p-2 text-right">{fmt(payrollAmounts(item).net)}</td><td className="p-2">{payment?<div className="text-emerald-700">จ่ายแล้ว {payment.batch?.paid_date}<div className="text-xs">{payment.batch?.reference}</div></div>:<span className="text-amber-700">{legacy?'ตรวจประวัติเดิม':'รอจ่าย'}</span>}</td><td className="p-2"><div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={()=>void previewReceipt(item,payment)} className="rounded border px-2 py-1">สลิป</button>{payment&&<button type="button" disabled={busy||waiting} onClick={()=>openCorrection(item)} className="rounded border border-amber-400 px-2 py-1 text-amber-800">ปรับส่วนต่าง</button>}</div></td></tr>})}</tbody></table></div>
    {related.length>0&&<div className="space-y-2 border-t pt-3"><h4 className="font-medium">รายการปรับเพิ่ม/ลดที่อ้างอิงการจ่ายเดิม</h4>{related.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"><div>{row.source?.employee_code} · {row.reason}<div className={Number(row.net_delta)<0?'text-red-600':'text-emerald-700'}>{Number(row.net_delta)<0?'รับคืน':'จ่ายเพิ่ม'} {fmt(Math.abs(Number(row.net_delta)))} บาท · {row.status==='cancelled'?'ยกเลิกแล้ว':settled.has(row.id)?'บันทึกแล้ว':'รอบันทึก'}</div></div>{row.status==='approved'&&!settled.has(row.id)&&<div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>openPay([{id:row.id,name:`${row.source?.employee_code} · ${row.reason}`,amount:Number(row.net_delta),adjustment:true}])} className="rounded-lg bg-emerald-600 px-3 py-2 text-white">{Number(row.net_delta)<0?'บันทึกรับคืน':'บันทึกจ่ายส่วนต่าง'}</button><button type="button" disabled={busy} onClick={()=>{setMessage('');setCancel({id:row.id,reason:''})}} className="rounded-lg border px-3 py-2">ยกเลิกรายการ</button></div>}{settled.has(row.id)&&row.source&&<button type="button" disabled={busy} onClick={()=>void previewReceipt(row.source!,settled.get(row.id),row)} className="rounded border px-3 py-2">สลิปส่วนต่าง</button>}</div>)}</div>}
    {history.length>0&&<details className="border-t pt-3 text-sm"><summary className="cursor-pointer font-medium">ประวัติการบันทึกจ่าย/รับคืน ({history.length} รายการ)</summary>{history.map(row=><div key={row.id} className="mt-2 rounded border p-3">{row.batch?.paid_date} · {row.batch?.channel} · {row.batch?.reference} · {fmt(Number(row.amount))} บาท{row.batch?.evidence_url&&<a href={row.batch.evidence_url} target="_blank" rel="noreferrer" className="ml-2 text-blue-700 underline">หลักฐาน</a>}</div>)}</details>}
    <Modal open={!!pay} onClose={()=>{if(!busy)setPay(null)}} contentClassName="max-w-2xl" stackClassName="z-[60]">
      {pay&&<div className="space-y-4 p-5"><h3 className="pr-8 text-lg font-semibold">{pay.review?'ตรวจสอบก่อนบันทึกผลการจ่าย':'ระบุการจ่ายเงินจริง / รับคืน'}</h3>
        <p className="text-sm text-gray-600">งวด {run.period_start||run.payroll_month} – {run.period_end||'สิ้นเดือน'} · {company.name_th}</p>
        <div className="max-h-52 overflow-auto rounded border">{pay.targets.map(target=><div key={target.id} className="flex justify-between gap-3 border-b p-2 text-sm"><span>{target.name}</span><b>{fmt(target.amount)}</b></div>)}</div>
        <p className="text-right font-semibold">{pay.targets.reduce((sum,row)=>sum+row.amount,0)<0?'ยอดรับคืน':'ยอดจ่าย'} {fmt(Math.abs(pay.targets.reduce((sum,row)=>sum+row.amount,0)))} บาท</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm">วันที่จ่าย/รับคืนจริง<input type="date" max={today()} disabled={busy||pay.review} value={pay.date} onChange={event=>changePay({date:event.target.value})} className={field}/></label><label className="text-sm">ช่องทาง<select disabled={busy||pay.review} value={pay.channel} onChange={event=>changePay({channel:event.target.value})} className={field}><option value="bank">โอนธนาคาร</option><option value="cash">เงินสด</option><option value="other">ช่องทางอื่น</option><option value="offset">ยอดสุทธิศูนย์ / ไม่มีเงินโอน</option></select></label><label className="text-sm sm:col-span-2">เลขอ้างอิงธนาคาร/ใบสำคัญ หรือรายละเอียดหลักฐาน<input disabled={busy||pay.review} value={pay.reference} onChange={event=>changePay({reference:event.target.value})} className={field}/></label><label className="text-sm sm:col-span-2">ลิงก์หลักฐาน HTTPS (ถ้ามี)<input type="url" disabled={busy||pay.review} value={pay.evidence} onChange={event=>changePay({evidence:event.target.value})} className={field}/></label></div>
        <label className="flex gap-2 text-sm"><input type="checkbox" disabled={busy||pay.review} checked={pay.ack} onChange={event=>changePay({ack:event.target.checked})}/><span>ตรวจยอด ผู้รับเงิน และหลักฐานแล้ว ยืนยันว่าการจ่าย/รับคืนเกิดขึ้นจริง หรือเป็นรายการสุทธิศูนย์</span></label>
        {message&&<p className="text-sm text-red-600">{message}</p>}<div className="flex justify-end gap-2">{pay.review&&<button type="button" disabled={busy} onClick={()=>setPay({...pay,review:false})} className="rounded-lg border px-4 py-2">กลับไปแก้ไข</button>}<button type="button" disabled={busy} onClick={()=>setPay(null)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={busy} onClick={()=>void submitPayment()} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">{busy?'กำลังตรวจสอบและบันทึก...':pay.review?'ยืนยันบันทึกผลการจ่าย':'ตรวจสอบยอดก่อนบันทึก'}</button></div>
      </div>}
    </Modal>
    <Modal open={!!correct} onClose={()=>{if(!busy)setCorrect(null)}} contentClassName="max-w-3xl" stackClassName="z-[60]">
      {correct&&<div className="space-y-4 p-5"><h3 className="pr-8 text-lg font-semibold">ปรับยอดที่ถูกต้อง — {correct.item.employee_code}</h3><p className="text-sm text-gray-600">คงสลิปและการจ่ายเดิมไว้ ระบบจะสร้างเฉพาะส่วนต่างรายได้และรายการหัก ห้ามกรอกยอดส่วนต่างในช่องยอดที่ถูกต้อง</p><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{FINANCIAL_FIELDS.map(key=><label key={key} className="text-sm">{labels[key]} ที่ถูกต้อง<input type="number" min="0" step="0.01" value={correct.values[key]} onChange={event=>setCorrect({...correct,key:crypto.randomUUID(),values:{...correct.values,[key]:Number(event.target.value)}})} className={field}/></label>)}</div><label className="block text-sm">เหตุผลและหลักฐาน<textarea rows={3} value={correct.reason} onChange={event=>setCorrect({...correct,key:crypto.randomUUID(),reason:event.target.value})} className={field}/></label><div className="text-right">สุทธิที่ถูกต้อง {fmt(payrollAmounts(correct.values).net)} บาท · สุทธิสะสมเดิม {fmt(payrollAmounts(correct.previous).net)} บาท · ส่วนต่าง {fmt(roundMoney(payrollAmounts(correct.values).net-payrollAmounts(correct.previous).net))} บาท</div>{message&&<p className="text-sm text-red-600">{message}</p>}<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={()=>setCorrect(null)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={busy} onClick={()=>void saveCorrection()} className="rounded-lg bg-amber-600 px-4 py-2 text-white">ยืนยันสร้างเฉพาะส่วนต่าง</button></div></div>}
    </Modal>
    <Modal open={!!cancel} onClose={()=>{if(!busy)setCancel(null)}} contentClassName="max-w-md" stackClassName="z-[60]">{cancel&&<div className="space-y-3 p-5"><h3 className="pr-8 font-semibold">ยกเลิกรายการส่วนต่างที่ยังไม่จ่าย</h3><textarea rows={3} value={cancel.reason} onChange={event=>setCancel({...cancel,reason:event.target.value})} placeholder="เหตุผล" className={field}/>{message&&<p className="text-sm text-red-600">{message}</p>}<button type="button" disabled={busy} onClick={()=>void confirmCancel()} className="rounded-lg bg-red-600 px-4 py-2 text-white">ยืนยันยกเลิก</button></div>}</Modal>
    <Modal open={!!preview} onClose={()=>setPreview(null)} contentClassName="max-w-none h-full" stackClassName="z-[70]">{preview&&<iframe title="สลิปการจ่าย/ส่วนต่าง" src={preview} className="h-full min-h-[70vh] w-full"/>}</Modal>
  </section>
}
