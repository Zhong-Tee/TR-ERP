import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { fetchAllSupabasePages } from '../../lib/supabasePagination'
import Modal from '../ui/Modal'
import OrderDetailView from '../order/OrderDetailView'
import { formatDateTime } from '../../lib/utils'
import type { Order } from '../../types'
import { PROMOTION_RULE_LABELS, type PromotionRuleType } from '../../lib/promotionRules'

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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : []
}

function money(value: unknown): string {
  return `฿${Number(value || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function SnapshotInfo({ label, value }: { label: string; value: ReactNode }) {
  return <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 font-semibold text-slate-800">{value}</div></div>
}

function RuleGroupList({ title, groups, itemNames }: { title: string; groups: Record<string, unknown>[]; itemNames: Map<string, string> }) {
  if (groups.length === 0) return null
  return (
    <div>
      <h5 className="mb-2 text-sm font-bold text-slate-700">{title}</h5>
      <div className="space-y-2">
        {groups.map((group, index) => {
          const options = arrayValue(group.options)
          return (
            <div key={`${String(group.id || title)}-${index}`} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-800">{String(group.id || `กลุ่มที่ ${index + 1}`)}</span>
                <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-700">จำนวน {Number(group.quantity || 1)} ชิ้น</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                {options.map((option, optionIndex) => {
                  const productId = String(option.product_id || '')
                  const text = option.selector_type === 'sku'
                    ? `สินค้า: ${itemNames.get(productId) || productId || 'ไม่ระบุ'}`
                    : `หมวดหมู่: ${String(option.category || 'ไม่ระบุ')}`
                  return <span key={optionIndex} className="rounded-md bg-slate-100 px-2 py-1 text-slate-700">{optionIndex > 0 ? 'หรือ ' : ''}{text}</span>
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PromotionSnapshotSummary({ audit }: { audit: PromotionAudit }) {
  const rule = objectValue(audit.rule_snapshot)
  const config = objectValue(rule.rule_config)
  const order = objectValue(audit.order_snapshot)
  const items = arrayValue(order.items)
  const itemNames = new Map(items.map((item) => [String(item.product_id || ''), String(item.product_name || '')]))
  const ruleType = String(rule.rule_type || 'legacy') as PromotionRuleType
  const channels = Array.isArray(rule.channel_codes) ? rule.channel_codes.map(String) : []
  const conditionGroups = arrayValue(config.condition_groups)
  const rewardGroups = arrayValue(config.reward_groups)
  const subtotal = Number(order.price || 0)
  const shipping = Number(order.shipping_cost || 0)
  const discount = Number(order.discount || 0)

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
      <div>
        <h4 className="font-bold text-slate-900">กติกาโปรโมชั่นที่ใช้ตรวจ</h4>
        <p className="mt-0.5 text-xs text-slate-500">ข้อมูลถูกเก็บไว้ตามกติกา ณ เวลาที่เปิดบิล แม้ภายหลังโปรโมชั่นจะถูกแก้ไข</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <SnapshotInfo label="ชื่อโปรโมชั่น" value={String(rule.name || audit.promotion_name)} />
        <SnapshotInfo label="เวอร์ชัน" value={`v${Number(rule.version || audit.promotion_version)}`} />
        <SnapshotInfo label="รูปแบบ" value={PROMOTION_RULE_LABELS[ruleType] || ruleType} />
        <SnapshotInfo label="ช่วงวันที่ใช้งาน" value={`${String(rule.start_date || 'ไม่จำกัด')} ถึง ${String(rule.end_date || 'ไม่จำกัด')}`} />
        <SnapshotInfo label="ช่องทางที่ใช้ได้" value={channels.length ? channels.join(', ') : 'ทุกช่องทาง'} />
        <SnapshotInfo label="สถานะกติกา" value={`${rule.is_active === false ? 'ปิดใช้งาน' : 'เปิดใช้งาน'} · ${rule.validation_enabled === false ? 'ไม่ตรวจอัตโนมัติ' : 'ตรวจอัตโนมัติ'}`} />
      </div>
      {(config.threshold_amount != null || config.discount_value != null || config.set_price != null || config.max_applications != null || rule.free_shipping === true) && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {config.threshold_amount != null && <SnapshotInfo label="ยอดซื้อขั้นต่ำ" value={money(config.threshold_amount)} />}
          {config.discount_value != null && <SnapshotInfo label={['spend_percent', 'quantity_percent'].includes(ruleType) ? 'ส่วนลด' : 'ส่วนลดต่อรอบ'} value={['spend_percent', 'quantity_percent'].includes(ruleType) ? `${Number(config.discount_value)}%` : money(config.discount_value)} />}
          {config.set_price != null && <SnapshotInfo label="ราคาเซ็ต" value={money(config.set_price)} />}
          {config.max_applications != null && <SnapshotInfo label="ใช้ได้สูงสุด" value={`${Number(config.max_applications)} รอบ`} />}
          {rule.free_shipping === true && <SnapshotInfo label="ค่าจัดส่ง" value="ส่งฟรี" />}
        </div>
      )}
      <RuleGroupList title="สินค้าฝั่งซื้อ (ต้องครบทุกกลุ่ม)" groups={conditionGroups} itemNames={itemNames} />
      <RuleGroupList title="ของแถม" groups={rewardGroups} itemNames={itemNames} />

      <div className="border-t border-slate-200 pt-4">
        <h4 className="font-bold text-slate-900">ข้อมูลบิลที่นำมาตรวจ</h4>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SnapshotInfo label="ยอดสินค้า" value={money(subtotal)} />
          <SnapshotInfo label="ค่าขนส่ง" value={money(shipping)} />
          <SnapshotInfo label="ส่วนลดในบิล" value={money(discount)} />
          <SnapshotInfo label="ยอดสุทธิ" value={money(subtotal + shipping - discount)} />
        </div>
        {items.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-lg border bg-white">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="bg-slate-100 text-slate-600"><tr><th className="px-3 py-2 text-left">สินค้า</th><th className="px-3 py-2 text-left">หมวดหมู่</th><th className="px-3 py-2 text-right">จำนวน</th><th className="px-3 py-2 text-right">ราคาต่อชิ้น</th><th className="px-3 py-2 text-right">รวม</th></tr></thead>
              <tbody>{items.map((item, index) => {
                const quantity = Number(item.quantity || 0)
                const unitPrice = Number(item.unit_price || 0)
                const isFree = item.is_free === true
                return <tr key={`${String(item.product_id || '')}-${index}`} className="border-t"><td className="px-3 py-2 font-medium text-slate-800">{String(item.product_name || 'ไม่ระบุสินค้า')}{isFree && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-bold text-emerald-700">ของแถม</span>}</td><td className="px-3 py-2 text-slate-600">{String(item.product_category || '–')}</td><td className="px-3 py-2 text-right tabular-nums">{quantity}</td><td className="px-3 py-2 text-right tabular-nums">{money(unitPrice)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{isFree ? money(0) : money(quantity * unitPrice)}</td></tr>
              })}</tbody>
            </table>
          </div>
        ) : <p className="mt-3 text-sm text-slate-500">ไม่มี Snapshot รายการสินค้าในประวัตินี้</p>}
      </div>
    </div>
  )
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
  const [orderDetail, setOrderDetail] = useState<Order | null>(null)
  const [orderDetailLoadingId, setOrderDetailLoadingId] = useState<string | null>(null)
  const [orderDetailError, setOrderDetailError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const data = await fetchAllSupabasePages<PromotionAudit>((from, to) => {
        let query = supabase
          .from('or_promotion_audits')
          .select('*')
          .gte('evaluated_at', `${fromDate}T00:00:00+07:00`)
          .lte('evaluated_at', `${toDate}T23:59:59.999+07:00`)
          .order('evaluated_at', { ascending: false })
          .order('id', { ascending: false })
        if (status) query = query.eq('validation_status', status)
        return query.range(from, to)
      })
      setRows(data)
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

  async function openOrderDetail(row: PromotionAudit) {
    if (orderDetailLoadingId) return
    setOrderDetailLoadingId(row.order_id)
    setOrderDetailError('')
    try {
      const { data, error: orderError } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', row.order_id)
        .single()
      if (orderError) throw orderError
      setOrderDetail(data as Order)
    } catch (cause) {
      setOrderDetailError(cause instanceof Error ? cause.message : 'โหลดรายละเอียดบิลไม่สำเร็จ')
    } finally {
      setOrderDetailLoadingId(null)
    }
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
          <tbody>{!loading && filtered.map((row) => <tr key={row.id} className="border-t hover:bg-blue-50/50"><td className="p-3 whitespace-nowrap">{formatDateTime(row.evaluated_at)}</td><td className="p-3 font-mono font-semibold"><button type="button" onClick={() => void openOrderDetail(row)} disabled={orderDetailLoadingId != null} className="inline-flex items-center gap-1.5 text-blue-700 underline-offset-2 hover:text-blue-900 hover:underline disabled:cursor-wait disabled:opacity-50" title="ดูรายละเอียดบิล">{row.bill_no}{orderDetailLoadingId === row.order_id && <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />}</button></td><td className="p-3">{row.channel_code}</td><td className="p-3 font-semibold">{row.promotion_name} <span className="text-xs font-normal text-gray-400">v{row.promotion_version}</span></td><td className="p-3 text-center"><span className={`rounded-full px-2 py-1 text-xs font-bold ${STATUS_CLASS[row.validation_status]}`}>{STATUS_LABEL[row.validation_status]}</span></td><td className="p-3 text-right tabular-nums">{Number(row.expected_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td><td className="p-3 text-right tabular-nums">{Number(row.actual_total_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td><td className="p-3">{row.order_admin_user || '–'}</td><td className="p-3 text-center"><button type="button" onClick={() => setDetail(row)} className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">ดู</button></td></tr>)}</tbody>
        </table>
        {!loading && filtered.length === 0 && <div className="py-12 text-center text-gray-400">ไม่พบประวัติการตรวจโปรโมชั่น</div>}
      </div>
      <Modal open={detail != null} onClose={() => setDetail(null)} contentClassName="max-w-3xl max-h-[90vh] overflow-y-auto">
        {detail && <div className="p-6 space-y-4"><div><h3 className="text-xl font-bold">{detail.bill_no} · {detail.promotion_name}</h3><p className="text-sm text-gray-500">ตรวจโดย {detail.evaluated_by || '–'} เมื่อ {formatDateTime(detail.evaluated_at)}</p></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ผลตรวจ</small><p className="font-bold">{STATUS_LABEL[detail.validation_status]}</p></div><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ส่วนลดที่ควรเป็น</small><p className="font-bold">฿{Number(detail.expected_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</p></div><div className="rounded-lg bg-gray-50 p-3"><small className="text-gray-500">ส่วนลดรวมในบิล</small><p className="font-bold">฿{Number(detail.actual_total_discount).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</p></div></div>{(detail.validation_messages || []).length > 0 && <div><h4 className="font-bold">เหตุผลจากระบบ</h4><ul className="mt-1 list-disc pl-5 text-sm text-red-700">{detail.validation_messages?.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}{detail.override_reason && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><h4 className="font-bold text-amber-800">เหตุผลข้ามการตรวจ</h4><p className="mt-1 text-sm text-amber-900">{detail.override_reason}</p></div>}<PromotionSnapshotSummary audit={detail} /><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-semibold text-gray-600">ข้อมูลดิบสำหรับตรวจสอบระบบ</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-gray-600">{JSON.stringify({ rule: detail.rule_snapshot, order: detail.order_snapshot }, null, 2)}</pre></details></div>}
      </Modal>
      <Modal open={orderDetail != null} onClose={() => setOrderDetail(null)} contentClassName="max-w-[96vw] w-full">
        {orderDetail && <OrderDetailView order={orderDetail} onClose={() => setOrderDetail(null)} readOnly />}
      </Modal>
      <Modal open={!!orderDetailError} onClose={() => setOrderDetailError('')} contentClassName="max-w-md">
        <div className="p-6">
          <h3 className="text-lg font-bold text-red-700">ไม่สามารถเปิดรายละเอียดบิลได้</h3>
          <p className="mt-2 break-words text-sm text-gray-600">{orderDetailError}</p>
          <div className="mt-5 flex justify-end"><button type="button" onClick={() => setOrderDetailError('')} className="rounded-lg bg-gray-800 px-4 py-2 font-semibold text-white">ปิด</button></div>
        </div>
      </Modal>
    </section>
  )
}
