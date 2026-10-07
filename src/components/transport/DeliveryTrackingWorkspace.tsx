import { useCallback, useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import ReconciliationDateFilter from '../account/ReconciliationDateFilter'
import { bangkokToday } from '../../lib/reconciliationDate'
import OrderDetailView from '../order/OrderDetailView'
import Modal from '../ui/Modal'
import type { Order } from '../../types'

type TrackingBill = {
  id: string; bill_no: string; channel_order_no: string | null; created_at: string
  channel_code: string; tracking_number: string | null; customer_name: string; recipient_name: string | null
  erp_status: string; packed_at: string | null; delivery_state: string; pickup_status: string
  source_id: string | null; import_id: string | null; file_name: string | null; carrier: string | null
  pickup_at: string | null; carrier_tracking: string | null; carrier_order_no: string | null
  match_detail: string | null; keys_match: boolean | null; has_duplicate: boolean | null; candidate_count: number | null
}
type Workspace = { rows: TrackingBill[]; count: number; channels: string[]; carriers: string[]; summary: { bills: number; states: Record<string, number> } }
const labels: Record<string, string> = {
  all: 'ทั้งหมด', issues: 'ข้อมูลต้องตรวจ / รับไม่สำเร็จ', pending: 'ค้างตรวจสอบ', received: 'ขนส่งรับพัสดุแล้ว', awaiting_carrier: 'แพ็คแล้ว ยังไม่พบในไฟล์',
  awaiting_pickup: 'พบในไฟล์ ขนส่งยังไม่ได้รับ', needs_review: 'ข้อมูลไม่ตรง / ต้องตรวจ', carrier_recorded: 'พบในไฟล์ รอยืนยันการรับ', pickup_issue: 'รับพัสดุไม่สำเร็จ',
  pending_pack: 'ยังไม่ปิดงานแพ็ค', no_tracking: 'ไม่มี Tracking', self_pickup: 'ลูกค้ารับเอง',
}
function dateTime(value: string | null) {
  if (!value) return '–'
  return new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function issueDetail(row: TrackingBill) {
  if (row.has_duplicate) return 'Tracking ซ้ำภายในไฟล์ ต้องตรวจรายการต้นทาง'
  if (row.candidate_count != null && row.candidate_count > 1) return 'Tracking หรือเลขออเดอร์อ้างถึงมากกว่า 1 บิล'
  if (row.keys_match === false) return 'Tracking / Order No. ไม่ตรงกับบิลปัจจุบัน'
  return row.match_detail || ''
}

export default function DeliveryTrackingWorkspace({ refreshKey, openImport }: { refreshKey: number; openImport: (id: string) => void }) {
  const [from, setFrom] = useState('2026-09-01')
  const [to, setTo] = useState(bangkokToday)
  const [basis, setBasis] = useState('created')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [carrier, setCarrier] = useState('')
  const [channel, setChannel] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Order | null>(null)
  const [opening, setOpening] = useState(false)
  const generation = useRef(0)
  const fetchPage = useCallback(async (start: number) => {
    const result = await supabase.rpc('tr_delivery_tracking_workspace', { p_from: from || null, p_to: to || null, p_status: status,
      p_search: search.trim(), p_carrier: carrier, p_channel: channel, p_date_basis: basis, p_offset: start })
    if (result.error) throw result.error
    return result.data as Workspace
  }, [from, to, status, search, carrier, channel, basis])
  const cancelLoad = useCallback(() => { generation.current++ }, [])
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setError('')
    if (from && to && from > to) { setData(null); setError('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด'); setLoading(false); return }
    try { const result = await fetchPage(offset); if (request === generation.current) setData(result) }
    catch (caught) { if (request === generation.current) { setData(null); setError((caught as { message: string }).message) } }
    finally { if (request === generation.current) setLoading(false) }
  }, [from, to, fetchPage, offset])
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => { window.clearTimeout(timer); cancelLoad() } }, [load, refreshKey, cancelLoad])
  async function openBill(id: string) {
    if (opening) return
    setOpening(true); setError('')
    try {
      const result = await supabase.from('or_orders').select('*,or_order_items(*)').eq('id', id).single()
      if (result.error) throw result.error
      const order = result.data as Order & { or_order_items?: Order['order_items'] }
      order.order_items = order.or_order_items
      setDetail(order)
    } catch (caught) { setError((caught as { message: string }).message) }
    finally { setOpening(false) }
  }
  async function exportBills() {
    if (from && to && from > to) return
    setExporting(true); setError('')
    try {
      const rows: TrackingBill[] = []
      for (let start = 0; ; start += 50) {
        const page = await fetchPage(start); rows.push(...page.rows)
        if (!page.rows.length || rows.length >= page.count) break
      }
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.map(row => ({
        'วันที่บิล': dateTime(row.created_at), 'เลขบิล': row.bill_no, 'เลขออเดอร์': row.channel_order_no || '', 'ช่องทาง': row.channel_code,
        'สถานะ ERP': row.erp_status, 'วันที่แพ็ค': dateTime(row.packed_at), Tracking: row.tracking_number || '',
        'ผู้รับ': row.recipient_name || row.customer_name, 'ผลตรวจ': labels[row.delivery_state], 'สถานะงานรับ': row.pickup_status,
        'วันที่รายการในไฟล์': dateTime(row.pickup_at), 'ขนส่ง': row.carrier || '', 'ไฟล์อ้างอิง': row.file_name || '',
        'Tracking ในไฟล์': row.carrier_tracking || '', 'Order No. ในไฟล์': row.carrier_order_no || '', 'รายละเอียด': issueDetail(row),
      }))), 'ติดตามการส่ง')
      XLSX.writeFile(workbook, 'ติดตามการส่งบิลERP.xlsx')
    } catch (caught) { setError((caught as { message: string }).message) }
    finally { setExporting(false) }
  }
  const field = 'rounded-lg border border-gray-300 px-3 py-2 text-sm'
  const counts = data?.summary.states || {}
  return <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-gray-900">ติดตามบิล ERP ตั้งแต่ 1 ก.ย. 2569</h2>
      <p className="mt-1 text-sm text-gray-500">เทียบกับไฟล์ขนส่งทุกวันที่นำเข้า · แสดงบิลละ 1 แถว · ตรวจว่าขนส่งรับพัสดุแล้วหรือยัง</p></div>
      <div className="flex gap-2"><button onClick={() => void exportBills()} disabled={exporting || loading || !data} className={field}>{exporting ? 'กำลังส่งออก...' : 'ดาวน์โหลด Excel'}</button><button onClick={() => void load()} className={field}>รีเฟรช</button></div></div>
    <div className="flex flex-wrap items-end gap-3"><label className="text-xs text-gray-600">กรองวันที่<select aria-label="ประเภทวันที่" value={basis} onChange={e => { setBasis(e.target.value); setOffset(0) }} className={`mt-1 block ${field}`}><option value="created">วันที่สร้างบิล</option><option value="packed">วันที่แพ็ค</option></select></label>
      <ReconciliationDateFilter from={from} to={to} onChange={(a,b) => { setFrom(a); setTo(b); setOffset(0) }} /></div>
    <div className="flex flex-wrap gap-2"><select aria-label="ผลตรวจการส่ง" value={status} onChange={e => { setStatus(e.target.value); setOffset(0) }} className={field}>{Object.entries(labels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select aria-label="ขนส่งที่พบ" value={carrier} onChange={e => { setCarrier(e.target.value); setOffset(0) }} className={field}><option value="">ทุกขนส่ง / รวมบิลที่ยังไม่พบ</option>{data?.carriers.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="ช่องทางขาย" value={channel} onChange={e => { setChannel(e.target.value); setOffset(0) }} className={field}><option value="">ทุกช่องทางขาย</option>{data?.channels.map(value => <option key={value}>{value}</option>)}</select>
      <input aria-label="ค้นหาบิลการส่ง" value={search} onChange={e => { setSearch(e.target.value); setOffset(0) }} placeholder="เลขบิล / Order No. / Tracking / ผู้รับ" className={`${field} min-w-[280px]`} /></div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {data && <><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
      ['all','บิลตามตัวกรอง',data.summary.bills],['received',labels.received,counts.received || 0],
      ['awaiting_carrier',labels.awaiting_carrier,counts.awaiting_carrier || 0],
      ['needs_review','ข้อมูลต้องตรวจ / รับไม่สำเร็จ',(counts.needs_review || 0)+(counts.pickup_issue || 0)+(counts.carrier_recorded || 0)],
    ].map(([key,label,count]) => <button key={key} onClick={() => { setStatus(key === 'needs_review' ? 'issues' : String(key)); setOffset(0) }} className="rounded-xl border bg-blue-50 p-4 text-left"><div className="text-xs text-gray-600">{label}</div><div className="mt-1 text-2xl font-bold text-blue-700">{count}</div></button>)}</div>
      <p className="text-xs text-gray-500">ยอดรวมตามวันที่ ช่องทาง และขนส่งที่เลือก · วันที่แพ็คคือเวลาปิดงานแพ็คใน ERP · การเลือกขนส่งจะแสดงเฉพาะบิลที่พบในไฟล์ของขนส่งนั้น</p>
      <p className="text-xs text-gray-500">“ยังไม่พบในไฟล์” อาจเป็นช่วงที่ยังไม่ได้อัปโหลดข้อมูลขนส่ง จึงยังไม่ถือว่าบิลนั้นไม่ได้ส่ง</p>
      <div className="flex flex-wrap gap-2">{Object.entries(counts).map(([key,count]) => <button key={key} onClick={() => { setStatus(key); setOffset(0) }} className={`rounded-full border px-3 py-1.5 text-xs ${status===key ? 'bg-blue-100 text-blue-800' : ''}`}>{labels[key]} ({count})</button>)}</div></>}
    <div className="overflow-x-auto"><table className="w-full min-w-[1250px] text-sm"><thead className="bg-slate-800 text-white"><tr>{['วันที่บิล','เลขบิล / ช่องทาง','วันที่แพ็ค','Tracking','ผู้รับ','ผลตรวจ','สถานะงานรับ / วันที่ในไฟล์','ไฟล์อ้างอิง'].map(label => <th key={label} className="p-3 text-left">{label}</th>)}</tr></thead><tbody>
      {loading ? <tr><td colSpan={8} className="p-10 text-center text-gray-500">กำลังโหลด...</td></tr> : !data?.rows.length ? <tr><td colSpan={8} className="p-10 text-center text-gray-500">ไม่พบบิลตามตัวกรอง</td></tr> : data.rows.map(row => <tr key={row.id} className="border-t align-top hover:bg-blue-50/40">
        <td className="whitespace-nowrap p-3">{dateTime(row.created_at)}</td><td className="p-3"><button disabled={opening} onClick={() => void openBill(row.id)} className="font-semibold text-blue-700 hover:underline">{row.bill_no}</button><div className="text-xs text-gray-500">{row.channel_code}</div><div className="mt-1 text-xs text-gray-500">ERP: {row.erp_status}</div></td>
        <td className="whitespace-nowrap p-3">{dateTime(row.packed_at)}</td><td className="p-3 font-mono">{row.tracking_number || '–'}{row.carrier_tracking && row.carrier_tracking !== row.tracking_number && <div className="mt-1 text-xs text-amber-700">ไฟล์: {row.carrier_tracking}</div>}</td>
        <td className="max-w-[220px] p-3">{row.recipient_name || row.customer_name || '–'}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${row.delivery_state==='received' ? 'bg-emerald-50 text-emerald-700' : row.delivery_state==='self_pickup' ? 'bg-gray-100 text-gray-600' : 'bg-amber-50 text-amber-700'}`}>{labels[row.delivery_state]}</span>{row.delivery_state==='needs_review' && <p className="mt-2 max-w-[220px] text-xs text-amber-700">{issueDetail(row)}</p>}</td>
        <td className="p-3"><div>{row.pickup_status || '–'}</div><div className="mt-1 whitespace-nowrap text-xs text-gray-500">{dateTime(row.pickup_at)}</div></td><td className="p-3">{row.import_id && <button onClick={() => openImport(row.import_id!)} className="max-w-[220px] break-all text-left text-xs text-blue-700 hover:underline">{row.file_name}</button>}<div className="mt-1 text-xs text-gray-500">{row.carrier || 'ยังไม่มีไฟล์อ้างอิง'}</div></td>
      </tr>)}
    </tbody></table></div>
    {data && <div className="flex items-center justify-between text-sm text-gray-600"><span>{data.count} บิล · หน้า {Math.floor(offset/50)+1}</span><div className="flex gap-2"><button disabled={offset===0 || loading} onClick={() => setOffset(Math.max(0,offset-50))} className={`${field} disabled:opacity-40`}>ก่อนหน้า</button><button disabled={offset+50>=data.count || loading} onClick={() => setOffset(offset+50)} className={`${field} disabled:opacity-40`}>ถัดไป</button></div></div>}
    <Modal open={detail!==null} onClose={() => setDetail(null)} contentClassName="max-w-[96vw] w-full">{detail && <OrderDetailView order={detail} onClose={() => setDetail(null)} readOnly />}</Modal>
  </section>
}
