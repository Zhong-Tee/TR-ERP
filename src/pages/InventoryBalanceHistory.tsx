import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import ModalCloseButton from '../components/ui/ModalCloseButton'

interface InventoryHistoryRow {
  product_id: string
  product_code: string
  product_name: string
  product_type: string | null
  product_category: string | null
  is_active: boolean
  on_hand: number
  safety_stock: number
  total_in_stock: number
}

interface StockMovement {
  id: string
  movement_type: string
  qty: number
  ref_type: string | null
  ref_id: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const fmt = (value: number) => Number(value || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })

export default function InventoryBalanceHistory() {
  const [date, setDate] = useState(localDate)
  const [rows, setRows] = useState<InventoryHistoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [productType, setProductType] = useState('')
  const [error, setError] = useState('')
  const [movementProduct, setMovementProduct] = useState<InventoryHistoryRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data, error: queryError } = await supabase.rpc('rpc_inventory_balances_as_of', { p_as_of_date: date })
      if (queryError) throw queryError
      setRows(((data || []) as InventoryHistoryRow[]).map((row) => ({
        ...row,
        on_hand: Number(row.on_hand || 0),
        safety_stock: Number(row.safety_stock || 0),
        total_in_stock: Number(row.total_in_stock || 0),
      })))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดรายการสินค้าคงเหลือไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('th-TH')
    return rows.filter((row) => {
      const matchesSearch = !term || row.product_code.toLocaleLowerCase('th-TH').includes(term) || row.product_name.toLocaleLowerCase('th-TH').includes(term)
      return matchesSearch && (!productType || (row.product_type || 'FG') === productType)
    })
  }, [rows, search, productType])

  const totals = useMemo(() => filtered.reduce((sum, row) => ({
    onHand: sum.onHand + row.on_hand,
    safety: sum.safety + row.safety_stock,
    total: sum.total + row.total_in_stock,
  }), { onHand: 0, safety: 0, total: 0 }), [filtered])

  const downloadExcel = () => {
    const sheet = XLSX.utils.json_to_sheet(filtered.map((row, index) => ({
      '#': index + 1,
      'รหัสสินค้า': row.product_code,
      'ชื่อสินค้า': row.product_name,
      'ประเภท': row.product_type || 'FG',
      'หมวดหมู่': row.product_category || '-',
      'จำนวนคงเหลือ': row.on_hand,
      'Safety stock': row.safety_stock,
      'รวมในคลัง': row.total_in_stock,
      'สถานะสินค้า': row.is_active ? 'ใช้งาน' : 'ไม่ใช้งาน',
    })))
    sheet['!cols'] = [5, 16, 42, 10, 22, 16, 16, 16, 14].map((wch) => ({ wch }))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'สินค้าคงเหลือย้อนหลัง')
    XLSX.writeFile(workbook, `รายการสินค้าคงเหลือ_${date}.xlsx`)
  }

  return (
    <div className="mt-4 space-y-4 pb-8">
      <div className="rounded-xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm font-medium text-gray-700">
            วันที่ตรวจสอบ
            <input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" />
          </label>
          <button type="button" onClick={load} disabled={loading || !date} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'กำลังโหลด...' : 'ค้นหา'}
          </button>
          <select value={productType} onChange={(e) => setProductType(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">
            <option value="">ทุกประเภท</option>
            <option value="FG">FG - สินค้าสำเร็จรูป</option>
            <option value="PP">PP - สินค้าแปรรูป</option>
            <option value="RM">RM - วัตถุดิบ</option>
          </select>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหารหัสหรือชื่อสินค้า..." className="min-w-64 flex-1 rounded-lg border px-3 py-2 text-sm" />
          <button type="button" onClick={downloadExcel} disabled={!filtered.length} className="rounded-lg border border-emerald-600 px-4 py-2 text-sm font-semibold text-emerald-700 disabled:opacity-50">ดาวน์โหลด Excel</button>
        </div>
        <p className="mt-3 text-xs text-gray-500">แสดงยอด ณ สิ้นวันที่เลือก ตามเวลาประเทศไทย</p>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-red-700">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label="จำนวนสินค้า" value={`${filtered.length.toLocaleString('th-TH')} รายการ`} color="text-blue-700" />
        <Summary label="จำนวนคงเหลือ" value={fmt(totals.onHand)} color="text-indigo-700" />
        <Summary label="Safety stock" value={fmt(totals.safety)} color="text-purple-700" />
        <Summary label="รวมในคลัง" value={fmt(totals.total)} color="text-emerald-700" />
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="bg-slate-100 text-slate-700">
            <tr>
              {['#', 'รหัสสินค้า', 'ชื่อสินค้า', 'ประเภท', 'หมวดหมู่', 'จำนวนคงเหลือ', 'Safety stock', 'รวมในคลัง', 'สถานะ', 'ดำเนินการ'].map((label) => <th key={label} className="px-4 py-3 text-left last:text-center">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, index) => (
              <tr key={row.product_id} className="border-t hover:bg-blue-50">
                <td className="px-4 py-3 text-gray-400">{index + 1}</td>
                <td className="px-4 py-3 font-medium">{row.product_code}</td>
                <td className="px-4 py-3 whitespace-normal min-w-72">{row.product_name}</td>
                <td className="px-4 py-3">{row.product_type || 'FG'}</td>
                <td className="px-4 py-3">{row.product_category || '-'}</td>
                <td className="px-4 py-3 text-right font-medium text-indigo-700">{fmt(row.on_hand)}</td>
                <td className="px-4 py-3 text-right font-medium text-purple-700">{fmt(row.safety_stock)}</td>
                <td className="px-4 py-3 text-right font-bold text-emerald-700">{fmt(row.total_in_stock)}</td>
                <td className="px-4 py-3 text-center"><span className={`rounded-full px-2 py-1 text-xs ${row.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{row.is_active ? 'ใช้งาน' : 'ไม่ใช้งาน'}</span></td>
                <td className="px-4 py-3 text-center"><button type="button" onClick={() => setMovementProduct(row)} className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100">ดูความเคลื่อนไหว</button></td>
              </tr>
            ))}
            {!loading && !filtered.length && <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-500">ไม่พบรายการสินค้า</td></tr>}
          </tbody>
        </table>
      </div>
      {movementProduct && <MovementModal product={movementProduct} reportDate={date} onClose={() => setMovementProduct(null)} />}
    </div>
  )
}

function Summary({ label, value, color }: { label: string; value: string; color: string }) {
  return <div className="rounded-xl border bg-white p-4 shadow-sm"><div className="text-xs text-gray-500">{label}</div><div className={`mt-1 text-xl font-bold ${color}`}>{value}</div></div>
}

const MOVEMENT_LABELS: Record<string, string> = {
  gr: 'รับสินค้าเข้า',
  pick: 'ตัดสินค้า/เบิกสินค้า',
  pick_reversal: 'คืนยอดจากการตัดสินค้า',
  return: 'รับสินค้าคืน',
  return_requisition: 'คืนสินค้าจากใบเบิก',
  adjust: 'ปรับสต็อก',
  waste: 'ตัดเป็นของเสีย',
  production_in: 'ผลิตสินค้าเข้า',
  production_out: 'เบิกเข้าผลิต',
  initial: 'ยอดตั้งต้น',
}

const REF_LABELS: Record<string, string> = {
  inv_gr: 'ใบรับสินค้า GR',
  inv_adjustments: 'ใบปรับสต็อก',
  inv_returns: 'ใบรับคืนสินค้า',
  wms_orders: 'งานคลัง/WMS',
  wms_requisitions: 'ใบเบิกสินค้า',
  internal_production: 'ผลิตภายใน',
  initial_import: 'นำเข้ายอดตั้งต้น',
  product_import: 'นำเข้าสินค้า',
  roll_auto_fg: 'ผลิตสินค้าจากม้วน',
}

function dateDaysBefore(value: string, days: number) {
  const date = new Date(`${value}T00:00:00`)
  date.setDate(date.getDate() - days)
  return localDate(date)
}

function MovementModal({ product, reportDate, onClose }: { product: InventoryHistoryRow; reportDate: string; onClose: () => void }) {
  const [dateFrom, setDateFrom] = useState(() => dateDaysBefore(reportDate, 30))
  const [dateTo, setDateTo] = useState(reportDate)
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [users, setUsers] = useState<Record<string, string>>({})
  const [referenceNames, setReferenceNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [popupTop, setPopupTop] = useState(12)

  useEffect(() => {
    const pageScroller = document.querySelector<HTMLElement>('[data-app-scroll-container]')
    const previousPageOverflow = pageScroller?.style.overflow || ''
    const previousBodyOverflow = document.body.style.overflow
    if (pageScroller) pageScroller.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      if (pageScroller) pageScroller.style.overflow = previousPageOverflow
      document.body.style.overflow = previousBodyOverflow
    }
  }, [])

  useEffect(() => {
    const updatePopupTop = () => {
      const subnav = document.querySelector<HTMLElement>('[data-app-subnav]')
      const visibleBottom = subnav ? Math.max(0, subnav.getBoundingClientRect().bottom) : 0
      setPopupTop(Math.min(Math.max(visibleBottom + 12, 12), window.innerHeight - 240))
    }
    updatePopupTop()
    window.addEventListener('resize', updatePopupTop)
    window.addEventListener('scroll', updatePopupTop, true)
    return () => {
      window.removeEventListener('resize', updatePopupTop)
      window.removeEventListener('scroll', updatePopupTop, true)
    }
  }, [])

  const loadMovements = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const from = `${dateFrom}T00:00:00+07:00`
      const toDate = new Date(`${dateTo}T00:00:00`)
      toDate.setDate(toDate.getDate() + 1)
      const to = `${localDate(toDate)}T00:00:00+07:00`
      const { data, error: movementError } = await supabase
        .from('inv_stock_movements')
        .select('id, movement_type, qty, ref_type, ref_id, note, created_by, created_at')
        .eq('product_id', product.product_id)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('created_at', { ascending: false })
      if (movementError) throw movementError
      const movementRows = ((data || []) as StockMovement[]).map((row) => ({ ...row, qty: Number(row.qty || 0) }))
      setMovements(movementRows)
      const userIds = [...new Set(movementRows.map((row) => row.created_by).filter((id): id is string => Boolean(id)))]
      if (userIds.length) {
        const { data: userRows, error: userError } = await supabase.from('us_users').select('id, username').in('id', userIds)
        if (userError) throw userError
        setUsers(Object.fromEntries((userRows || []).map((row) => [row.id, row.username])))
      } else setUsers({})

      const referenceSpecs = [
        { type: 'wms_orders', table: 'wms_orders', column: 'order_id', prefix: 'งาน ' },
        { type: 'wms_requisitions', table: 'wms_requisitions', column: 'requisition_id', prefix: 'ใบเบิก ' },
        { type: 'inv_gr', table: 'inv_gr', column: 'gr_no', prefix: 'GR ' },
        { type: 'inv_adjustments', table: 'inv_adjustments', column: 'adjust_no', prefix: 'ใบปรับ ' },
        { type: 'inv_returns', table: 'inv_returns', column: 'return_no', prefix: 'ใบคืน ' },
      ]
      const resolvedReferences: Record<string, string> = {}
      await Promise.all(referenceSpecs.map(async (spec) => {
        const ids = [...new Set(movementRows.filter((row) => row.ref_type === spec.type && row.ref_id).map((row) => row.ref_id as string))]
        if (!ids.length) return
        const { data: refs } = await supabase.from(spec.table).select(`id, ${spec.column}`).in('id', ids)
        ;((refs || []) as unknown as Record<string, string>[]).forEach((ref) => {
          if (ref.id && ref[spec.column]) resolvedReferences[ref.id] = `${spec.prefix}${ref[spec.column]}`
        })
      }))
      setReferenceNames(resolvedReferences)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดความเคลื่อนไหวไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, product.product_id])

  useEffect(() => { loadMovements() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => movements.reduce((sum, row) => {
    if (row.qty >= 0) sum.in += row.qty
    else sum.out += Math.abs(row.qty)
    return sum
  }, { in: 0, out: 0 }), [movements])

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-stretch justify-center bg-black/50 px-4 pb-4" style={{ top: popupTop }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} role="dialog" aria-modal="true">
      <div className="relative flex min-h-0 w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <ModalCloseButton onClick={onClose} className="absolute right-3 top-3 z-10" />
        <div className="flex flex-none items-start border-b px-5 py-4 pr-16">
          <div><h2 className="text-lg font-bold text-gray-900">ความเคลื่อนไหวสินค้า</h2><p className="mt-1 text-sm text-gray-600"><span className="font-semibold">{product.product_code}</span> — {product.product_name}</p></div>
        </div>
        <div className="flex flex-none flex-wrap items-end gap-3 border-b bg-gray-50 px-5 py-4">
          <label className="text-sm">วันที่เริ่มต้น<input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <label className="text-sm">วันที่สิ้นสุด<input type="date" value={dateTo} min={dateFrom} max={localDate()} onChange={(e) => setDateTo(e.target.value)} className="mt-1 block rounded-lg border px-3 py-2" /></label>
          <button type="button" onClick={loadMovements} disabled={loading} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? 'กำลังโหลด...' : 'ค้นหา'}</button>
          <div className="ml-auto flex gap-3 text-sm"><span className="rounded-lg bg-emerald-100 px-3 py-2 text-emerald-700">รับเข้า <b>{fmt(summary.in)}</b></span><span className="rounded-lg bg-red-100 px-3 py-2 text-red-700">จ่ายออก <b>{fmt(summary.out)}</b></span><span className="rounded-lg bg-blue-100 px-3 py-2 text-blue-700">สุทธิ <b>{fmt(summary.in - summary.out)}</b></span></div>
        </div>
        {error && <div className="m-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="sticky top-0 bg-slate-100 text-slate-700"><tr>{['วันเวลา', 'เหตุการณ์', 'จำนวน', 'เอกสารอ้างอิง', 'หมายเหตุ', 'ผู้ดำเนินการ'].map((label) => <th key={label} className="px-4 py-3 text-left">{label}</th>)}</tr></thead>
            <tbody>
              {movements.map((row) => <tr key={row.id} className="border-t align-top hover:bg-blue-50">
                <td className="px-4 py-3 whitespace-nowrap">{new Date(row.created_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' })}</td>
                <td className="px-4 py-3 font-medium">{MOVEMENT_LABELS[row.movement_type] || row.movement_type}</td>
                <td className={`px-4 py-3 text-right text-base font-bold ${row.qty >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{row.qty > 0 ? '+' : ''}{fmt(row.qty)}</td>
                <td className="px-4 py-3"><div>{row.ref_type ? REF_LABELS[row.ref_type] || row.ref_type : '-'}</div>{row.ref_id && <div className="mt-1 font-semibold text-blue-700">{referenceNames[row.ref_id] || 'ไม่พบเลขเอกสารอ้างอิง'}</div>}</td>
                <td className="max-w-sm whitespace-normal px-4 py-3 text-gray-600">{row.note || '-'}</td>
                <td className="px-4 py-3">{row.created_by ? users[row.created_by] || row.created_by : 'ระบบ'}</td>
              </tr>)}
              {!loading && !movements.length && <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-500">ไม่พบความเคลื่อนไหวในช่วงวันที่เลือก</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex-none border-t bg-amber-50 px-5 py-3 text-xs text-amber-800">หมายเหตุ: การย้ายระหว่างจำนวนคงเหลือกับ Safety stock อาจไม่ปรากฏเป็น Stock Movement หากรายการเดิมไม่ได้บันทึก Movement แต่ยังตรวจยอดก่อน–หลังได้จากรายการสินค้าคงเหลือย้อนหลัง</div>
      </div>
    </div>
  )
}
