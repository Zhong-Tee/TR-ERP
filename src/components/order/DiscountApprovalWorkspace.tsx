import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { DISCOUNT_STATUS } from '../../lib/salesDiscountApproval'
import Modal from '../ui/Modal'

type Row = { source: string; id: string; document_no: string; owner_name: string; reason: string; subtotal: number; shipping_cost: number; discount: number; total_amount: number; status: string; created_at: string; reviewed_name?: string; reviewed_at?: string; review_note?: string; snapshot: { items?: { product_id: string; product_name?: string; quantity: number; unit_price: number; is_free?: boolean }[] } }
const money = (v: number) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export default function DiscountApprovalWorkspace({ onChanged }: { onChanged: () => void }) {
 const { user } = useAuthContext()
 const [status, setStatus] = useState('pending'), [type, setType] = useState('all'), [offset, setOffset] = useState(0)
 const [rows, setRows] = useState<Row[]>([]), [count, setCount] = useState(0), [loading, setLoading] = useState(false)
 const [error, setError] = useState(''), [reviewing, setReviewing] = useState<Row | null>(null), [approve, setApprove] = useState(true), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
 const loadVersion = useRef({ value: 0 })
 const load = useCallback(async () => {
  if (user?.role !== 'superadmin') return
  const version = ++loadVersion.current.value
  setLoading(true); setError('')
  try {
   const { data, error: e } = await supabase.rpc('rpc_discount_approval_queue', { p_status: status, p_type: type, p_offset: offset })
   if (version !== loadVersion.current.value) return
   if (e) throw e
   setRows(data.rows || []); setCount(data.count || 0)
  } catch (e) { if (version === loadVersion.current.value) { setError((e as Error).message); setRows([]); setCount(0) } }
  finally { if (version === loadVersion.current.value) setLoading(false) }
 }, [status, type, offset, user?.role])
 useEffect(() => {
  const generation = loadVersion.current
  const timer = setTimeout(() => void load(), 0)
  const channel = supabase.channel('discount-approval-workspace')
   .on('postgres_changes', { event: '*', schema: 'public', table: 'or_sales_discount_requests' }, () => void load())
   .on('postgres_changes', { event: '*', schema: 'public', table: 'or_prebill_documents' }, () => void load()).subscribe()
  return () => { clearTimeout(timer); generation.value++; void supabase.removeChannel(channel) }
 }, [load])
 async function decide() {
  if (!reviewing || busy) return
  setBusy(true); setError('')
  try {
   const { error: e } = reviewing.source === 'sale'
    ? await supabase.rpc('rpc_review_sales_discount', { p_request_id: reviewing.id, p_approve: approve, p_note: note.trim() || null })
    : await supabase.rpc('rpc_review_prebill_discount', { p_document_id: reviewing.id, p_approve: approve, p_approved_discount: null, p_note: note.trim() || null })
   if (e) throw e
   setReviewing(null); await load(); onChanged(); window.dispatchEvent(new CustomEvent('discount-approval-refresh'))
  } catch (e) { setError((e as Error).message) }
  finally { setBusy(false) }
 }
 if (user?.role !== 'superadmin') return <p className="p-4 text-red-700">เฉพาะ superadmin เท่านั้นที่เข้าหน้าอนุมัติส่วนลดได้</p>
 return <div className="space-y-4">
  <div className="flex flex-wrap items-end gap-3"><label className="text-sm">ประเภทเอกสาร<select value={type} onChange={e => { setType(e.target.value); setOffset(0) }} className="ml-2 rounded-xl border p-2">{[['all','ทั้งหมด'],['sale','บิลขาย'],['QT','QT'],['PC','PC']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label className="text-sm">สถานะ<select value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }} className="ml-2 rounded-xl border p-2">{[['pending','รออนุมัติ'],['approved','อนุมัติแล้ว'],['rejected','ไม่อนุมัติ'],['all','ทั้งหมด']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><button onClick={() => void load()} className="rounded-xl border px-4 py-2">โหลดใหม่</button><span>{count} รายการ</span></div>
  {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
  <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-sm"><thead className="bg-slate-100"><tr>{['ประเภท / เลขเอกสาร','ผู้ขอ / เหตุผล','ยอดสินค้า','ค่าส่ง','ส่วนลดรวม','ยอดสุทธิ','สถานะ / ผู้พิจารณา','จัดการ'].map(t => <th className="whitespace-nowrap p-3 text-left" key={t}>{t}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={8} className="p-6 text-center">กำลังโหลด...</td></tr> : !rows.length ? <tr><td colSpan={8} className="p-6 text-center">ไม่มีรายการ</td></tr> : rows.map(r => <tr key={`${r.source}-${r.id}`} className="border-t align-top"><td className="p-3 font-semibold">{r.source === 'sale' ? 'บิลขาย' : r.source} · {r.document_no}</td><td className="p-3"><div>{r.owner_name}</div><div className="whitespace-pre-wrap text-slate-500">{r.reason}</div></td>{[r.subtotal,r.shipping_cost,r.discount,r.total_amount].map((v,i) => <td key={i} className={`whitespace-nowrap p-3 ${i===3 && Number(v)===0 ? 'font-bold text-green-700' : ''}`}>{money(v)}</td>)}<td className="p-3">{DISCOUNT_STATUS[r.status] || r.status}<div>{r.reviewed_name}</div><div className="text-xs text-slate-500">{r.reviewed_at && new Date(r.reviewed_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</div><div>{r.review_note}</div></td><td className="p-3"><button onClick={() => { setReviewing(r); setApprove(true); setNote(''); setError('') }} className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-white">{r.status==='pending' ? 'พิจารณา' : 'ดูรายละเอียด'}</button></td></tr>)}</tbody></table></div>
  <div className="flex justify-end gap-3"><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0,offset-50))}>ก่อนหน้า</button><span>{count ? offset+1 : 0}–{Math.min(offset+50,count)} / {count}</span><button disabled={offset+50>=count || loading} onClick={() => setOffset(offset+50)}>ถัดไป</button></div>
  <Modal open={!!reviewing} onClose={() => { if (!busy) setReviewing(null) }} contentClassName="max-w-2xl" ariaLabelledby="discount-review-title"><div className="space-y-4 p-6">{reviewing && <><h3 id="discount-review-title" className="pr-8 text-xl font-bold">ส่วนลด {reviewing.document_no}</h3><p>ผู้ขอ: {reviewing.owner_name}</p><p className="whitespace-pre-wrap">เหตุผล: {reviewing.reason}</p><p>ยอดสินค้า {money(reviewing.subtotal)} + ค่าส่ง {money(reviewing.shipping_cost)} − ส่วนลด {money(reviewing.discount)} = <b>{money(reviewing.total_amount)} บาท</b></p><ul className="max-h-56 overflow-y-auto text-sm">{reviewing.snapshot.items?.map((i,n) => <li className="border-b py-2" key={n}>{i.product_name || i.product_id} · {i.quantity} × {money(i.unit_price)} {i.is_free ? '(ของแถม)' : ''}</li>)}</ul>{error && <p role="alert" className="text-red-700">{error}</p>}{reviewing.status==='pending' && <><label className="block">ผลพิจารณา<select disabled={busy} value={approve ? 'yes' : 'no'} onChange={e => setApprove(e.target.value==='yes')} className="ml-3 rounded-lg border p-2"><option value="yes">อนุมัติ</option><option value="no">ไม่อนุมัติ</option></select></label><label className="block">หมายเหตุผู้พิจารณา {!approve && '(บังคับ)'}<textarea disabled={busy} value={note} onChange={e => setNote(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border p-3" /></label><div className="flex justify-end"><button disabled={busy || (!approve && !note.trim())} onClick={() => void decide()} className="rounded-xl bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-50">{busy ? 'กำลังบันทึก...' : 'ยืนยันผลพิจารณา'}</button></div></>}</>}</div></Modal>
 </div>
}
