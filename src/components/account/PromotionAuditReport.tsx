import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import { formatDateTime } from '../../lib/utils'

type AuditStatus = 'passed' | 'failed' | 'overridden' | 'not_checked'
type PromotionAudit = {
  id: string
  order_id: string
  bill_no: string
  channel_code: string
  order_admin_user: string | null
  promotion_name: string
  promotion_version: number
  validation_status: AuditStatus
  validation_messages: string[] | null
  expected_discount: number
  expected_total_discount: number
  actual_total_discount: number
  application_count: number
  rule_snapshot: Record<string, unknown> | null
  order_snapshot: Record<string, unknown> | null
  override_reason: string | null
  evaluated_at: string
  evaluated_by: string | null
}

const STATUS_LABEL: Record<AuditStatus, string> = {
  passed: 'ผ่าน', failed: 'ไม่ผ่าน', overridden: 'ข้ามการตรวจ', not_checked: 'ไม่ได้ตรวจ',
}
const STATUS_CLASS: Record<AuditStatus, string> = {
  passed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  overridden: 'bg-amber-100 text-amber-800',
  not_checked: 'bg-gray-100 text-gray-600',
}

function localDate(offsetDays = 0) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function firstDateOfCurrentMonth() {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}-01`
}

export default function PromotionAuditReport() {
  const [rows, setRows] = useState<PromotionAudit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fromDate, setFromDate] = useState(firstDateOfCurrentMonth())
  const [toDate, setToDate] = useState(localDate())
  const [status, setStatus] = useState<AuditStatus | ''>('')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<PromotionAudit | null>(null)

  async function load() {
    setLoading(true)
    setError('')
    try {
      let query = supabase
        .from('or_promotion_audits')
        .select('*')
        .gte('evaluated_at', `${fromDate}T00:00:00+07:00`)
        .lte('evaluated_at', `${toDate}T23:59:59.999+07:00`)
        .order('evaluated_at', { ascending: false })
        .limit(2000)
      if (status) query = query.eq('validation_status', status)
      const { data, error: queryError } = await query
      if (queryError) throw queryError
      setRows((data || []) as PromotionAudit[])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'โหลดรายงานโปรโมชั่นไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return rows
    return rows.filter((row) => [row.bill_no, row.channel_code, row.promotion_name, row.order_admin_user, row.evaluated_by]
      .some((value) => String(value || '').toLowerCase().includes(keyword)))
  }, [rows, search])

  const totals = useMemo(() => ({
    all: filtered.length,
    passed: filtered.filter((row) => row.validation_status === 'passed').length,
    overridden: filtered.filter((row) => row.validation_status === 'overridden').length,
    mismatch: new Set(filtered
      .filter((row) => Math.abs(Number(row.expected_total_discount) - Number(row.actual_total_discount)) > 0.01)
      .map((row) => row.order_id)).size,
  }), [filtered])

  function exportExcel() {
    const data = filtered.map((row) => ({
      วันที่ตรวจ: formatDateTime(row.evaluated_at),
      เลขบิล: row.bill_no,
      ช่องทาง: row.channel_code,
      โปรโมชั่น: row.promotion_name,
      เวอร์ชัน: row.promotion_version,
      ผลตรวจ: STATUS_LABEL[row.validation_status],
      ส่วนลดที่ควรเป็น: Number(row.expected_discount),
      ส่วนลดรวมที่ควรเป็น: Number(row.expected_total_discount),
      ส่วนลดรวมในบิล: Number(row.actual_total_discount),
      เหตุผล: (row.validation_messages || []).join(' | '),
      เหตุผลข้ามการตรวจ: row.override_reason || '',
      ผู้เปิดบิล: row.order_admin_user || '',
      ผู้ตรวจบันทึก: row.evaluated_by || '',
    }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), 'ตรวจโปรโมชั่น')
    XLSX.writeFile(workbook, `promotion_audit_${fromDate}_${toDate}.xlsx`)
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-xl font-bold text-gray-900">รายงานตรวจโปรโมชั่น</h2><p className="mt-1 text-sm text-gray-500">ประวัติการเปิดบิลด้วยโปรโมชั่นและผลตรวจตามกติกา ณ เวลาที่บันทึก</p></div>
          <button type="button" onClick={exportExcel} disabled={!filtered.length} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40">Export Excel</button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[['ทั้งหมด', totals.all, 'text-blue-700'], ['ผ่าน', totals.passed, 'text-emerald-700'], ['ข้ามการตรวจ', totals.overridden, 'text-amber-700'], ['ส่วนลดต่างจากที่ควรเป็น', totals.mismatch, 'text-red-700']].map(([label, value, tone]) => <div key={String(label)} className="rounded-xl border bg-gray-50 p-3"><p className="text-xs text-gray-500">{label}</p><p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p></div>)}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-gray-700">จากวันที่<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium text-gray-700">ถึงวันที่<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm font-medium text-gray-700">ผลตรวจ<select value={status} onChange={(e) => setStatus(e.target.value as AuditStatus | '')} className="mt-1 block rounded-lg border px-3 py-2"><option value="">ทั้งหมด</option>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="min-w-[220px] flex-1 text-sm font-medium text-gray-700">ค้นหา<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="เลขบิล / โปรโมชั่น / ช่องทาง / ผู้เปิดบิล" className="mt-1 block w-full rounded-lg border px-3 py-2" /></label>
          <button type="button" onClick={load} disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{loading ? 'กำลังโหลด...' : 'ค้นหา'}</button>
        </div>
        {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-gray-50 text-gray-600"><tr><th className="p-3 text-left">วันที่ตรวจ</th><th className="p-3 text-left">เลขบิล</th><th className="p-3 text-left">ช่องทาง</th><th className="p-3 text-left">โปรโมชั่น</th><th className="p-3 text-center">ผลตรวจ</th><th className="p-3 text-right">ส่วนลดที่ควรเป็น</th><th className="p-3 text-right">ส่วนลดในบิล</th><th className="p-3 text-left">ผู้เปิดบิล</th><th className="p-3 text-center">รายละเอียด</th></tr></thead>
          <tbody>{!loading && filtered.map((row) => <tr key={row.id} className="border-t hover:bg-blue-50/50"><td className="p-3 whitespace-nowrap">{formatDateTime(row.evaluated_at)}</td><td className="p-3 font-mono font-semibold text-blue-700">{row.bill_no}</td><td className="p-3">{row.channel_code}</td><td className="p-3 font-semibold">{row.promotion_name} <span className="text-xs font-normal text-gray-400">v{row.promotion_version}</span></td><td className="p-3 text-center"><span className={`rounded-full px-2 py-1 text-xs font-bold ${STATUS_CLASS[row.validation_status]}`}>{STATUS_LABEL[row.validation_status]}</span></td><td className="p-3 text-right tabular-nums">{Number(row.expected_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td><td className="p-3 text-right tabular-nums">{Number(row.actual_total_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td><td className="p-3">{row.order_admin_user || '–'}</td><td className="p-3 text-center"><button type="button" onClick={() => setDetail(row)} className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">ดู</button></td></tr>)}</tbody>
        </table>
        {!loading && filtered.length === 0 && <div className="py-12 text-center text-gray-400">ไม่พบประวัติการตรวจโปรโมชั่น</div>}
      </div>
      <Modal open={detail != null} onClose={() => setDetail(null)} contentClassName="max-w-3xl max-h-[90vh] overflow-y-auto">
        {detail && <div className="p-6 space-y-4"><div><h3 className="text-xl font-bold">{detail.bill_no} · {detail.promotion_name}</h3><p className="text-sm text-gray-500">ตรวจโดย {detail.evaluated_by || '–'} เมื่อ {formatDateTime(detail.evaluated_at)}</p></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ผลตรวจ</small><p className="font-bold">{STATUS_LABEL[detail.validation_status]}</p></div><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ส่วนลดที่ควรเป็น</small><p className="font-bold">฿{Number(detail.expected_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</p></div><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ส่วนลดรวมในบิล</small><p className="font-bold">฿{Number(detail.actual_total_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</p></div></div>{(detail.validation_messages || []).length > 0 && <div><h4 className="font-bold">เหตุผลจากระบบ</h4><ul className="mt-1 list-disc pl-5 text-sm text-red-700">{detail.validation_messages?.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}{detail.override_reason && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><h4 className="font-bold text-amber-800">เหตุผลข้ามการตรวจ</h4><p className="mt-1 text-sm text-amber-900">{detail.override_reason}</p></div>}<details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold">Snapshot กติกาและบิล</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-gray-600">{JSON.stringify({ rule: detail.rule_snapshot, order: detail.order_snapshot }, null, 2)}</pre></details><div className="flex justify-end"><button type="button" onClick={() => setDetail(null)} className="rounded-lg bg-gray-800 px-4 py-2 font-semibold text-white">ปิด</button></div></div>}
      </Modal>
    </section>
  )
}
