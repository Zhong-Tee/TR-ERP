import { useEffect, useState } from 'react'
import Modal from '../ui/Modal'
import { fetchHRCompanies } from '../../lib/payrollApi'
import { fetchPaySchedules, savePaySchedule } from '../../lib/payrollPaymentApi'
import { DEFAULT_PAY_SCHEDULE_ID, schedulePeriods, type PaySchedule } from '../../lib/payrollSchedule'
import type { HRCompany } from '../../types'

const field='mt-1 w-full rounded-lg border px-3 py-2'
const fresh=(company_id:string):Partial<PaySchedule>=>({company_id,name:'',frequency:'monthly',weekday:1,first_day:15,second_day:null,payment_day:null,holiday_rule:'none',deduction_policy:'last',cutoff_time:'18:00',is_active:true})
const labels={daily:'ทุกวัน',weekly:'รายสัปดาห์',semimonthly:'เดือนละสองครั้ง',monthly:'รายเดือน',custom:'กำหนดช่วงเอง'}
export default function PayScheduleSettings() {
  const [companies,setCompanies]=useState<HRCompany[]>([]),[companyId,setCompanyId]=useState(''),[rows,setRows]=useState<PaySchedule[]>([])
  const [form,setForm]=useState<Partial<PaySchedule>|null>(null),[saving,setSaving]=useState(false),[message,setMessage]=useState('')
  useEffect(()=>{fetchHRCompanies().then(value=>{setCompanies(value);setCompanyId(value[0]?.id||'')}).catch(error=>setMessage(error.message))},[])
  useEffect(()=>{if(companyId) fetchPaySchedules(companyId).then(setRows).catch(error=>setMessage(error.message))},[companyId])
  const save=async()=>{
    if(!form?.name?.trim() || !form.company_id) {setMessage('กรุณาระบุชื่อและบริษัท');return}
    setSaving(true);setMessage('')
    try {
      const value={...form,name:form.name.trim()}
      if(value.frequency!=='custom') schedulePeriods(value as PaySchedule,'2026-02')
      await savePaySchedule(value);setRows(await fetchPaySchedules(companyId));setForm(null)
    } catch(error) {setMessage(error instanceof Error?error.message:'บันทึกรอบจ่ายไม่สำเร็จ')}
    finally{setSaving(false)}
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3"><label className="text-sm">บริษัท<select value={companyId} onChange={event=>setCompanyId(event.target.value)} className={field}>{companies.map(company=><option key={company.id} value={company.id}>{company.name_th}</option>)}</select></label><button type="button" onClick={()=>{setMessage('');setForm(fresh(companyId))}} disabled={!companyId} className="rounded-lg bg-emerald-600 px-4 py-2 text-white">เพิ่มรอบจ่าย</button></div>
    <p className="text-sm text-gray-600">คิดสิทธิ์ค่าจ้างตามเดือนปฏิทิน รอบจ่ายกำหนดช่วงที่จะนำมาจ่าย หากรอบมีประวัติใช้งานแล้ว ให้ทำสำเนาและกำหนดวันที่เริ่มมีผลในทะเบียนพนักงาน</p>
    {message && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{message}</p>}
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-sm"><thead><tr className="bg-gray-50"><th className="p-3 text-left">ชื่อรอบ</th><th className="p-3 text-left">ความถี่</th><th className="p-3 text-left">รายการหักรายเดือน</th><th className="p-3 text-right">จัดการ</th></tr></thead><tbody>{rows.map(row=><tr key={row.id} className="border-t"><td className="p-3">{row.name}{!row.is_active&&' (พักใช้งาน)'}</td><td className="p-3">{labels[row.frequency]}</td><td className="p-3">{row.deduction_policy==='last'?'หักงวดสุดท้ายของเดือน':'กระจายตามช่วงวันและคุมยอดรวมเดือน'}</td><td className="p-3 text-right"><div className="flex justify-end gap-2">{row.id!==DEFAULT_PAY_SCHEDULE_ID&&<button type="button" onClick={()=>{setMessage('');setForm({...row})}} className="rounded border px-3 py-1">แก้ไข</button>}<button type="button" onClick={()=>{setMessage('');setForm({...row,id:undefined,company_id:companyId,name:`${row.name} (สำเนา)`})}} className="rounded border px-3 py-1">ทำสำเนา</button></div></td></tr>)}</tbody></table></div>
    <Modal open={!!form} onClose={()=>{if(!saving)setForm(null)}} contentClassName="max-w-2xl">
      {form&&<div className="space-y-4 p-5"><h3 className="pr-8 text-lg font-semibold">ตั้งค่ารอบจ่าย</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">ชื่อรอบ<input value={form.name||''} onChange={event=>setForm({...form,name:event.target.value})} className={field}/></label>
          <label className="text-sm">ความถี่<select value={form.frequency} onChange={event=>setForm({...form,frequency:event.target.value as PaySchedule['frequency']})} className={field}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          {form.frequency==='weekly'&&<label className="text-sm">วันจ่าย (ค่าจ้าง 7 วันก่อนวันจ่าย)<select value={form.weekday} onChange={event=>setForm({...form,weekday:Number(event.target.value)})} className={field}>{['จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์','เสาร์','อาทิตย์'].map((day,index)=><option key={day} value={index+1}>{day}</option>)}</select></label>}
          {form.frequency==='semimonthly'&&<><label className="text-sm">วันที่ตัดงวดแรก<input type="number" min={1} max={27} value={form.first_day} onChange={event=>setForm({...form,first_day:Number(event.target.value)})} className={field}/></label><label className="text-sm">วันที่ตัดงวดที่สอง<select value={form.second_day||''} onChange={event=>setForm({...form,second_day:event.target.value?Number(event.target.value):null})} className={field}><option value="">วันสุดท้ายของเดือน</option>{Array.from({length:16},(_,index)=>index+16).map(day=><option key={day} value={day}>{day}</option>)}</select></label></>}
          {form.frequency==='monthly'&&<label className="text-sm">วันจ่าย (หากก่อนสิ้นเดือนจะเป็นเดือนถัดไป)<select value={form.payment_day||''} onChange={event=>setForm({...form,payment_day:event.target.value?Number(event.target.value):null})} className={field}><option value="">วันสุดท้ายของเดือน</option>{Array.from({length:31},(_,index)=>index+1).map(day=><option key={day} value={day}>{day}</option>)}</select></label>}
          <label className="text-sm">วันจ่ายตรงเสาร์–อาทิตย์/วันหยุดบริษัท<select value={form.holiday_rule} onChange={event=>setForm({...form,holiday_rule:event.target.value as PaySchedule['holiday_rule']})} className={field}><option value="none">คงวันเดิม</option><option value="next">วันทำการถัดไป</option><option value="previous">วันทำการก่อนหน้า</option></select></label>
          <label className="text-sm">เวลาปิดงวดวันสุดท้าย<input type="time" value={form.cutoff_time?.slice(0,5)} onChange={event=>setForm({...form,cutoff_time:event.target.value})} className={field}/></label>
          <label className="text-sm">การหักรายการรายเดือน<select value={form.deduction_policy} onChange={event=>setForm({...form,deduction_policy:event.target.value as PaySchedule['deduction_policy']})} className={field}><option value="last">หักงวดสุดท้ายของเดือน</option><option value="proportional">กระจายตามวัน คุมยอดรวมต่อเดือน</option></select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={event=>setForm({...form,is_active:event.target.checked})}/>เปิดใช้งาน</label>
        </div>
        <p className="text-xs text-gray-500">วันที่ไม่มีในเดือนจะใช้วันสุดท้ายของเดือน หากกำหนดวันที่ 15 กับ 30 วันที่ 31 จะอยู่ในงวดแรกของเดือนถัดไป การยืนยันต้องรอปิดงวด แม้วันจ่ายตามแผนเลื่อนมาก่อนวันปิดงวด</p>
        {message&&<p className="text-sm text-red-600">{message}</p>}<div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={()=>setForm(null)} className="rounded-lg border px-4 py-2">ยกเลิก</button><button type="button" disabled={saving} onClick={()=>void save()} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">บันทึก</button></div>
      </div>}
    </Modal>
  </div>
}
