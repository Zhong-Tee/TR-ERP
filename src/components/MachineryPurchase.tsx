import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuthContext } from '../contexts/AuthContext'
import { getPublicUrl } from '../lib/qcApi'
import PhotoLightbox from './hr/PhotoLightbox'

export type MachineryPurchaseProduct = {
  product_id: string
  product_code: string
  product_name: string
  product_category: string | null
  unit_name: string | null
  storage_location: string | null
  on_hand: number
  enabled: boolean
  order_point: string | null
  order_point_days: number | null
  product_type: 'FG' | 'RM' | 'PP' | null
}

type MyRequest = {
  id: string
  pr_no: string
  status: string
  note: string | null
  created_at: string
  rejection_reason: string | null
  inv_po: Array<{ id: string; po_no: string }>
  inv_pr_items: Array<{ id: string; product_id: string; qty: number; unit: string | null; note: string | null; pr_products: { product_code: string; product_name: string } | null }>
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'รออนุมัติ', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'ไม่อนุมัติ', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'ยกเลิก', cls: 'bg-gray-100 text-gray-600' },
}

/** รูปย่อสินค้า — คลิกเพื่อดูรูปขนาดใหญ่ (ซ่อนอัตโนมัติเมื่อไม่มีรูป) */
function ProductThumb({ code, name, size = 'h-14 w-14' }: { code: string; name: string; size?: string }) {
  const url = getPublicUrl('product-images', code, '.jpg')
  const [broken, setBroken] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const canZoom = !!url && !broken
  return <>
    <button type="button" disabled={!canZoom} onClick={() => setZoomed(true)} title={canZoom ? 'คลิกเพื่อดูรูปขนาดใหญ่' : undefined} aria-label={canZoom ? `ดูรูปขนาดใหญ่ ${name}` : undefined} className={`${size} shrink-0 overflow-hidden rounded-lg border bg-gray-50 ${canZoom ? 'cursor-zoom-in hover:border-blue-400' : 'cursor-default'}`}>
      {canZoom && <img src={url} alt={name} className="h-full w-full object-contain p-0.5" onError={() => setBroken(true)} />}
    </button>
    {zoomed && canZoom && <PhotoLightbox url={url} alt={name} onClose={() => setZoomed(false)} />}
  </>
}

async function loadProducts(includeDisabled = false): Promise<MachineryPurchaseProduct[]> {
  const { data, error } = await supabase.rpc('get_machinery_purchase_products', { p_include_disabled: includeDisabled })
  if (error) throw error
  const rows = (data || []) as MachineryPurchaseProduct[]
  const productIds = rows.map((row) => row.product_id)
  const productMetaById = new Map<string, { order_point: string | null; order_point_days: number | null; product_type: 'FG' | 'RM' | 'PP' | null }>()
  if (productIds.length > 0) {
    const { data: productRows, error: productError } = await supabase
      .from('pr_products')
      .select('id, order_point, order_point_days, product_type')
      .in('id', productIds)
    if (productError) throw productError
    for (const product of productRows || []) {
      productMetaById.set(product.id, {
        order_point: product.order_point != null ? String(product.order_point) : null,
        order_point_days: product.order_point_days != null ? Number(product.order_point_days) : null,
        product_type: product.product_type === 'FG' || product.product_type === 'RM' || product.product_type === 'PP' ? product.product_type : null,
      })
    }
  }
  return rows.map((row) => {
    const reorder = productMetaById.get(row.product_id)
    return {
      ...row,
      on_hand: Number(row.on_hand) || 0,
      order_point: reorder?.order_point ?? row.order_point ?? null,
      order_point_days: reorder?.order_point_days ?? row.order_point_days ?? null,
      product_type: reorder?.product_type ?? row.product_type ?? null,
    }
  })
}

export function MachineryPurchaseRequest({ onCountChange }: { onCountChange?: (count: number) => void }) {
  const { user } = useAuthContext()
  const [subtab, setSubtab] = useState<'new' | 'mine' | 'ordered'>('new')
  const [products, setProducts] = useState<MachineryPurchaseProduct[]>([])
  const [requests, setRequests] = useState<MyRequest[]>([])
  const [qty, setQty] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [requestNote, setRequestNote] = useState('')
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)
  const [editQty, setEditQty] = useState<Record<string, string>>({})
  const [editNotes, setEditNotes] = useState<Record<string, string>>({})
  const [editRequestNote, setEditRequestNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [productRows, requestRes] = await Promise.all([
        loadProducts(false),
        supabase
          .from('inv_pr')
          .select('id, pr_no, status, note, created_at, rejection_reason, inv_po(id, po_no), inv_pr_items(id, product_id, qty, unit, note, pr_products(product_code, product_name))')
          .eq('pr_type', 'machinery')
          .eq('requested_by', user?.id || '00000000-0000-0000-0000-000000000000')
          .order('created_at', { ascending: false }),
      ])
      if (requestRes.error) throw requestRes.error
      setProducts(productRows)
      const rows = (requestRes.data || []) as unknown as MyRequest[]
      setRequests(rows)
      onCountChange?.(rows.filter((r) => r.status === 'pending' && !(r.inv_po?.length)).length)
    } catch (e: any) {
      setMessage(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [user?.id, onCountChange])

  useEffect(() => {
    load()
    const channel = supabase.channel('machinery-my-pr').on('postgres_changes', { event: '*', schema: 'public', table: 'inv_pr' }, load).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products
      .filter((p) => !selectedProductIds.includes(p.product_id))
      .filter((p) => !q || `${p.product_code} ${p.product_name} ${p.product_category || ''}`.toLowerCase().includes(q))
      .slice(0, 10)
  }, [products, search, selectedProductIds])
  const myRequests = useMemo(() => requests.filter((r) => !(r.inv_po?.length)), [requests])
  const orderedRequests = useMemo(() => requests.filter((r) => (r.inv_po?.length || 0) > 0), [requests])
  const selectedProducts = useMemo(
    () => selectedProductIds.flatMap((id) => {
      const product = products.find((p) => p.product_id === id)
      return product ? [product] : []
    }),
    [products, selectedProductIds],
  )

  function addProduct(product: MachineryPurchaseProduct) {
    setSelectedProductIds((ids) => ids.includes(product.product_id) ? ids : [...ids, product.product_id])
    setQty((value) => ({ ...value, [product.product_id]: value[product.product_id] || '1' }))
    setSearch('')
    setSearchOpen(false)
  }

  function removeProduct(productId: string) {
    setSelectedProductIds((ids) => ids.filter((id) => id !== productId))
    setQty((value) => { const next = { ...value }; delete next[productId]; return next })
    setNotes((value) => { const next = { ...value }; delete next[productId]; return next })
  }

  function toggleRequestDetail(request: MyRequest) {
    setExpandedRequestId((id) => id === request.id ? null : request.id)
    setEditingRequestId(null)
  }

  function beginEditRequest(request: MyRequest) {
    if (request.inv_po?.length) return
    setEditQty(Object.fromEntries(request.inv_pr_items.map((item) => [item.id, String(item.qty)])))
    setEditNotes(Object.fromEntries(request.inv_pr_items.map((item) => [item.id, item.note || ''])))
    setEditRequestNote(request.note || '')
    setEditingRequestId(request.id)
  }

  async function saveRequestEdit(request: MyRequest) {
    const items = request.inv_pr_items.map((item) => ({
      product_id: item.product_id,
      qty: Number(editQty[item.id]),
      unit: item.unit || 'ชิ้น',
      note: editNotes[item.id]?.trim() || null,
    }))
    if (items.some((item) => !Number.isFinite(item.qty) || item.qty <= 0)) {
      setMessage('กรุณาระบุจำนวนสินค้าให้มากกว่า 0 ทุกรายการ')
      return
    }
    setSaving(true)
    setMessage('')
    try {
      const { error } = await supabase.rpc('rpc_update_machinery_pr', {
        p_pr_id: request.id,
        p_items: items,
        p_note: editRequestNote.trim() || null,
      })
      if (error) throw error
      setEditingRequestId(null)
      setMessage(`แก้ไขคำขอซื้อ ${request.pr_no} เรียบร้อยแล้ว`)
      await load()
      window.dispatchEvent(new Event('purchase-badge-refresh'))
    } catch (e: any) {
      setMessage(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  async function submit() {
    const items = selectedProducts.flatMap((p) => {
      const amount = Number(qty[p.product_id])
      return amount > 0 ? [{ product_id: p.product_id, qty: amount, unit: p.unit_name || 'ชิ้น', note: notes[p.product_id]?.trim() || null }] : []
    })
    if (!items.length) { setMessage('กรุณาระบุจำนวนสินค้าอย่างน้อย 1 รายการ'); return }
    setSaving(true)
    setMessage('')
    try {
      const { data, error } = await supabase.rpc('rpc_create_machinery_pr', { p_items: items, p_note: requestNote.trim() || null })
      if (error) throw error
      setQty({}); setNotes({}); setRequestNote(''); setSelectedProductIds([]); setSearch('')
      setMessage(`สร้างคำขอซื้อ ${(data as any)?.pr_no || ''} เรียบร้อยแล้ว`)
      setSubtab('mine')
      window.dispatchEvent(new Event('purchase-badge-refresh'))
      await load()
    } catch (e: any) { setMessage(e?.message || String(e)) } finally { setSaving(false) }
  }

  const isOrderedTab = subtab === 'ordered'
  const visibleRequests = isOrderedTab ? orderedRequests : myRequests

  return <section className="space-y-4">
    <div className="flex gap-2 border-b">
      {[
        { key: 'new' as const, label: 'คำขอใหม่', count: 0 },
        { key: 'mine' as const, label: 'รายการของฉัน', count: myRequests.filter((r) => r.status === 'pending').length },
        { key: 'ordered' as const, label: 'สั่งซื้อแล้ว', count: orderedRequests.length },
      ].map(({ key, label, count }) => <button key={key} onClick={() => { setSubtab(key); setExpandedRequestId(null); setEditingRequestId(null) }} className={`px-4 py-2.5 font-semibold border-b-2 ${subtab === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}>
        {label}{count > 0 ? ` (${count})` : ''}
      </button>)}
    </div>
    {message && <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">{message}</div>}
    {loading ? <div className="py-12 text-center text-gray-500">กำลังโหลด…</div> : subtab === 'new' ? <>
      <div className="relative rounded-xl border bg-white p-4">
        <label className="mb-2 block text-sm font-semibold text-gray-700">เพิ่มสินค้า</label>
        <input value={search} onFocus={() => setSearchOpen(true)} onChange={(e) => { setSearch(e.target.value); setSearchOpen(true) }} placeholder="ค้นหาหรือเลือกรายการสินค้า…" role="combobox" aria-expanded={searchOpen} className="w-full rounded-xl border px-4 py-2.5" />
        {searchOpen && <div className="absolute left-4 right-4 top-[5.3rem] z-20 max-h-80 divide-y overflow-y-auto rounded-xl border bg-white shadow-xl">{searchResults.length > 0 ? searchResults.map((p) => <div key={p.product_id} className="flex items-center gap-3 bg-white p-3 hover:bg-gray-50">
          <ProductThumb code={p.product_code} name={p.product_name} size="h-12 w-12" />
          <div className="min-w-0 flex-1"><div className="font-semibold">รหัสสินค้า: {p.product_code}</div><div className="text-sm text-gray-600">{p.product_name} · คงเหลือ {p.on_hand.toLocaleString()} {p.unit_name || 'ชิ้น'}</div></div>
          <button type="button" onClick={() => addProduct(p)} className="shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">+ เพิ่มรายการ</button>
        </div>) : <div className="p-4 text-center text-sm text-gray-500">ไม่พบสินค้า หรือสินค้าถูกเพิ่มแล้ว</div>}</div>}
      </div>
      {selectedProducts.length === 0 ? <div className="rounded-xl border border-dashed bg-gray-50 py-10 text-center text-gray-500">ยังไม่มีรายการสินค้า กรุณาค้นหาและเพิ่มสินค้าทีละรายการ</div> : <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full min-w-[1100px] table-fixed text-sm"><colgroup><col className="w-[5%]" /><col className="w-[8%]" /><col className="w-[10%]" /><col className="w-[30%]" /><col className="w-[12%]" /><col className="w-[11%]" /><col className="w-[17%]" /><col className="w-[7%]" /></colgroup><thead className="bg-gray-50"><tr><th className="p-3 text-center">ลำดับ</th><th className="p-3 text-center">รูปสินค้า</th><th className="p-3 text-left">รหัส</th><th className="p-3 text-left">สินค้า</th><th className="p-3 text-right">จำนวนคงเหลือ</th><th className="p-3 text-left">จำนวนที่ขอ</th><th className="p-3 text-left">หมายเหตุ</th><th className="p-3 text-center">จัดการ</th></tr></thead><tbody className="divide-y">{selectedProducts.map((p, index) => <tr key={p.product_id} className="align-middle"><td className="p-3 text-center font-bold text-gray-500">{index + 1}</td><td className="p-3"><div className="flex justify-center"><ProductThumb code={p.product_code} name={p.product_name} /></div></td><td className="p-3 font-semibold text-blue-700">{p.product_code}</td><td className="p-3 font-medium text-gray-800">{p.product_name}</td><td className="p-3 text-right font-bold tabular-nums">{p.on_hand.toLocaleString()} {p.unit_name || 'ชิ้น'}</td><td className="p-3"><input type="number" min="1" value={qty[p.product_id] || ''} onChange={(e) => setQty((v) => ({ ...v, [p.product_id]: e.target.value }))} className="w-full rounded-lg border px-3 py-2" /></td><td className="p-3"><input value={notes[p.product_id] || ''} onChange={(e) => setNotes((v) => ({ ...v, [p.product_id]: e.target.value }))} placeholder="ระบุหมายเหตุของรายการ" className="w-full rounded-lg border px-3 py-2" /></td><td className="p-3 text-center"><button type="button" onClick={() => removeProduct(p.product_id)} className="rounded-lg border border-red-200 px-3 py-2 font-semibold text-red-600 hover:bg-red-50">ลบ</button></td></tr>)}</tbody></table></div>}
      <textarea value={requestNote} onChange={(e) => setRequestNote(e.target.value)} placeholder="หมายเหตุคำขอซื้อ" className="w-full rounded-xl border px-4 py-3" rows={3} />
      <div className="flex items-center justify-between"><span className="text-sm font-semibold text-gray-600">เพิ่มแล้ว {selectedProducts.length.toLocaleString()} รายการ</span><button onClick={submit} disabled={saving || selectedProducts.length === 0} className="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white disabled:opacity-50">{saving ? 'กำลังส่ง…' : 'ส่งคำขอซื้อ'}</button></div>
    </> : visibleRequests.length === 0 ? <div className="py-12 text-center text-gray-500">{isOrderedTab ? 'ยังไม่มีรายการที่สั่งซื้อแล้ว' : 'ยังไม่มีคำขอซื้อ'}</div> : <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="bg-gray-50 text-gray-600"><tr>
          <th className="p-3 text-left">เลข PR</th>{isOrderedTab && <th className="p-3 text-left">เลข PO</th>}<th className="p-3 text-left">วันที่สร้าง</th><th className="p-3 text-left">ผู้สร้าง</th><th className="p-3 text-center">สถานะ</th><th className="p-3 text-right">จัดการ</th>
        </tr></thead>
        <tbody className="divide-y">{visibleRequests.map((r) => {
          const isExpanded = expandedRequestId === r.id
          const isEditing = editingRequestId === r.id
          const hasPO = (r.inv_po?.length || 0) > 0
          return <Fragment key={r.id}>
            <tr className="hover:bg-gray-50">
              <td className="p-3 font-bold text-blue-700">{r.pr_no}</td>
              {isOrderedTab && <td className="p-3 font-semibold text-emerald-700">{r.inv_po.map((po) => po.po_no).join(', ') || '-'}</td>}
              <td className="p-3 text-gray-600">{new Date(r.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' })}</td>
              <td className="p-3 text-gray-700">{user?.username || user?.email || '-'}</td>
              <td className="p-3">
                <div className="flex items-center justify-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${(STATUS[r.status] || STATUS.cancelled).cls}`}>{(STATUS[r.status] || STATUS.cancelled).label}</span>
                </div>
              </td>
              <td className="p-3 text-right"><button type="button" onClick={() => toggleRequestDetail(r)} className="rounded-lg border px-3 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50">{isExpanded ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}</button></td>
            </tr>
            {isExpanded && <tr><td colSpan={isOrderedTab ? 6 : 5} className="border-t bg-gray-50/60 p-4">
          <div className="overflow-x-auto rounded-lg border bg-white">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-gray-50"><tr><th className="p-3 text-left">ลำดับ</th><th className="p-3 text-center">รูปสินค้า</th><th className="p-3 text-left">รหัสสินค้า</th><th className="p-3 text-left">สินค้า</th><th className="p-3 text-left">จำนวนที่ขอ</th><th className="p-3 text-left">หมายเหตุ</th></tr></thead>
              <tbody className="divide-y">{r.inv_pr_items.map((i, index) => <tr key={i.id}>
                <td className="p-3">{index + 1}</td><td className="p-3"><div className="flex justify-center"><ProductThumb code={i.pr_products?.product_code || ''} name={i.pr_products?.product_name || ''} /></div></td><td className="p-3 font-semibold text-blue-700">{i.pr_products?.product_code}</td><td className="p-3">{i.pr_products?.product_name}</td>
                <td className="p-3">{isEditing ? <input type="number" min="1" value={editQty[i.id] || ''} onChange={(e) => setEditQty((value) => ({ ...value, [i.id]: e.target.value }))} className="w-28 rounded-lg border px-3 py-2" /> : <b>{Number(i.qty).toLocaleString()} {i.unit || 'ชิ้น'}</b>}</td>
                <td className="p-3">{isEditing ? <input value={editNotes[i.id] || ''} onChange={(e) => setEditNotes((value) => ({ ...value, [i.id]: e.target.value }))} className="w-full min-w-52 rounded-lg border px-3 py-2" /> : (i.note || '-')}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="mt-3"><label className="mb-1 block text-sm font-semibold text-gray-700">หมายเหตุคำขอซื้อ</label>{isEditing ? <textarea value={editRequestNote} onChange={(e) => setEditRequestNote(e.target.value)} rows={2} className="w-full rounded-lg border px-3 py-2" /> : <div className="rounded-lg border bg-white px-3 py-2 text-sm text-gray-700">{r.note || '-'}</div>}</div>
          {r.rejection_reason && <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">เหตุผลที่ไม่อนุมัติ: {r.rejection_reason}</div>}
          {hasPO && <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">คำขอนี้สร้าง PO {r.inv_po.map((po) => po.po_no).join(', ')} แล้ว จึงไม่สามารถแก้ไขได้</div>}
          <div className="mt-4 flex justify-end gap-2">{isEditing ? <><button type="button" onClick={() => setEditingRequestId(null)} className="rounded-lg border px-4 py-2 font-semibold text-gray-600">ยกเลิก</button><button type="button" onClick={() => saveRequestEdit(r)} disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-50">{saving ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}</button></> : <button type="button" onClick={() => beginEditRequest(r)} disabled={hasPO} className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-300">แก้ไขคำขอซื้อ</button>}</div>
            </td></tr>}
          </Fragment>
        })}</tbody>
      </table>
    </div>}
  </section>
}

export function MachineryStock() {
  const [products, setProducts] = useState<MachineryPurchaseProduct[]>([])
  const [search, setSearch] = useState('')
  const [stockFilter, setStockFilter] = useState<'all' | 'reorder'>('all')
  useEffect(() => { loadProducts(false).then(setProducts).catch(console.error) }, [])
  const isAtReorderPoint = (p: MachineryPurchaseProduct) => {
    const rawPoint = String(p.order_point ?? '').replace(/,/g, '').trim()
    if (!rawPoint) return false
    const point = Number(rawPoint)
    return Number.isFinite(point) && point >= 0 && p.on_hand <= point
  }
  const reorderCount = products.filter(isAtReorderPoint).length
  const rows = products.filter((p) => {
    const matchesSearch = `${p.product_code} ${p.product_name} ${p.product_category || ''}`.toLowerCase().includes(search.toLowerCase())
    return matchesSearch && (stockFilter === 'all' || isAtReorderPoint(p))
  })
  return <section className="space-y-4">
    <div className="flex flex-col gap-3 lg:flex-row">
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาสินค้า…" className="min-w-0 flex-1 rounded-xl border px-4 py-2.5" />
      <div className="flex shrink-0 overflow-hidden rounded-xl border bg-white p-1">
        <button type="button" onClick={() => setStockFilter('all')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${stockFilter === 'all' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>ทั้งหมด <span className="ml-1">{products.length.toLocaleString()}</span></button>
        <button type="button" onClick={() => setStockFilter('reorder')} className={`rounded-lg px-4 py-2 text-sm font-semibold ${stockFilter === 'reorder' ? 'bg-orange-500 text-white' : 'text-orange-700 hover:bg-orange-50'}`}>ถึงจุดสั่งซื้อ <span className={`ml-1 rounded-full px-2 py-0.5 text-xs ${stockFilter === 'reorder' ? 'bg-white/25 text-white' : 'bg-orange-100 text-orange-800'}`}>{reorderCount.toLocaleString()}</span></button>
      </div>
    </div>
    <div className="divide-y overflow-hidden rounded-xl border bg-white">{rows.map((p) => <article key={p.product_id} className="flex items-center gap-4 p-4 sm:p-5">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-gray-50 sm:h-24 sm:w-24">
        <img src={getPublicUrl('product-images', p.product_code, '.jpg')} alt={p.product_name} className="h-full w-full object-contain p-1" onError={(e) => { e.currentTarget.style.display = 'none' }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-lg font-bold text-blue-700"><span className="text-sm font-semibold text-gray-500">รหัสสินค้า: </span>{p.product_code}</div>
        <div className="font-semibold text-gray-800">{p.product_name}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-semibold text-slate-700">ประเภท: {p.product_category || 'ไม่ระบุ'}</span>
          <span>ตำแหน่ง: {p.storage_location || 'ไม่ระบุ'}</span>
          <span>จุดสั่งซื้อ: <b className="text-gray-700">{p.order_point || '-'}</b></span>
          <span>จุดสั่งซื้อ (วัน): <b className="text-gray-700">{p.order_point_days ?? '-'}</b></span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs font-medium text-gray-500">จำนวนคงเหลือ</div>
        <div className="text-2xl font-black text-emerald-700 tabular-nums sm:text-3xl">{p.on_hand.toLocaleString()} <span className="text-sm font-semibold">{p.unit_name || 'ชิ้น'}</span></div>
      </div>
    </article>)}</div>
    {rows.length === 0 && <div className="rounded-xl border bg-white py-10 text-center text-gray-500">ไม่พบสินค้า</div>}
  </section>
}

export function MachineryPurchaseSettings() {
  const [products, setProducts] = useState<MachineryPurchaseProduct[]>([])
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<'' | 'FG' | 'RM' | 'PP'>('')
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'selected' | 'unselected'>('all')
  const [saving, setSaving] = useState<string | null>(null)
  const load = () => loadProducts(true).then(setProducts).catch(console.error)
  useEffect(() => { void load() }, [])
  async function toggle(p: MachineryPurchaseProduct) { setSaving(p.product_id); await supabase.rpc('set_machinery_purchase_product', { p_product_id: p.product_id, p_enabled: !p.enabled }); await load(); setSaving(null) }
  const categories = useMemo(
    () => [...new Set(products.map((p) => p.product_category?.trim()).filter((v): v is string => !!v))].sort(),
    [products],
  )
  const rows = products.filter((p) => {
    const matchesSearch = `${p.product_code} ${p.product_name} ${p.product_category || ''}`.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = !categoryFilter || p.product_category === categoryFilter
    const matchesProductType = !productTypeFilter || p.product_type === productTypeFilter
    const matchesSelected = selectedFilter === 'all' || (selectedFilter === 'selected' ? p.enabled : !p.enabled)
    return matchesSearch && matchesCategory && matchesProductType && matchesSelected
  })
  const selectedCount = products.filter((p) => p.enabled).length
  return <section className="space-y-4">
    <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between">
      <span>เลือกรายการสินค้าที่ผู้ใช้ Machinery สามารถเห็นยอดคงเหลือและสร้างคำขอซื้อได้</span>
      <span className="shrink-0 rounded-full bg-emerald-100 px-3 py-1 font-bold text-emerald-800">เลือกแล้ว {selectedCount.toLocaleString()} รายการ</span>
    </div>
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาสินค้า…" className="min-w-0 flex-1 rounded-xl border px-4 py-2.5" />
      <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="min-w-56 rounded-xl border bg-white px-4 py-2.5">
        <option value="">ประเภทสินค้าทั้งหมด</option>
        {categories.map((category) => <option key={category} value={category}>{category}</option>)}
      </select>
      <select value={productTypeFilter} onChange={(e) => setProductTypeFilter(e.target.value as '' | 'FG' | 'RM' | 'PP')} className="min-w-40 rounded-xl border bg-white px-4 py-2.5">
        <option value="">FG / RM / PP ทั้งหมด</option>
        <option value="FG">FG</option>
        <option value="RM">RM</option>
        <option value="PP">PP</option>
      </select>
      <select value={selectedFilter} onChange={(e) => setSelectedFilter(e.target.value as 'all' | 'selected' | 'unselected')} className="min-w-44 rounded-xl border bg-white px-4 py-2.5">
        <option value="all">สถานะทั้งหมด</option>
        <option value="selected">เลือกแล้ว</option>
        <option value="unselected">ยังไม่เลือก</option>
      </select>
    </div>
    <div className="divide-y rounded-xl border bg-white">{rows.map((p) => <label key={p.product_id} className="flex cursor-pointer items-center gap-3 p-4">
      <input type="checkbox" checked={p.enabled} disabled={saving === p.product_id} onChange={() => toggle(p)} className="h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold"><span className="text-sm text-gray-500">รหัสสินค้า: </span>{p.product_code} — {p.product_name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">{p.product_type || '-'}</span>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">ประเภท: {p.product_category || 'ไม่ระบุ'}</span>
          {p.storage_location && <span className="text-xs text-gray-500">ตำแหน่ง: {p.storage_location}</span>}
          <span className="text-xs text-gray-500">จุดสั่งซื้อ: <b className="text-gray-700">{p.order_point || '-'}</b></span>
          <span className="text-xs text-gray-500">จุดสั่งซื้อ (วัน): <b className="text-gray-700">{p.order_point_days ?? '-'}</b></span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs text-gray-500">คงเหลือ</div>
        <div className="text-lg font-black text-emerald-700 tabular-nums">{p.on_hand.toLocaleString()} <span className="text-xs font-semibold">{p.unit_name || 'ชิ้น'}</span></div>
      </div>
    </label>)}</div>
    {rows.length === 0 && <div className="rounded-xl border bg-white py-10 text-center text-gray-500">ไม่พบสินค้าตามตัวกรอง</div>}
  </section>
}
