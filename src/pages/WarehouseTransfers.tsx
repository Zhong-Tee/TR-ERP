import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'

type StorageLocation = {
  id: string
  code: string
  name: string | null
  location_type: 'picking' | 'reserve' | 'hold' | 'unallocated'
  is_active: boolean
}

type ProductStock = {
  product_id: string
  product_code: string
  product_name: string
  unit_name: string | null
  qty: number
}

type TransferRow = {
  id: string
  transfer_no: string
  status: 'draft' | 'posted' | 'cancelled'
  note: string | null
  created_at: string
  posted_at: string | null
  created_by: string
  from_location_id: string
  to_location_id: string
  from_code: string
  to_code: string
  item_count: number
  product_codes: string
  product_names: string
}

type DraftLine = ProductStock & { transfer_qty: string }
type TransferIndexRow = {
  transfer_id: string
  product_id: string
  pr_products: { product_code: string; product_name: string } | null
}
type UserRow = { id: string; username: string | null; email: string | null }
type SourceStockRow = { product_id: string; qty: number | string; pr_products: { product_code: string; product_name: string; unit_name: string | null } }
type TransferDetailItem = { id: string; qty: number | string; product_id: string; pr_products: { product_code: string; product_name: string; unit_name: string | null } }
type TransferDbRow = Omit<TransferRow, 'from_code' | 'to_code' | 'item_count' | 'product_codes' | 'product_names'> & { created_by: string }

const statusLabel = {
  draft: { text: 'ร่าง', css: 'bg-amber-100 text-amber-700' },
  posted: { text: 'ยืนยันแล้ว', css: 'bg-emerald-100 text-emerald-700' },
  cancelled: { text: 'ยกเลิก', css: 'bg-gray-200 text-gray-600' },
}

function formatDate(value: string | null) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message)
  return 'เกิดข้อผิดพลาด'
}

export default function WarehouseTransfers() {
  const navigate = useNavigate()
  const route = useLocation()
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [transfers, setTransfers] = useState<TransferRow[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(new URLSearchParams(route.search).get('create') === '1')
  const [manageOpen, setManageOpen] = useState(false)
  const [detail, setDetail] = useState<TransferRow | null>(null)
  const [detailItems, setDetailItems] = useState<TransferDetailItem[]>([])
  const [cancelTarget, setCancelTarget] = useState<TransferRow | null>(null)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const [sourceStock, setSourceStock] = useState<ProductStock[]>([])
  const [lines, setLines] = useState<DraftLine[]>([])
  const [productSearch, setProductSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [historySearch, setHistorySearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [newLocation, setNewLocation] = useState({ code: '', name: '', location_type: 'reserve' })
  const initialProductId = new URLSearchParams(route.search).get('product')
  const [historyProduct, setHistoryProduct] = useState<{ product_code: string; product_name: string } | null>(null)

  useEffect(() => { void loadAll() }, [initialProductId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (fromId) void loadSourceStock(fromId); else setSourceStock([]) }, [fromId])
  useEffect(() => {
    if (!initialProductId || lines.some((line) => line.product_id === initialProductId)) return
    const product = sourceStock.find((row) => row.product_id === initialProductId)
    if (product) addProduct(product)
  }, [sourceStock, initialProductId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    setLoading(true)
    try {
      const [locationRes, transferRes, itemRes, usersRes] = await Promise.all([
        supabase.from('wh_storage_locations').select('*').order('sort_order').order('code'),
        supabase.from('wh_stock_transfers').select('*').order('created_at', { ascending: false }).limit(500),
        supabase.from('wh_stock_transfer_items').select('transfer_id, product_id, pr_products(product_code, product_name)'),
        supabase.from('us_users').select('id, username, email'),
      ])
      if (locationRes.error) throw locationRes.error
      if (transferRes.error) throw transferRes.error
      if (itemRes.error) throw itemRes.error
      setLocations((locationRes.data || []) as StorageLocation[])
      const locationData = (locationRes.data || []) as unknown as StorageLocation[]
      const itemData = (itemRes.data || []) as unknown as TransferIndexRow[]
      const userData = (usersRes.data || []) as unknown as UserRow[]
      const transferData = (transferRes.data || []) as unknown as TransferDbRow[]
      const locationMap = new Map(locationData.map((row) => [row.id, row.code]))
      const countMap = new Map<string, number>()
      itemData.forEach((row) => countMap.set(row.transfer_id, (countMap.get(row.transfer_id) || 0) + 1))
      const productTransferIds = initialProductId
        ? new Set(itemData.filter((row) => row.product_id === initialProductId).map((row) => row.transfer_id))
        : null
      let selectedProduct = initialProductId
        ? itemData.find((row) => row.product_id === initialProductId)?.pr_products || null
        : null
      if (initialProductId && !selectedProduct) {
        const { data: productData } = await supabase
          .from('pr_products')
          .select('product_code, product_name')
          .eq('id', initialProductId)
          .maybeSingle()
        selectedProduct = productData
      }
      setHistoryProduct(selectedProduct)
      const userMap = new Map(userData.map((row) => [row.id, row.username || row.email || row.id]))
      setTransfers(transferData.filter((row) => !productTransferIds || productTransferIds.has(row.id)).map((row) => ({
        ...row,
        from_code: locationMap.get(row.from_location_id) || '-',
        to_code: locationMap.get(row.to_location_id) || '-',
        item_count: countMap.get(row.id) || 0,
        created_by: userMap.get(row.created_by) || row.created_by,
        product_codes: [...new Set(itemData.filter((item) => item.transfer_id === row.id).map((item) => item.pr_products?.product_code).filter(Boolean))].join(', '),
        product_names: [...new Set(itemData.filter((item) => item.transfer_id === row.id).map((item) => item.pr_products?.product_name).filter(Boolean))].join(', '),
      })))
    } catch (error) {
      setMessage({ type: 'error', text: errorMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  async function loadSourceStock(locationId: string) {
    const { data, error } = await supabase
      .from('wh_location_stock')
      .select('product_id, qty, pr_products!inner(product_code, product_name, unit_name)')
      .eq('location_id', locationId)
      .gt('qty', 0)
      .order('product_id')
    if (error) {
      setMessage({ type: 'error', text: error.message })
      return
    }
    const rows = ((data || []) as unknown as SourceStockRow[]).map((row) => ({
      product_id: row.product_id,
      product_code: row.pr_products.product_code,
      product_name: row.pr_products.product_name,
      unit_name: row.pr_products.unit_name,
      qty: Number(row.qty || 0),
    }))
    setSourceStock(rows)
    setLines((current) => current.filter((line) => rows.some((row) => row.product_id === line.product_id)))
  }

  const filteredSourceStock = useMemo(() => {
    const term = productSearch.trim().toLowerCase()
    if (!term) return sourceStock
    return sourceStock.filter((row) => `${row.product_code} ${row.product_name}`.toLowerCase().includes(term))
  }, [sourceStock, productSearch])

  const filteredTransfers = useMemo(() => {
    const term = historySearch.trim().toLowerCase()
    return transfers.filter((row) =>
      (!statusFilter || row.status === statusFilter) &&
      (!term || `${row.transfer_no} ${row.from_code} ${row.to_code} ${row.created_by} ${row.product_codes} ${row.product_names}`.toLowerCase().includes(term)),
    )
  }, [transfers, historySearch, statusFilter])

  function addProduct(row: ProductStock) {
    if (lines.some((line) => line.product_id === row.product_id)) return
    setLines((current) => [...current, { ...row, transfer_qty: '' }])
  }

  async function saveTransfer(post: boolean) {
    if (!fromId || !toId || fromId === toId) {
      setMessage({ type: 'error', text: 'กรุณาเลือกต้นทางและปลายทางคนละจุด' })
      return
    }
    const items = lines.map((line) => ({ product_id: line.product_id, qty: Number(line.transfer_qty) }))
    if (!items.length || items.some((item) => !Number.isFinite(item.qty) || item.qty <= 0)) {
      setMessage({ type: 'error', text: 'กรุณาระบุจำนวนย้ายให้ถูกต้อง' })
      return
    }
    const over = lines.find((line) => Number(line.transfer_qty) > line.qty)
    if (over) {
      setMessage({ type: 'error', text: `${over.product_code} มีที่ต้นทางไม่เพียงพอ` })
      return
    }
    setSaving(true)
    const { error } = await supabase.rpc('rpc_create_stock_transfer', {
      p_from_location_id: fromId,
      p_to_location_id: toId,
      p_items: items,
      p_note: note || null,
      p_post: post,
    })
    setSaving(false)
    if (error) {
      setMessage({ type: 'error', text: error.message })
      return
    }
    setMessage({ type: 'success', text: post ? 'ยืนยันการย้ายตำแหน่งเรียบร้อยแล้ว' : 'บันทึกใบย้ายฉบับร่างแล้ว' })
    setCreateOpen(false)
    setFromId(''); setToId(''); setLines([]); setNote(''); setProductSearch('')
    navigate('/warehouse/transfers', { replace: true })
    await loadAll()
  }

  async function openDetail(row: TransferRow) {
    setDetail(row)
    const { data, error } = await supabase
      .from('wh_stock_transfer_items')
      .select('id, qty, product_id, pr_products!inner(product_code, product_name, unit_name)')
      .eq('transfer_id', row.id)
    if (error) setMessage({ type: 'error', text: error.message })
    setDetailItems((data || []) as unknown as TransferDetailItem[])
  }

  async function postDraft(id: string) {
    setSaving(true)
    const { error } = await supabase.rpc('rpc_post_stock_transfer', { p_transfer_id: id })
    setSaving(false)
    if (error) return setMessage({ type: 'error', text: error.message })
    setDetail(null)
    setMessage({ type: 'success', text: 'ยืนยันใบย้ายเรียบร้อยแล้ว' })
    await loadAll()
  }

  async function cancelTransfer(id: string) {
    setSaving(true)
    const { error } = await supabase.rpc('rpc_cancel_stock_transfer', { p_transfer_id: id, p_note: 'ยกเลิกจากหน้าประวัติ' })
    setSaving(false)
    if (error) return setMessage({ type: 'error', text: error.message })
    setCancelTarget(null)
    setDetail(null)
    setMessage({ type: 'success', text: 'ยกเลิกใบย้ายเรียบร้อยแล้ว' })
    await loadAll()
  }

  async function createLocation() {
    const { error } = await supabase.rpc('rpc_upsert_storage_location', {
      p_id: null,
      p_code: newLocation.code,
      p_name: newLocation.name || null,
      p_location_type: newLocation.location_type,
      p_is_active: true,
    })
    if (error) return setMessage({ type: 'error', text: error.message })
    setNewLocation({ code: '', name: '', location_type: 'reserve' })
    setMessage({ type: 'success', text: 'เพิ่มจุดจัดเก็บแล้ว' })
    await loadAll()
  }

  return (
    <div className="mt-4 space-y-4">
      {message && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {message.text}
        </div>
      )}
      <div className="rounded-xl bg-white p-5 shadow">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              {initialProductId && historyProduct
                ? `ประวัติการย้ายรายสินค้า — ${historyProduct.product_code}`
                : 'ประวัติการย้ายตำแหน่งทั้งหมด'}
            </h1>
            <p className="text-sm text-gray-500">
              {initialProductId && historyProduct
                ? historyProduct.product_name
                : 'แสดงใบย้ายของสินค้าทุกรหัส การย้ายไม่เปลี่ยนยอดรวมและไม่กระทบ FIFO'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setManageOpen(true)} className="rounded-xl border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">จัดการจุดจัดเก็บ</button>
            <button onClick={() => setCreateOpen(true)} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">+ สร้างใบย้าย</button>
            <button onClick={() => navigate('/warehouse')} className="rounded-xl border border-blue-300 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">กลับคลังสินค้า</button>
          </div>
        </div>
        {initialProductId && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
            <div>
              <span className="rounded-full bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white">กำลังดูเฉพาะรายสินค้า</span>
              {historyProduct && <span className="ml-3 text-sm font-medium text-blue-900">{historyProduct.product_code} · {historyProduct.product_name}</span>}
            </div>
            <button type="button" onClick={() => navigate('/warehouse/transfers')} className="text-sm font-semibold text-blue-700 hover:underline">
              ดูประวัติทั้งหมด
            </button>
          </div>
        )}
        <div className="mb-4 flex flex-wrap gap-3">
          <input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="ค้นหาเลขที่ใบย้าย รหัสสินค้า ชื่อสินค้า จุดจัดเก็บ หรือผู้ทำรายการ" className="min-w-[280px] flex-1 rounded-xl border border-gray-300 px-4 py-2.5" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-xl border border-gray-300 px-4 py-2.5">
            <option value="">ทุกสถานะ</option><option value="draft">ร่าง</option><option value="posted">ยืนยันแล้ว</option><option value="cancelled">ยกเลิก</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="bg-blue-600 text-white"><th className="rounded-tl-xl p-3 text-left">เลขที่ใบย้าย</th><th className="p-3 text-left">วันที่</th>{!initialProductId && <><th className="p-3 text-left">รหัสสินค้า</th><th className="p-3 text-left">ชื่อสินค้า</th></>}<th className="p-3 text-left">ต้นทาง → ปลายทาง</th><th className="p-3 text-center">รายการ</th><th className="p-3 text-left">ผู้ทำรายการ</th><th className="rounded-tr-xl p-3 text-center">สถานะ</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={initialProductId ? 6 : 8} className="p-10 text-center text-gray-500">กำลังโหลด...</td></tr> : filteredTransfers.length === 0 ? <tr><td colSpan={initialProductId ? 6 : 8} className="p-10 text-center text-gray-500">ยังไม่มีประวัติการย้าย</td></tr> : filteredTransfers.map((row) => (
                <tr key={row.id} onClick={() => void openDetail(row)} className="cursor-pointer border-b hover:bg-blue-50">
                  <td className="p-3 font-semibold text-blue-700">{row.transfer_no}</td><td className="p-3">{formatDate(row.posted_at || row.created_at)}</td>{!initialProductId && <><td className="max-w-[220px] p-3 font-medium" title={row.product_codes}>{row.product_codes || '-'}</td><td className="max-w-[320px] truncate p-3" title={row.product_names}>{row.product_names || '-'}</td></>}<td className="p-3 font-medium">{row.from_code} → {row.to_code}</td><td className="p-3 text-center">{row.item_count}</td><td className="p-3">{row.created_by}</td><td className="p-3 text-center"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusLabel[row.status].css}`}>{statusLabel[row.status].text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} contentClassName="max-w-6xl">
        <div className="p-6">
          <h2 className="text-xl font-bold">สร้างใบย้ายตำแหน่ง</h2>
          <p className="mb-5 text-sm text-gray-500">เลือกต้นทางก่อน ระบบจะแสดงเฉพาะสินค้าที่มีอยู่ในจุดนั้น</p>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium">ต้นทาง<select value={fromId} onChange={(e) => { setFromId(e.target.value); setLines([]) }} className="mt-1 w-full rounded-xl border p-2.5"><option value="">เลือกต้นทาง</option>{locations.filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` — ${l.name}` : ''}</option>)}</select></label>
            <label className="text-sm font-medium">ปลายทาง<select value={toId} onChange={(e) => setToId(e.target.value)} className="mt-1 w-full rounded-xl border p-2.5"><option value="">เลือกปลายทาง</option>{locations.filter((l) => l.is_active && l.id !== fromId).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` — ${l.name}` : ''}</option>)}</select></label>
          </div>
          <label className="mt-4 block text-sm font-medium">หมายเหตุ<input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-xl border p-2.5" placeholder="เช่น เติมจุดหยิบประจำวัน" /></label>
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="rounded-xl border p-3">
              <input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="ค้นหารหัสหรือชื่อสินค้า" className="mb-3 w-full rounded-lg border px-3 py-2" />
              <div className="max-h-72 overflow-y-auto">
                {!fromId ? <p className="py-8 text-center text-sm text-gray-400">กรุณาเลือกต้นทาง</p> : filteredSourceStock.map((row) => <button key={row.product_id} onClick={() => addProduct(row)} className="flex w-full items-center justify-between border-b px-2 py-2 text-left hover:bg-blue-50"><span><b>{row.product_code}</b><span className="ml-2 text-sm text-gray-600">{row.product_name}</span></span><span className="text-sm font-semibold text-blue-600">{row.qty.toLocaleString()} {row.unit_name?.trim() || 'ชิ้น'}</span></button>)}
              </div>
            </div>
            <div className="rounded-xl border p-3">
              <h3 className="mb-2 font-semibold">รายการที่จะย้าย ({lines.length})</h3>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {lines.length === 0 ? <p className="py-8 text-center text-sm text-gray-400">ยังไม่ได้เลือกสินค้า</p> : lines.map((line) => <div key={line.product_id} className="grid grid-cols-[1fr_110px_32px] items-center gap-2 rounded-lg bg-gray-50 p-2"><div className="min-w-0"><b>{line.product_code}</b><p className="truncate text-xs text-gray-500">{line.product_name} · <span className="font-semibold text-blue-600">{line.qty.toLocaleString()} {line.unit_name?.trim() || 'ชิ้น'}</span></p></div><input type="number" min="0.01" max={line.qty} value={line.transfer_qty} onWheel={(e) => e.currentTarget.blur()} onChange={(e) => setLines((current) => current.map((item) => item.product_id === line.product_id ? { ...item, transfer_qty: e.target.value } : item))} placeholder="จำนวน" className="rounded-lg border px-2 py-1.5" /><button onClick={() => setLines((current) => current.filter((item) => item.product_id !== line.product_id))} className="text-red-500">×</button></div>)}
              </div>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2"><button onClick={() => setCreateOpen(false)} className="rounded-xl border px-4 py-2">ปิด</button><button disabled={saving} onClick={() => void saveTransfer(false)} className="rounded-xl border border-amber-400 px-4 py-2 font-semibold text-amber-700 disabled:opacity-50">บันทึกร่าง</button><button disabled={saving} onClick={() => void saveTransfer(true)} className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">ยืนยันการย้าย</button></div>
        </div>
      </Modal>

      <Modal open={manageOpen} onClose={() => setManageOpen(false)} contentClassName="max-w-2xl">
        <div className="p-6"><h2 className="mb-4 text-xl font-bold">จัดการจุดจัดเก็บ</h2><div className="grid gap-2 sm:grid-cols-[140px_1fr_150px_auto]"><input value={newLocation.code} onChange={(e) => setNewLocation((v) => ({ ...v, code: e.target.value }))} placeholder="รหัส เช่น B-05" className="rounded-lg border p-2" /><input value={newLocation.name} onChange={(e) => setNewLocation((v) => ({ ...v, name: e.target.value }))} placeholder="ชื่อจุดจัดเก็บ" className="rounded-lg border p-2" /><select value={newLocation.location_type} onChange={(e) => setNewLocation((v) => ({ ...v, location_type: e.target.value }))} className="rounded-lg border p-2"><option value="picking">จุดหยิบหลัก</option><option value="reserve">เก็บสำรอง</option><option value="hold">พัก/รอตรวจ</option></select><button onClick={() => void createLocation()} className="rounded-lg bg-blue-600 px-4 py-2 text-white">เพิ่ม</button></div><div className="mt-5 divide-y rounded-xl border">{locations.map((location) => <div key={location.id} className="flex items-center justify-between p-3"><span><b>{location.code}</b>{location.name ? ` — ${location.name}` : ''}</span><span className="text-xs text-gray-500">{location.location_type === 'picking' ? 'จุดหยิบหลัก' : location.location_type === 'reserve' ? 'เก็บสำรอง' : 'พัก/รอตรวจ'}</span></div>)}</div></div>
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} contentClassName="max-w-2xl">
        {detail && <div className="p-6"><div className="mb-4"><h2 className="text-xl font-bold">{detail.transfer_no}</h2><p className="text-sm text-gray-500">{detail.from_code} → {detail.to_code} · {formatDate(detail.posted_at || detail.created_at)}</p></div><div className="divide-y rounded-xl border">{detailItems.map((item) => <div key={item.id} className="flex justify-between p-3"><span><b>{item.pr_products.product_code}</b> — {item.pr_products.product_name}</span><b>{Number(item.qty).toLocaleString()} {item.pr_products.unit_name || 'ชิ้น'}</b></div>)}</div>{detail.note && <p className="mt-3 rounded-lg bg-gray-50 p-3 text-sm">หมายเหตุ: {detail.note}</p>}<div className="mt-5 flex justify-end gap-2">{detail.status === 'draft' && <button disabled={saving} onClick={() => void postDraft(detail.id)} className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white">ยืนยันใบย้าย</button>}{detail.status !== 'cancelled' && <button disabled={saving} onClick={() => setCancelTarget(detail)} className="rounded-xl border border-red-300 px-4 py-2 font-semibold text-red-600">ยกเลิกใบย้าย</button>}</div></div>}
      </Modal>

      <Modal
        open={!!cancelTarget}
        onClose={() => { if (!saving) setCancelTarget(null) }}
        contentClassName="max-w-md"
        stackClassName="z-[60]"
        showCloseButton={!saving}
      >
        {cancelTarget && (
          <div className="p-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-2xl text-red-600">!</div>
            <h2 className="mt-4 text-xl font-bold text-gray-900">ยืนยันยกเลิกใบย้าย</h2>
            <p className="mt-2 font-semibold text-gray-700">{cancelTarget.transfer_no}</p>
            <p className="mt-2 text-sm leading-6 text-gray-500">
              ระบบจะคืนจำนวนสินค้าจาก {cancelTarget.to_code} กลับไปยัง {cancelTarget.from_code}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => setCancelTarget(null)}
                className="rounded-xl border border-gray-300 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                ไม่ยกเลิก
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void cancelTransfer(cancelTarget.id)}
                className="rounded-xl bg-red-600 px-5 py-2.5 font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิก'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
