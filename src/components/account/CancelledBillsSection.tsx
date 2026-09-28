import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import { cancellationApprovalLabel, latestFullCancellation } from '../../lib/cancelledBills'
import type { CancellationRequest } from '../../lib/cancelledBills'

type CancelledBill = {
  id: string
  bill_no: string | null
  channel_order_no: string | null
  customer_name: string | null
  cancelled_by_name: string | null
  cancelled_at: string | null
  amendments: CancellationRequest[]
}

const PAGE_SIZE = 50
const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100'

export default function CancelledBillsSection({ onViewOrder }: { onViewOrder: (id: string) => void }) {
  const [bills, setBills] = useState<CancelledBill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [approval, setApproval] = useState('all')
  const [page, setPage] = useState(1)

  useEffect(() => {
    let active = true
    async function load() {
      setLoading(true)
      setError('')
      try {
        const rows: CancelledBill[] = []
        // Page through the source so older cancellations are not silently truncated.
        const batchSize = 500
        for (let offset = 0; ; offset += batchSize) {
          const { data, error: queryError } = await supabase
            .from('or_orders')
            .select(`id, bill_no, channel_order_no, customer_name, cancelled_by_name, cancelled_at,
              amendments:or_order_amendments!order_id(id, amendment_no, status, reason_type, reason_detail, created_at, changes_json,
                requested_by_user:us_users!requested_by(username, email), approved_by_user:us_users!approved_by(username, email))`)
            .eq('status', 'ยกเลิก')
            .order('cancelled_at', { ascending: false, nullsFirst: false })
            .order('id', { ascending: false })
            .range(offset, offset + batchSize - 1)
          if (!active) return
          if (queryError) throw queryError
          rows.push(...(data as unknown as CancelledBill[]))
          if (data.length < batchSize) break
        }
        setBills(rows)
        setPage(1)
      } catch (cause) {
        if (active) {
          console.error('Error loading cancelled bills:', cause)
          setError('โหลดรายการยกเลิกไม่สำเร็จ กรุณาลองอีกครั้ง')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [reload])

  const rows = useMemo(() => bills.map((bill) => ({ bill, request: latestFullCancellation(bill.amendments || []) })), [bills])
  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('th-TH')
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : -Infinity
    const to = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Infinity
    return rows.filter(({ bill, request }) => {
      if (dateFrom || dateTo) {
        if (!bill.cancelled_at) return false
        const time = new Date(bill.cancelled_at).getTime()
        if (!Number.isFinite(time) || time < from || time > to) return false
      }
      const status = request?.status
      if (approval === 'approved' && status !== 'approved' && status !== 'executed') return false
      if (approval === 'pending' && status !== 'pending') return false
      if (approval === 'rejected' && status !== 'rejected') return false
      if (approval === 'none' && request) return false
      return !keyword || [bill.bill_no, bill.channel_order_no, bill.customer_name, bill.cancelled_by_name,
        request?.amendment_no, request?.requested_by_user?.username, request?.requested_by_user?.email,
        request?.approved_by_user?.username, request?.approved_by_user?.email, cancellationApprovalLabel(status),
      ].filter(Boolean).join(' ').toLocaleLowerCase('th-TH').includes(keyword)
    })
  }, [rows, search, dateFrom, dateTo, approval])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <section className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800"><i className="fas fa-ban mr-2 text-red-500" />รายการยกเลิก</h2>
          <p className="text-sm text-gray-500 mt-0.5">บิลสถานะยกเลิกทั้งหมด พร้อมสถานะคำขออนุมัติยกเลิกบิล</p>
        </div>
        <button type="button" onClick={() => setReload((value) => value + 1)} disabled={loading} className="text-sm text-blue-600 disabled:opacity-40">รีเฟรช</button>
      </div>
      <div className="px-4 py-3 border-b border-surface-200 space-y-2">
        <div className="flex flex-col xl:flex-row xl:items-end gap-3">
          <label className="flex-1"><span className="block text-xs font-semibold text-gray-600 mb-1">ค้นหา</span>
            <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} placeholder="เลขบิล / เลขคำสั่งซื้อ / เลขคำขอ / ลูกค้า / ผู้ยกเลิก / ผู้ขอ / ผู้อนุมัติ" className={INPUT_CLASS} />
          </label>
          <label><span className="block text-xs font-semibold text-gray-600 mb-1">สถานะการอนุมัติ</span>
            <select value={approval} onChange={(event) => { setApproval(event.target.value); setPage(1) }} className={INPUT_CLASS}>
              <option value="all">ทั้งหมด</option><option value="approved">อนุมัติยกเลิกแล้ว</option><option value="pending">รออนุมัติ</option><option value="rejected">คำขอถูกปฏิเสธ</option><option value="none">ไม่มีคำขออนุมัติ</option>
            </select>
          </label>
          <label><span className="block text-xs font-semibold text-gray-600 mb-1">วันที่ยกเลิก ตั้งแต่</span>
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1) }} className={INPUT_CLASS} />
          </label>
          <label><span className="block text-xs font-semibold text-gray-600 mb-1">ถึงวันที่</span>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1) }} className={INPUT_CLASS} />
          </label>
          <button type="button" onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setApproval('all'); setPage(1) }} disabled={!search && !dateFrom && !dateTo && approval === 'all'} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 disabled:opacity-40">ล้างตัวกรอง</button>
        </div>
        {!loading && !error && <p className="text-xs text-gray-500">พบ {filtered.length.toLocaleString('th-TH')} จาก {bills.length.toLocaleString('th-TH')} รายการ</p>}
      </div>
      {loading ? <p className="py-12 text-center text-gray-500" role="status">กำลังโหลดรายการยกเลิก...</p>
        : error ? <div role="alert" className="py-12 text-center text-red-600"><p>{error}</p><button type="button" onClick={() => setReload((value) => value + 1)} className="mt-3 underline">ลองอีกครั้ง</button></div>
        : !filtered.length ? <p className="py-12 text-center text-gray-500">{bills.length ? 'ไม่พบรายการที่ตรงกับตัวกรอง' : 'ไม่มีรายการยกเลิก'}</p>
        : <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50 text-left text-gray-600">
                {['เลขบิล', 'เลขคำสั่งซื้อ', 'ลูกค้า', 'สถานะบิล', 'สถานะการอนุมัติ', 'เลขที่คำขอ', 'ผู้ขอ', 'ผู้อนุมัติ', 'ผู้ยกเลิก', 'วันที่ยกเลิก'].map((label) => <th key={label} className="px-4 py-3 font-semibold whitespace-nowrap">{label}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map(({ bill, request }) => <tr key={bill.id} className="hover:bg-blue-50/50">
                  <td className="px-4 py-3"><button type="button" onClick={() => onViewOrder(bill.id)} className="font-mono text-blue-600 font-semibold hover:underline">{bill.bill_no || bill.id}</button></td>
                  <td className="px-4 py-3 font-mono">{bill.channel_order_no || '-'}</td>
                  <td className="px-4 py-3">{bill.customer_name || '-'}</td>
                  <td className="px-4 py-3"><span className="rounded-full px-2.5 py-0.5 text-xs font-semibold bg-red-100 text-red-700 whitespace-nowrap">ยกเลิก</span></td>
                  <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${request?.status === 'pending' ? 'bg-amber-100 text-amber-800' : request?.status === 'approved' || request?.status === 'executed' ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-700'}`}>{cancellationApprovalLabel(request?.status)}</span></td>
                  <td className="px-4 py-3 font-mono">{request?.amendment_no || '-'}</td>
                  <td className="px-4 py-3">{request?.requested_by_user?.username || request?.requested_by_user?.email || '-'}</td>
                  <td className="px-4 py-3">{request?.approved_by_user?.username || request?.approved_by_user?.email || '-'}</td>
                  <td className="px-4 py-3">{bill.cancelled_by_name || '-'}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-gray-600">{bill.cancelled_at ? formatDateTime(bill.cancelled_at) : '-'}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-surface-200 flex items-center justify-between text-sm">
            <span>หน้า {currentPage} / {pageCount} · หน้าละ {PAGE_SIZE} รายการ</span>
            <div className="flex gap-3">
              <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} className="text-blue-600 disabled:opacity-40">ก่อนหน้า</button>
              <button type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} className="text-blue-600 disabled:opacity-40">ถัดไป</button>
            </div>
          </div>
        </>}
    </section>
  )
}
