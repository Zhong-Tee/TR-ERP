import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../components/ui/Modal'
import { useAuthContext } from '../contexts/AuthContext'
import type { InventoryPR, InventoryPRItem, Product } from '../types'
import {
  loadPRList,
  loadPRDetail,
  createPR,
  approvePR,
  rejectPR,
  loadProductsWithLastPrice,
  loadStockBalances,
  loadUserDisplayNames,
} from '../lib/purchaseApi'
import { getPublicUrl } from '../lib/qcApi'

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: 'รออนุมัติ', color: 'bg-yellow-100 text-yellow-800' },
  approved: { label: 'อนุมัติแล้ว', color: 'bg-green-100 text-green-800' },
  rejected: { label: 'ไม่อนุมัติ', color: 'bg-red-100 text-red-800' },
}

const APPROVE_ROLES = ['superadmin', 'admin', 'account']
const PRICE_VISIBLE_ROLES = ['superadmin', 'account']

interface DraftItem {
  product_id: string
  qty: number
  unit: string
  estimated_price: number | null
  note: string
}

function ZoomImage({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const handleEnter = () => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.top, left: rect.right + 8 })
  }
  const handleLeave = () => setPos(null)

  return (
    <div ref={ref} className="w-16 h-16 flex-shrink-0 cursor-pointer" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className="w-16 h-16 rounded-lg bg-gray-200 overflow-hidden">
        <img src={src} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
      </div>
      {pos && (
        <img
          src={src}
          alt=""
          className="fixed w-48 h-48 object-cover rounded-xl shadow-2xl border-2 border-white pointer-events-none"
          style={{ top: pos.top, left: pos.left, zIndex: 9999 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
    </div>
  )
}

export default function PurchasePR() {
  const { user } = useAuthContext()

  // list state
  const [prs, setPrs] = useState<(InventoryPR & { _itemCount?: number })[]>([])
  const [products, setProducts] = useState<(Product & { last_price?: number | null })[]>([])
  const [stockBalances, setStockBalances] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')

  // create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
  const [note, setNote] = useState('')
  const [prType, setPrType] = useState<'normal' | 'urgent'>('normal')
  const [productSearch, setProductSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterSeller, setFilterSeller] = useState('')
  const [filterCategory, setFilterCategory] = useState('')

  // supplier panel (right side)
  const [supplierPanelSeller, setSupplierPanelSeller] = useState('')
  const [supplierPanelIndex, setSupplierPanelIndex] = useState<number>(-1)

  // detail modal
  const [viewing, setViewing] = useState<InventoryPR | null>(null)
  const [viewItems, setViewItems] = useState<InventoryPRItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  // user display names
  const [userMap, setUserMap] = useState<Record<string, string>>({})

  // approve/reject
  const [updating, setUpdating] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const canApprove = APPROVE_ROLES.includes(user?.role || '')
  const canSeePrice = PRICE_VISIBLE_ROLES.includes(user?.role || '')

  const handleCreateFromTopBar = useCallback(() => setCreateOpen(true), [])

  useEffect(() => {
    window.addEventListener('purchase-pr-create', handleCreateFromTopBar)
    return () => window.removeEventListener('purchase-pr-create', handleCreateFromTopBar)
  }, [handleCreateFromTopBar])

  useEffect(() => {
    loadAll()
  }, [statusFilter, search])

  async function loadAll() {
    setLoading(true)
    try {
      const [prData, prodData, stockData] = await Promise.all([
        loadPRList({ status: statusFilter, search }),
        products.length ? Promise.resolve(products) : loadProductsWithLastPrice(),
        Object.keys(stockBalances).length ? Promise.resolve(stockBalances) : loadStockBalances(),
      ])
      const mappedPrs = prData.map((pr: any) => ({
        ...pr,
        _itemCount: pr.inv_pr_items?.length ?? 0,
      }))
      setPrs(mappedPrs)
      if (!products.length) setProducts(prodData as any)
      if (!Object.keys(stockBalances).length) setStockBalances(stockData as Record<string, number>)

      const uids = mappedPrs.map((pr: any) => pr.requested_by).filter(Boolean)
      if (uids.length) {
        const names = await loadUserDisplayNames(uids)
        setUserMap((prev) => ({ ...prev, ...names }))
      }
    } catch (e) {
      console.error('Load PR failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const productMap = useMemo(() => {
    const m = new Map<string, Product & { last_price?: number | null }>()
    products.forEach((p) => m.set(p.id, p))
    return m
  }, [products])

  /* ── Filter options extracted from products ── */
  const uniqueTypes = useMemo(() => [...new Set(products.map((p) => p.product_type).filter(Boolean))].sort(), [products])
  const uniqueSellers = useMemo(() => [...new Set(products.map((p) => p.seller_name).filter(Boolean) as string[])].sort(), [products])
  const uniqueCategories = useMemo(() => {
    const base = filterType ? products.filter((p) => p.product_type === filterType) : products
    return [...new Set(base.map((p) => p.product_category).filter(Boolean) as string[])].sort()
  }, [products, filterType])

  const filteredProducts = useMemo(() => {
    let filtered = products
    if (productSearch.trim()) {
      const s = productSearch.toLowerCase()
      filtered = filtered.filter(
        (p) =>
          p.product_code.toLowerCase().includes(s) ||
          p.product_name.toLowerCase().includes(s) ||
          (p.product_name_cn && p.product_name_cn.toLowerCase().includes(s)) ||
          (p.seller_name && p.seller_name.toLowerCase().includes(s))
      )
    }
    if (filterType) filtered = filtered.filter((p) => p.product_type === filterType)
    if (filterSeller) filtered = filtered.filter((p) => p.seller_name === filterSeller)
    if (filterCategory) filtered = filtered.filter((p) => p.product_category === filterCategory)
    return filtered
  }, [products, productSearch, filterType, filterSeller, filterCategory])

  /* ── Supplier panel products ── */
  const supplierProducts = useMemo(() => {
    if (!supplierPanelSeller) return []
    return products.filter((p) => p.seller_name === supplierPanelSeller)
  }, [products, supplierPanelSeller])

  /* ── Draft item helpers ── */
  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
  }
  function updateDraftItem(i: number, patch: Partial<DraftItem>) {
    setDraftItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)))
  }
  function removeDraftItem(i: number) {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== i))
  }

  function onSelectProduct(index: number, productId: string) {
    if (productId && draftItems.some((d, i) => i !== index && d.product_id === productId)) {
      alert('สินค้านี้ถูกเพิ่มในรายการแล้ว')
      return
    }
    const prod = productMap.get(productId)
    updateDraftItem(index, {
      product_id: productId,
      estimated_price: canSeePrice ? (prod?.last_price ?? prod?.unit_cost ?? null) : null,
    })
  }

  function addSupplierProduct(productId: string) {
    if (draftItems.some((d) => d.product_id === productId)) return
    const prod = productMap.get(productId)
    const newItem: DraftItem = {
      product_id: productId,
      qty: 1,
      unit: 'ชิ้น',
      estimated_price: canSeePrice ? (prod?.last_price ?? prod?.unit_cost ?? null) : null,
      note: '',
    }
    setDraftItems((prev) => {
      const insertAt = supplierPanelIndex >= 0 ? supplierPanelIndex + 1 : prev.length
      return [...prev.slice(0, insertAt), newItem, ...prev.slice(insertAt)]
    })
  }

  function handleViewSupplier(index: number) {
    const item = draftItems[index]
    const prod = item.product_id ? productMap.get(item.product_id) : null
    const seller = prod?.seller_name
    if (!seller) {
      alert('สินค้านี้ไม่มีข้อมูลผู้ขาย')
      return
    }
    setSupplierPanelSeller(seller)
    setSupplierPanelIndex(index)
  }

  function closeSupplierPanel() {
    setSupplierPanelSeller('')
    setSupplierPanelIndex(-1)
  }

  /* ── Pull reorder-point items ── */
  function loadReorderPointItems() {
    const existingProductIds = new Set(draftItems.map((d) => d.product_id).filter(Boolean))
    const reorderItems: DraftItem[] = []
    for (const prod of products) {
      if (!prod.order_point) continue
      if (existingProductIds.has(prod.id)) continue
      const op = parseFloat(String(prod.order_point).replace(/,/g, ''))
      if (isNaN(op) || op <= 0) continue
      const onHand = stockBalances[prod.id] ?? 0
      if (onHand < op) {
        reorderItems.push({
          product_id: prod.id,
          qty: Math.ceil(op - onHand),
          unit: 'ชิ้น',
          estimated_price: canSeePrice ? ((prod as any).last_price ?? prod.unit_cost ?? null) : null,
          note: `คงเหลือ ${onHand} / จุดสั่งซื้อ ${prod.order_point}`,
        })
      }
    }
    if (reorderItems.length === 0) {
      alert('ไม่มีรายการที่ถึงจุดสั่งซื้อ')
      return
    }
    setDraftItems((prev) => {
      if (prev.length === 1 && !prev[0].product_id) return reorderItems
      return [...prev, ...reorderItems]
    })
  }

  function closeCreate() {
    setCreateOpen(false)
    setSupplierPanelSeller('')
    setSupplierPanelIndex(-1)
    setProductSearch('')
    setFilterType('')
    setFilterSeller('')
    setFilterCategory('')
  }

  /* ── Create PR ── */
  async function handleCreatePR() {
    if (!note.trim()) { alert('กรุณาระบุหัวข้อขอซื้อ'); return }
    const valid = draftItems.filter((i) => i.product_id && i.qty > 0)
    if (!valid.length) { alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ'); return }
    const ids = valid.map((i) => i.product_id)
    if (new Set(ids).size !== ids.length) { alert('พบรายการสินค้าซ้ำ กรุณาตรวจสอบอีกครั้ง'); return }
    setSaving(true)
    try {
      await createPR({
        items: valid.map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          unit: i.unit,
          estimated_price: i.estimated_price,
          note: i.note || undefined,
        })),
        note: note.trim(),
        userId: user?.id,
        prType,
      })
      setDraftItems([{ product_id: '', qty: 1, unit: 'ชิ้น', estimated_price: null, note: '' }])
      setNote('')
      setPrType('normal')
      closeCreate()
      await loadAll()
    } catch (e: any) {
      alert('สร้าง PR ไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  /* ── View Detail ── */
  async function openDetail(pr: InventoryPR) {
    setViewing(pr)
    setDetailLoading(true)
    try {
      const detail = await loadPRDetail(pr.id)
      setViewing(detail)
      setViewItems(detail.inv_pr_items || [])
    } catch (e) {
      console.error(e)
    } finally {
      setDetailLoading(false)
    }
  }

  /* ── Approve / Reject ── */
  async function handleApprove() {
    if (!viewing) return
    setUpdating(true)
    try {
      await approvePR(viewing.id, user?.id || '')
      setViewing(null)
      await loadAll()
    } catch (e: any) {
      alert('อนุมัติไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(false)
    }
  }

  async function handleReject() {
    if (!viewing || !rejectReason.trim()) { alert('กรุณาระบุเหตุผล'); return }
    setUpdating(true)
    try {
      await rejectPR(viewing.id, user?.id || '', rejectReason.trim())
      setRejectOpen(false)
      setRejectReason('')
      setViewing(null)
      await loadAll()
    } catch (e: any) {
      alert('ปฏิเสธไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setUpdating(false)
    }
  }

  const statusTabs = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: 'pending', label: 'รออนุมัติ' },
    { key: 'approved', label: 'อนุมัติแล้ว' },
    { key: 'rejected', label: 'ไม่อนุมัติ' },
  ]

  return (
    <div className="space-y-4 mt-12">
      {/* ── Filter Bar ── */}
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* status tabs */}
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {statusTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setStatusFilter(t.key)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                  statusFilter === t.key ? 'bg-white shadow text-emerald-700' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* search */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="ค้นหาเลขที่ PR..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* ── PR List ── */}
      <div className="bg-white rounded-xl shadow-sm border">
        {loading ? (
          <div className="flex justify-center items-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
          </div>
        ) : prs.length === 0 ? (
          <div className="text-center py-16 text-gray-400">ไม่พบรายการ PR</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">เลขที่ PR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ประเภท PR</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">วันที่สร้าง</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">ผู้สร้าง</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">จำนวนรายการ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">หัวข้อขอซื้อ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">สถานะ</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {prs.map((pr) => {
                  const st = STATUS_MAP[pr.status] || { label: pr.status, color: 'bg-gray-100 text-gray-700' }
                  const isUrgent = pr.pr_type === 'urgent'
                  return (
                    <tr key={pr.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{pr.pr_no}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${isUrgent ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>
                          {isUrgent ? 'ด่วน' : 'ปกติ'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {pr.requested_at ? new Date(pr.requested_at).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{pr.requested_by ? userMap[pr.requested_by] || '-' : '-'}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{(pr as any)._itemCount || '-'}</td>
                      <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">{pr.note || '-'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openDetail(pr)}
                          className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 text-xs font-semibold transition-colors"
                        >
                          ดูรายละเอียด
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create PR Full-Screen ── */}
      {createOpen && (
        <div className="fixed right-0 bottom-0 z-50 flex flex-col bg-white" style={{ left: 'var(--content-offset-left, 16rem)', top: 'calc(4rem + var(--subnav-height, 0rem))' }}>
          {/* Search + Filters */}
          <div className="px-6 pt-5 pb-3 border-b bg-gray-50 shrink-0 space-y-2">
            <div className="flex gap-3 items-center">
              <div className="flex-1">
                <input
                  type="text"
                  placeholder="ค้นหาสินค้า... (รหัส, ชื่อ, ชื่อจีน, ผู้จัดจำหน่าย)"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <button
                onClick={loadReorderPointItems}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 text-sm font-semibold whitespace-nowrap transition-colors flex items-center gap-2"
              >
                <i className="fas fa-exclamation-triangle"></i>
                ดึงข้อมูลจากจุดสั่งซื้อ
              </button>
              <button onClick={closeCreate} className="w-9 h-9 flex items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-300 transition-colors shrink-0" title="ปิด">
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="flex gap-3">
              <select
                value={filterType}
                onChange={(e) => { setFilterType(e.target.value); setFilterCategory('') }}
                className="px-3 py-1.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">ประเภท: ทั้งหมด</option>
                {uniqueTypes.map((t) => (
                  <option key={t} value={t!}>{t === 'FG' ? 'FG (สินค้าสำเร็จรูป)' : t === 'RM' ? 'RM (วัตถุดิบ)' : t}</option>
                ))}
              </select>
              <select
                value={filterSeller}
                onChange={(e) => setFilterSeller(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">ผู้ขาย: ทั้งหมด</option>
                {uniqueSellers.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-3 py-1.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">หมวดหมู่: ทั้งหมด</option>
                {uniqueCategories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {(filterType || filterSeller || filterCategory) && (
                <button
                  onClick={() => { setFilterType(''); setFilterSeller(''); setFilterCategory('') }}
                  className="px-3 py-1.5 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg transition-colors"
                >
                  ล้างตัวกรอง
                </button>
              )}
            </div>
          </div>

          {/* Main content — two columns */}
          <div className="flex-1 flex overflow-hidden min-h-0">
            {/* Left: Draft items */}
            <div className={`flex-1 overflow-y-auto p-6 transition-all ${supplierPanelSeller ? 'w-1/2' : 'w-full'}`}>
              <div className="space-y-3">
                {draftItems.map((item, index) => {
                  const prod = item.product_id ? productMap.get(item.product_id) : null
                  const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                  return (
                    <div key={`draft-${index}`} className={`border rounded-lg p-3 transition-colors ${supplierPanelIndex === index ? 'bg-emerald-50 border-emerald-300' : 'bg-gray-50/50'}`}>
                      <div className="flex gap-3">
                        {/* item number */}
                        <div className="w-7 text-center text-sm font-bold text-gray-400 pt-5 shrink-0">{index + 1}</div>
                        {/* product image */}
                        {imgUrl ? (
                          <ZoomImage src={imgUrl} />
                        ) : (
                          <div className="w-16 h-16 rounded-lg bg-gray-200 overflow-hidden flex-shrink-0">
                            <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">ไม่มีรูป</div>
                          </div>
                        )}

                        <div className="flex-1 space-y-2 min-w-0">
                          {/* product select + supplier button */}
                          <div className="flex gap-2">
                            <select
                              value={item.product_id}
                              onChange={(e) => onSelectProduct(index, e.target.value)}
                              className="flex-1 px-3 py-2 border rounded-lg bg-white text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                            >
                              <option value="">เลือกสินค้า</option>
                              {filteredProducts
                                .filter((p) => p.id === item.product_id || !draftItems.some((d, di) => di !== index && d.product_id === p.id))
                                .map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.product_code} - {p.product_name}
                                    {p.seller_name ? ` (${p.seller_name})` : ''}
                                  </option>
                                ))}
                            </select>
                            {item.product_id && prod?.seller_name && (
                              <button
                                onClick={() => handleViewSupplier(index)}
                                className={`px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                                  supplierPanelIndex === index
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                }`}
                              >
                                <i className="fas fa-store mr-1"></i>
                                ดูรายการผู้ขาย
                              </button>
                            )}
                          </div>

                          {/* product info */}
                          {prod && (
                            <div className="text-xs text-gray-500 flex flex-wrap gap-x-4">
                              {prod.product_name_cn && <span>ชื่อจีน: {prod.product_name_cn}</span>}
                              {prod.seller_name && <span>ผู้จัดจำหน่าย: {prod.seller_name}</span>}
                              {prod.product_category && <span>หมวด: {prod.product_category}</span>}
                              {canSeePrice && prod.last_price != null && (
                                <span className="text-blue-600 font-medium">ราคาซื้อล่าสุด: {Number(prod.last_price).toLocaleString()} บาท</span>
                              )}
                              <span className="text-orange-600 font-medium">
                                คงเหลือ: {(stockBalances[prod.id] ?? 0).toLocaleString()}
                              </span>
                            </div>
                          )}

                          {/* qty / unit / price */}
                          <div className={`grid gap-2 ${canSeePrice ? 'grid-cols-4' : 'grid-cols-3'}`}>
                            <div>
                              <label className="block text-xs text-gray-500 mb-0.5">จำนวน</label>
                              <input
                                type="number"
                                min={1}
                                value={item.qty}
                                onChange={(e) => updateDraftItem(index, { qty: Number(e.target.value) || 1 })}
                                className="w-full px-2 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-gray-500 mb-0.5">หน่วย</label>
                              <input
                                type="text"
                                value={item.unit}
                                onChange={(e) => updateDraftItem(index, { unit: e.target.value })}
                                className="w-full px-2 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                                placeholder="ชิ้น"
                              />
                            </div>
                            {canSeePrice && (
                              <div>
                                <label className="block text-xs text-gray-500 mb-0.5">ราคาประเมิน</label>
                                <input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={item.estimated_price ?? ''}
                                  onChange={(e) => updateDraftItem(index, { estimated_price: e.target.value ? Number(e.target.value) : null })}
                                  className="w-full px-2 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                                  placeholder="0.00"
                                />
                              </div>
                            )}
                            <div className="flex items-end">
                              <button
                                onClick={() => removeDraftItem(index)}
                                disabled={draftItems.length === 1}
                                className="w-full px-2 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 text-sm disabled:opacity-30 transition-colors"
                              >
                                ลบ
                              </button>
                            </div>
                          </div>

                          {/* item note */}
                          <div>
                            <input
                              type="text"
                              value={item.note}
                              onChange={(e) => updateDraftItem(index, { note: e.target.value })}
                              className="w-full px-2 py-1.5 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none"
                              placeholder="หมายเหตุรายการ (ถ้ามี)"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button onClick={addDraftItem} className="mt-3 px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg hover:border-emerald-400 hover:text-emerald-600 text-sm text-gray-500 w-full transition-colors">
                + เพิ่มรายการสินค้า
              </button>

              {/* pr type + note */}
              <div className="mt-4 space-y-3">
                <div className="flex gap-4 items-center">
                  <label className="text-sm font-medium text-gray-700">ประเภท PR:</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPrType('normal')}
                      className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${prType === 'normal' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >
                      ปกติ
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrType('urgent')}
                      className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${prType === 'urgent' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    >
                      ด่วน
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    หัวข้อขอซื้อ <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 focus:outline-none ${!note.trim() ? 'border-red-300' : ''}`}
                    rows={2}
                    placeholder="ระบุหัวข้อขอซื้อ (บังคับ)"
                    required
                  />
                </div>
              </div>
            </div>

            {/* Right: Supplier products panel */}
            {supplierPanelSeller && (
              <div className="w-[480px] border-l overflow-y-auto bg-gray-50 shrink-0 flex flex-col">
                <div className="px-4 py-3 border-b bg-blue-600 text-white flex items-center justify-between shrink-0">
                  <div>
                    <h3 className="text-sm font-bold">รายการสินค้าของ: {supplierPanelSeller}</h3>
                    <p className="text-xs text-blue-200">{supplierProducts.length} รายการ</p>
                  </div>
                  <button onClick={closeSupplierPanel} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/20 transition-all">
                    <i className="fas fa-times"></i>
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {supplierProducts.length === 0 ? (
                    <div className="text-center py-8 text-gray-400 text-sm">ไม่พบรายการสินค้า</div>
                  ) : (
                    supplierProducts.map((p) => {
                      const stock = stockBalances[p.id] ?? 0
                      const imgUrl = getPublicUrl('product-images', p.product_code)
                      const alreadyAdded = draftItems.some((d) => d.product_id === p.id)
                      return (
                        <div key={p.id} className="flex items-center gap-3 p-3 bg-white rounded-lg border hover:border-blue-300 transition-colors">
                          {imgUrl ? (
                            <ZoomImage src={imgUrl} />
                          ) : (
                            <div className="w-16 h-16 rounded-lg bg-gray-200 overflow-hidden flex-shrink-0">
                              <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-gray-900 text-sm truncate">{p.product_code}</div>
                            <div className="text-xs text-gray-500 truncate">{p.product_name}</div>
                            <div className="flex gap-3 mt-0.5">
                              <span className={`text-xs font-semibold ${stock > 0 ? 'text-green-600' : 'text-red-500'}`}>
                                คงเหลือ: {stock.toLocaleString()}
                              </span>
                              {p.product_category && <span className="text-xs text-gray-400">{p.product_category}</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => addSupplierProduct(p.id)}
                            disabled={alreadyAdded}
                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shrink-0 ${
                              alreadyAdded
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            }`}
                          >
                            <i className={`fas ${alreadyAdded ? 'fa-check' : 'fa-plus'} mr-1`}></i>
                            {alreadyAdded ? 'เพิ่มแล้ว' : 'เพิ่ม'}
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="px-6 py-3 border-t bg-white flex justify-between items-center shrink-0">
            <div className="text-sm text-gray-500">
              รายการทั้งหมด: <span className="font-bold text-gray-800">{draftItems.filter((i) => i.product_id).length}</span> รายการ
            </div>
            <div className="flex gap-3">
              <button onClick={closeCreate} className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium transition-colors">
                ยกเลิก
              </button>
              <button onClick={handleCreatePR} disabled={saving} className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm font-semibold transition-colors">
                {saving ? 'กำลังบันทึก...' : 'บันทึก PR'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Detail Modal ── */}
      <Modal open={!!viewing} onClose={() => { setViewing(null); setRejectOpen(false) }} contentClassName="max-w-6xl">
        <div className="p-6 space-y-5">
          {detailLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500" />
            </div>
          ) : viewing ? (
            <>
              {/* header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">รายละเอียด PR</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    เลขที่: <span className="font-semibold text-gray-800">{viewing.pr_no}</span>
                  </p>
                </div>
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${(STATUS_MAP[viewing.status] || { color: 'bg-gray-100 text-gray-700' }).color}`}>
                  {(STATUS_MAP[viewing.status] || { label: viewing.status }).label}
                </span>
              </div>

              {/* meta */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">วันที่สร้าง</div>
                  <div className="font-medium">{viewing.requested_at ? new Date(viewing.requested_at).toLocaleString('th-TH') : '-'}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">ประเภท PR</div>
                  <div className="font-medium">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${viewing.pr_type === 'urgent' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>
                      {viewing.pr_type === 'urgent' ? 'ด่วน' : 'ปกติ'}
                    </span>
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-gray-500 text-xs">จำนวนรายการ</div>
                  <div className="font-medium">{viewItems.length} รายการ</div>
                </div>
                {viewing.approved_at && (
                  <div className="bg-green-50 rounded-lg p-3">
                    <div className="text-green-600 text-xs">วันที่อนุมัติ</div>
                    <div className="font-medium text-green-800">{new Date(viewing.approved_at).toLocaleString('th-TH')}</div>
                  </div>
                )}
                {viewing.rejected_at && (
                  <div className="bg-red-50 rounded-lg p-3">
                    <div className="text-red-600 text-xs">ไม่อนุมัติ</div>
                    <div className="font-medium text-red-800">{viewing.rejection_reason || '-'}</div>
                  </div>
                )}
              </div>

              {viewing.note && (
                <div className="bg-blue-50 rounded-lg p-3 text-sm">
                  <span className="text-blue-600 font-medium">หัวข้อขอซื้อ:</span> {viewing.note}
                </div>
              )}

              {/* items table */}
              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600 w-14">รูป</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">สินค้า</th>
                      <th className="px-3 py-2.5 text-right font-semibold text-gray-600">จำนวน</th>
                      {canSeePrice && (
                        <>
                          <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ราคาซื้อล่าสุด</th>
                          <th className="px-3 py-2.5 text-right font-semibold text-gray-600">ราคาประเมิน</th>
                        </>
                      )}
                      <th className="px-3 py-2.5 text-left font-semibold text-gray-600">หมายเหตุ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {viewItems.map((item: any) => {
                      const prod = item.pr_products
                      const imgUrl = prod ? getPublicUrl('product-images', prod.product_code) : ''
                      return (
                        <tr key={item.id} className="hover:bg-gray-50/50">
                          <td className="px-3 py-2">
                            <div className="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                              {imgUrl ? (
                                <img src={imgUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-400 text-[10px]">-</div>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-900">{prod?.product_code} - {prod?.product_name}</div>
                            <div className="text-xs text-gray-500 flex gap-3 mt-0.5">
                              {prod?.product_name_cn && <span>{prod.product_name_cn}</span>}
                              {prod?.seller_name && <span>ผู้จัดจำหน่าย: {prod.seller_name}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-medium">
                            {Number(item.qty).toLocaleString()} {item.unit || ''}
                          </td>
                          {canSeePrice && (
                            <>
                              <td className="px-3 py-2 text-right text-blue-600">
                                {item.last_purchase_price != null ? Number(item.last_purchase_price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                              </td>
                              <td className="px-3 py-2 text-right">
                                {item.estimated_price != null ? Number(item.estimated_price).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '-'}
                              </td>
                            </>
                          )}
                          <td className="px-3 py-2 text-gray-500 max-w-[160px] truncate">
                            {item.note || '-'}
                          </td>
                        </tr>
                      )
                    })}
                    {!viewItems.length && (
                      <tr><td colSpan={canSeePrice ? 6 : 4} className="px-3 py-8 text-center text-gray-400">ไม่มีรายการ</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* actions */}
              <div className="flex justify-end gap-3 pt-3 border-t">
                {canApprove && viewing.status === 'pending' && !rejectOpen && (
                  <>
                    <button
                      onClick={() => setRejectOpen(true)}
                      disabled={updating}
                      className="px-5 py-2.5 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 text-sm font-semibold disabled:opacity-50 transition-colors"
                    >
                      ไม่อนุมัติ
                    </button>
                    <button
                      onClick={handleApprove}
                      disabled={updating}
                      className="px-5 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-semibold disabled:opacity-50 transition-colors"
                    >
                      {updating ? 'กำลังดำเนินการ...' : 'อนุมัติ'}
                    </button>
                  </>
                )}
                {rejectOpen && (
                  <div className="flex-1 flex gap-2 items-end">
                    <div className="flex-1">
                      <label className="block text-xs text-gray-500 mb-1">เหตุผลที่ไม่อนุมัติ</label>
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none"
                        placeholder="ระบุเหตุผล..."
                        autoFocus
                      />
                    </div>
                    <button
                      onClick={() => { setRejectOpen(false); setRejectReason('') }}
                      className="px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
                    >
                      ยกเลิก
                    </button>
                    <button
                      onClick={handleReject}
                      disabled={updating}
                      className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-semibold disabled:opacity-50"
                    >
                      ยืนยัน
                    </button>
                  </div>
                )}
                <button
                  onClick={() => { setViewing(null); setRejectOpen(false) }}
                  className="px-5 py-2.5 border rounded-lg hover:bg-gray-50 text-sm font-medium"
                >
                  ปิด
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
