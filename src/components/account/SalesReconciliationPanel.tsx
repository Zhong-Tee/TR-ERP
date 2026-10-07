import { useCallback, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import ReconciliationDateFilter from './ReconciliationDateFilter'
import { bangkokToday } from '../../lib/reconciliationDate'

type Bill = { id: string; bill_no: string; created_at: string; channel_code: string; payment_method: string | null; total_amount: number; bank_received: number; certified_received: number; evidence_amount: number; reconciliation_state: string; statement_coverage: string }
type Receipt = { id: string; amount: number; receipt_method: string; received_on: string; reason: string; evidence_reference: string | null; certified_by: string; certified_at: string; revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null; actor?: string; revoker?: string }
type Workspace = { rows: Bill[]; count: number; channels: string[]; summary: { cash: number; other_certified: number; bills: number; sales: number; bank: number; certified: number; outstanding: number }; states: Record<string, number> }
const states: Record<string, string> = { pending: 'ค้างดำเนินการ', no_evidence: 'ยังไม่มีหลักฐานรับเงิน', waiting_bank: 'รอพบเงินเข้า', partial: 'รับเงินบางส่วน', matched: 'กระทบยอดธนาคารครบ', certified: 'รับเงินครบ มีการรับรอง', overpaid: 'รับเกิน', all: 'ทั้งหมด' }
const methods: Record<string, string> = { cash: 'เงินสด', other: 'ช่องทางอื่น', transfer_exception: 'โอน: รับรองกรณีพิเศษ' }
const money = (value: number) => Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function SalesReconciliationPanel({ openOrder, refreshKey, onChanged, initialStatus = 'pending' }: { initialStatus?: string; openOrder: (id: string) => void; refreshKey: number; onChanged: () => void }) {
  const { user } = useAuthContext()
  const [from, setFrom] = useState('2026-10-01')
  const [to, setTo] = useState(bangkokToday)
  const [status, setStatus] = useState(initialStatus)
  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('')
  const [method, setMethod] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [bill, setBill] = useState<Bill | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [receiptLoading, setReceiptLoading] = useState(false)
  const [amount, setAmount] = useState('')
  const [receiptMethod, setReceiptMethod] = useState('cash')
  const [receivedOn, setReceivedOn] = useState(bangkokToday())
  const [reason, setReason] = useState('')
  const [evidence, setEvidence] = useState('')
  const [revoke, setRevoke] = useState<Receipt | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const receiptGeneration = useRef(0)
  const cancelLoad = useCallback(() => { generation.current++ }, [])
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setError('')
    if (from && to && from > to) { setError('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด'); setLoading(false); return }
    const result = await supabase.rpc('bank_sales_workspace', { p_from: from || null, p_to: to || null, p_status: status, p_search: search.trim(), p_channel: channel.trim(), p_method: method, p_offset: offset })
    if (request !== generation.current) return
    if (result.error) { setError(result.error.message); setData(null) } else setData(result.data as Workspace)
    setLoading(false)
  }, [from, to, status, search, channel, method, offset])
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => { window.clearTimeout(timer); cancelLoad() } }, [load, refreshKey, cancelLoad])

  async function loadReceipts(orderId: string) {
    const request = ++receiptGeneration.current
    setReceiptLoading(true)
    const result = await supabase.rpc('bank_receipt_history', { p_order_id: orderId })
    if (request !== receiptGeneration.current) return
    if (result.error) { setError(result.error.message); setReceiptLoading(false); return }
    setReceipts((result.data || []) as Receipt[])
    setReceiptLoading(false)
  }
  function openReceipt(row: Bill) {
    setBill(row); setReceipts([]); setRevoke(null); setRevokeReason(''); setError('')
    setAmount(String(Math.max(0, Number(row.total_amount) - Number(row.bank_received) - Number(row.certified_received))))
    setReason(''); setEvidence(''); setReceivedOn(bangkokToday()); setReceiptMethod(row.payment_method === 'เงินสด' ? 'cash' : 'transfer_exception')
    void loadReceipts(row.id)
  }
  async function certify() {
    if (!bill || busy) return
    setBusy(true); setError('')
    const result = await supabase.rpc('bank_certify_receipt', { p_order_id: bill.id, p_amount: Number(amount), p_method: receiptMethod, p_received_on: receivedOn, p_reason: reason.trim(), p_evidence: evidence.trim() || null })
    if (result.error) setError(result.error.message)
    else { setBill(null); await load(); onChanged() }
    setBusy(false)
  }
  async function revokeReceipt() {
    if (!revoke || !bill || busy) return
    setBusy(true); setError('')
    const result = await supabase.rpc('bank_revoke_receipt', { p_id: revoke.id, p_reason: revokeReason.trim() })
    if (result.error) setError(result.error.message)
    else { setBill(null); setRevoke(null); await load(); onChanged() }
    setBusy(false)
  }
  async function exportBills() {
    setBusy(true); setError('')
    try {
      const rows: Bill[] = []
      for (let start = 0; ; start += 50) {
        const result = await supabase.rpc('bank_sales_workspace', { p_from: from || null, p_to: to || null, p_status: status, p_search: search.trim(), p_channel: channel.trim(), p_method: method, p_offset: start })
        if (result.error) throw result.error
        const page = result.data as Workspace; rows.push(...page.rows)
        if (rows.length >= page.count || !page.rows.length) break
      }
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.map(r => ({ 'เลขบิล': r.bill_no, 'วันที่บิล': r.created_at, 'ช่องทาง': r.channel_code, 'วิธีชำระ': r.payment_method, 'ยอดบิล': Number(r.total_amount), 'ธนาคาร': Number(r.bank_received), 'รับรอง': Number(r.certified_received), 'ค้าง': Math.max(0, Number(r.total_amount)-Number(r.bank_received)-Number(r.certified_received)), 'สถานะ': states[r.reconciliation_state] }))), 'บิลขาย')
      XLSX.writeFile(workbook, 'ติดตามเงินรับบิลขาย.xlsx')
    } catch (caught) { setError((caught as { message?: string }).message || String(caught)) }
    finally { setBusy(false) }
  }
  const field = 'rounded-lg border border-gray-300 px-3 py-2 text-sm'
  return <section className="space-y-4 rounded-xl border bg-white p-5">
    <div className="flex flex-wrap justify-between gap-2"><div><h3 className="font-semibold">ติดตามเงินรับจากบิลขาย ตั้งแต่ 1 ต.ค. 2569</h3><p className="text-xs text-gray-500">กรองตามวันที่สร้างบิล · รวมเงินรับตลอดอายุบิล · ติดตามเฉพาะบิลตั้งแต่ 1 ต.ค. 2569 เป็นต้นไป</p></div><div className="flex gap-2"><button disabled={busy || loading} onClick={() => void exportBills()} className={field}>ดาวน์โหลด Excel</button><button onClick={() => void load()} className={field}>รีเฟรช</button></div></div>
    <ReconciliationDateFilter from={from} to={to} onChange={(a,b) => { setFrom(a && a > '2026-10-01' ? a : '2026-10-01'); setTo(b); setOffset(0) }} />
    <div className="flex flex-wrap gap-2">
      <select aria-label="สถานะบิล" value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }} className={field}>{Object.entries(states).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      <input aria-label="ค้นหาเลขบิล" value={search} placeholder="ค้นหาเลขบิล" onChange={e => { setSearch(e.target.value); setOffset(0) }} className={field} />
      <select aria-label="ช่องทางขาย" value={channel} onChange={e => { setChannel(e.target.value); setOffset(0) }} className={field}><option value="">ทุกช่องทางขาย</option>{(data?.channels || []).map(c => <option key={c} value={c}>{c}</option>)}</select>
      <select aria-label="วิธีชำระเงิน" value={method} onChange={e => { setMethod(e.target.value); setOffset(0) }} className={field}><option value="">ทุกวิธีชำระ</option>{['โอน','เงินสด','เก็บเงินปลายทาง','เครดิต'].map(m => <option key={m}>{m}</option>)}</select>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {data && <><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[['ยอดบิล',data.summary.sales],['จับคู่ธนาคาร',data.summary.bank],['เงินสดรับรองแล้ว',data.summary.cash],['รับรองช่องทางอื่น',data.summary.other_certified],['ยอดค้าง',data.summary.outstanding]].map(([label,value]) => <div key={label} className="rounded-lg bg-blue-50 p-3"><div className="text-xs text-gray-600">{label}</div><div className="font-bold">฿{money(Number(value))}</div></div>)}</div>
    <p className="text-xs text-gray-500">ยอดสรุปจาก {data.summary.bills} บิลตามวันที่ ช่องทาง และวิธีชำระที่เลือก · จำนวนในตารางแยกตามสถานะ</p><div className="flex flex-wrap gap-2">{Object.entries(data.states).map(([key,count]) => <button key={key} onClick={() => { setStatus(key); setOffset(0) }} className={`rounded-full border px-3 py-1.5 text-xs ${status===key ? 'bg-blue-100 text-blue-800' : ''}`}>{states[key]} ({count})</button>)}</div></>}
    <div className="overflow-x-auto"><table className="w-full min-w-[950px] text-sm"><thead className="bg-gray-50"><tr>{['วันที่บิล','เลขบิล / ช่องทาง','วิธีชำระ','ยอดบิล','ธนาคาร','รับรอง','ยอดค้าง','สถานะ','จัดการ'].map(label => <th key={label} className="p-3 text-left">{label}</th>)}</tr></thead><tbody>
      {loading ? <tr><td colSpan={9} className="p-8 text-center">กำลังโหลด...</td></tr> : !data?.rows.length ? <tr><td colSpan={9} className="p-8 text-center text-gray-500">ไม่พบบิลตามตัวกรอง</td></tr> : data.rows.map(row => <tr key={row.id} className="border-t align-top"><td className="p-3 whitespace-nowrap">{new Date(row.created_at).toLocaleDateString('th-TH',{timeZone:'Asia/Bangkok'})}</td><td className="p-3"><button onClick={() => openOrder(row.id)} className="font-semibold text-blue-700 hover:underline">{row.bill_no}</button><div className="text-xs text-gray-500">{row.channel_code}</div></td><td className="p-3">{row.payment_method || '–'}</td>{[row.total_amount,row.bank_received,row.certified_received,Math.max(0,Number(row.total_amount)-Number(row.bank_received)-Number(row.certified_received))].map((v,i) => <td key={i} className="p-3 whitespace-nowrap">฿{money(v)}</td>)}<td className="p-3"><span className={`text-xs font-semibold ${['matched','certified'].includes(row.reconciliation_state) ? 'text-emerald-700' : 'text-amber-700'}`}>{states[row.reconciliation_state]}</span>{row.reconciliation_state==='waiting_bank' && <div className="mt-1 text-xs text-gray-500">{row.statement_coverage==='not_uploaded' ? 'ยังไม่มี Statement ครอบคลุมวันรับเงิน' : row.statement_coverage==='covered' ? 'มี Statement ครอบคลุมแล้ว ยังไม่จับคู่' : 'ยังระบุช่วง Statement ไม่ได้'}</div>}</td><td className="p-3"><button onClick={() => openReceipt(row)} className="text-xs font-medium text-violet-700 hover:underline">{user?.role==='superadmin' ? 'รับรอง / ประวัติ' : 'ประวัติรับรอง'}</button></td></tr>)}
    </tbody></table></div>
    <div className="flex items-center justify-between text-sm"><span>{data?.count || 0} บิล · หน้า {offset/50+1}</span><div className="flex gap-2"><button disabled={offset===0 || loading} onClick={() => setOffset(offset-50)} className={`${field} disabled:opacity-40`}>ก่อนหน้า</button><button disabled={loading || offset+50 >= (data?.count || 0)} onClick={() => setOffset(offset+50)} className={`${field} disabled:opacity-40`}>ถัดไป</button></div></div>
    <Modal open={!!bill} onClose={() => { if (!busy) { receiptGeneration.current++; setBill(null) } }} contentClassName="max-w-2xl w-full">
      {bill && <div className="space-y-4 p-5"><h3 className="text-lg font-bold">รับรองเงินรับ · {bill.bill_no}</h3>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <p className="text-sm">ยอดค้าง ฿{money(Math.max(0,Number(bill.total_amount)-Number(bill.bank_received)-Number(bill.certified_received)))}</p>
        {user?.role==='superadmin' && <div className="space-y-3 rounded-lg bg-violet-50 p-4"><div className="grid grid-cols-2 gap-3"><label className="text-sm">วิธีรับเงิน<select className={`mt-1 w-full ${field}`} value={receiptMethod} onChange={e => setReceiptMethod(e.target.value)}>{Object.entries(methods).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label><label className="text-sm">ยอดรับรอง<input type="number" min="0.01" step="0.01" className={`mt-1 w-full ${field}`} value={amount} onChange={e => setAmount(e.target.value)} /></label><label className="text-sm">วันที่รับเงิน<input type="date" max={bangkokToday()} className={`mt-1 w-full ${field}`} value={receivedOn} onChange={e => setReceivedOn(e.target.value)} /></label><label className="text-sm">หลักฐาน / เลขอ้างอิง<input className={`mt-1 w-full ${field}`} value={evidence} onChange={e => setEvidence(e.target.value)} /></label></div><label className="block text-sm">เหตุผลรับรอง<textarea className={`mt-1 w-full ${field}`} value={reason} onChange={e => setReason(e.target.value)} /></label>{receiptMethod==='transfer_exception' && <p className="text-xs text-amber-800">การรับรองกรณีพิเศษไม่ถือว่าเงินถูกกระทบยอดกับธนาคารแล้ว หากพบรายการธนาคารภายหลัง ให้ยกเลิกการรับรองก่อนจับคู่</p>}<button disabled={busy || receiptLoading || !reason.trim() || !receivedOn || !Number.isFinite(Number(amount)) || Number(amount)<=0} onClick={() => void certify()} className="rounded-lg bg-violet-600 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? 'กำลังบันทึก...' : 'ยืนยันรับรองเงินรับ'}</button></div>}
        <h4 className="font-semibold">ประวัติการรับรอง</h4>{receiptLoading ? <p>กำลังโหลด...</p> : !receipts.length ? <p className="text-sm text-gray-500">ยังไม่มีการรับรอง</p> : receipts.map(r => <div key={r.id} className="rounded-lg border p-3 text-sm"><div className="font-semibold">{methods[r.receipt_method]} ฿{money(r.amount)} · {r.received_on}</div><p>{r.reason}</p>{r.evidence_reference && <p>หลักฐาน: {r.evidence_reference}</p>}<p className="text-xs text-gray-500">ผู้รับรอง: {r.actor} · {new Date(r.certified_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</p>{r.revoked_at ? <p className="text-xs text-red-700">ยกเลิกโดย {r.revoker} · {new Date(r.revoked_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})} · {r.revoke_reason}</p> : user?.role==='superadmin' && <button onClick={() => { setRevoke(r); setRevokeReason('') }} className="mt-2 text-xs text-red-700">ยกเลิกการรับรอง</button>}</div>)}
        {revoke && <div className="space-y-2 rounded-lg bg-red-50 p-3"><label className="text-sm">เหตุผลยกเลิก<input value={revokeReason} onChange={e => setRevokeReason(e.target.value)} className={`mt-1 w-full ${field}`} /></label><button disabled={busy || !revokeReason.trim()} onClick={() => void revokeReceipt()} className="text-sm font-semibold text-red-700 disabled:opacity-40">ยืนยันยกเลิกการรับรอง ฿{money(revoke.amount)}</button></div>}
      </div>}
    </Modal>
  </section>
}
