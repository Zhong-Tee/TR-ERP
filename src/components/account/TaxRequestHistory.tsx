import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type AuditData = Record<string, unknown> | null
type HistoryEntry = {
  id: string; action: string; reason: string | null; created_at: string; actor_id: string
  before_data: AuditData; after_data: AuditData
}
const actions: Record<string,string> = {
  approve:'อนุมัติคำขอ', reject:'ส่งกลับแก้ไข', resubmit:'แก้ไขข้อมูลและส่งคำขอใหม่',
  received:'บันทึกรับหนังสือรับรองหัก ณ ที่จ่าย', issue:'ออกใบกำกับภาษี',
  recover_legacy:'บันทึกเลขใบกำกับภาษีเดิม', initialize_series:'ตั้งเลขลำดับล่าสุด',
  flow_reference:'บันทึกเลขอ้างอิง FlowAccount', close_cancelled:'ปิดคำขอของบิลยกเลิก',
}
const value = (data: AuditData, key: string) => {
  const v=data?.[key]
  return typeof v==='string'||typeof v==='number' ? String(v).trim() : ''
}
function details(log: HistoryEntry): [string,string][] {
  const before=log.before_data, after=log.after_data
  if(log.action==='flow_reference') {
    const old=value(before,'reference'), next=value(after,'reference')
    return old===next ? [['เลขอ้างอิง',`${next || 'ไม่ได้ระบุ'} (ไม่มีการเปลี่ยนแปลง)`]]
      : [['เลขอ้างอิงเดิม',old || 'ไม่ได้ระบุ'],['เลขอ้างอิงใหม่',next || 'ล้างเลขอ้างอิง']]
  }
  if(log.action==='initialize_series') return [
    ['รอบเอกสาร',value(after,'period') ? `${value(after,'period').slice(2)}/${2000+Number(value(after,'period').slice(0,2))}` : 'ไม่ได้ระบุ'],
    ['ลำดับล่าสุด',value(after,'last_number') || '0'],
  ]
  if(log.action==='issue'||log.action==='recover_legacy') return [
    ['เลขใบกำกับภาษี',value(after,'invoice_no') || 'ไม่ได้ระบุ'],
    ...(value(after,'flow_account_reference') ? [['เลขอ้างอิง FlowAccount',value(after,'flow_account_reference')] as [string,string]] : []),
  ]
  if(log.action==='resubmit') return ['tax_customer_name','tax_id','tax_customer_address','tax_branch']
    .filter(key=>value(before,key)!==value(after,key))
    .map(key=>[({tax_customer_name:'ผู้รับใบกำกับภาษี',tax_id:'เลขผู้เสียภาษี',tax_customer_address:'ที่อยู่',tax_branch:'สาขา'} as Record<string,string>)[key],`${value(before,key)||'ไม่ได้ระบุ'} → ${value(after,key)||'ไม่ได้ระบุ'}`])
  return []
}

export default function TaxRequestHistory({orderId,kind}:{orderId:string;kind:'invoice'|'withholding'}) {
  const [entries,setEntries]=useState<HistoryEntry[]>([])
  const [names,setNames]=useState<Record<string,string>>({})
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    setLoading(true);setError('');setEntries([]);setNames({})
    void (async()=>{
      try {
        const {data,error}=await supabase.from('or_tax_audit')
          .select('id,action,reason,created_at,actor_id,before_data,after_data')
          .eq('order_id',orderId).eq('kind',kind).order('created_at',{ascending:false})
        if(error) throw error
        if(!active) return
        const logs=(data || []) as HistoryEntry[]
        setEntries(logs)
        const ids=[...new Set(logs.map(log=>log.actor_id).filter(Boolean))]
        if(ids.length) {
          // A missing/inaccessible user must not hide the audit history.
          try {
            const {data:users}=await supabase.from('us_users').select('id,username,email').in('id',ids)
            if(active) setNames(Object.fromEntries((users || []).map(u=>[u.id,u.username || u.email || 'ไม่พบชื่อผู้ทำรายการ'])))
          } catch { /* Show the fallback name while preserving all audit events. */ }
        }
      } catch(e) {
        if(active) setError((e as {message?:string})?.message || 'โหลดประวัติไม่สำเร็จ กรุณาปิดแล้วลองใหม่')
      } finally {if(active) setLoading(false)}
    })()
    return ()=>{active=false}
  },[orderId,kind])
  if(loading) return <p role="status">กำลังโหลดประวัติ…</p>
  if(error) return <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-700">{error}</p>
  if(!entries.length) return <p className="text-gray-500">ยังไม่มีประวัติในระบบใหม่</p>
  return <div className="space-y-3"><p className="text-sm text-gray-500">ล่าสุดอยู่ด้านบน · {entries.length} รายการ</p>
    <ol className="space-y-3">{entries.map(log=><li key={log.id} className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`font-semibold ${log.action==='reject'?'text-red-700':'text-blue-700'}`}>{actions[log.action] || 'ดำเนินการกับคำขอ'}</p>
        <time dateTime={log.created_at} className="text-sm text-gray-500">{new Date(log.created_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time>
      </div>
      <p className="mt-1 text-sm text-gray-600">ผู้ทำรายการ: {names[log.actor_id] || 'ไม่พบชื่อผู้ทำรายการ'}</p>
      <dl className="mt-3 space-y-1 text-sm">{details(log).map(([label,text])=><div key={label} className="grid gap-1 sm:grid-cols-[9rem_1fr]"><dt className="text-gray-500">{label}</dt><dd className="break-words whitespace-pre-wrap">{text}</dd></div>)}</dl>
      {log.reason&&<p className="mt-3 break-words whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm"><span className="font-medium">{log.action==='reject'?'เหตุผลที่ส่งกลับ: ':'หมายเหตุ: '}</span>{log.reason}</p>}
    </li>)}</ol>
  </div>
}
