import { useState } from 'react'
import { downloadTransportBillingWorkbook } from '../../lib/transportBillingExport'
import * as XLSX from 'xlsx'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { normalizeDeliveryKey } from '../../lib/deliveryCheck'
import { billingSourceMetadata, isBillingSummaryRow, detectBillingColumns, parseBillingAmount, reconcileBilling, type BillingLine, type BillingOrder, type BillingReference } from '../../lib/transportBilling'

type Upload = { id: number; kind: 'bill' | 'wanyen'; name: string; sheet: string; matrix: string[][]; header: number; tracking: string; order: string; amount: string; note: string; shipment: string }
const money = (value: number | null) => value === null ? '–' : value.toLocaleString('th-TH', { minimumFractionDigits: 2 })
export default function TransportBillingWorkspace() {
  const { user } = useAuthContext()
  const [uploads, setUploads] = useState<Upload[]>([])
  const [results, setResults] = useState<ReturnType<typeof reconcileBilling> | null>(null)
  const [exporting, setExporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [senderFilter, setSenderFilter] = useState('')
  const [page, setPage] = useState(1)
  if (!['superadmin', 'account'].includes(user?.role || '')) return null
  function update(id: number, change: Partial<Upload>) { setUploads(items => items.map(item => item.id === id ? { ...item, ...change } : item)); setResults(null) }
  async function upload(files: FileList | null, kind: Upload['kind']) {
    if (!files) return
    setBusy(true); setError(''); setResults(null)
    try {
      const next: Upload[] = []
      for (const file of Array.from(files)) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
        for (const sheet of workbook.SheetNames) {
          const matrix = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheet], { header: 1, defval: '', raw: false }).map(row => row.map(String))
          if (matrix.length < 2) continue
          next.push({ id: Date.now() + next.length, kind, name: file.name, sheet, matrix, header: 0, ...detectBillingColumns(matrix[0], kind) })
        }
      }
      if (!next.length) throw new Error('ไม่พบข้อมูลในไฟล์')
      setUploads(items => [...items, ...next])
    } catch (err) { setError(err instanceof Error ? err.message : 'อ่านไฟล์ไม่สำเร็จ') } finally { setBusy(false) }
  }
  async function run() {
    setBusy(true); setError(''); setResults(null)
    try {
      const lines = (kind: Upload['kind']) => uploads.filter(item => item.kind === kind).flatMap(item => {
        if (!item.tracking && !item.order) throw new Error(`${item.name}: เลือกคอลัมน์ Tracking หรือเลขออเดอร์`)
        if (kind === 'bill' && !item.amount) throw new Error(`${item.name}: เลือกคอลัมน์ยอดเรียกเก็บ`)
        return item.matrix.slice(item.header + 1).flatMap((row, index): BillingLine[] => {
          if (row.every(cell => !cell.trim())) return []
          if (kind === 'bill' && isBillingSummaryRow(row, item)) return []
          const get = (column: string) => column ? (row[Number(column) - 1] || '').trim() : ''
          return [{ ...billingSourceMetadata(item.matrix[item.header], row), file: item.name, sheet: item.sheet, row: item.header + index + 2, tracking: get(item.tracking), order: get(item.order), amount: kind === 'bill' ? parseBillingAmount(get(item.amount)) : null, consignment: /ฝากส่ง/.test(get(item.note)), shipmentId: get(item.shipment) }]
        })
      })
      const bills = lines('bill'), wy = lines('wanyen')
      if (!bills.length) throw new Error('กรุณาเพิ่มใบเรียกเก็บ')
      const keys = [...new Set(bills.flatMap(row => [normalizeDeliveryKey(row.tracking), normalizeDeliveryKey(row.order)]).filter(Boolean))]
      const orders = new Map<string, BillingOrder>(), consignments: BillingReference[] = []
      for (let offset = 0; offset < keys.length; offset += 500) {
        const { data, error: rpcError } = await supabase.rpc('tr_billing_references', { p_keys: keys.slice(offset, offset + 500) })
        if (rpcError) throw new Error(rpcError.message)
        const refs = data as { orders: BillingOrder[]; consignments: BillingReference[] }
        refs.orders.forEach(order => orders.set(order.id, order)); consignments.push(...refs.consignments)
      }
      setResults(reconcileBilling(bills, wy, [...orders.values()], consignments)); setSenderFilter(''); setPage(1)
    } catch (err) { setError(err instanceof Error ? err.message : 'กระทบยอดไม่สำเร็จ') } finally { setBusy(false) }
  }
  const shown = (results || []).filter(row => (filter === 'all' || (filter === 'with_amount' && row.amount !== null) || (filter === 'ฝากส่ง' && row.consignment) || row.status === filter) && (!senderFilter || (row.sender?.trim() || 'ไม่ระบุผู้ส่ง') === senderFilter) && `${row.tracking} ${row.order} ${row.file}`.toLowerCase().includes(query.toLowerCase()))
  const pages = Math.max(1, Math.ceil(shown.length / 50))
  const currentPage = Math.min(page, pages)
  return <section className="space-y-4 rounded-xl border bg-white p-5">
    <h2 className="text-lg font-bold">กระทบยอดเรียกเก็บ</h2>
    <p className="text-sm text-gray-600">นำเข้าใบเรียกเก็บและรายการจัดส่งหวานเย็น ระบบเลือกคอลัมน์ตามไฟล์ตัวอย่างให้อัตโนมัติ สามารถปรับได้</p>
    <p className="text-sm text-gray-600">ไฟล์หวานเย็นรวมหลายสินค้าเป็นการจัดส่งเดียวกันด้วยรหัสรายการจัดส่งและ Tracking โดยไฟล์ตัวอย่างไม่มีต้นทุนขนส่ง จึงใช้ยืนยันรายการจัดส่งเท่านั้น</p>
    <p className="text-sm text-amber-700">ไฟล์และผลตรวจใช้เฉพาะรอบนี้ ออกจากหน้านี้ต้องนำเข้าใหม่ • ยังไม่ได้อัปโหลดหวานเย็น ผล “ไม่พบ” จะอ้างอิง ERP เท่านั้น • พบรายการไม่ได้หมายความว่าอัตราเรียกเก็บถูกต้อง</p>
    <div className="flex flex-wrap gap-4">{(['bill', 'wanyen'] as const).map(kind => <label key={kind} className="rounded-lg border p-3 text-sm font-semibold">{kind === 'bill' ? 'อัปโหลดใบเรียกเก็บขนส่ง' : 'อัปโหลดรายการจัดส่งหวานเย็น'}<input className="mt-2 block" type="file" multiple accept=".xlsx,.xls,.csv" disabled={busy} onChange={event => { void upload(event.target.files, kind); event.target.value = '' }} /></label>)}</div>
    {uploads.map(item => <div key={item.id} className="space-y-2 rounded-lg border bg-slate-50 p-3 text-sm">
      <div className="flex justify-between gap-2"><strong>{item.kind === 'bill' ? 'ใบเรียกเก็บ' : 'หวานเย็น'}: {item.name} / {item.sheet}</strong><button disabled={busy} onClick={() => { setUploads(items => items.filter(row => row.id !== item.id)); setResults(null) }}>นำออก</button></div>
      <label>แถวหัวตาราง <input disabled={busy} type="number" min={1} max={item.matrix.length - 1} value={item.header + 1} onChange={event => { const header = Number(event.target.value) - 1; if (header >= 0 && header < item.matrix.length - 1) update(item.id, { header, ...detectBillingColumns(item.matrix[header], item.kind) }) }} className="w-20 rounded border p-1" /></label>
      <div className="flex flex-wrap gap-3">{([['tracking', 'Tracking'], ['order', 'เลขออเดอร์ / เลขบิล'], ['amount', 'ยอดเรียกเก็บ']] as const).filter(([field]) => field !== 'amount' || item.kind === 'bill').map(([field, label]) => <label key={field}>{label}<select disabled={busy} className="ml-2 max-w-64 rounded border p-2" value={item[field]} onChange={event => update(item.id, { [field]: event.target.value })}><option value="">ไม่เลือก</option>{item.matrix[item.header].map((cell, index) => <option key={index} value={String(index + 1)}>{index + 1}: {cell || '(ว่าง)'}</option>)}</select></label>)}</div>
      <p className="text-xs text-gray-500">ตัวอย่าง: {item.matrix[item.header + 1]?.join(' | ')}</p>
    </div>)}
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-red-700">{error}</p>}
    <button disabled={busy || !uploads.length} onClick={() => void run()} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? 'กำลังประมวลผล...' : 'กระทบยอดทั้งหมด'}</button>
    {results && <>
      <div className="grid gap-3 md:grid-cols-4">{[
        { label: 'รายการเรียกเก็บ', value: results.length, filter: 'all' },
        { label: 'ยอดเรียกเก็บรวม', value: money(results.reduce((sum, row) => sum + (row.amount || 0), 0)), filter: 'with_amount' },
        { label: 'ไม่พบ ERP + Wanyen', value: results.filter(row => row.status === 'ไม่พบใน ERP + Wanyen').length, filter: 'ไม่พบใน ERP + Wanyen' },
        { label: 'ฝากส่ง', value: results.filter(row => row.consignment).length, filter: 'ฝากส่ง' },
      ].map(card => <button key={card.label} type="button" aria-pressed={filter === card.filter} onClick={() => { setFilter(card.filter); setQuery(''); setPage(1) }} className={`rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${filter === card.filter ? 'border-blue-600 bg-blue-100 ring-1 ring-blue-600' : 'border-transparent bg-blue-50 hover:border-blue-300 hover:bg-blue-100'}`}><div>{card.label}</div><strong className="text-xl">{card.value}</strong></button>)}</div>
      <div className="flex flex-wrap gap-3"><select aria-label="กรองผู้ส่ง" value={senderFilter} onChange={event => { setSenderFilter(event.target.value); setPage(1) }} className="rounded border p-2"><option value="">ผู้ส่งทั้งหมด</option>{[...new Set(results.map(row => row.sender?.trim() || 'ไม่ระบุผู้ส่ง'))].sort((a, b) => a.localeCompare(b, 'th')).map(sender => <option key={sender} value={sender}>{sender}</option>)}</select><input aria-label="ค้นหารายการเรียกเก็บ" placeholder="ค้นหา Tracking / เลขบิล / ไฟล์" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} className="rounded border p-2" /><select aria-label="กรองผลกระทบยอด" value={filter} onChange={event => { setFilter(event.target.value); setPage(1) }} className="rounded border p-2"><option value="all">ทั้งหมด</option><option value="with_amount">รายการที่มียอดเรียกเก็บ</option>{[...new Set(['ไม่พบใน ERP + Wanyen', 'ฝากส่ง', ...results.map(row => row.status)])].map(label => <option key={label}>{label}</option>)}</select><button type="button" className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2" disabled={exporting} onClick={async () => { setExporting(true); setError(''); try { await downloadTransportBillingWorkbook(results) } catch (err) { setError(err instanceof Error ? err.message : 'ส่งออก Excel ไม่สำเร็จ') } finally { setExporting(false) } }}>{exporting ? 'กำลังส่งออก...' : 'ดาวน์โหลด Excel'}</button></div>
      <p className="text-sm text-gray-600">ยอดรวมไม่นับแถวที่ยอดไม่ถูกต้อง • รายการซ้ำและข้อมูลขัดแย้งต้องตรวจสอบเพิ่มเติม</p>
      <div className="overflow-auto"><table className="w-full whitespace-nowrap text-sm"><thead className="bg-slate-800 text-white"><tr>{['ไฟล์ / แถว', 'Tracking', 'เลขบิล', 'ผู้ส่ง', 'ผลตรวจรายการ', 'แหล่งอ้างอิง', 'เรียกเก็บ'].map(label => <th key={label} className="p-3 text-left">{label}</th>)}</tr></thead><tbody>{shown.slice((currentPage - 1) * 50, currentPage * 50).map((row, index) => <tr key={index} className="border-b"><td className="p-3">{row.file} / แถว {row.row}</td><td className="px-3">{row.tracking || '–'}</td><td className="px-3">{row.order || '–'}</td><td className="px-3">{row.sender || '–'}</td><td className={row.status === 'ฝากส่ง' ? 'text-violet-700' : 'text-amber-700'}>{row.status}{row.consignment && row.status !== 'ฝากส่ง' ? ' • ฝากส่ง' : ''}</td><td>{row.source || '–'}</td><td>{money(row.amount)}</td></tr>)}</tbody></table></div>
      <div className="flex items-center gap-3 text-sm"><span>{shown.length} รายการ</span><button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} className="rounded-lg border border-gray-300 bg-white px-4 py-2 font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button><span>หน้า {currentPage}/{pages}</span><button type="button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)} className="rounded-lg border border-blue-600 bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button></div>
    </>}
  </section>
}
