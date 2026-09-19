import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fetchAllSupabasePages } from '../lib/supabasePagination'
import { getPublicUrl } from '../lib/qcApi'
import { useAuthContext } from '../contexts/AuthContext'
import { Product, ProductType, StockBalance } from '../types'
import LotCostPopover from '../components/ui/LotCostPopover'
import Modal from '../components/ui/Modal'
import ColumnVisibilityMenu from '../components/ui/ColumnVisibilityMenu'
import { useColumnVisibility, type ColumnVisibilityOption } from '../lib/columnVisibility'
import { fetchProductLocationLabels, type ProductLocationLabelRow } from '../lib/productLocationLabels'
import { canManageWarehouseTransfers } from '../lib/warehouseTransferAccess'
import * as XLSX from 'xlsx'

const BUCKET_PRODUCT_IMAGES = 'product-images'
const WAREHOUSE_COLUMNS: ColumnVisibilityOption[] = [
  { id: 'image', label: 'รูป' },
  { id: 'code', label: 'รหัสสินค้า' },
  { id: 'type', label: 'ประเภท' },
  { id: 'category', label: 'หมวดหมู่' },
  { id: 'name', label: 'ชื่อสินค้า' },
  { id: 'seller', label: 'ผู้ขาย' },
  { id: 'orderPoint', label: 'จุดสั่งซื้อ' },
  { id: 'movement', label: 'Movement' },
  { id: 'pending', label: 'รอรับเข้า' },
  { id: 'safety', label: 'Safety stock' },
  { id: 'total', label: 'รวมในคลัง' },
  { id: 'locations', label: 'จุดจัดเก็บ' },
  { id: 'usage', label: 'การใช้' },
  { id: 'days', label: 'วันขายคงเหลือ' },
  { id: 'cost', label: 'ต้นทุนสินค้า' },
]
type WarehouseProductTypeFilter = '' | ProductType | 'ST'
type FifoStatus = {
  sellableLotCount: number
  sellableLotQty: number
}

type LocationSummary = { location_id: string; code: string; name: string | null; location_type: string; qty: number }
type TransferHistory = { id: string; transfer_no: string; created_at: string; posted_at: string | null; from_code: string; to_code: string; qty: number; status: string; created_by_name: string }

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** YYYY-MM-DD ตามปฏิทินเครื่อง (ไม่ใช้ UTC แบบ toISOString) */
function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * จำนวนวันระหว่างวันที่เริ่ม (ตัวกรอง YYYY-MM-DD) ถึงวันที่ปัจจุบันตามปฏิทินเครื่อง
 * เทียบเฉพาะวันที่ ไม่รวมชั่วโมง/นาที — อย่างน้อย 1 วัน
 */
function calendarDaysFromFilterToToday(salesFromYmd: string, now: Date): number {
  const parts = salesFromYmd.split('-').map((s) => Number(s.trim()))
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 1
  const [y, mo, d] = parts as [number, number, number]
  const from = new Date(y, mo - 1, d)
  if (Number.isNaN(from.getTime())) return 1
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffMs = end.getTime() - from.getTime()
  const wholeDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  return Math.max(wholeDays, 1)
}

export default function Warehouse() {
  const navigate = useNavigate()
  const { user } = useAuthContext()
  const canSeeCost = user?.role === 'superadmin'
  const canManageTransfers = canManageWarehouseTransfers(user?.role)
  const warehouseColumns = useMemo(
    () => WAREHOUSE_COLUMNS.filter((column) => column.id !== 'cost' || canSeeCost),
    [canSeeCost],
  )
  const { hiddenColumns, isColumnVisible, toggleColumn, resetColumns } = useColumnVisibility('tr-erp:warehouse:hidden-columns:v1')

  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [fifoStatusMap, setFifoStatusMap] = useState<Record<string, FifoStatus>>({})
  const [fifoStatusLoaded, setFifoStatusLoaded] = useState(false)
  const [pendingPoMap, setPendingPoMap] = useState<Record<string, number>>({})
  const [specialTrackedSources, setSpecialTrackedSources] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sellerFilter, setSellerFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState<WarehouseProductTypeFilter>('')
  const [onlyBelowOrderPoint, setOnlyBelowOrderPoint] = useState(false)
  const [onlyWithoutFifo, setOnlyWithoutFifo] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [sellers, setSellers] = useState<string[]>([])
  const [salesFromDate, setSalesFromDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 14)
    return toLocalDateString(d)
  })
  const [salesMap, setSalesMap] = useState<Record<string, number>>({})
  const [salesLoading, setSalesLoading] = useState(false)
  const [specialTrackedDetailId, setSpecialTrackedDetailId] = useState<string | null>(null)
  const [locationCountMap, setLocationCountMap] = useState<Record<string, number>>({})
  const [locationProduct, setLocationProduct] = useState<Product | null>(null)
  const [locationRows, setLocationRows] = useState<LocationSummary[]>([])
  const [locationLabels, setLocationLabels] = useState<ProductLocationLabelRow[]>([])
  const [locationHistory, setLocationHistory] = useState<TransferHistory[]>([])
  const [locationLoading, setLocationLoading] = useState(false)
  const [exportingExcel, setExportingExcel] = useState(false)
  const [excelError, setExcelError] = useState('')

  useEffect(() => {
    loadProducts()
    loadBalances()
    loadFifoStatus()
    loadPendingPoMap()
    loadSpecialTrackedSources()
    loadCategories()
    loadSellers()
    loadLocationCounts()
  }, [])

  async function loadLocationCounts() {
    const { data, error } = await supabase.from('wh_location_stock').select('product_id, qty').gt('qty', 0)
    if (error) {
      console.error('Load warehouse location counts failed:', error)
      return
    }
    const map: Record<string, number> = {}
    ;(data || []).forEach((row: { product_id: string }) => { map[row.product_id] = (map[row.product_id] || 0) + 1 })
    setLocationCountMap(map)
  }

  async function openLocationDrawer(product: Product) {
    setLocationProduct(product)
    setLocationLoading(true)
    setLocationLabels([])
    try {
      const [summaryRes, historyRes, labels] = await Promise.all([
        supabase.rpc('rpc_get_product_location_summary', { p_product_id: product.id }),
        supabase.rpc('rpc_get_product_transfer_history', { p_product_id: product.id, p_limit: 5 }),
        fetchProductLocationLabels(product.id),
      ])
      if (summaryRes.error) throw summaryRes.error
      if (historyRes.error) throw historyRes.error
      setLocationRows((summaryRes.data || []).map((row: LocationSummary) => ({ ...row, qty: Number(row.qty || 0) })))
      setLocationHistory((historyRes.data || []).map((row: TransferHistory) => ({ ...row, qty: Number(row.qty || 0) })))
      setLocationLabels(labels)
    } catch (error) {
      console.error('Load product location detail failed:', error)
      setLocationRows([])
      setLocationHistory([])
    } finally {
      setLocationLoading(false)
    }
  }

  useEffect(() => {
    loadSalesData()
  }, [salesFromDate])

  useEffect(() => {
    if (!locationProduct) return
    const scrollContainer = document.querySelector<HTMLElement>('[data-app-scroll-container]')
    if (!scrollContainer) return
    const previousOverflow = scrollContainer.style.overflow
    scrollContainer.style.overflow = 'hidden'
    return () => {
      scrollContainer.style.overflow = previousOverflow
    }
  }, [locationProduct])

  async function loadProducts() {
    setLoading(true)
    try {
      const data = await fetchAllSupabasePages((from, to) => supabase
        .from('pr_products')
        .select('id, product_code, product_name, product_category, product_type, order_point, order_point_days, seller_name, landed_cost, unit_name, is_hold')
        .eq('is_active', true)
        .order('product_code', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to))
      setProducts(data as Product[])
    } catch (e) {
      console.error('Load products failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadBalances() {
    try {
      const data = await fetchAllSupabasePages<StockBalance>((from, to) => supabase
        .from('inv_stock_balances')
        .select('id, product_id, on_hand, reserved, safety_stock, created_at, updated_at')
        .order('product_id', { ascending: true })
        .range(from, to))
      const map: Record<string, StockBalance> = {}
      data.forEach((row) => {
        map[row.product_id] = row
      })
      setBalances(map)
    } catch (e) {
      console.error('Load stock balances failed:', e)
    }
  }

  async function loadFifoStatus() {
    const toMap = (rows: Array<{ product_id: string; sellable_lot_count?: number | null; sellable_lot_qty?: number | null }>) => {
      const map: Record<string, FifoStatus> = {}
      rows.forEach((row) => {
        map[row.product_id] = {
          sellableLotCount: Number(row.sellable_lot_count || 0),
          sellableLotQty: Number(row.sellable_lot_qty || 0),
        }
      })
      setFifoStatusMap(map)
    }

    try {
      const { data, error } = await supabase.rpc('rpc_get_warehouse_fifo_status')
      if (error) throw error
      toMap(data || [])
      setFifoStatusLoaded(true)
      return
    } catch (e) {
      // Migration 505 may not have been applied yet. Superadmin can still use
      // the existing cost-protected lot policy as a temporary read-only fallback.
      if (!canSeeCost) {
        console.error('Load FIFO status failed:', e)
        setFifoStatusMap({})
        setFifoStatusLoaded(false)
        return
      }
    }

    try {
      const data = await fetchAllSupabasePages<{ id: string; product_id: string; qty_remaining: number | null }>((from, to) => supabase
        .from('inv_stock_lots')
        .select('id, product_id, qty_remaining')
        .gt('qty_remaining', 0)
        .eq('is_safety_stock', false)
        .order('id', { ascending: true })
        .range(from, to))

      const map: Record<string, FifoStatus> = {}
      data.forEach((row) => {
        const current = map[row.product_id] || { sellableLotCount: 0, sellableLotQty: 0 }
        current.sellableLotCount += 1
        current.sellableLotQty += Number(row.qty_remaining || 0)
        map[row.product_id] = current
      })
      setFifoStatusMap(map)
      setFifoStatusLoaded(true)
    } catch (e) {
      console.error('Load FIFO status fallback failed:', e)
      setFifoStatusMap({})
      setFifoStatusLoaded(false)
    }
  }

  async function loadPendingPoMap() {
    try {
      const { data, error } = await supabase.rpc('rpc_get_pending_po_by_product')
      if (error) throw error
      const map: Record<string, number> = {}
      ;(data || []).forEach((row: { product_id: string; pending_qty: number | null }) => {
        map[row.product_id] = Number(row.pending_qty || 0)
      })
      setPendingPoMap(map)
    } catch (e) {
      console.error('Load pending PO qty failed:', e)
      setPendingPoMap({})
    }
  }

  async function loadSpecialTrackedSources() {
    try {
      const [{ data: spareRows, error: spareError }, { data: sourceRows, error: sourceError }] = await Promise.all([
        supabase.from('wh_sub_wms_map_spares').select('group_id, product_id'),
        supabase.from('wh_sub_wms_map_sources').select('group_id, product_id'),
      ])
      if (spareError) throw spareError
      if (sourceError) throw sourceError

      const sourceIdsByGroup = new Map<string, Set<string>>()
      ;(sourceRows || []).forEach((row: { group_id: string; product_id: string }) => {
        const ids = sourceIdsByGroup.get(row.group_id) || new Set<string>()
        ids.add(row.product_id)
        sourceIdsByGroup.set(row.group_id, ids)
      })

      const result: Record<string, string[]> = {}
      ;(spareRows || []).forEach((row: { group_id: string; product_id: string }) => {
        result[row.product_id] = [...(sourceIdsByGroup.get(row.group_id) || [])]
      })
      setSpecialTrackedSources(result)
    } catch (e) {
      console.error('Load special tracked stock mapping failed:', e)
      setSpecialTrackedSources({})
    }
  }

  const isSpecialTracked = useCallback(
    (productId: string) => Object.prototype.hasOwnProperty.call(specialTrackedSources, productId),
    [specialTrackedSources],
  )

  const getStockDisplay = useCallback((productId: string): { onHand: number; safetyStock: number | null; total: number } => {
    const sourceIds = specialTrackedSources[productId]
    if (sourceIds) {
      const aggregated = sourceIds.reduce((result, sourceId) => {
        const sourceBalance = balances[sourceId]
        result.onHand += Number(sourceBalance?.on_hand || 0)
        result.safetyStock += Number(sourceBalance?.safety_stock || 0)
        return result
      }, { onHand: 0, safetyStock: 0 })
      return {
        onHand: aggregated.onHand,
        safetyStock: aggregated.safetyStock,
        total: aggregated.onHand + aggregated.safetyStock,
      }
    }
    const balance = balances[productId]
    const onHand = Number(balance?.on_hand || 0)
    const safetyStock = balance?.safety_stock != null ? Number(balance.safety_stock) : null
    return { onHand, safetyStock, total: onHand + (safetyStock ?? 0) }
  }, [balances, specialTrackedSources])

  async function loadCategories() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_category')
        .eq('is_active', true)
        .not('product_category', 'is', null)
      if (error) throw error
      const list = (data || [])
        .map((r: { product_category: string | null }) => r.product_category)
        .filter(Boolean) as string[]
      setCategories([...new Set(list)].sort())
    } catch (e) {
      console.error('Load categories failed:', e)
    }
  }

  async function loadSellers() {
    try {
      const { data, error } = await supabase
        .from('pr_sellers')
        .select('name')
        .eq('is_active', true)
        .order('name')
      if (error) throw error
      setSellers((data || []).map((r: { name: string }) => r.name))
    } catch (e) {
      console.error('Load sellers failed:', e)
    }
  }

  async function loadSalesData() {
    if (!salesFromDate) {
      setSalesMap({})
      return
    }
    setSalesLoading(true)
    try {
      const { data, error } = await supabase.rpc('calc_avg_daily_sales', {
        p_from_date: salesFromDate,
      })
      if (error) throw error
      const map: Record<string, number> = {}
      ;(data || []).forEach((row: { product_id: string; total_sold: number }) => {
        map[row.product_id] = Number(row.total_sold)
      })
      setSalesMap(map)
    } catch (e) {
      console.error('Load sales data failed:', e)
    } finally {
      setSalesLoading(false)
    }
  }

  function calcAvgDailySales(productId: string): number | null {
    if (!salesFromDate) return null
    const totalSold = salesMap[productId]
    if (!totalSold || totalSold <= 0) return null
    const diffDays = calendarDaysFromFilterToToday(salesFromDate, new Date())
    const avgPerDay = totalSold / diffDays
    return avgPerDay > 0 ? Math.round(avgPerDay * 100) / 100 : null
  }

  function calcDaysRemaining(productId: string, onHand: number): number | null {
    const avg = calcAvgDailySales(productId)
    if (!avg || avg <= 0) return null
    return Math.round(onHand / avg)
  }

  function isBelowReorderThreshold(product: Product, onHand: number): boolean {
    // ST is a display-only aggregate and must not enter reorder/PR workflows.
    if (isSpecialTracked(product.id)) return false
    if (product.is_hold) return false
    const pendingQty = Number(pendingPoMap[product.id] || 0)
    const availableSoon = onHand + pendingQty
    const orderPoint = toNumber(product.order_point)
    const byQty = orderPoint !== null && orderPoint > 0 && availableSoon < orderPoint

    const orderPointDaysRaw = Number(product.order_point_days)
    const orderPointDays =
      product.order_point_days == null || !Number.isFinite(orderPointDaysRaw)
        ? null
        : orderPointDaysRaw
    const daysRemaining = calcDaysRemaining(product.id, onHand)
    const byDays =
      orderPointDays !== null &&
      orderPointDays > 0 &&
      daysRemaining !== null &&
      daysRemaining < orderPointDays

    return byQty || byDays
  }

  // คำนวณจำนวนสินค้าที่ต่ำกว่าจุดสั่งซื้อ (ใช้ทั้งแสดงปุ่มและส่งไป Sidebar)
  const belowOrderPointCount = useMemo(() => {
    return products.filter((p) => {
      const balance = balances[p.id]
      const onHand = Number(balance?.on_hand || 0)
      return isBelowReorderThreshold(p, onHand)
    }).length
  }, [products, balances, pendingPoMap, salesFromDate, salesMap, specialTrackedSources])

  // ส่งจำนวนไป Sidebar ทุกครั้งที่เปลี่ยน
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('warehouse-below-order-point', { detail: { count: belowOrderPointCount } })
    )
  }, [belowOrderPointCount])

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase()
    return products.filter((p) => {
      const matchTerm =
        !term ||
        p.product_code.toLowerCase().includes(term) ||
        p.product_name.toLowerCase().includes(term)
      const matchCategory = !categoryFilter || (p.product_category || '') === categoryFilter
      const matchSeller = !sellerFilter || (p.seller_name || '') === sellerFilter
      const displayType = isSpecialTracked(p.id) ? 'ST' : (p.product_type || 'FG')
      const matchProductType = !productTypeFilter || displayType === productTypeFilter
      const matchFifo =
        !onlyWithoutFifo ||
        (fifoStatusLoaded && !isSpecialTracked(p.id) && Number(fifoStatusMap[p.id]?.sellableLotQty || 0) <= 0)

      // ตัวกรองถึงจุดสั่งซื้อ
      let matchOrderPoint = true
      if (onlyBelowOrderPoint) {
        const balance = balances[p.id]
        const onHand = Number(balance?.on_hand || 0)
        matchOrderPoint = isBelowReorderThreshold(p, onHand)
      }

      return matchTerm && matchCategory && matchSeller && matchProductType && matchFifo && matchOrderPoint
    })
  }, [products, search, categoryFilter, sellerFilter, productTypeFilter, onlyBelowOrderPoint, onlyWithoutFifo, fifoStatusLoaded, fifoStatusMap, balances, pendingPoMap, salesFromDate, salesMap, isSpecialTracked])

  const specialTrackedDetail = useMemo(() => {
    if (!specialTrackedDetailId) return null

    const parentProduct = products.find((product) => product.id === specialTrackedDetailId)
    if (!parentProduct) return null

    const productById = new Map(products.map((product) => [product.id, product]))
    const rows = (specialTrackedSources[specialTrackedDetailId] || [])
      .map((sourceId) => {
        const sourceProduct = productById.get(sourceId)
        const balance = balances[sourceId]
        const onHand = Number(balance?.on_hand || 0)
        const safetyStock = Number(balance?.safety_stock || 0)
        return {
          id: sourceId,
          productCode: sourceProduct?.product_code || sourceId,
          productName: sourceProduct?.product_name || '-',
          onHand,
          safetyStock,
          total: onHand + safetyStock,
        }
      })
      .sort((a, b) => a.productCode.localeCompare(b.productCode, undefined, { numeric: true }))

    return {
      parentProduct,
      rows,
      totals: rows.reduce(
        (result, row) => ({
          onHand: result.onHand + row.onHand,
          safetyStock: result.safetyStock + row.safetyStock,
          total: result.total + row.total,
        }),
        { onHand: 0, safetyStock: 0, total: 0 },
      ),
    }
  }, [specialTrackedDetailId, products, specialTrackedSources, balances])

  const handleDownloadExcel = useCallback(async () => {
    setExportingExcel(true)
    setExcelError('')
    try {
      const [freshBalances, freshLocationStock, locationResult, pendingResult, salesResult, freshLocationLabels] = await Promise.all([
        fetchAllSupabasePages<StockBalance>((from, to) => supabase
          .from('inv_stock_balances')
          .select('id, product_id, on_hand, reserved, safety_stock, created_at, updated_at')
          .order('product_id')
          .range(from, to)),
        fetchAllSupabasePages<{ product_id: string; location_id: string; qty: number }>((from, to) => supabase
          .from('wh_location_stock')
          .select('product_id, location_id, qty')
          .order('product_id')
          .order('location_id')
          .range(from, to)),
        supabase.from('wh_storage_locations').select('id, code, name, location_type').order('sort_order').order('code'),
        supabase.rpc('rpc_get_pending_po_by_product'),
        salesFromDate ? supabase.rpc('calc_avg_daily_sales', { p_from_date: salesFromDate }) : Promise.resolve({ data: [], error: null }),
        fetchAllSupabasePages<{ product_id: string; label_type: string; location_id: string | null; display_name: string }>((from, to) => supabase
          .from('wh_product_location_labels')
          .select('product_id, label_type, location_id, display_name')
          .order('product_id')
          .range(from, to)),
      ])
      if (locationResult.error) throw locationResult.error
      if (pendingResult.error) throw pendingResult.error
      if (salesResult.error) throw salesResult.error

      const freshBalanceMap: Record<string, StockBalance> = {}
      freshBalances.forEach((balance) => { freshBalanceMap[balance.product_id] = balance })
      const freshPendingMap: Record<string, number> = {}
      ;(pendingResult.data || []).forEach((row: { product_id: string; pending_qty: number | null }) => {
        freshPendingMap[row.product_id] = Number(row.pending_qty || 0)
      })
      const freshSalesMap: Record<string, number> = {}
      ;(salesResult.data || []).forEach((row: { product_id: string; total_sold: number | null }) => {
        freshSalesMap[row.product_id] = Number(row.total_sold || 0)
      })
      const locations = new Map((locationResult.data || []).map((location: { id: string; code: string; name: string | null; location_type: string }) => [location.id, location]))
      const moveLocationId = [...locations.values()].find((location) => location.code.trim().toUpperCase() === 'MOVE')?.id
      const locationLabelMap = new Map(freshLocationLabels.map((label) => [
        `${label.product_id}:${label.label_type}:${label.location_id || ''}`,
        label.display_name,
      ]))
      const locationStockByProduct = new Map<string, Array<{ location_id: string; qty: number }>>()
      freshLocationStock.forEach((stock) => {
        const productRows = locationStockByProduct.get(stock.product_id) || []
        productRows.push({ location_id: stock.location_id, qty: Number(stock.qty || 0) })
        locationStockByProduct.set(stock.product_id, productRows)
      })

      const getFreshStockDisplay = (productId: string) => {
        const sourceIds = specialTrackedSources[productId]
        if (sourceIds) {
          const totals = sourceIds.reduce((result, sourceId) => {
            const balance = freshBalanceMap[sourceId]
            result.onHand += Number(balance?.on_hand || 0)
            result.safetyStock += Number(balance?.safety_stock || 0)
            return result
          }, { onHand: 0, safetyStock: 0 })
          return { ...totals, total: totals.onHand + totals.safetyStock }
        }
        const balance = freshBalanceMap[productId]
        const onHand = Number(balance?.on_hand || 0)
        const safetyStock = Number(balance?.safety_stock || 0)
        return { onHand, safetyStock, total: onHand + safetyStock }
      }

      const daysInRange = salesFromDate ? calendarDaysFromFilterToToday(salesFromDate, new Date()) : 1
      const rows = filteredProducts.map((p) => {
      const stockDisplay = getFreshStockDisplay(p.id)
      const onHand = stockDisplay.onHand
      const safetyStock = stockDisplay.safetyStock
      const pendingQty = Number(freshPendingMap[p.id] || 0)
      const totalSold = Number(freshSalesMap[p.id] || 0)
      const avg = totalSold > 0 ? Math.round((totalSold / daysInRange) * 100) / 100 : null
      const days = avg && avg > 0 ? Math.round(onHand / avg) : null
      const specialTracked = isSpecialTracked(p.id)
      const unitName = p.unit_name?.trim() || 'ชิ้น'
      const productLocationRows = locationStockByProduct.get(p.id) || []
      const positiveLocationRows = productLocationRows.filter((location) => location.qty > 0)
      const locationTotal = positiveLocationRows.reduce((sum, location) => sum + location.qty, 0)
      const locationDifference = specialTracked ? null : locationTotal - stockDisplay.total
      const row: Record<string, unknown> = {
        'รหัสสินค้า': p.product_code,
        'ประเภท': specialTracked ? 'ST' : (p.product_type || 'FG'),
        'หมวดหมู่': p.product_category || '-',
        'ชื่อสินค้า': p.product_name,
        'หน่วย': unitName,
        'ผู้ขาย': p.seller_name || '-',
        'จุดสั่งซื้อ': p.order_point || '-',
        'ชื่อจุด Movement': moveLocationId
          ? locationLabelMap.get(`${p.id}:storage:${moveLocationId}`) || 'ไม่มีจุดจัดเก็บ'
          : 'ไม่มีจุดจัดเก็บ',
        'จำนวนคงเหลือ': specialTracked ? 'ไม่มีค่า' : onHand,
        'รอรับเข้า': specialTracked ? 'ไม่มีค่า' : (pendingQty > 0 ? pendingQty : '-'),
        'Safety stock': specialTracked ? 'ไม่มีค่า' : (safetyStock ?? '-'),
        'ชื่อจุด Safety stock': locationLabelMap.get(`${p.id}:safety:`) || 'Safety stock',
        'รวมในคลัง': stockDisplay.total,
        'จำนวนจุดจัดเก็บ': specialTracked ? '-' : positiveLocationRows.length,
        'ยอดรวมตามจุดเก็บ': specialTracked ? '-' : locationTotal,
        'ผลต่างจุดเก็บ': specialTracked ? '-' : locationDifference,
        'สถานะจุดเก็บ': specialTracked ? 'สินค้า ST' : Math.abs(locationDifference || 0) < 0.0001 ? 'ตรง' : 'ไม่ตรง',
        'การใช้ (หน่วย/วัน)': !specialTracked && avg !== null ? avg : '-',
        'วันขายคงเหลือ': !specialTracked && days !== null ? days : '-',
      }
      if (canSeeCost) {
        row['ต้นทุนสินค้า'] = specialTracked
          ? 'ไม่มีค่า'
          : p.landed_cost != null && Number(p.landed_cost) > 0
          ? Number(p.landed_cost)
          : '-'
      }
      return row
      })

      const visibleProductIds = new Set(filteredProducts.filter((product) => !isSpecialTracked(product.id)).map((product) => product.id))
      const productById = new Map(filteredProducts.map((product) => [product.id, product]))
      const locationDetailRows: Record<string, unknown>[] = []
      freshLocationStock
        .filter((stock) => visibleProductIds.has(stock.product_id) && Number(stock.qty || 0) > 0)
        .forEach((stock) => {
          const product = productById.get(stock.product_id)
          const location = locations.get(stock.location_id)
          if (!product || !location) return
          const typeLabel = location.location_type === 'picking'
            ? 'จุดหยิบหลัก'
            : location.location_type === 'reserve'
              ? 'เก็บสำรอง'
              : location.location_type === 'hold'
                ? 'พัก/รอตรวจ'
                : 'ยังไม่จัดสรร'
          locationDetailRows.push({
            'รหัสสินค้า': product.product_code,
            'ชื่อสินค้า': product.product_name,
            'รหัสจุดจัดเก็บ': location.code,
            'ชื่อจุดจัดเก็บ': locationLabelMap.get(`${stock.product_id}:storage:${stock.location_id}`) || location.name || '-',
            'ประเภทจุดจัดเก็บ': typeLabel,
            'จำนวน': Number(stock.qty || 0),
            'หน่วย': product.unit_name?.trim() || 'ชิ้น',
          })
        })

      const ws = XLSX.utils.json_to_sheet(rows)
      const locationWs = XLSX.utils.json_to_sheet(locationDetailRows.length > 0 ? locationDetailRows : [{ 'ข้อมูล': 'ไม่พบยอดตามจุดจัดเก็บ' }])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'คลังสินค้า')
      XLSX.utils.book_append_sheet(wb, locationWs, 'ยอดตามจุดเก็บ')
      const today = toLocalDateString(new Date())
      XLSX.writeFile(wb, `คลังสินค้า_${today}.xlsx`)
    } catch (error) {
      console.error('Export warehouse Excel failed:', error)
      setExcelError(error instanceof Error ? error.message : 'ดาวน์โหลด Excel ไม่สำเร็จ')
    } finally {
      setExportingExcel(false)
    }
  }, [filteredProducts, salesFromDate, canSeeCost, isSpecialTracked, specialTrackedSources])

  return (
    <>
      <div className="space-y-6 mt-4">
        <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex flex-wrap gap-4 mb-4 items-center">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="warehouse-search" className="sr-only">ค้นหาสินค้า</label>
            <input
              id="warehouse-search"
              type="text"
              autoComplete="off"
              placeholder="ค้นหารหัสสินค้าหรือชื่อสินค้า..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-surface-50 text-base"
            />
          </div>
          <div className="w-full sm:w-auto sm:min-w-[150px]">
            <label htmlFor="warehouse-product-type" className="sr-only">ประเภทสินค้า</label>
            <select
              id="warehouse-product-type"
              value={productTypeFilter}
              onChange={(e) => setProductTypeFilter(e.target.value as WarehouseProductTypeFilter)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">ทุกประเภท</option>
              <option value="FG">FG - สินค้าสำเร็จรูป</option>
              <option value="RM">RM - วัตถุดิบ</option>
              <option value="PP">PP - สินค้าแปรรูป</option>
              <option value="ST">ST - อะไหล่ยอดรวมจากสินค้าผลิต</option>
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="warehouse-category" className="sr-only">หมวดหมู่</label>
            <select
              id="warehouse-category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">หมวดหมู่ทั้งหมด</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-auto sm:min-w-[180px]">
            <label htmlFor="warehouse-seller" className="sr-only">ผู้ขาย</label>
            <select
              id="warehouse-seller"
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-base"
            >
              <option value="">ผู้ขายทั้งหมด</option>
              {sellers.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setOnlyBelowOrderPoint((v) => !v)}
            className={`px-4 py-2.5 rounded-xl font-semibold text-sm border transition-colors whitespace-nowrap ${
              onlyBelowOrderPoint
                ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
            }`}
          >
            ถึงจุดสั่งซื้อ {belowOrderPointCount > 0 && (
              <span className={`ml-1.5 inline-flex items-center justify-center min-w-[1.4rem] h-5 px-1.5 rounded-full text-xs font-bold ${
                onlyBelowOrderPoint ? 'bg-white text-orange-600' : 'bg-orange-500 text-white'
              }`}>
                {belowOrderPointCount}
              </span>
            )}
          </button>
          <div className="flex flex-col items-center gap-0.5">
            <div className="flex items-center gap-2">
              <input
                id="sales-from-date"
                type="date"
                value={salesFromDate}
                onChange={(e) => setSalesFromDate(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white text-sm"
              />
              {salesLoading && (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
              )}
            </div>
            <label htmlFor="sales-from-date" className="text-[10px] leading-tight text-gray-500 whitespace-nowrap">
              คำนวณยอดขายตั้งแต่
            </label>
          </div>
          <div className="basis-full" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void handleDownloadExcel()}
            disabled={exportingExcel}
            className="ml-auto shrink-0 px-4 py-2.5 rounded-xl font-semibold text-sm border border-green-500 bg-green-500 text-white hover:bg-green-600 transition-colors whitespace-nowrap flex items-center justify-center gap-1.5 disabled:cursor-wait disabled:opacity-60"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            {exportingExcel ? 'กำลังเตรียม Excel...' : 'ดาวน์โหลด Excel'}
          </button>
          <ColumnVisibilityMenu
            columns={warehouseColumns}
            hiddenColumns={hiddenColumns}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
          <button
            type="button"
            onClick={() => setOnlyWithoutFifo((value) => !value)}
            disabled={!fifoStatusLoaded}
            title={fifoStatusLoaded ? 'แสดงเฉพาะสินค้าที่ไม่มีล็อต FIFO คงเหลือ' : 'กำลังโหลดข้อมูล FIFO'}
            className={`px-4 py-2.5 rounded-xl font-semibold text-sm border transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${
              onlyWithoutFifo
                ? 'border-red-500 bg-red-500 text-white hover:bg-red-600'
                : 'border-red-300 bg-white text-red-600 hover:bg-red-50'
            }`}
          >
            ไม่มี FIFO
          </button>
          {canManageTransfers && (
            <>
              <button
                type="button"
                onClick={() => navigate('/warehouse/transfers')}
                className="px-4 py-2.5 rounded-xl font-semibold text-sm border border-blue-300 bg-white text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap"
              >
                ประวัติการย้าย
              </button>
              <button
                type="button"
                onClick={() => navigate('/warehouse/transfers?create=1')}
                className="shrink-0 px-4 py-2.5 rounded-xl font-semibold text-sm border border-blue-600 bg-blue-600 text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                + สร้างใบย้าย
              </button>
            </>
          )}
        </div>

        {excelError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ดาวน์โหลด Excel ไม่สำเร็จ: {excelError}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ไม่พบข้อมูลสินค้า</div>
        ) : (
          <div className="max-h-[60dvh] overflow-auto rounded-t-xl">
            <table className="w-full">
              <thead className="sticky top-0 z-20 bg-blue-600 shadow-sm">
                <tr className="bg-blue-600 text-white text-xs leading-tight [&>th]:whitespace-normal [&>th]:break-words">
                  {isColumnVisible('image') && <th className="p-3 text-left font-semibold rounded-tl-xl">รูป</th>}
                  {isColumnVisible('code') && <th className="p-3 text-left font-semibold">รหัสสินค้า</th>}
                  {isColumnVisible('type') && <th className="p-3 text-center font-semibold">ประเภท</th>}
                  {isColumnVisible('category') && <th className="p-3 text-left font-semibold">หมวดหมู่</th>}
                  {isColumnVisible('name') && <th className="p-3 text-left font-semibold">ชื่อสินค้า</th>}
                  {isColumnVisible('seller') && <th className="p-3 text-left font-semibold">ผู้ขาย</th>}
                  {isColumnVisible('orderPoint') && <th className="p-3 text-center font-semibold">จุดสั่งซื้อ</th>}
                  {isColumnVisible('movement') && <th className="p-3 text-center font-semibold">Movement</th>}
                  {isColumnVisible('pending') && <th className="p-3 text-center font-semibold">รอรับเข้า</th>}
                  {isColumnVisible('safety') && <th className="p-3 text-center font-semibold">Safety stock</th>}
                  {isColumnVisible('total') && <th className="p-3 text-center font-semibold">รวมในคลัง</th>}
                  {isColumnVisible('locations') && <th className="p-3 text-center font-semibold">จุดจัดเก็บ</th>}
                  {isColumnVisible('usage') && <th className="p-3 text-center font-semibold">การใช้</th>}
                  {isColumnVisible('days') && <th className="p-3 text-center font-semibold">วันขายคงเหลือ</th>}
                  {canSeeCost && isColumnVisible('cost') && <th className="p-3 text-right font-semibold rounded-tr-xl">ต้นทุนสินค้า</th>}
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product, idx) => {
                  const stockDisplay = getStockDisplay(product.id)
                  const onHand = stockDisplay.onHand
                  const pendingQty = Number(pendingPoMap[product.id] || 0)
                  const safetyStock = stockDisplay.safetyStock
                  const specialTracked = isSpecialTracked(product.id)
                  const fifoStatus = fifoStatusMap[product.id]
                  const hasFifo = !specialTracked && Number(fifoStatus?.sellableLotQty || 0) > 0
                  const totalInStock = stockDisplay.total
                  const isLow = isBelowReorderThreshold(product, onHand)
                  const unitName = product.unit_name?.trim() || 'ชิ้น'
                  return (
                    <tr
                      key={product.id}
                      onClick={(event) => {
                        if (specialTracked || (event.target as HTMLElement).closest('a,button,input,select')) return
                        void openLocationDrawer(product)
                      }}
                      className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${specialTracked ? '' : 'cursor-pointer'} ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                    >
                      {isColumnVisible('image') && <td className="p-3">
                        <div className="inline-flex items-center gap-1">
                          {hasFifo && (
                            <span
                              className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-emerald-600 px-1 text-[9px] font-bold leading-none text-white"
                              title={`มี FIFO ${fifoStatus.sellableLotQty.toLocaleString()} ${product.unit_name?.trim() || 'ชิ้น'} (${fifoStatus.sellableLotCount.toLocaleString()} ล็อต)`}
                              aria-label="มี FIFO"
                            >
                              F
                            </span>
                          )}
                          <ProductImage code={product.product_code} name={product.product_name} />
                        </div>
                      </td>}
                      {isColumnVisible('code') && <td className="p-3 font-medium">{product.product_code}</td>}
                      {isColumnVisible('type') && <td className="p-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                          specialTracked
                            ? 'bg-sky-100 text-sky-700'
                            : product.product_type === 'RM'
                            ? 'bg-amber-100 text-amber-700'
                            : product.product_type === 'PP'
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {specialTracked ? 'ST' : (product.product_type || 'FG')}
                        </span>
                      </td>}
                      {isColumnVisible('category') && <td className="p-3">{product.product_category || '-'}</td>}
                      {isColumnVisible('name') && <td className="p-3">{product.product_name}</td>}
                      {isColumnVisible('seller') && <td className="p-3 text-sm">{product.seller_name || '-'}</td>}
                      {isColumnVisible('orderPoint') && <td className="p-3 text-center">{product.order_point ? `${Number(product.order_point).toLocaleString()} ${unitName}` : '-'}</td>}
                      {isColumnVisible('movement') && <td className={`p-3 text-center ${isLow ? 'bg-orange-50 text-orange-700 font-semibold' : ''}`}>
                        {specialTracked ? <span className="text-xs text-gray-400">ไม่มีค่า</span> : `${onHand.toLocaleString()} ${unitName}`}
                      </td>}
                      {isColumnVisible('pending') && <td className="p-3 text-center">
                        {specialTracked ? <span className="text-xs text-gray-400">ไม่มีค่า</span> : (pendingQty > 0 ? `${pendingQty.toLocaleString()} ${unitName}` : '-')}
                      </td>}
                      {isColumnVisible('safety') && <td className="p-3 text-center">
                        {specialTracked ? <span className="text-xs text-gray-400">ไม่มีค่า</span> : (safetyStock !== null ? `${safetyStock.toLocaleString()} ${unitName}` : '-')}
                      </td>}
                      {isColumnVisible('total') && <td className="p-3 text-center font-medium text-gray-700 align-middle">
                        <span title={specialTracked ? `ยอดรวมจากสินค้าผลิตที่ผูกไว้ ${specialTrackedSources[product.id]?.length || 0} SKU (ไม่กระทบ FIFO)` : undefined}>
                          {totalInStock.toLocaleString()} {unitName}
                        </span>
                        {specialTracked && (
                          <button
                            type="button"
                            onClick={() => setSpecialTrackedDetailId(product.id)}
                            className="mx-auto mt-0.5 block rounded text-[10px] font-medium text-sky-600 underline decoration-sky-300 underline-offset-2 transition-colors hover:text-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-1"
                            aria-label={`ดูรายละเอียด ${specialTrackedSources[product.id]?.length || 0} SKU ของ ${product.product_name}`}
                          >
                            รวม {specialTrackedSources[product.id]?.length || 0} SKU
                          </button>
                        )}
                      </td>}
                      {isColumnVisible('locations') && <td className="p-3 text-center">
                        {specialTracked ? <span className="text-gray-400">-</span> : (
                          <button
                            type="button"
                            onClick={() => void openLocationDrawer(product)}
                            className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                          >
                            {locationCountMap[product.id] || 0} จุด
                          </button>
                        )}
                      </td>}
                      {isColumnVisible('usage') && <td className="p-3 text-center text-sm text-gray-600">
                        {(() => {
                          if (specialTracked) return <span className="text-gray-400">-</span>
                          const avg = calcAvgDailySales(product.id)
                          if (avg === null) return <span className="text-gray-400">-</span>
                          return <span>{avg.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {unitName}/วัน</span>
                        })()}
                      </td>}
                      {isColumnVisible('days') && <td className="p-3 text-center">
                        {(() => {
                          if (specialTracked) return <span className="text-gray-400">-</span>
                          const days = calcDaysRemaining(product.id, onHand)
                          if (days === null) return <span className="text-gray-400">-</span>
                          const color =
                            days <= 7
                              ? 'text-red-600 font-bold'
                              : days <= 14
                                ? 'text-orange-600 font-semibold'
                                : days <= 30
                                  ? 'text-yellow-600 font-medium'
                                  : 'text-green-600'
                          return <span className={color}>{days} วัน</span>
                        })()}
                      </td>}
                      {canSeeCost && isColumnVisible('cost') && (
                        <td className="p-3 text-right font-medium">
                          {specialTracked ? (
                            <span className="text-xs font-normal text-gray-400">ไม่มีค่า</span>
                          ) : product.landed_cost != null && Number(product.landed_cost) > 0 ? (
                            <LotCostPopover productId={product.id} landedCost={Number(product.landed_cost)}>
                              {Number(product.landed_cost).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ฿
                            </LotCostPopover>
                          ) : '-'}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>

      {locationProduct && (
        <div
          className="fixed bottom-0 left-0 right-0 top-[calc(3.5rem+var(--subnav-height,0rem))] z-50 md:top-[calc(4rem+var(--subnav-height,0rem))]"
          role="dialog"
          aria-modal="true"
          aria-label="รายละเอียดสต๊อกตามจุดจัดเก็บ"
        >
          <button type="button" aria-label="ปิด" onClick={() => setLocationProduct(null)} className="absolute inset-0 bg-gray-900/30" />
          <aside className="absolute bottom-0 right-0 top-0 flex w-full max-w-2xl flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">รายละเอียดสต๊อกตามจุดจัดเก็บ</h2>
                <p className="mt-1 text-sm text-gray-500">{locationProduct.product_code} · {locationProduct.product_name}</p>
              </div>
              <button
                type="button"
                onClick={() => setLocationProduct(null)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition-colors hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2"
                aria-label="ปิด"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {locationLoading ? (
                <div className="py-16 text-center text-gray-500">กำลังโหลด...</div>
              ) : (
                <>
                  <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                      <div className="flex items-center justify-between gap-3 text-sm text-blue-700">
                        <span>Movement</span>
                        <span className="min-w-0 truncate text-right text-xs font-medium text-blue-600" title={locationLabels.find((row) => row.label_type === 'storage' && row.code.trim().toUpperCase() === 'MOVE')?.configured_name || 'ไม่มีจุดจัดเก็บ'}>
                          {locationLabels.find((row) => row.label_type === 'storage' && row.code.trim().toUpperCase() === 'MOVE')?.configured_name || 'ไม่มีจุดจัดเก็บ'}
                        </span>
                      </div>
                      <div className="mt-1 text-2xl font-bold text-blue-900">
                        {getStockDisplay(locationProduct.id).onHand.toLocaleString()} {locationProduct.unit_name?.trim() || 'ชิ้น'}
                      </div>
                    </div>
                    <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
                      <div className="flex items-center justify-between gap-3 text-sm text-amber-700">
                        <span>Safety stock</span>
                        <span className="min-w-0 truncate text-right text-xs font-medium text-amber-700" title={locationLabels.find((row) => row.label_type === 'safety')?.configured_name || 'ไม่มีจุดจัดเก็บ'}>
                          {locationLabels.find((row) => row.label_type === 'safety')?.configured_name || 'ไม่มีจุดจัดเก็บ'}
                        </span>
                      </div>
                      <div className="mt-1 text-2xl font-bold text-amber-900">
                        {(getStockDisplay(locationProduct.id).safetyStock ?? 0).toLocaleString()} {locationProduct.unit_name?.trim() || 'ชิ้น'}
                      </div>
                    </div>
                  </div>
                  <h3 className="mb-2 font-semibold text-gray-900">ยอดตามจุดจัดเก็บ</h3>
                  <div className="divide-y rounded-xl border">
                    {locationRows.length === 0 ? <p className="p-6 text-center text-sm text-gray-400">ยังไม่มีการระบุตำแหน่ง</p> : locationRows.map((row) => (
                      <div key={row.location_id} className="flex items-center justify-between p-3">
                        <div><b>{row.code}</b>{row.name ? <span className="ml-2 text-sm text-gray-500">{row.name}</span> : null}<div className="text-xs text-gray-400">{row.location_type === 'picking' ? 'จุดหยิบหลัก' : row.location_type === 'reserve' ? 'เก็บสำรอง' : row.location_type === 'hold' ? 'พัก/รอตรวจ' : 'ยังไม่จัดสรร'}</div></div>
                        <b>{row.qty.toLocaleString()} {locationProduct.unit_name?.trim() || 'ชิ้น'}</b>
                      </div>
                    ))}
                  </div>

                  <div className="mb-2 mt-6 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900">ประวัติล่าสุด</h3>
                    <span className="text-xs text-gray-400">สูงสุด 5 ครั้ง</span>
                  </div>
                  <div className="divide-y rounded-xl border">
                    {locationHistory.length === 0 ? <p className="p-6 text-center text-sm text-gray-400">ยังไม่มีประวัติการย้ายตำแหน่ง</p> : locationHistory.map((row) => (
                      <div key={row.id} className="p-3">
                        <div className="flex items-center justify-between gap-3"><b className="text-sm">{row.from_code} → {row.to_code}</b><b className="text-sm text-blue-700">{row.qty.toLocaleString()} {locationProduct.unit_name?.trim() || 'ชิ้น'}</b></div>
                        <div className="mt-1 flex justify-between gap-3 text-xs text-gray-500"><span>{new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(row.posted_at || row.created_at))}</span><span>{row.created_by_name}</span></div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {canManageTransfers && (
              <div className="flex gap-2 border-t p-4">
                <button type="button" onClick={() => navigate(`/warehouse/transfers?create=1&product=${locationProduct.id}`)} className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white hover:bg-blue-700">ย้ายตำแหน่ง</button>
                <button type="button" onClick={() => navigate(`/warehouse/transfers?product=${locationProduct.id}`)} className="flex-1 rounded-xl border border-blue-300 px-4 py-2.5 font-semibold text-blue-700 hover:bg-blue-50">ดูประวัติทั้งหมด</button>
              </div>
            )}
          </aside>
        </div>
      )}

      <Modal
        open={specialTrackedDetail !== null}
        onClose={() => setSpecialTrackedDetailId(null)}
        closeOnBackdropClick
        contentClassName="max-w-4xl"
        ariaLabelledby="special-tracked-detail-title"
      >
        {specialTrackedDetail && (
          <div>
            <div className="border-b border-surface-200 px-5 py-4 pr-14 sm:px-6">
              <h2 id="special-tracked-detail-title" className="text-lg font-bold text-gray-900">
                รายละเอียด SKU ในคลัง
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                {specialTrackedDetail.parentProduct.product_code} · {specialTrackedDetail.parentProduct.product_name}
              </p>
            </div>

            <div className="overflow-x-auto p-4 sm:p-6">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="bg-blue-600 text-white">
                    <th className="rounded-tl-xl px-4 py-3 text-left font-semibold">รหัส SKU</th>
                    <th className="px-4 py-3 text-left font-semibold">ชื่อสินค้า</th>
                    <th className="px-4 py-3 text-right font-semibold">จำนวนคงเหลือ</th>
                    <th className="px-4 py-3 text-right font-semibold">Safety stock</th>
                    <th className="rounded-tr-xl px-4 py-3 text-right font-semibold">รวมในคลัง</th>
                  </tr>
                </thead>
                <tbody>
                  {specialTrackedDetail.rows.map((row, index) => (
                    <tr key={row.id} className={`border-b border-surface-200 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="px-4 py-3 font-medium text-gray-900">{row.productCode}</td>
                      <td className="px-4 py-3 text-gray-700">{row.productName}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.onHand.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.safetyStock.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-gray-900">{row.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-sky-50 text-gray-900">
                    <td colSpan={2} className="rounded-bl-xl px-4 py-3 font-bold">
                      รวม {specialTrackedDetail.rows.length} SKU
                    </td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">{specialTrackedDetail.totals.onHand.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-bold tabular-nums">{specialTrackedDetail.totals.safetyStock.toLocaleString()}</td>
                    <td className="rounded-br-xl px-4 py-3 text-right font-bold tabular-nums text-sky-700">{specialTrackedDetail.totals.total.toLocaleString()}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

function ProductImage({ code, name }: { code: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const url = code ? getProductImageUrl(code) : ''
  const displayUrl = url && !failed ? url : ''
  if (!displayUrl) {
    return (
      <div className="w-16 h-16 bg-gray-200 rounded flex items-center justify-center text-gray-400 text-xs">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-16 h-16 rounded overflow-hidden hover:ring-2 hover:ring-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-16 h-16 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
