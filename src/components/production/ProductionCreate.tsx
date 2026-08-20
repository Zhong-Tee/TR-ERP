import { useEffect, useMemo, useState, useCallback } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchPPProducts,
  calcProducibleQtyBatch,
  fetchProductionOrders,
  fetchProductionOrderItems,
  createProductionOrder,
  updateProductionOrder,
  submitForApproval,
  approveOrder,
  rejectOrder,
  startProductionOrder,
  completeProductionOrder,
  fetchFgRmProducts,
  fetchRecipe,
  fetchRecipeProductIds,
  validateProductionItems,
} from '../../lib/productionApi'
import type { Product, PpProductionOrder, PpProductionOrderItem } from '../../types'
import ProductImageHover from '../ui/ProductImageHover'
import Modal from '../ui/Modal'

type TabKey = 'pp' | 'pending' | 'approved' | 'processing' | 'completed' | 'rejected'

interface PPProductRow extends Product {
  on_hand: number
  producible_qty?: number
  min_stock: number | null
  max_stock: number | null
}

interface DraftItem {
  key: string
  product_id: string
  product_code: string
  product_name: string
  qty: number
  max_qty: number
  warnings: string[]
  requirements: { product_code: string; product_name: string; qty_per_unit: number; needed: number; on_hand: number }[]
}

interface ViewRmItem {
  product_id: string
  product_code: string
  product_name: string
  qty_per_unit: number
  total_qty: number
}

const formatQty = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function ProductionCreate() {
  const { user } = useAuthContext()
  const [activeTab, setActiveTab] = useState<TabKey>('pp')
  const [loading, setLoading] = useState(false)

  // PP products tab
  const [ppProducts, setPpProducts] = useState<PPProductRow[]>([])
  const [producibleMap, setProducibleMap] = useState<Record<string, number>>({})
  const [warningOnly, setWarningOnly] = useState(false)

  // Orders tabs
  const [orders, setOrders] = useState<PpProductionOrder[]>([])

  // Full-screen create/edit
  const [createOpen, setCreateOpen] = useState(false)
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [docNo, setDocNo] = useState('')
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [draftItems, setDraftItems] = useState<DraftItem[]>([])
  const [saving, setSaving] = useState(false)

  // PP products for add-to-draft dropdown
  const [allPPProducts, setAllPPProducts] = useState<PPProductRow[]>([])
  const [fgRmProducts, setFgRmProducts] = useState<Product[]>([])
  const [recipeProductIds, setRecipeProductIds] = useState<Set<string>>(new Set())

  // View detail modal
  const [viewingOrder, setViewingOrder] = useState<PpProductionOrder | null>(null)
  const [viewItems, setViewItems] = useState<PpProductionOrderItem[]>([])
  const [viewRmItems, setViewRmItems] = useState<ViewRmItem[]>([])

  // Reject modal
  const [rejectModal, setRejectModal] = useState<PpProductionOrder | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  // Notification
  const [notifyModal, setNotifyModal] = useState<{ open: boolean; type: 'success' | 'error'; title: string; message: string }>({
    open: false, type: 'success', title: '', message: '',
  })

  const canApprove = ['superadmin', 'admin', 'store'].includes(user?.role || '')
  const canCreate = ['superadmin', 'admin', 'store', 'production'].includes(user?.role || '')
  const canProcess = ['superadmin', 'admin', 'production'].includes(user?.role || '')
  const canViewCosts = !['store', 'production'].includes(user?.role || '')

  const tabs: { key: TabKey; label: string; color: string; activeColor: string }[] = [
    { key: 'pp', label: 'สินค้าPP', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-indigo-600 text-white' },
    { key: 'pending', label: 'รออนุมัติ', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-yellow-500 text-white' },
    { key: 'approved', label: 'อนุมัติแล้ว', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-green-600 text-white' },
    { key: 'processing', label: 'รอแปรรูป', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-blue-600 text-white' },
    { key: 'completed', label: 'แปรรูปสำเร็จ', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-emerald-600 text-white' },
    { key: 'rejected', label: 'ปฏิเสธ', color: 'bg-white text-gray-600 border border-gray-200', activeColor: 'bg-red-500 text-white' },
  ]

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { pp: ppProducts.length, pending: 0, approved: 0, processing: 0, completed: 0, rejected: 0 }
    orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1 })
    counts.processing = (counts.approved || 0) + (counts.processing || 0)
    return counts
  }, [ppProducts, orders])

  // ── Load data ──────────────────────────────────────────────

  const loadPPProducts = useCallback(async () => {
    setLoading(true)
    try {
      const [data, recipeIds] = await Promise.all([
        fetchPPProducts(),
        fetchRecipeProductIds(),
      ])
      setPpProducts(data as PPProductRow[])
      setAllPPProducts(data as PPProductRow[])
      setRecipeProductIds(new Set(recipeIds))

      const qtyMap = await calcProducibleQtyBatch(data.map((p: PPProductRow) => p.id))
      setProducibleMap(qtyMap)
    } catch (err) {
      console.error('loadPPProducts error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadOrders = useCallback(async () => {
    try {
      const data = await fetchProductionOrders()
      setOrders(data)
    } catch (err) {
      console.error('loadOrders error:', err)
    }
  }, [])

  useEffect(() => {
    loadPPProducts()
    loadOrders()
    fetchFgRmProducts().then(setFgRmProducts).catch(console.error)
  }, [loadPPProducts, loadOrders])

  // ── Filtered orders by tab ─────────────────────────────────

  const filteredOrders = useMemo(() => {
    if (activeTab === 'pp') return []
    if (activeTab === 'processing') return orders.filter((o) => o.status === 'approved' || o.status === 'processing')
    return orders.filter((o) => o.status === activeTab)
  }, [orders, activeTab])

  const displayedPPProducts = useMemo(
    () => warningOnly
      ? ppProducts.filter((p) => p.min_stock != null && p.on_hand < p.min_stock)
      : ppProducts,
    [ppProducts, warningOnly]
  )

  const maxCreatableQty = useCallback((product: PPProductRow) => {
    const materialLimit = producibleMap[product.id] ?? 0
    if (product.max_stock == null) return materialLimit
    return Math.max(0, Math.min(materialLimit, product.max_stock - product.on_hand))
  }, [producibleMap])

  // ── Create/Edit helpers ────────────────────────────────────

  const generateDocNo = () => {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `PP-${y}${m}${day}-001`
  }

  const openCreateForm = () => {
    if (!canCreate) return
    setEditingOrderId(null)
    setDocNo(generateDocNo())
    setTitle('')
    setNote('')
    setProductSearch('')
    setDraftItems([])
    setCreateOpen(true)
  }

  const getRequirements = async (productId: string, qty: number) => {
    const recipeData = await fetchRecipe(productId)
    if (!recipeData) return { requirements: [], warnings: [] }
    const requirements = recipeData.includes.map((inc) => {
      const prod = fgRmProducts.find((p) => p.id === inc.product_id)
      const onHand = Number((prod as Product & { on_hand?: number })?.on_hand) || 0
      return {
        product_code: prod?.product_code || inc.product?.product_code || inc.product_id,
        product_name: prod?.product_name || inc.product?.product_name || '',
        qty_per_unit: inc.qty,
        needed: inc.qty * qty,
        on_hand: onHand,
      }
    })
    return {
      requirements,
      warnings: requirements
        .filter((r) => r.on_hand < r.needed)
        .map((r) => `${r.product_code} ต้องการ ${formatQty(r.needed)} คงเหลือ ${formatQty(r.on_hand)}`),
    }
  }

  const addDraftItem = async (productId: string) => {
    const product = allPPProducts.find((p) => p.id === productId)
    if (!product) return
    if (draftItems.some((d) => d.product_id === productId)) return

    const requirementData = await getRequirements(product.id, 1)

    setDraftItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        product_id: product.id,
        product_code: product.product_code,
        product_name: product.product_name,
        qty: 1,
        max_qty: maxCreatableQty(product),
        warnings: requirementData.warnings,
        requirements: requirementData.requirements,
      },
    ])
  }

  const updateDraftQty = async (key: string, rawQty: number) => {
    const item = draftItems.find((d) => d.key === key)
    if (!item) return

    const qty = item.max_qty > 0 ? Math.min(rawQty, item.max_qty) : rawQty

    setDraftItems((prev) =>
      prev.map((d) => {
        if (d.key !== key) return d
        return { ...d, qty, warnings: [] }
      })
    )

    try {
      const requirementData = await getRequirements(item.product_id, qty)
      setDraftItems((prev) =>
        prev.map((d) => (d.key === key ? { ...d, ...requirementData } : d))
      )
    } catch { /* ignore */ }
  }

  const removeDraftItem = (key: string) => {
    setDraftItems((prev) => prev.filter((d) => d.key !== key))
  }

  const handleSave = async () => {
    if (!title.trim()) {
      setNotifyModal({ open: true, type: 'error', title: 'ผิดพลาด', message: 'กรุณากรอกหัวข้อแปรรูป' })
      return
    }
    if (draftItems.length === 0) {
      setNotifyModal({ open: true, type: 'error', title: 'ผิดพลาด', message: 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ' })
      return
    }

    const overItems = draftItems.filter((d) => d.max_qty > 0 && d.qty > d.max_qty)
    if (overItems.length > 0) {
      const names = overItems.map((d) => `${d.product_code} (สูงสุด ${d.max_qty})`).join(', ')
      setNotifyModal({ open: true, type: 'error', title: 'จำนวนเกินที่แปรรูปได้', message: `กรุณาลดจำนวน: ${names}` })
      return
    }

    const zeroMaxItems = draftItems.filter((d) => d.max_qty <= 0)
    if (zeroMaxItems.length > 0) {
      const names = zeroMaxItems.map((d) => d.product_code).join(', ')
      setNotifyModal({ open: true, type: 'error', title: 'ไม่สามารถแปรรูปได้', message: `วัตถุดิบไม่เพียงพอ: ${names}` })
      return
    }

    const hasWarnings = draftItems.some((d) => d.warnings.length > 0)
    if (hasWarnings) {
      const allWarnings = draftItems.flatMap((d) => d.warnings)
      setNotifyModal({ open: true, type: 'error', title: 'วัตถุดิบไม่เพียงพอ', message: allWarnings.join('\n') })
      return
    }

    setSaving(true)
    try {
      const items = draftItems.map((d) => ({ product_id: d.product_id, qty: d.qty }))

      const validation = await validateProductionItems(items)
      if (!validation.valid) {
        setNotifyModal({
          open: true,
          type: 'error',
          title: 'วัตถุดิบไม่เพียงพอ',
          message: validation.errors.join('\n'),
        })
        setSaving(false)
        return
      }

      let orderId: string
      if (editingOrderId) {
        await updateProductionOrder(editingOrderId, title, note, items)
        orderId = editingOrderId
      } else {
        const result = await createProductionOrder(title, note, items, user!.id)
        orderId = result.id
      }

      await submitForApproval(orderId)

      setCreateOpen(false)
      setNotifyModal({ open: true, type: 'success', title: 'สำเร็จ', message: 'สร้างและส่งอนุมัติใบแปรรูปเรียบร้อย' })
      loadOrders()
      loadPPProducts()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาด'
      setNotifyModal({ open: true, type: 'error', title: 'ผิดพลาด', message: msg })
    } finally {
      setSaving(false)
    }
  }

  // ── Actions ────────────────────────────────────────────────

  const handleApprove = async (order: PpProductionOrder) => {
    try {
      await approveOrder(order.id, user!.id)
      setNotifyModal({ open: true, type: 'success', title: 'อนุมัติสำเร็จ', message: `อนุมัติ ${order.doc_no} เรียบร้อย และส่งเข้าคิวรอแปรรูปแล้ว` })
      loadOrders()
      loadPPProducts()
      setViewingOrder(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาด'
      setNotifyModal({ open: true, type: 'error', title: 'ผิดพลาด', message: msg })
    }
  }

  const handleReject = async () => {
    if (!rejectModal) return
    try {
      await rejectOrder(rejectModal.id, user!.id, rejectReason)
      setNotifyModal({ open: true, type: 'success', title: 'ปฏิเสธสำเร็จ', message: `ปฏิเสธ ${rejectModal.doc_no} เรียบร้อย` })
      setRejectModal(null)
      setRejectReason('')
      loadOrders()
      setViewingOrder(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'เกิดข้อผิดพลาด'
      setNotifyModal({ open: true, type: 'error', title: 'ผิดพลาด', message: msg })
    }
  }

  const handleStartProduction = async (order: PpProductionOrder) => {
    try {
      await startProductionOrder(order.id)
      setNotifyModal({ open: true, type: 'success', title: 'เริ่มแปรรูปแล้ว', message: `${order.doc_no} อยู่ระหว่างการแปรรูป` })
      loadOrders()
    } catch (err: unknown) {
      setNotifyModal({ open: true, type: 'error', title: 'ไม่สามารถเริ่มงานได้', message: err instanceof Error ? err.message : 'เกิดข้อผิดพลาด' })
    }
  }

  const handleCompleteProduction = async (order: PpProductionOrder) => {
    if (!confirm(`ยืนยันว่าแปรรูป ${order.doc_no} สำเร็จแล้ว? ระบบจะอัปเดตสต๊อกหลังยืนยัน`)) return
    try {
      await completeProductionOrder(order.id)
      setNotifyModal({ open: true, type: 'success', title: 'แปรรูปสำเร็จ', message: `${order.doc_no} เสร็จสมบูรณ์และอัปเดตสต๊อกแล้ว` })
      loadOrders()
      loadPPProducts()
    } catch (err: unknown) {
      setNotifyModal({ open: true, type: 'error', title: 'ไม่สามารถจบงานได้', message: err instanceof Error ? err.message : 'เกิดข้อผิดพลาด' })
    }
  }

  const viewDetail = async (order: PpProductionOrder) => {
    setViewingOrder(order)
    setViewRmItems([])
    try {
      const items = await fetchProductionOrderItems(order.id)
      setViewItems(items)
      const recipes = await Promise.all(items.map((item) => fetchRecipe(item.product_id)))
      const rmMap = new Map<string, ViewRmItem>()
      recipes.forEach((recipe, index) => {
        if (!recipe) return
        const ppQty = items[index].qty
        recipe.includes
          .filter((inc) => inc.product?.product_type === 'RM')
          .forEach((inc) => {
            const existing = rmMap.get(inc.product_id)
            const totalQty = inc.qty * ppQty
            if (existing) existing.total_qty += totalQty
            else rmMap.set(inc.product_id, {
              product_id: inc.product_id,
              product_code: inc.product?.product_code || inc.product_id,
              product_name: inc.product?.product_name || '-',
              qty_per_unit: inc.qty,
              total_qty: totalQty,
            })
          })
      })
      setViewRmItems([...rmMap.values()])
    } catch { setViewItems([]) }
  }

  const formatDate = (d: string) => {
    const dt = new Date(d)
    return dt.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + dt.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  }

  const statusLabel = (s: string) => {
    const map: Record<string, string> = { open: 'เปิด', pending: 'รออนุมัติ', approved: 'รอแปรรูป', processing: 'กำลังทำ', completed: 'แปรรูปสำเร็จ', rejected: 'ปฏิเสธ' }
    return map[s] || s
  }

  const statusColor = (s: string) => {
    const map: Record<string, string> = {
      open: 'bg-blue-100 text-blue-700',
      pending: 'bg-yellow-100 text-yellow-700',
      approved: 'bg-green-100 text-green-700',
      processing: 'bg-blue-100 text-blue-700',
      completed: 'bg-emerald-100 text-emerald-700',
      rejected: 'bg-red-100 text-red-700',
    }
    return map[s] || 'bg-gray-100 text-gray-700'
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-2">
        <div className="flex flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-5 py-3 border-b-2 text-base font-semibold transition-colors ${activeTab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
          >
            {t.label}
            {tabCounts[t.key] > 0 && (
              <span className="ml-2 px-2.5 py-0.5 rounded-full text-sm bg-white bg-opacity-30">{tabCounts[t.key]}</span>
            )}
          </button>
        ))}
        </div>
        {canCreate && <button onClick={openCreateForm} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-base font-semibold hover:bg-blue-700">
          <i className="fas fa-plus mr-2"></i>สร้างใบแปรรูป
        </button>}
      </div>

      {/* Tab Content */}
      <div className="bg-white p-6 rounded-lg shadow">
        {/* ── สินค้า PP ── */}
        {activeTab === 'pp' && (
          <>
            <div className="flex justify-end mb-4">
              <button onClick={() => setWarningOnly((v) => !v)}
                className={`px-4 py-2 rounded-lg border font-semibold ${warningOnly ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-700 border-amber-300'}`}>
                <i className="fas fa-exclamation-triangle mr-2"></i>รายการเตือน
              </button>
            </div>
            {loading ? (
              <div className="text-center py-12 text-gray-400 text-base">กำลังโหลด...</div>
            ) : ppProducts.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-base">ยังไม่มีสินค้าแปรรูป (PP) — กรุณาตั้งค่าหมวด PP ในสินค้าก่อน</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-base">
                  <thead>
                    <tr className="bg-indigo-600 text-white">
                      <th className="px-5 py-3.5 text-left rounded-tl-xl">รูปภาพ</th>
                      <th className="px-5 py-3.5 text-left">รหัสสินค้า</th>
                      <th className="px-5 py-3.5 text-left">ชื่อสินค้า</th>
                      <th className="px-5 py-3.5 text-right">คงเหลือ</th>
                      <th className="px-5 py-3.5 text-right">จุดเตือนผลิต</th>
                      <th className="px-5 py-3.5 text-right rounded-tr-xl">แปรรูปได้</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedPPProducts.map((p, i) => {
                      const warning = p.min_stock != null && p.on_hand < p.min_stock
                      return <tr key={p.id} className={`${warning ? 'bg-amber-50' : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-indigo-50 transition`}>
                        <td className="px-5 py-3">
                          <ProductImageHover productCode={p.product_code} productName={p.product_name} size="sm" />
                        </td>
                        <td className="px-5 py-3 font-mono text-sm">{p.product_code}</td>
                        <td className="px-5 py-3">{p.product_name}</td>
                        <td className="px-5 py-3 text-right font-semibold">{p.on_hand}</td>
                        <td className={`px-5 py-3 text-right font-semibold ${warning ? 'text-amber-700' : 'text-gray-500'}`}>
                          {p.min_stock ?? '-'}{warning && <i className="fas fa-exclamation-triangle ml-2"></i>}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold text-indigo-600">{maxCreatableQty(p)}</td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── รออนุมัติ / อนุมัติแล้ว / ปฏิเสธ ── */}
        {(activeTab === 'pending' || activeTab === 'approved' || activeTab === 'processing' || activeTab === 'completed' || activeTab === 'rejected') && (
          <>
            <h3 className="text-xl font-bold text-gray-700 mb-5">
              {activeTab === 'pending' && 'รายการรออนุมัติ'}
              {activeTab === 'approved' && 'รายการอนุมัติแล้ว'}
              {activeTab === 'processing' && 'รายการรอแปรรูป / กำลังทำ'}
              {activeTab === 'completed' && 'รายการแปรรูปสำเร็จ'}
              {activeTab === 'rejected' && 'รายการปฏิเสธ'}
            </h3>
            {filteredOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-base">ไม่มีรายการ</div>
            ) : (
              <OrderTable
                orders={filteredOrders}
                canApprove={canApprove}
                canProcess={canProcess}
                onView={viewDetail}
                onApprove={handleApprove}
                onReject={(o) => { setRejectModal(o); setRejectReason('') }}
                onStart={handleStartProduction}
                onComplete={handleCompleteProduction}
                formatDate={formatDate}
                statusLabel={statusLabel}
                statusColor={statusColor}
                showActions={activeTab}
              />
            )}
          </>
        )}
      </div>

      {/* ── Full-screen Create/Edit ── */}
      {createOpen && (
        <div
          className="fixed right-0 bottom-0 z-50 flex flex-col bg-white"
          style={{ left: 'var(--content-offset-left, 16rem)', top: 'calc(4rem + var(--subnav-height, 0rem))' }}
        >
          {/* Header */}
          <div className="px-6 pt-5 pb-4 border-b bg-gray-50 shrink-0">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-bold text-gray-800">
                {editingOrderId ? 'แก้ไขใบแปรรูป' : 'สร้างใบแปรรูป'}
              </h2>
              <button onClick={() => setCreateOpen(false)} className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-200 hover:bg-red-500 hover:text-white text-gray-500 text-xl transition-colors">
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-5">
              <div>
                <label className="text-sm text-gray-500 font-semibold">เลขที่เอกสาร</label>
                <div className="mt-1 px-4 py-2.5 bg-gray-100 rounded-lg text-base font-mono">{docNo}</div>
              </div>
              <div>
                <label className="text-sm text-gray-500 font-semibold">หัวข้อแปรรูป <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="เช่น แปรรูปกล่องดินสอ 5DAY"
                  className="mt-1 w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {/* Body - items */}
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {/* Add product */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
              <div>
                <label className="text-sm text-gray-500 font-semibold">ค้นหาสินค้า PP</label>
                <div className="relative mt-1">
                  <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="ค้นหาด้วยรหัสหรือชื่อสินค้า..."
                    className="w-full pl-10 pr-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-gray-500 font-semibold">เพิ่มสินค้า PP</label>
                <select
                  className="mt-1 w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  value=""
                  onChange={(e) => { if (e.target.value) { addDraftItem(e.target.value); setProductSearch('') } }}
                >
                  <option value="">-- เลือกสินค้า PP --</option>
                  {allPPProducts
                    .filter((p) => recipeProductIds.has(p.id) && (producibleMap[p.id] ?? 0) > 0 && !draftItems.some((d) => d.product_id === p.id))
                    .filter((p) => {
                      const search = productSearch.trim().toLowerCase()
                      return !search || p.product_code.toLowerCase().includes(search) || p.product_name.toLowerCase().includes(search)
                    })
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.product_code} - {p.product_name} (แปรรูปได้ {producibleMap[p.id] ?? 0})</option>
                    ))}
                </select>
              </div>
            </div>

            {/* Draft items table */}
            {draftItems.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-base">
                  <thead>
                    <tr className="bg-blue-600 text-white">
                      <th className="px-5 py-3 text-left rounded-tl-xl">รูป</th>
                      <th className="px-5 py-3 text-left">รหัส</th>
                      <th className="px-5 py-3 text-left">ชื่อสินค้า</th>
                      <th className="px-5 py-3 text-right">แปรรูปได้</th>
                      <th className="px-5 py-3 text-right">จำนวน</th>
                      <th className="px-5 py-3 text-center rounded-tr-xl">ลบ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftItems.map((d, i) => (
                      <tr key={d.key} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-5 py-3">
                          <ProductImageHover productCode={d.product_code} productName={d.product_name} size="sm" />
                        </td>
                        <td className="px-5 py-3 font-mono text-sm align-top">
                          <div>{d.product_code}</div>
                          {d.requirements.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-gray-200 space-y-1 text-xs text-blue-700">
                              {d.requirements.map((r) => <div key={r.product_code}>{r.product_code}</div>)}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div>{d.product_name}</div>
                          {d.requirements.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">
                              {d.requirements.map((r) => (
                                <div key={r.product_code} className="text-xs text-gray-600">
                                  {r.product_name || r.product_code} — ใช้ {formatQty(r.needed)} (คงเหลือ {formatQty(r.on_hand)})
                                </div>
                              ))}
                            </div>
                          )}
                          {d.warnings.length > 0 && (
                            <div className="mt-1">
                              {d.warnings.map((w, wi) => (
                                <div key={wi} className="text-sm text-red-500 flex items-center gap-1">
                                  <i className="fas fa-exclamation-triangle"></i> {w}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right text-indigo-600 font-semibold">{d.max_qty}</td>
                        <td className="px-5 py-3 text-right">
                          <input
                            type="number"
                            min={1}
                            max={d.max_qty > 0 ? d.max_qty : undefined}
                            value={d.qty}
                            onChange={(e) => updateDraftQty(d.key, Number(e.target.value) || 1)}
                            onWheel={(e) => e.currentTarget.blur()}
                            className={`w-28 px-3 py-1.5 border rounded text-right text-base focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${d.max_qty > 0 && d.qty > d.max_qty ? 'border-red-500 bg-red-50 text-red-700 focus:ring-2 focus:ring-red-500' : 'focus:ring-2 focus:ring-blue-500'}`}
                          />
                          {d.max_qty > 0 && d.qty > d.max_qty && (
                            <div className="text-sm text-red-500 mt-1">สูงสุด {d.max_qty}</div>
                          )}
                        </td>
                        <td className="px-5 py-3 text-center">
                          <button onClick={() => removeDraftItem(d.key)} className="text-red-400 hover:text-red-600 text-lg">
                            <i className="fas fa-trash"></i>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Note */}
            <div>
              <label className="text-sm text-gray-500 font-semibold">หมายเหตุ</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="mt-1 w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none"
                placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t bg-gray-50 shrink-0 flex justify-between items-center">
            <div className="text-base text-gray-500 font-medium">
              {draftItems.length} รายการ
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setCreateOpen(false)}
                className="px-6 py-2.5 bg-gray-200 text-gray-700 rounded-lg text-base font-semibold hover:bg-gray-300 transition"
              >
                ปิด
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2.5 bg-green-600 text-white rounded-lg text-base font-semibold hover:bg-green-700 transition disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึกและส่งอนุมัติ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── View Detail Modal ── */}
      {viewingOrder && (
        <Modal open onClose={() => setViewingOrder(null)} contentClassName="max-w-4xl" closeOnBackdropClick>
          <div className="p-6 space-y-5">
            <div className="flex justify-between items-start">
              <h2 className="text-xl font-bold text-gray-800">รายละเอียด {viewingOrder.doc_no}</h2>
              <button
                onClick={() => setViewingOrder(null)}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-200 hover:bg-red-500 hover:text-white text-gray-500 text-xl transition-colors shrink-0"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 text-base">
              <div><span className="text-gray-500">หัวข้อ:</span> <span className="font-semibold">{viewingOrder.title || '-'}</span></div>
              <div><span className="text-gray-500">สถานะ:</span> <span className={`px-3 py-1 rounded-full text-sm font-semibold ${statusColor(viewingOrder.status)}`}>{statusLabel(viewingOrder.status)}</span></div>
              <div><span className="text-gray-500">วันที่สร้าง:</span> {formatDate(viewingOrder.created_at)}</div>
              <div><span className="text-gray-500">ผู้สร้าง:</span> {viewingOrder.creator?.display_name || '-'}</div>
              {viewingOrder.approved_by && <div><span className="text-gray-500">ผู้อนุมัติ:</span> {viewingOrder.approver?.display_name || '-'}</div>}
              {viewingOrder.note && <div className="col-span-2"><span className="text-gray-500">หมายเหตุ:</span> {viewingOrder.note}</div>}
              {viewingOrder.rejection_reason && (
                <div className="col-span-2"><span className="text-gray-500">เหตุผลที่ปฏิเสธ:</span> <span className="text-red-600 font-medium">{viewingOrder.rejection_reason}</span></div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead>
                  <tr className="bg-blue-600 text-white">
                    <th className="px-5 py-3 text-left rounded-tl-xl">รูป</th>
                    <th className="px-5 py-3 text-left">รหัส</th>
                    <th className="px-5 py-3 text-left">ชื่อสินค้า</th>
                    <th className={`px-5 py-3 text-right ${canViewCosts ? '' : 'rounded-tr-xl'}`}>จำนวน</th>
                    {canViewCosts && <th className="px-5 py-3 text-right">ต้นทุน/หน่วย</th>}
                    {canViewCosts && <th className="px-5 py-3 text-right rounded-tr-xl">ต้นทุนรวม</th>}
                  </tr>
                </thead>
                <tbody>
                  {viewItems.map((it, i) => (
                    <tr key={it.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-5 py-3">
                        <ProductImageHover productCode={it.product?.product_code || ''} productName={it.product?.product_name} size="sm" />
                      </td>
                      <td className="px-5 py-3 font-mono text-sm">{it.product?.product_code || '-'}</td>
                      <td className="px-5 py-3">{it.product?.product_name || '-'}</td>
                      <td className="px-5 py-3 text-right font-medium">{it.qty}</td>
                      {canViewCosts && <td className="px-5 py-3 text-right">{it.unit_cost != null ? it.unit_cost.toFixed(2) : '-'}</td>}
                      {canViewCosts && <td className="px-5 py-3 text-right font-semibold">{it.total_cost != null ? it.total_cost.toFixed(2) : '-'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3">
              <h3 className="text-base font-bold text-gray-700">
                รายการสินค้า RM ที่ใช้
              </h3>
              <div className="overflow-x-auto rounded-xl border border-orange-200">
                <table className="w-full text-base">
                  <thead>
                    <tr className="bg-orange-500 text-white">
                      <th className="px-5 py-3 text-left rounded-tl-xl">รูป</th>
                      <th className="px-5 py-3 text-left">รหัส RM</th>
                      <th className="px-5 py-3 text-left">ชื่อสินค้า</th>
                      <th className="px-5 py-3 text-right">จำนวนต่อ PP</th>
                      <th className="px-5 py-3 text-right rounded-tr-xl">จำนวนรวม</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRmItems.length > 0 ? viewRmItems.map((rm, i) => (
                      <tr key={rm.product_id} className={i % 2 === 0 ? 'bg-white' : 'bg-orange-50'}>
                        <td className="px-5 py-3">
                          <ProductImageHover productCode={rm.product_code} productName={rm.product_name} size="sm" />
                        </td>
                        <td className="px-5 py-3 font-mono text-sm">{rm.product_code}</td>
                        <td className="px-5 py-3">{rm.product_name}</td>
                        <td className="px-5 py-3 text-right font-medium">{formatQty(rm.qty_per_unit)}</td>
                        <td className="px-5 py-3 text-right font-bold text-orange-700">{formatQty(rm.total_qty)}</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-gray-400">
                          ไม่พบสินค้า RM ในสูตรแปรรูป
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {canApprove && viewingOrder.status === 'pending' && (
              <div className="flex justify-end gap-3 pt-2">
                <button
                  onClick={() => { setRejectModal(viewingOrder); setRejectReason('') }}
                  className="px-5 py-2.5 bg-red-500 text-white rounded-lg text-base font-semibold hover:bg-red-600 transition"
                >
                  <i className="fas fa-times mr-2 text-lg"></i>ปฏิเสธ
                </button>
                <button
                  onClick={() => handleApprove(viewingOrder)}
                  className="px-5 py-2.5 bg-green-600 text-white rounded-lg text-base font-semibold hover:bg-green-700 transition"
                >
                  <i className="fas fa-check mr-2 text-lg"></i>อนุมัติ
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Reject Modal ── */}
      {rejectModal && (
        <Modal open onClose={() => setRejectModal(null)} contentClassName="max-w-lg" closeOnBackdropClick>
          <div className="p-6 space-y-5">
            <div className="flex justify-between items-start">
              <h2 className="text-xl font-bold text-gray-800">ปฏิเสธ {rejectModal.doc_no}</h2>
              <button
                onClick={() => setRejectModal(null)}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-200 hover:bg-red-500 hover:text-white text-gray-500 text-xl transition-colors shrink-0"
              >
                <i className="fas fa-times"></i>
              </button>
            </div>
            <div>
              <label className="text-base text-gray-600 font-semibold">เหตุผลที่ปฏิเสธ</label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={3}
                className="mt-1 w-full px-4 py-2.5 border rounded-lg text-base focus:ring-2 focus:ring-red-500 focus:outline-none resize-none"
                placeholder="กรอกเหตุผล..."
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setRejectModal(null)} className="px-5 py-2.5 bg-gray-200 text-gray-700 rounded-lg text-base font-semibold hover:bg-gray-300">
                ยกเลิก
              </button>
              <button onClick={handleReject} className="px-5 py-2.5 bg-red-500 text-white rounded-lg text-base font-semibold hover:bg-red-600">
                ยืนยันปฏิเสธ
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Notification Modal ── */}
      {notifyModal.open && (
        <Modal open onClose={() => setNotifyModal((p) => ({ ...p, open: false }))} contentClassName="max-w-md" closeOnBackdropClick>
          <div className="p-8 text-center space-y-4">
            <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${notifyModal.type === 'success' ? 'bg-green-100' : 'bg-red-100'}`}>
              <i className={`fas ${notifyModal.type === 'success' ? 'fa-check text-green-600' : 'fa-times text-red-600'} text-3xl`}></i>
            </div>
            <h3 className="text-xl font-bold">{notifyModal.title}</h3>
            <p className="text-base text-gray-600">{notifyModal.message}</p>
            <button
              onClick={() => setNotifyModal((p) => ({ ...p, open: false }))}
              className={`px-8 py-2.5 rounded-lg text-base font-semibold text-white ${notifyModal.type === 'success' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-500 hover:bg-red-600'}`}
            >
              ตกลง
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════

function OrderTable({
  orders,
  canApprove,
  canProcess,
  onView,
  onEdit,
  onSubmit,
  onDelete,
  onApprove,
  onReject,
  onStart,
  onComplete,
  formatDate,
  statusLabel,
  statusColor,
  showActions,
}: {
  orders: PpProductionOrder[]
  canApprove: boolean
  canProcess?: boolean
  onView: (o: PpProductionOrder) => void
  onEdit?: (o: PpProductionOrder) => void
  onSubmit?: (o: PpProductionOrder) => void
  onDelete?: (o: PpProductionOrder) => void
  onApprove?: (o: PpProductionOrder) => void
  onReject?: (o: PpProductionOrder) => void
  onStart?: (o: PpProductionOrder) => void
  onComplete?: (o: PpProductionOrder) => void
  formatDate: (d: string) => string
  statusLabel: (s: string) => string
  statusColor: (s: string) => string
  showActions: string
}) {
  const isRejected = showActions === 'rejected'

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-base">
        <thead>
          <tr className="bg-blue-600 text-white">
            <th className="px-5 py-3.5 text-left rounded-tl-xl">เลขที่เอกสาร</th>
            <th className="px-5 py-3.5 text-left">วันที่สร้าง</th>
            <th className="px-5 py-3.5 text-left">ผู้สร้าง</th>
            <th className="px-5 py-3.5 text-left">{isRejected ? 'ผู้ปฏิเสธ' : 'ผู้อนุมัติ'}</th>
            <th className="px-5 py-3.5 text-left">หัวข้อ</th>
            {isRejected && <th className="px-5 py-3.5 text-left">เหตุผลปฏิเสธ</th>}
            <th className="px-5 py-3.5 text-center">สถานะ</th>
            <th className="px-5 py-3.5 text-center rounded-tr-xl">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr key={o.id} className={`${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition`}>
              <td className="px-5 py-3 font-mono text-sm">{o.doc_no}</td>
              <td className="px-5 py-3 text-sm">{formatDate(o.created_at)}</td>
              <td className="px-5 py-3">{o.creator?.display_name || '-'}</td>
              <td className="px-5 py-3">{isRejected ? (o.rejector?.display_name || '-') : (o.approver?.display_name || '-')}</td>
              <td className="px-5 py-3">{o.title || '-'}</td>
              {isRejected && <td className="px-5 py-3 text-red-600">{o.rejection_reason || '-'}</td>}
              <td className="px-5 py-3 text-center">
                <span className={`px-3 py-1 rounded-full text-sm font-semibold ${statusColor(o.status)}`}>
                  {statusLabel(o.status)}
                </span>
              </td>
              <td className="px-5 py-3 text-center">
                <div className="flex gap-3 justify-center">
                  <button onClick={() => onView(o)} className="text-blue-600 hover:text-blue-800 text-lg" title="ดูรายละเอียด">
                    <i className="fas fa-eye"></i>
                  </button>
                  {showActions === 'open' && onEdit && (
                    <button onClick={() => onEdit(o)} className="text-yellow-600 hover:text-yellow-800 text-lg" title="แก้ไข">
                      <i className="fas fa-edit"></i>
                    </button>
                  )}
                  {showActions === 'open' && onSubmit && (
                    <button onClick={() => onSubmit(o)} className="text-green-600 hover:text-green-800 text-lg" title="ส่งอนุมัติ">
                      <i className="fas fa-paper-plane"></i>
                    </button>
                  )}
                  {showActions === 'open' && onDelete && (
                    <button onClick={() => onDelete(o)} className="text-red-500 hover:text-red-700 text-lg" title="ลบ">
                      <i className="fas fa-trash"></i>
                    </button>
                  )}
                  {showActions === 'pending' && canApprove && onApprove && (
                    <button onClick={() => onApprove(o)} className="text-green-600 hover:text-green-800 text-lg" title="อนุมัติ">
                      <i className="fas fa-check-circle"></i>
                    </button>
                  )}
                  {showActions === 'pending' && canApprove && onReject && (
                    <button onClick={() => onReject(o)} className="text-red-500 hover:text-red-700 text-lg" title="ปฏิเสธ">
                      <i className="fas fa-times-circle"></i>
                    </button>
                  )}
                  {showActions === 'processing' && o.status === 'approved' && canProcess && onStart && (
                    <button onClick={() => onStart(o)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
                      กำลังทำ
                    </button>
                  )}
                  {showActions === 'processing' && o.status === 'processing' && canProcess && onComplete && (
                    <button onClick={() => onComplete(o)} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">
                      แปรรูปสำเร็จ
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
