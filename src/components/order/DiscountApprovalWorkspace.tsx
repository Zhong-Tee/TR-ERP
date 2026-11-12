import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { DISCOUNT_STATUS } from '../../lib/salesDiscountApproval'
import Modal from '../ui/Modal'
import { FiEye } from 'react-icons/fi'
import OrderDetailView from './OrderDetailView'
import PreBillPreview from './PreBillPreview'
import { loadPreBillDetail } from '../../lib/prebillWorkspace'
import type { Order } from '../../types'
import type { PreBillDocument } from '../../types/prebill'

type Row = { source: string; id: string; document_id: string; document_no: string; owner_name: string; reason: string; subtotal: number; shipping_cost: number; discount: number; total_amount: number; status: string; created_at: string; reviewed_name?: string; reviewed_at?: string; review_note?: string; snapshot: { channel_code?: string; payment_method?: string; price?: number; items?: { product_id: string; product_name?: string; quantity: number; unit_price: number; is_free?: boolean; is_detail_row?: boolean }[] } }
const dateTime = (value?: string) => value ? new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-'
const money = (v: number) => Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export default function DiscountApprovalWorkspace({ onChanged }: { onChanged: () => void }) {
 const { user } = useAuthContext()
 const [status, setStatus] = useState('pending'), [type, setType] = useState('all'), [offset, setOffset] = useState(0)
 const [rows, setRows] = useState<Row[]>([]), [count, setCount] = useState(0), [loading, setLoading] = useState(false)
 const [error, setError] = useState(''), [reviewing, setReviewing] = useState<Row | null>(null), [approve, setApprove] = useState(true), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
 const [confirming, setConfirming] = useState(false)
 const [detail, setDetail] = useState<{ source: string; order?: Order; prebill?: PreBillDocument } | null>(null)
 const [detailLoading, setDetailLoading] = useState(false)
 const [detailError, setDetailError] = useState('')
 const [context, setContext] = useState<{ customer_name?: string; channel_code?: string } | null>(null)
 const reviewVersion = useRef(0)
 const detailVersion = useRef(0)
 const detailLock = useRef(false)
 async function openDetails(row: Row) {
  if (detailLock.current) return
  detailLock.current = true
  const version = ++detailVersion.current
  setDetail({ source: row.source }); setDetailLoading(true); setDetailError('')
  try {
   if (row.source === 'sale') {
    const { data, error } = await supabase.from('or_orders').select('*').eq('id', row.document_id).single()
    if (error) throw error
    if (version === detailVersion.current) setDetail({ source: row.source, order: data as Order })
   } else {
    const document = await loadPreBillDetail(row.document_id)
    if (version === detailVersion.current) setDetail({ source: row.source, prebill: document })
   }
  } catch (e) { if (version === detailVersion.current) setDetailError(`โหลดรายละเอียดไม่สำเร็จ: ${(e as Error).message}`) }
  finally { if (version === detailVersion.current) { setDetailLoading(false); detailLock.current = false } }
 }
 function closeReview() {
  if (busy) return
  reviewVersion.current++; setReviewing(null); setConfirming(false)
 }
 async function openReview(row: Row) {
  const version = ++reviewVersion.current
  setReviewing(row); setApprove(true); setNote(''); setError(''); setConfirming(false); setContext(null)
  const { data, error: e } = await supabase.from(row.source === 'sale' ? 'or_orders' : 'or_prebill_documents')
   .select('customer_name,channel_code').eq('id', row.document_id).single()
  if (version !== reviewVersion.current) return
  if (e) setError(`โหลดข้อมูลลูกค้าไม่สำเร็จ: ${e.message}`)
  else setContext(data)
 }
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
  if (!reviewing || busy || !confirming || reviewing.status !== 'pending' || (!approve && !note.trim())) return
  setBusy(true); setError('')
  try {
   const { error: e } = reviewing.source === 'sale'
    ? await supabase.rpc('rpc_review_sales_discount', { p_request_id: reviewing.id, p_approve: approve, p_note: note.trim() || null })
    : await supabase.rpc('rpc_review_prebill_discount', { p_document_id: reviewing.id, p_approve: approve, p_approved_discount: null, p_note: note.trim() || null })
   if (e) throw e
   setReviewing(null); setConfirming(false); reviewVersion.current++; await load(); onChanged(); window.dispatchEvent(new CustomEvent('discount-approval-refresh'))
  } catch (e) { setConfirming(false); setError((e as Error).message) }
  finally { setBusy(false) }
 }
 if (user?.role !== 'superadmin') return <p className="p-4 text-red-700">เฉพาะ superadmin เท่านั้นที่เข้าหน้าอนุมัติส่วนลดได้</p>
 return <div className="space-y-4">
  <div className="flex flex-wrap items-end gap-3"><label className="text-sm">ประเภทเอกสาร<select value={type} onChange={e => { setType(e.target.value); setOffset(0) }} className="ml-2 rounded-xl border p-2">{[['all','ทั้งหมด'],['sale','บิลขาย'],['QT','QT'],['PC','PC']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><label className="text-sm">สถานะ<select value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }} className="ml-2 rounded-xl border p-2">{[['pending','รออนุมัติ'],['approved','อนุมัติแล้ว'],['rejected','ไม่อนุมัติ'],['all','ทั้งหมด']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><button onClick={() => void load()} className="rounded-xl border px-4 py-2">โหลดใหม่</button><span>{count} รายการ</span></div>
  {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
  <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-sm"><thead className="bg-slate-100"><tr>{['ประเภท / เลขเอกสาร','ผู้ขอ / เหตุผล','ยอดสินค้า','ค่าส่ง','ส่วนลดรวม','ยอดสุทธิ','สถานะ / ผู้พิจารณา','จัดการ'].map(t => <th className="whitespace-nowrap p-3 text-left" key={t}>{t}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={8} className="p-6 text-center">กำลังโหลด...</td></tr> : !rows.length ? <tr><td colSpan={8} className="p-6 text-center">ไม่มีรายการ</td></tr> : rows.map(r => <tr key={`${r.source}-${r.id}`} className="border-t align-top"><td className="p-3 font-semibold">{r.source === 'sale' ? 'บิลขาย' : r.source} · {r.document_no}</td><td className="p-3"><div>{r.owner_name}</div><div className="whitespace-pre-wrap text-slate-500">{r.reason}</div></td>{[r.subtotal,r.shipping_cost,r.discount,r.total_amount].map((v,i) => <td key={i} className={`whitespace-nowrap p-3 ${i===3 && Number(v)===0 ? 'font-bold text-green-700' : ''}`}>{money(v)}</td>)}<td className="p-3">{DISCOUNT_STATUS[r.status] || r.status}<div>{r.reviewed_name}</div><div className="text-xs text-slate-500">{r.reviewed_at && new Date(r.reviewed_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</div><div>{r.review_note}</div></td><td className="p-3"><div className="flex items-center gap-2"><button type="button" disabled={detailLoading} onClick={() => void openDetails(r)} title="ดูรายละเอียดบิล" aria-label={`ดูรายละเอียดบิล ${r.document_no}`} className="rounded-lg border p-2 text-blue-700 hover:bg-blue-50 disabled:opacity-50"><FiEye size={20} /></button><button onClick={() => void openReview(r)} className="whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-white">{r.status==='pending' ? 'พิจารณา' : 'ผลพิจารณา'}</button></div></td></tr>)}</tbody></table></div>
  <div className="flex justify-end gap-3"><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0,offset-50))}>ก่อนหน้า</button><span>{count ? offset+1 : 0}–{Math.min(offset+50,count)} / {count}</span><button disabled={offset+50>=count || loading} onClick={() => setOffset(offset+50)}>ถัดไป</button></div>
  <Modal open={!!reviewing} onClose={closeReview} showCloseButton={!busy} contentClassName="max-w-4xl" ariaLabelledby="discount-review-title" ariaModal={!confirming && !detail}><div className="space-y-5 p-6">{reviewing && <>
   <div className="pr-10"><h3 id="discount-review-title" className="text-xl font-bold">พิจารณาส่วนลด {reviewing.document_no}</h3><p className="mt-1 text-sm text-slate-500">{reviewing.source === 'sale' ? 'บิลขาย' : reviewing.source} · {DISCOUNT_STATUS[reviewing.status] || reviewing.status}</p></div>
   <dl className="grid gap-3 rounded-xl bg-slate-100 p-4 text-sm sm:grid-cols-2">
    <div><dt className="text-slate-500">ผู้ขอ</dt><dd className="font-semibold">{reviewing.owner_name || '-'}</dd></div>
    <div><dt className="text-slate-500">วันที่ขอ</dt><dd>{dateTime(reviewing.created_at)}</dd></div>
    <div><dt className="text-slate-500">ลูกค้า (ข้อมูลบิลปัจจุบัน)</dt><dd>{context?.customer_name || '-'}</dd></div>
    <div><dt className="text-slate-500">ช่องทาง{reviewing.snapshot.channel_code ? ' ณ เวลาส่งคำขอ' : ' (ข้อมูลบิลปัจจุบัน)'}</dt><dd>{reviewing.snapshot.channel_code || context?.channel_code || '-'}</dd></div>
   </dl>
   <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><h4 className="font-semibold">เหตุผลขอส่วนลด</h4><p className="mt-1 whitespace-pre-wrap break-words">{reviewing.reason || '-'}</p></div>
   <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">รายการประกอบคำขอ</h4><button type="button" onClick={() => void openDetails(reviewing)} className="flex items-center gap-2 text-sm text-blue-700"><FiEye /> ดูรายละเอียดบิลปัจจุบัน</button></div>
    <p className="mb-2 text-xs text-slate-500">ยอดเงินอ้างอิงคำขอส่วนลด รายการสินค้าอ้างอิงข้อมูลที่บันทึกไว้เมื่อมีข้อมูลย้อนหลัง</p>
    <div className="max-h-72 overflow-auto rounded-xl border"><table className="w-full text-sm"><thead className="sticky top-0 bg-slate-100"><tr><th className="p-3 text-left">สินค้า</th><th className="p-3 text-right">จำนวน</th><th className="p-3 text-right">ราคา/หน่วย</th><th className="p-3 text-right">รวม (บาท)</th></tr></thead><tbody>
     {reviewing.snapshot.items?.length ? reviewing.snapshot.items.map((item, index) => <tr key={index} className="border-t"><td className="min-w-48 p-3">{item.product_name || item.product_id}{item.is_free && <span className="ml-2 rounded bg-green-100 px-2 py-1 text-xs text-green-800">ของแถม</span>}{item.is_detail_row && <span className="ml-2 text-xs text-slate-500">รายการรายละเอียด</span>}</td><td className="p-3 text-right">{item.quantity}</td><td className="whitespace-nowrap p-3 text-right">{money(item.unit_price)}</td><td className="whitespace-nowrap p-3 text-right">{item.is_detail_row ? '—' : money(item.is_free ? 0 : item.quantity * item.unit_price)}</td></tr>) : <tr><td colSpan={4} className="p-4 text-center text-slate-500">ไม่มีรายการสินค้าที่บันทึกไว้</td></tr>}
    </tbody></table></div>
   </section>
   <dl className="ml-auto space-y-2 rounded-xl bg-blue-50 p-4 sm:max-w-sm">{[['ยอดสินค้า', reviewing.subtotal], ['ค่าส่ง', reviewing.shipping_cost], ['ส่วนลดรวม', reviewing.discount], ['ยอดสุทธิหลังส่วนลด', reviewing.total_amount]].map(([label, amount], index) => <div key={label} className={`flex justify-between gap-4 ${index > 1 ? 'font-bold' : ''} ${index === 3 ? 'border-t border-blue-200 pt-3 text-lg text-blue-800' : ''}`}><dt>{label}</dt><dd className="whitespace-nowrap">{money(Number(amount))} บาท</dd></div>)}</dl>
   <p className="text-xs text-slate-500">ส่วนลดรวมอาจรวมส่วนลดโปรโมชั่นและส่วนลดพิเศษ ข้อมูลคำขอเดิมไม่ได้แยกยอดสองส่วนนี้</p>
   {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
   {reviewing.status === 'pending' ? <div className="space-y-4 border-t pt-4">
    <label className="block">ผลพิจารณา<select disabled={busy} value={approve ? 'yes' : 'no'} onChange={e => setApprove(e.target.value === 'yes')} className="ml-3 rounded-lg border p-2"><option value="yes">อนุมัติ</option><option value="no">ไม่อนุมัติ</option></select></label>
    <label className="block">หมายเหตุผู้พิจารณา {!approve && '(บังคับ)'}<textarea disabled={busy} required={!approve} value={note} onChange={e => setNote(e.target.value)} rows={3} className="mt-1 w-full rounded-xl border p-3" /></label>
    <div className="flex justify-end"><button disabled={busy || (!approve && !note.trim())} onClick={() => setConfirming(true)} className="rounded-xl bg-blue-600 px-4 py-2 font-bold text-white disabled:opacity-50">ยืนยันผลพิจารณา</button></div>
   </div> : <section className="rounded-xl border p-4"><h4 className="font-semibold">ผลการพิจารณา</h4><p>{DISCOUNT_STATUS[reviewing.status] || reviewing.status}</p><p>ผู้พิจารณา: {reviewing.reviewed_name || '-'} · {dateTime(reviewing.reviewed_at)}</p><p className="whitespace-pre-wrap break-words">หมายเหตุ: {reviewing.review_note || '-'}</p></section>}
  </>}</div></Modal>
  <Modal open={confirming && !!reviewing} onClose={() => { if (!busy) setConfirming(false) }} showCloseButton={!busy} stackClassName="z-[70]" contentClassName="max-w-lg" ariaLabelledby="discount-confirm-title"><div className="space-y-4 p-6">{reviewing && <>
   <h3 id="discount-confirm-title" className="pr-8 text-xl font-bold">ยืนยัน{approve ? 'อนุมัติ' : 'ไม่อนุมัติ'}ส่วนลด</h3>
   <p>เอกสาร {reviewing.document_no}</p><p>ผู้ขอ: {reviewing.owner_name}</p>
   <p>ส่วนลดรวม <b>{money(reviewing.discount)} บาท</b></p><p>ยอดสุทธิ{approve ? 'หลังส่วนลด' : 'ตามคำขอที่ไม่อนุมัติ'} <b>{money(reviewing.total_amount)} บาท</b></p>
   <p className="whitespace-pre-wrap break-words">หมายเหตุ: {note.trim() || '-'}</p>
   <p className="text-sm text-slate-500">{approve ? 'บันทึกผลอนุมัติส่วนลดสำหรับคำขอนี้' : 'บันทึกผลไม่อนุมัติส่วนลดสำหรับคำขอนี้'}</p>
   <div className="flex flex-wrap justify-end gap-2"><button disabled={busy} onClick={() => setConfirming(false)} className="rounded-xl border px-4 py-2 disabled:opacity-50">กลับไปแก้ไข</button><button disabled={busy} onClick={() => void decide()} className={`rounded-xl px-4 py-2 font-bold text-white disabled:opacity-50 ${approve ? 'bg-blue-600' : 'bg-red-600'}`}>{busy ? 'กำลังบันทึก...' : approve ? 'ยืนยันอนุมัติ' : 'ยืนยันไม่อนุมัติ'}</button></div>
  </>}</div></Modal>
  <Modal open={!!detail} onClose={() => { detailVersion.current++; detailLock.current = false; setDetail(null); setDetailLoading(false) }} stackClassName="z-[80]" contentClassName="max-w-6xl" ariaLabelledby="discount-bill-title"><div className="p-6"><h3 id="discount-bill-title" className="mb-4 pr-10 text-xl font-bold">รายละเอียดบิลปัจจุบัน</h3>
   {detailLoading ? <p role="status">กำลังโหลดรายละเอียด...</p> : detailError ? <p role="alert" className="text-red-700">{detailError}</p> : detail?.order ? <OrderDetailView key={detail.order.id} order={detail.order} onClose={() => setDetail(null)} readOnly /> : detail?.prebill ? <><div className="overflow-x-auto"><div className="mx-auto w-fit"><PreBillPreview document={detail.prebill} items={detail.prebill.or_prebill_items || []} /></div></div></> : null}
  </div></Modal>
 </div>
}
