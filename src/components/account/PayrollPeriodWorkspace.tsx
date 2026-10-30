import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pdf } from '@react-pdf/renderer'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import Modal from '../ui/Modal'
import { useAuthContext } from '../../contexts/AuthContext'
import type { HRCompany } from '../../types'
import { fetchHRCompanies, savePayrollRun, type PayrollItem, type PayrollRun, type PayrollType } from '../../lib/payrollApi'
import { buildScheduledPayroll, changePayrollRun, fetchPayHolidays, fetchPaySchedules, fetchPeriodHistory, fetchPeriodRun, payrollFinancialYtd, setPeriodManualAmount } from '../../lib/payrollPaymentApi'
import { DEFAULT_PAY_SCHEDULE_ID, lastDateOfMonth, payrollAmounts, periodClosed, schedulePeriods, type PayPeriod, type PaySchedule } from '../../lib/payrollSchedule'
import PayrollPaymentsPanel from './PayrollPaymentsPanel'
import PayrollSlipPDF from './pdf/PayrollSlipPDF'

const now=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(' ','T')
const fmt=(value:number)=>Number(value||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2})
const field='mt-1 w-full rounded-lg border px-3 py-2'
const periodKey=(period:PayPeriod)=>JSON.stringify(period)
export default function PayrollPeriodWorkspace() {
  const {user}=useAuthContext()
  const [companies,setCompanies]=useState<HRCompany[]>([]),[companyId,setCompanyId]=useState(''),[schedules,setSchedules]=useState<PaySchedule[]>([]),[holidays,setHolidays]=useState(new Set<string>())
  const [selection,setSelection]=useState({scheduleId:DEFAULT_PAY_SCHEDULE_ID,month:now().slice(0,7),key:'',start:'',end:'',pay:''})
  const [kind,setKind]=useState<PayrollType>('permanent'),[items,setItems]=useState<PayrollItem[]>([]),[run,setRun]=useState<PayrollRun|null>(null),[history,setHistory]=useState<PayrollRun[]>([])
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[message,setMessage]=useState(''),[search,setSearch]=useState(''),[reserved,setReserved]=useState(0),[dirty,setDirty]=useState(false)
  const [preview,setPreview]=useState<{item:PayrollItem;url:string}|null>(null)
  const [action,setAction]=useState<'confirm'|'reload'|'reopen'|'cancel'|null>(null),[reason,setReason]=useState('')
  const [clock,setClock]=useState(now())
  const version=useRef(0)
  const company=companies.find(row=>row.id===companyId),schedule=schedules.find(row=>row.id===selection.scheduleId)
  const periods=useMemo(()=>schedule?schedulePeriods(schedule,selection.month,holidays):[],[schedule,selection.month,holidays])
  const defaultPeriod=periods.filter(row=>row.paymentDate<=clock.slice(0,10)).at(-1)||periods[0]
  let selected:PayPeriod|undefined
  if(schedule?.frequency==='custom')selected={start:selection.start||`${selection.month}-01`,end:selection.end||lastDateOfMonth(selection.month),paymentDate:selection.pay||lastDateOfMonth(selection.month)}
  else if(selection.key){try{selected=JSON.parse(selection.key) as PayPeriod}catch{selected=defaultPeriod}}else selected=defaultPeriod
  const start=selected?.start||'',end=selected?.end||'',payDate=selected?.paymentDate||''
  const locked=run?.status==='confirmed',closed=!!selected&&!!schedule&&periodClosed(selected,schedule.cutoff_time,clock)
  const legacy=schedule?.id===DEFAULT_PAY_SCHEDULE_ID&&start.endsWith('-01')&&end===lastDateOfMonth(start.slice(0,7))
  useEffect(()=>{fetchHRCompanies().then(rows=>{setCompanies(rows);setCompanyId(rows[0]?.id||'')}).catch(error=>setMessage(error.message))},[])
  useEffect(()=>{if(companyId)fetchPaySchedules(companyId).then(setSchedules).catch(error=>setMessage(error.message))},[companyId])
  useEffect(()=>{fetchPayHolidays(selection.month).then(setHolidays).catch(error=>setMessage(error.message))},[selection.month])
  useEffect(()=>{const interval=setInterval(()=>setClock(now()),30000);return()=>clearInterval(interval)},[])
  useEffect(()=>()=>{if(preview)URL.revokeObjectURL(preview.url)},[preview])
  const load=useCallback(async()=>{
    if(!company||!schedule||!start||!end||!payDate||end<start)return
    const token=++version.current;setLoading(true);setMessage('');setItems([]);setRun(null);setDirty(false)
    try{
      const period={start,end,paymentDate:payDate}
      const [saved,reports]=await Promise.all([fetchPeriodRun(company.id,kind,schedule,period),fetchPeriodHistory(company.id)])
      const result=await buildScheduledPayroll(company,kind,schedule,period,saved)
      if(token!==version.current)return
      setRun(saved);setHistory(reports);setItems(result.items);setReserved(result.reservedCount)
    }catch(error){if(token===version.current)setMessage(error instanceof Error?error.message:'โหลดงวดไม่สำเร็จ')}
    finally{if(token===version.current)setLoading(false)}
  },[company,schedule,start,end,payDate,kind])
  useEffect(()=>{void load()},[load])
  const save=async(confirm:boolean,approved=false)=>{
    if(!company||!schedule||!selected||loading||saving)return
    if(confirm&&!approved){setMessage('');setAction('confirm');return}
    if(confirm&&(!closed||items.some(item=>!item.reviewed_at||Number(item.unresolved_attendance_days||0)>0||payrollAmounts(item).net<0))){setMessage('ยังไม่ปิดงวด หรือมีสลิป/เวลาเข้าออก/ยอดติดลบที่ต้องตรวจสอบ');setAction(null);return}
    setSaving(true);setMessage('');setAction(null)
    try{
      // Recompute immutable source inputs before confirmation. Preserve manual
      // adjustments, but invalidate a review if earnings or deduction caps moved.
      if(confirm){
        const fresh=await buildScheduledPayroll(company,kind,schedule,selected,{...(run||{}),status:'draft',items} as PayrollRun)
        const changed=fresh.items.length!==items.length||fresh.items.some(item=>!item.reviewed_at)
        if(changed){setItems(fresh.items);setDirty(true);setMessage('ข้อมูลสิทธิ์ค่าจ้างหรือยอดหักสะสมเปลี่ยนแล้ว กรุณาตรวจสลิปที่เปลี่ยนก่อนยืนยัน');return}
      }
      const saved=await savePayrollRun({month:start.slice(0,7),company,paymentDate:payDate,items,confirm,payrollType:kind,expectedVersion:run?.version||0,
        scheduleId:legacy?null:schedule.id,periodStart:start,periodEnd:end})
      setRun(saved);setItems(saved.items||[]);setDirty(false);setHistory(await fetchPeriodHistory(company.id));setMessage(confirm?'ยืนยันยอดแล้ว สถานะรอจ่าย กรุณาบันทึกผลหลังจ่ายเงินจริง':'บันทึกร่างแล้ว')
    }catch(error){setMessage(error instanceof Error?error.message:'บันทึกงวดไม่สำเร็จ')}finally{setSaving(false)}
  }
  const modifyRun=async(cancel:boolean)=>{
    if(!run||!reason.trim()){setMessage('กรุณาระบุเหตุผล');return}
    setSaving(true)
    try{await changePayrollRun(run.id,reason,cancel);setAction(null);setReason('');await load();setMessage(cancel?'ยกเลิกงวดแล้ว เก็บข้อมูลเดิมในประวัติ':'เปิดปรับปรุงงวดที่ยังไม่จ่ายแล้ว ต้องตรวจสลิปใหม่')}
    catch(error){setMessage(error instanceof Error?error.message:'ปรับงวดไม่สำเร็จ')}finally{setSaving(false)}
  }
  const slip=async(item:PayrollItem)=>{
    if(!company)return
    const ytd=await payrollFinancialYtd(company.id,item,end.slice(0,7),!locked)
    return pdf(<PayrollSlipPDF company={item.company_snapshot||company} item={item} monthLabel={`${start} – ${end}`} paymentDate={payDate} ytd={ytd}/>).toBlob()
  }
  const openPreview=async(item:PayrollItem)=>{
    setSaving(true)
    try{const blob=await slip(item);if(blob)setPreview({item,url:URL.createObjectURL(blob)})}
    catch(error){setMessage(error instanceof Error?error.message:'สร้างสลิปไม่สำเร็จ')}finally{setSaving(false)}
  }
  const markReviewed=(reviewed:boolean)=>{
    if(!preview||locked)return
    setItems(rows=>rows.map(item=>item.employee_id===preview.item.employee_id?{...item,reviewed_at:reviewed?new Date().toISOString():null,reviewed_by:reviewed?user?.id:null}:item))
    setDirty(true);setPreview(null)
  }
  const downloadZip=async()=>{
    if(!company)return
    setSaving(true)
    try{const zip=new JSZip();for(const item of items){const blob=await slip(item);if(blob)zip.file(`${item.employee_code}_${start}_${end}.pdf`,blob)}const url=URL.createObjectURL(await zip.generateAsync({type:'blob'}));const a=document.createElement('a');a.href=url;a.download=`สลิป_${schedule?.name}_${start}_${end}.zip`;a.click();URL.revokeObjectURL(url)}
    catch(error){setMessage(error instanceof Error?error.message:'สร้าง ZIP ไม่สำเร็จ')}finally{setSaving(false)}
  }
  const exportExcel=()=>{
    const rows=items.map(item=>({รหัส:item.employee_code,พนักงาน:item.employee_name,เริ่มงวด:start,สิ้นงวด:end,วันจ่ายตามแผน:payDate,ค่าจ้าง:item.base_salary,เงินพิเศษ:item.position_allowance,OT:item.overtime_pay,รายได้อื่น:item.other_income,รวมรายได้:payrollAmounts(item).income,รวมหัก:payrollAmounts(item).deduction,สุทธิ:payrollAmounts(item).net,สถานะ:locked?'ยืนยันยอด/ตรวจสถานะจ่ายจากประวัติ':'ร่าง'}))
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'งวดค่าจ้าง');XLSX.writeFile(book,`งวดค่าจ้าง_${start}_${end}.xlsx`)
  }
  const shown=items.filter(item=>`${item.employee_code} ${item.employee_name} ${item.employee_nickname||''}`.toLocaleLowerCase('th-TH').includes(search.toLocaleLowerCase('th-TH')))
  const totals=items.reduce((sum,item)=>({income:sum.income+payrollAmounts(item).income,deduction:sum.deduction+payrollAmounts(item).deduction,net:sum.net+payrollAmounts(item).net}),{income:0,deduction:0,net:0})
  const guardSelect=()=>{if(dirty){setMessage('มีการแก้ไขที่ยังไม่บันทึก กรุณาบันทึกร่าง หรือกดโหลดใหม่เพื่อยืนยันการทิ้งข้อมูลก่อนเปลี่ยนงวด');return false}return true}
  return <div className="space-y-4">
    <div className="rounded-xl border bg-white p-4"><h2 className="font-semibold">จัดทำตามรอบจ่ายและบันทึกผลการจ่าย</h2><p className="mt-1 text-sm text-gray-600">สิทธิ์ค่าจ้างอ้างอิงวันที่ 1–สิ้นเดือนจริง รอบจ่ายแบ่งช่วงวัน ยืนยันยอดเป็นการกันรายการไว้ ส่วนจ่ายแล้วบันทึกหลังตรวจหลักฐานจริง</p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4"><label className="text-sm">บริษัท<select value={companyId} disabled={saving} onChange={event=>{if(guardSelect()){setCompanyId(event.target.value);setSelection({...selection,scheduleId:DEFAULT_PAY_SCHEDULE_ID,key:''})}}} className={field}>{companies.map(row=><option key={row.id} value={row.id}>{row.name_th}</option>)}</select></label>
        <label className="text-sm">กลุ่มค่าจ้าง<select value={kind} disabled={saving} onChange={event=>{if(guardSelect())setKind(event.target.value as PayrollType)}} className={field}><option value="permanent">รายเดือน (เข้า สปส.)</option><option value="monthly_uninsured">รายเดือน (ไม่เข้า สปส.)</option><option value="daily">ค่าจ้างรายวัน</option></select></label>
        <label className="text-sm">รอบจ่าย<select value={selection.scheduleId} disabled={saving} onChange={event=>{if(guardSelect())setSelection({...selection,scheduleId:event.target.value,key:''})}} className={field}>{schedules.map(row=><option key={row.id} value={row.id}>{row.name}{!row.is_active?' (พักใช้งาน)':''}</option>)}</select></label>
        <label className="text-sm">เดือนแสดงงวด<input type="month" disabled={saving} value={selection.month} onChange={event=>{if(event.target.value&&guardSelect())setSelection({...selection,month:event.target.value,key:''})}} className={field}/></label>
      </div>
      {schedule?.frequency==='custom'?<div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">{[['start','วันเริ่มงวด'],['end','วันสิ้นงวด'],['pay','วันจ่ายตามแผน']].map(([key,label])=><label key={key} className="text-sm">{label}<input type="date" disabled={saving} value={key==='start'?start:key==='end'?end:payDate} onChange={event=>{if(guardSelect())setSelection({...selection,[key]:event.target.value})}} className={field}/></label>)}</div>:<label className="mt-3 block text-sm">งวดค่าจ้าง<select disabled={saving} value={selected?periodKey(selected):''} onChange={event=>{if(guardSelect())setSelection({...selection,key:event.target.value})}} className={field}>{selected&&!periods.some(row=>periodKey(row)===periodKey(selected))&&<option value={periodKey(selected)}>งวดจากประวัติ {start} – {end}</option>}{periods.map(row=><option key={periodKey(row)} value={periodKey(row)}>{row.start} – {row.end} · จ่าย {row.paymentDate}</option>)}</select></label>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div className="text-sm"><b>{run?.status==='cancelled'?'ยกเลิกแล้ว / จัดทำใหม่ได้':locked?'ยืนยันแล้ว · ตรวจผลการจ่ายด้านล่าง':`ร่าง · ตรวจแล้ว ${items.filter(item=>item.reviewed_at).length}/${items.length} คน`}</b>{!closed&&!locked&&<p className="text-amber-700">ยังไม่ปิดงวด: {end} เวลา {schedule?.cutoff_time?.slice(0,5)} น.</p>}</div><div className="flex flex-wrap gap-2"><button type="button" disabled={saving||loading} onClick={()=>setAction('reload')} className="rounded-lg border px-3 py-2">โหลดใหม่</button><button type="button" disabled={saving||!items.length} onClick={exportExcel} className="rounded-lg border px-3 py-2">Excel</button><button type="button" disabled={saving||!items.length} onClick={()=>void downloadZip()} className="rounded-lg border px-3 py-2">ZIP สลิป</button>{!locked?<><button type="button" disabled={saving||loading||!schedule?.is_active} onClick={()=>void save(false)} className="rounded-lg border px-3 py-2">บันทึกร่าง</button><button type="button" disabled={saving||loading||!closed||!items.length||items.some(item=>!item.reviewed_at)||!schedule?.is_active} onClick={()=>void save(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-white disabled:opacity-50">ยืนยันยอด / รอจ่าย</button></>:<button type="button" disabled={saving} onClick={()=>{setReason('');setAction('reopen')}} className="rounded-lg border border-amber-500 px-3 py-2 text-amber-800">เปิดปรับปรุงที่ยังไม่จ่าย</button>}{run&&run.status!=='cancelled'&&<button type="button" disabled={saving} onClick={()=>{setReason('');setAction('cancel')}} className="rounded-lg border border-red-300 px-3 py-2 text-red-700">ยกเลิกงวดที่ยังไม่จ่าย</button>}</div></div>
    </div>
    {message&&<p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{message}</p>}
    {!!reserved&&<p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">ไม่นำวันที่ยืนยัน/จ่ายในงวดอื่นแล้ว {reserved} วันพนักงานมาจ่ายซ้ำ หากต้องแก้ยอดที่จ่ายแล้วให้ใช้รายการส่วนต่าง</p>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[['พนักงาน',items.length],['รวมรายได้',totals.income],['รวมหัก',totals.deduction],['สุทธิ',totals.net]].map(([label,value])=><div key={label} className="rounded-xl border bg-white p-4"><div className="text-xs text-gray-500">{label}</div><div className="mt-1 text-xl font-bold text-emerald-700">{fmt(Number(value))}</div></div>)}</div>
    <label className="block text-sm">ค้นหาพนักงาน<input type="search" value={search} onChange={event=>setSearch(event.target.value)} className={field}/></label>
    <div className="overflow-x-auto rounded-xl border bg-white">{loading?<p className="p-8 text-center">กำลังคำนวณสิทธิ์ค่าจ้างและตรวจรายการซ้ำ...</p>:<table className="w-full whitespace-nowrap text-sm"><thead><tr className="bg-gray-50">{['พนักงาน','ช่วงวันที่/จำนวนวัน','ค่าจ้าง','เงินพิเศษ','OT','ภาษี','สปส.','EWF','เงินสะสม','กยศ.','กู้บริษัทฯ','ลาเกินสิทธิ์','รายได้อื่น','หักอื่น','สุทธิ','ตรวจสอบ'].map(label=><th key={label} className="p-3 text-right first:text-left">{label}</th>)}</tr></thead><tbody>{shown.map(item=><tr key={item.employee_id} className="border-t"><td className="p-3"><b>{item.employee_code}</b><div>{item.employee_name}</div></td><td className="p-3 text-right text-xs">{item.earning_dates?.[0]} – {item.earning_dates?.at(-1)}<div>{item.earning_dates?.length||0} วันในช่วง{kind==='daily'?` · จ่าย ${fmt(Number(item.payable_days))} วัน`:''}</div>{Number(item.unresolved_attendance_days)>0&&<div className="text-red-600">ต้องตรวจเวลา {item.unresolved_attendance_days} วัน</div>}</td>{(['base_salary','position_allowance','overtime_pay','personal_tax','social_security','ewf','savings','student_loan','company_loan','leave_deduction'] as const).map(key=><td key={key} className="p-3 text-right">{fmt(item[key])}</td>)}{(['other_income','other_deduction'] as const).map(key=><td key={key} className="p-2 text-right">{locked?fmt(item[key]):<input type="number" min={0} step="0.01" disabled={saving} value={item[key]} onChange={event=>{setDirty(true);setItems(rows=>rows.map(row=>row.employee_id===item.employee_id?setPeriodManualAmount(row,key,Number(event.target.value)||0):row))}} className="w-24 rounded border px-2 py-1 text-right"/>}</td>)}<td className={`p-3 text-right font-semibold ${payrollAmounts(item).net<0?'text-red-600':'text-emerald-700'}`}>{fmt(payrollAmounts(item).net)}</td><td className="p-3 text-right"><button type="button" disabled={saving} onClick={()=>void openPreview(item)} className="rounded border px-3 py-2">{item.reviewed_at?'ตรวจแล้ว / ดูสลิป':'ดูและตรวจสลิป'}</button></td></tr>)}{!shown.length&&<tr><td colSpan={16} className="p-8 text-center text-gray-500">ไม่พบสิทธิ์ค่าจ้างในรอบนี้ ตรวจรอบจ่ายที่กำหนดให้พนักงานและวันที่เริ่มมีผล</td></tr>}</tbody></table>}</div>
    {company&&run?.status==='confirmed'&&<PayrollPaymentsPanel company={company} run={run} items={items}/>}
    <details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer font-medium">งวดเดิมและประวัติ ({history.length} งวด)</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">ช่วงค่าจ้าง</th><th className="p-2 text-left">รอบ / กลุ่ม</th><th className="p-2 text-left">สถานะยอด</th><th className="p-2 text-right">เปิด</th></tr></thead><tbody>{history.map(row=><tr key={row.id} className="border-t"><td className="p-2">{row.period_start||row.payroll_month} – {row.period_end||lastDateOfMonth(row.payroll_month.slice(0,7))}</td><td className="p-2">{row.schedule_snapshot?.name||'รายเดือนเดิม'} · {row.payroll_type==='daily'?'รายวัน':row.payroll_type==='monthly_uninsured'?'รายเดือน ไม่เข้า สปส.':'รายเดือน เข้า สปส.'}</td><td className="p-2">{row.status==='confirmed'?'ยืนยันยอดแล้ว (ตรวจสถานะจ่ายเมื่อเปิด)':row.status==='cancelled'?'ยกเลิก':'ร่าง'}</td><td className="p-2 text-right"><button type="button" disabled={saving} onClick={()=>{if(!guardSelect())return;setKind(row.payroll_type||'permanent');setSelection({scheduleId:row.schedule_id||DEFAULT_PAY_SCHEDULE_ID,month:(row.period_end||row.payroll_month).slice(0,7),key:periodKey({start:row.period_start||row.payroll_month,end:row.period_end||lastDateOfMonth(row.payroll_month.slice(0,7)),paymentDate:row.payment_date||lastDateOfMonth(row.payroll_month.slice(0,7))}),start:row.period_start||row.payroll_month,end:row.period_end||lastDateOfMonth(row.payroll_month.slice(0,7)),pay:row.payment_date||lastDateOfMonth(row.payroll_month.slice(0,7))})}} className="rounded border px-3 py-1">เปิดงวด</button></td></tr>)}</tbody></table></div></details>
    <Modal open={!!preview} onClose={()=>setPreview(null)} contentClassName="max-w-none h-full" stackClassName="z-[60]">{preview&&<div className="flex h-full flex-col"><div className="flex items-center justify-between gap-3 border-b p-4 pr-16"><div>{preview.item.employee_code} · {start} – {end}</div>{!locked&&<div className="flex gap-2"><button type="button" onClick={()=>markReviewed(false)} className="rounded-lg border px-3 py-2">ยังไม่ตรวจสอบ</button><button type="button" onClick={()=>markReviewed(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-white">ตรวจสอบแล้ว</button></div>}</div><iframe title="ตรวจสลิปก่อนยืนยันงวด" src={preview.url} className="min-h-[60vh] w-full flex-1"/></div>}</Modal>
    <Modal open={!!action} onClose={()=>{if(!saving)setAction(null)}} contentClassName="max-w-lg" stackClassName="z-[70]"><div className="space-y-4 p-5"><h3 className="pr-8 text-lg font-semibold">{action==='confirm'?'ยืนยันยอดและกันรายการค่าจ้าง':action==='reload'?'โหลดข้อมูลใหม่':action==='cancel'?'ยกเลิกงวดที่ยังไม่จ่าย':'เปิดปรับปรุงงวดที่ยังไม่จ่าย'}</h3><p className="text-sm text-gray-600">{action==='confirm'?`${start} – ${end} · ${items.length} คน · สุทธิ ${fmt(totals.net)} บาท หลังยืนยันเป็นรอจ่าย ยังไม่ได้บันทึกว่าจ่ายเงินจริง`:action==='reload'?'ข้อมูลที่ยังไม่บันทึกจะถูกแทนที่ด้วยข้อมูลล่าสุด':'ระบบเก็บสำเนายอดเดิม ยอดที่จ่ายจริงแล้วปรับด้วยรายการส่วนต่างเท่านั้น'}</p>{(action==='reopen'||action==='cancel')&&<textarea rows={3} value={reason} onChange={event=>setReason(event.target.value)} placeholder="เหตุผล" className={field}/>}<div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={()=>setAction(null)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={saving} onClick={()=>{if(action==='confirm')void save(true,true);else if(action==='reload'){setAction(null);void load()}else void modifyRun(action==='cancel')}} className="rounded-lg bg-emerald-600 px-4 py-2 text-white">ยืนยัน</button></div>{message&&<p className="text-sm text-red-600">{message}</p>}</div></Modal>
  </div>
}
