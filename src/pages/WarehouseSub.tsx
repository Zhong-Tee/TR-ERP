import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildIlikeOr } from '../lib/searchFilter'
import { useAuthContext } from '../contexts/AuthContext'
import Modal from '../components/ui/Modal'
import { useWmsModal } from '../components/wms/useWmsModal'
import { getPublicUrl } from '../lib/qcApi'

type SubWarehouse = {
  id: string
  name: string
  is_active: boolean
  created_at: string
}

type AssignedProductRow = {
  product_id: string
  product_code: string
  product_name: string
  unit_name: string | null
  qty_on_hand: number
}

type DailySheetRow = {
  product_id: string
  product_code: string
  product_name: string
  unit_name: string | null
  received_opening: number
  replenish_day: number
  reduce_day: number
  wms_opening: number
  wms_day: number
  balance_opening: number
  balance_eod: number
}

type WmsUsageBreakdown = {
  workOrder: number
  requisition: number
  other: number
  total: number
}

type WmsUsageRpcRow = {
  product_code: string | null
  correct_qty: number | string | null
  work_order_qty?: number | string | null
  requisition_qty?: number | string | null
  other_qty?: number | string | null
}

type OtherWmsDetailRow = {
  wms_order_id: string
  order_reference: string | null
  product_code: string
  product_name: string
  qty: number
  unit_name: string | null
  used_at: string
  fulfillment_mode: string | null
  picker_name: string | null
  classification_reason: string
}

type OtherWmsDetailContext = {
  productId: string
  productCode: string
  productName: string
  from: string
  to: string
}

type WmsMapLineUi = {
  id: string
  product_id: string
  product_code: string
  product_name: string
}

type WmsMapGroupUi = {
  id: string
  name: string
  sub_warehouse_id: string | null
  sort_order: number
  spares: WmsMapLineUi[]
  sources: WmsMapLineUi[]
}

type MoveRow = {
  id: string
  created_at: string
  created_by: string | null
  product_id: string
  product_code: string
  product_name: string
  unit_name: string | null
  qty_delta: number
  reason: string | null
  note: string | null
  balance_after: number
}

type ProductLookupRow = {
  id: string
  product_code: string
  product_name: string
  unit_name: string | null
}

const BUCKET_PRODUCT_IMAGES = 'product-images'

function sanitizeExportFilenamePart(raw: string) {
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'export'
}

function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  return getPublicUrl(BUCKET_PRODUCT_IMAGES, productCode, ext)
}

function toLocalYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfDayIso(ymd: string): string {
  return `${ymd}T00:00:00+07:00`
}

type PeriodBalance = {
  opening: number
  closing: number
}

function endOfDayIso(ymd: string): string {
  return `${ymd}T23:59:59.999+07:00`
}

const SUB_WAREHOUSE_READ_ONLY_ROLES = new Set(['production', 'qc_staff', 'packing_staff'])
const MANUAL_REMOVE_REASONS = [
  'ของเสีย/ชำรุด',
  'สูญหาย',
  'ปรับยอดจากการนับ',
  'ใช้งานภายในนอก WMS',
  'แก้ไขยอดตั้งต้น',
  'อื่น ๆ',
] as const

const EMPTY_WMS_USAGE: WmsUsageBreakdown = { workOrder: 0, requisition: 0, other: 0, total: 0 }

export default function WarehouseSub() {
  const { user } = useAuthContext()
  const canManageSubWarehouseSettings = user?.role === 'superadmin' || user?.role === 'admin'
  const canModifySubWarehouseStock = !!user && !SUB_WAREHOUSE_READ_ONLY_ROLES.has(user.role)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal({ showCancelButton: false })

  const [subWarehouses, setSubWarehouses] = useState<SubWarehouse[]>([])
  const [loadingSubs, setLoadingSubs] = useState(false)
  const [selectedSubId, setSelectedSubId] = useState<string>('')

  const [products, setProducts] = useState<AssignedProductRow[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [draggingProductId, setDraggingProductId] = useState<string | null>(null)
  const [savingProductOrder, setSavingProductOrder] = useState(false)

  const [moves, setMoves] = useState<MoveRow[]>([])
  const [loadingMoves, setLoadingMoves] = useState(false)

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return toLocalYmd(d)
  })
  const [dateTo, setDateTo] = useState(() => toLocalYmd(new Date()))
  const [historyProductCode, setHistoryProductCode] = useState('')

  const [wmsCorrectMap, setWmsCorrectMap] = useState<Record<string, number>>({})
  const [wmsUsageMap, setWmsUsageMap] = useState<Record<string, WmsUsageBreakdown>>({})
  const [dailyWmsUsageMap, setDailyWmsUsageMap] = useState<Record<string, WmsUsageBreakdown>>({})
  const [loadingWms, setLoadingWms] = useState(false)
  const [otherWmsModalOpen, setOtherWmsModalOpen] = useState(false)
  const [otherWmsLoading, setOtherWmsLoading] = useState(false)
  const [otherWmsRows, setOtherWmsRows] = useState<OtherWmsDetailRow[]>([])
  const [otherWmsContext, setOtherWmsContext] = useState<OtherWmsDetailContext | null>(null)

  /** วันที่นับสต๊อครายวัน (เขตเวลาไทย — ฝั่ง RPC) */
  const [countDate, setCountDate] = useState(() => toLocalYmd(new Date()))
  const [productViewMode, setProductViewMode] = useState<'daily' | 'history' | 'range'>('daily')
  const [warehouseProductSearch, setWarehouseProductSearch] = useState('')
  const [dailyRows, setDailyRows] = useState<DailySheetRow[]>([])
  const [loadingDaily, setLoadingDaily] = useState(false)
  const [periodBalances, setPeriodBalances] = useState<Record<string, PeriodBalance>>({})
  const [loadingPeriodBalances, setLoadingPeriodBalances] = useState(false)

  const productStockExportRef = useRef<HTMLDivElement>(null)
  const [savingTableImage, setSavingTableImage] = useState(false)

  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newSubName, setNewSubName] = useState('')
  const [creatingSub, setCreatingSub] = useState(false)

  const [addProductModalOpen, setAddProductModalOpen] = useState(false)
  const [productSearch, setProductSearch] = useState('')
  const [productSearchLoading, setProductSearchLoading] = useState(false)
  const [productOptions, setProductOptions] = useState<ProductLookupRow[]>([])
  const [selectedProductId, setSelectedProductId] = useState<string>('')
  const [addingProduct, setAddingProduct] = useState(false)

  const [adjustModalOpen, setAdjustModalOpen] = useState(false)
  const [adjustProductId, setAdjustProductId] = useState<string>('')
  const [adjustType, setAdjustType] = useState<'add' | 'remove'>('add')
  const [adjustQty, setAdjustQty] = useState<string>('')
  const [adjustReason, setAdjustReason] = useState<string>('เติมสต๊อค')
  const [adjustNote, setAdjustNote] = useState<string>('')
  const [adjustSaving, setAdjustSaving] = useState(false)

  const [rubberMapModalOpen, setRubberMapModalOpen] = useState(false)
  const [mapModalLoading, setMapModalLoading] = useState(false)
  const [mapUiGroups, setMapUiGroups] = useState<WmsMapGroupUi[]>([])
  const [mapNewGroupName, setMapNewGroupName] = useState('กลุ่มจับคู่ใหม่')
  const [mapNewGroupScope, setMapNewGroupScope] = useState<'current' | 'all'>('current')
  const [mapLineDraft, setMapLineDraft] = useState<Record<string, { spare: string; source: string }>>({})
  const [mapGroupSearch, setMapGroupSearch] = useState('')
  const [expandedMapGroups, setExpandedMapGroups] = useState<Record<string, boolean>>({})
  const [mapProductOptions, setMapProductOptions] = useState<Record<string, ProductLookupRow[]>>({})
  const [mapSelectedProducts, setMapSelectedProducts] = useState<Record<string, ProductLookupRow | null>>({})
  const [mapProductSearchLoading, setMapProductSearchLoading] = useState<Record<string, boolean>>({})
  const [draggingMapGroupId, setDraggingMapGroupId] = useState<string | null>(null)

  const selectedSub = useMemo(
    () => subWarehouses.find((s) => s.id === selectedSubId) || null,
    [subWarehouses, selectedSubId],
  )
  const filteredMapUiGroups = useMemo(() => {
    const term = mapGroupSearch.trim().toLocaleLowerCase('th')
    if (!term) return mapUiGroups
    return mapUiGroups.filter((group) => group.name.toLocaleLowerCase('th').includes(term))
  }, [mapGroupSearch, mapUiGroups])
  const filteredWarehouseProducts = useMemo(() => {
    const term = warehouseProductSearch.trim().toLocaleLowerCase('th')
    if (!term) return products
    return products.filter((product) =>
      `${product.product_code} ${product.product_name}`.toLocaleLowerCase('th').includes(term),
    )
  }, [products, warehouseProductSearch])
  const filteredDailyRows = useMemo(() => {
    const term = warehouseProductSearch.trim().toLocaleLowerCase('th')
    const filtered = term ? dailyRows.filter((product) =>
      `${product.product_code} ${product.product_name}`.toLocaleLowerCase('th').includes(term),
    ) : dailyRows
    const order = new Map(products.map((product, index) => [product.product_id, index]))
    return [...filtered].sort((a, b) => (order.get(a.product_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.product_id) ?? Number.MAX_SAFE_INTEGER))
  }, [dailyRows, products, warehouseProductSearch])
  const filteredMoves = useMemo(() => {
    const term = historyProductCode.trim().toLocaleLowerCase('th')
    if (!term) return moves
    return moves.filter((move) =>
      `${move.product_code} ${move.product_name}`.toLocaleLowerCase('th').includes(term),
    )
  }, [historyProductCode, moves])
  const chronologicalMoves = useMemo(
    () => [...filteredMoves].sort((a, b) => {
      const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return timeDiff || a.id.localeCompare(b.id)
    }),
    [filteredMoves],
  )
  const rangeMoveTotals = useMemo(() => {
    const totals = new Map<string, { added: number; removed: number }>()
    moves.forEach((move) => {
      const current = totals.get(move.product_id) || { added: 0, removed: 0 }
      const delta = Number(move.qty_delta || 0)
      if (delta >= 0) current.added += delta
      else current.removed += Math.abs(delta)
      totals.set(move.product_id, current)
    })
    return totals
  }, [moves])
  const historySummaryRows = useMemo(() => {
    const productById = new Map<string, Pick<MoveRow, 'product_id' | 'product_code' | 'product_name' | 'unit_name'>>()
    filteredMoves.forEach((move) => productById.set(move.product_id, move))
    return [...productById.values()].map((product) => {
      const totals = rangeMoveTotals.get(product.product_id) || { added: 0, removed: 0 }
      const wmsUsage = wmsUsageMap[product.product_code] || EMPTY_WMS_USAGE
      const wmsUsed = wmsUsage.total
      const balance = periodBalances[product.product_id]
      return { ...product, ...totals, ...wmsUsage, wmsUsed, opening: balance?.opening, closing: balance?.closing }
    })
  }, [filteredMoves, periodBalances, rangeMoveTotals, wmsUsageMap])

  async function applyDynamicWmsMapsToUsageMap(map: Record<string, WmsUsageBreakdown>, subId: string) {
    if (!subId) return
    try {
      const { data: groups, error } = await supabase
        .from('wh_sub_wms_map_groups')
        .select('id')
        .or(`sub_warehouse_id.is.null,sub_warehouse_id.eq.${subId}`)
      if (error || !groups?.length) return
      const gids = groups.map((g: { id: string }) => String(g.id))
      const { data: spareRows } = await supabase
        .from('wh_sub_wms_map_spares')
        .select('group_id, product_id')
        .in('group_id', gids)
      const { data: sourceRows } = await supabase
        .from('wh_sub_wms_map_sources')
        .select('group_id, product_id')
        .in('group_id', gids)
      if (!spareRows?.length) return
      const pids = [
        ...new Set([
          ...spareRows.map((r: { product_id: string }) => String(r.product_id)),
          ...(sourceRows || []).map((r: { product_id: string }) => String(r.product_id)),
        ]),
      ]
      const { data: prods } = await supabase.from('pr_products').select('id, product_code').in('id', pids)
      const idToCode: Record<string, string> = {}
      ;(prods || []).forEach((p: { id: string; product_code: string }) => {
        idToCode[String(p.id)] = String(p.product_code || '')
      })
      const sumByGroup: Record<string, WmsUsageBreakdown> = {}
      gids.forEach((gid) => {
        sumByGroup[gid] = { ...EMPTY_WMS_USAGE }
      })
      ;(sourceRows || []).forEach((s: { group_id: string; product_id: string }) => {
        const code = idToCode[String(s.product_id)]
        if (!code) return
        const gid = String(s.group_id)
        const current = sumByGroup[gid] || { ...EMPTY_WMS_USAGE }
        const source = map[code] || EMPTY_WMS_USAGE
        sumByGroup[gid] = {
          workOrder: current.workOrder + source.workOrder,
          requisition: current.requisition + source.requisition,
          other: current.other + source.other,
          total: current.total + source.total,
        }
      })
      spareRows.forEach((s: { group_id: string; product_id: string }) => {
        const code = idToCode[String(s.product_id)]
        if (!code) return
        const gid = String(s.group_id)
        map[code] = { ...(sumByGroup[gid] || EMPTY_WMS_USAGE) }
      })
    } catch (e) {
      console.warn('applyDynamicWmsMapsToUsageMap skipped:', e)
    }
  }

  async function fetchWmsUsageBreakdown(fromYmd: string, toYmd: string, subId: string) {
    const params = {
      p_from: startOfDayIso(fromYmd),
      p_to: endOfDayIso(toYmd),
    }
    let { data, error } = await supabase.rpc('rpc_get_wms_usage_breakdown_by_product', params)
    let hasBreakdown = !error
    if (error) {
      const fallback = await supabase.rpc('rpc_get_wms_correct_qty_by_product', params)
      data = fallback.data
      error = fallback.error
      hasBreakdown = false
    }
    if (error) throw error
    const map: Record<string, WmsUsageBreakdown> = {}
    ;((data || []) as WmsUsageRpcRow[]).forEach((r) => {
      const code = String(r.product_code || '')
      if (!code) return
      const total = Number(r.correct_qty || 0)
      map[code] = {
        workOrder: Number(r.work_order_qty || 0),
        requisition: Number(r.requisition_qty || 0),
        other: hasBreakdown ? Number(r.other_qty || 0) : total,
        total,
      }
    })
    await applyDynamicWmsMapsToUsageMap(map, subId)
    return map
  }

  async function openOtherWmsDetails(context: OtherWmsDetailContext) {
    if (!selectedSubId) return
    setOtherWmsContext(context)
    setOtherWmsRows([])
    setOtherWmsModalOpen(true)
    setOtherWmsLoading(true)
    try {
      const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_other_wms_details', {
        p_sub_warehouse_id: selectedSubId,
        p_product_id: context.productId,
        p_from: startOfDayIso(context.from),
        p_to: endOfDayIso(context.to),
      })
      if (error) throw error
      setOtherWmsRows(((data || []) as Array<Record<string, unknown>>).map((row) => ({
        wms_order_id: String(row.wms_order_id || ''),
        order_reference: row.order_reference ? String(row.order_reference) : null,
        product_code: String(row.product_code || ''),
        product_name: String(row.product_name || ''),
        qty: Number(row.qty || 0),
        unit_name: row.unit_name ? String(row.unit_name) : null,
        used_at: String(row.used_at || ''),
        fulfillment_mode: row.fulfillment_mode ? String(row.fulfillment_mode) : null,
        picker_name: row.picker_name ? String(row.picker_name) : null,
        classification_reason: String(row.classification_reason || 'ข้อมูลอ้างอิงไม่ครบ'),
      })))
    } catch (e: unknown) {
      console.error('Load other WMS details failed:', e)
      showMessage({
        title: 'โหลดรายละเอียดไม่สำเร็จ',
        message: e instanceof Error ? e.message : String(e),
      })
      setOtherWmsModalOpen(false)
    } finally {
      setOtherWmsLoading(false)
    }
  }

  async function loadRubberMapData() {
    if (!selectedSubId) return
    setMapModalLoading(true)
    try {
      const { data: groups, error: ge } = await supabase
        .from('wh_sub_wms_map_groups')
        .select('id, name, sub_warehouse_id, sort_order, created_at')
        .or(`sub_warehouse_id.is.null,sub_warehouse_id.eq.${selectedSubId}`)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (ge) throw ge
      const gids = (groups || []).map((g: { id: string }) => String(g.id))
      if (gids.length === 0) {
        setMapUiGroups([])
        return
      }
      const { data: spareRows } = await supabase.from('wh_sub_wms_map_spares').select('id, group_id, product_id').in('group_id', gids)
      const { data: sourceRows } = await supabase.from('wh_sub_wms_map_sources').select('id, group_id, product_id').in('group_id', gids)
      const allPid = [
        ...new Set([
          ...(spareRows || []).map((r: { product_id: string }) => String(r.product_id)),
          ...(sourceRows || []).map((r: { product_id: string }) => String(r.product_id)),
        ]),
      ]
      const idToProd: Record<string, { code: string; name: string }> = {}
      if (allPid.length > 0) {
        const { data: prods } = await supabase
          .from('pr_products')
          .select('id, product_code, product_name')
          .in('id', allPid)
        ;(prods || []).forEach((p: { id: string; product_code: string; product_name: string }) => {
          idToProd[String(p.id)] = {
            code: String(p.product_code || ''),
            name: String(p.product_name || ''),
          }
        })
      }
      const next: WmsMapGroupUi[] = (groups || []).map((g: { id: string; name: string; sub_warehouse_id: string | null; sort_order: number | null }) => {
        const gid = String(g.id)
        const spares = (spareRows || [])
          .filter((r: { group_id: string }) => String(r.group_id) === gid)
          .map((r: { id: string; product_id: string }) => {
            const meta = idToProd[String(r.product_id)] || { code: '', name: '' }
            return {
              id: String(r.id),
              product_id: String(r.product_id),
              product_code: meta.code,
              product_name: meta.name,
            }
          })
        const sources = (sourceRows || [])
          .filter((r: { group_id: string }) => String(r.group_id) === gid)
          .map((r: { id: string; product_id: string }) => {
            const meta = idToProd[String(r.product_id)] || { code: '', name: '' }
            return {
              id: String(r.id),
              product_id: String(r.product_id),
              product_code: meta.code,
              product_name: meta.name,
            }
          })
        return {
          id: gid,
          name: String(g.name || ''),
          sub_warehouse_id: g.sub_warehouse_id != null ? String(g.sub_warehouse_id) : null,
          sort_order: Number(g.sort_order || 0),
          spares,
          sources,
        }
      })
      setMapUiGroups(next)
    } catch (e: any) {
      console.error('loadRubberMapData failed:', e)
      showMessage({
        title: 'ผิดพลาด',
        message: 'โหลดตั้งค่าจับคู่ไม่สำเร็จ — ตรวจว่าได้รัน migration 244 แล้ว: ' + (e?.message || String(e)),
      })
      setMapUiGroups([])
    } finally {
      setMapModalLoading(false)
    }
  }

  async function createWmsMapGroup() {
    if (!selectedSubId) return
    const name = mapNewGroupName.trim() || 'กลุ่มจับคู่'
    const subVal = mapNewGroupScope === 'all' ? null : selectedSubId
    try {
      const { error } = await supabase.from('wh_sub_wms_map_groups').insert({
        name,
        sub_warehouse_id: subVal,
        sort_order: mapUiGroups.length ? Math.max(...mapUiGroups.map((group) => group.sort_order)) + 1 : 1,
      })
      if (error) throw error
      setMapNewGroupName('กลุ่มจับคู่ใหม่')
      await loadRubberMapData()
      await refreshAllForSelected()
      showMessage({ title: 'สำเร็จ', message: 'สร้างกลุ่มจับคู่แล้ว' })
    } catch (e: any) {
      console.error(e)
      showMessage({ title: 'ผิดพลาด', message: e?.message || String(e) })
    }
  }

  async function reorderWmsMapGroups(targetGroupId: string) {
    const sourceGroupId = draggingMapGroupId
    setDraggingMapGroupId(null)
    if (!sourceGroupId || sourceGroupId === targetGroupId || mapGroupSearch.trim()) return
    const fromIndex = mapUiGroups.findIndex((group) => group.id === sourceGroupId)
    const toIndex = mapUiGroups.findIndex((group) => group.id === targetGroupId)
    if (fromIndex < 0 || toIndex < 0) return
    const reordered = [...mapUiGroups]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    const next = reordered.map((group, index) => ({ ...group, sort_order: index + 1 }))
    setMapUiGroups(next)
    try {
      const results = await Promise.all(
        next.map((group) =>
          supabase.from('wh_sub_wms_map_groups').update({ sort_order: group.sort_order }).eq('id', group.id),
        ),
      )
      const failed = results.find((result) => result.error)
      if (failed?.error) throw failed.error
    } catch (e: any) {
      await loadRubberMapData()
      showMessage({ title: 'ผิดพลาด', message: 'บันทึกลำดับกลุ่มไม่สำเร็จ: ' + (e?.message || String(e)) })
    }
  }

  async function searchWmsMapProducts(groupId: string, kind: 'spare' | 'source', rawTerm: string) {
    const key = `${groupId}:${kind}`
    const term = rawTerm.trim()
    setMapSelectedProducts((prev) => ({ ...prev, [key]: null }))
    if (!term) {
      setMapProductOptions((prev) => ({ ...prev, [key]: [] }))
      return
    }
    setMapProductSearchLoading((prev) => ({ ...prev, [key]: true }))
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, unit_name')
        .eq('is_active', true)
        .or(buildIlikeOr(term, ['product_code', 'product_name']))
        .order('product_code', { ascending: true })
        .limit(12)
      if (error) throw error
      setMapProductOptions((prev) => ({ ...prev, [key]: (data || []) as ProductLookupRow[] }))
    } catch (e) {
      console.error('Search WMS map products failed:', e)
      setMapProductOptions((prev) => ({ ...prev, [key]: [] }))
    } finally {
      setMapProductSearchLoading((prev) => ({ ...prev, [key]: false }))
    }
  }

  function selectWmsMapProduct(groupId: string, kind: 'spare' | 'source', product: ProductLookupRow) {
    const key = `${groupId}:${kind}`
    setMapSelectedProducts((prev) => ({ ...prev, [key]: product }))
    setMapProductOptions((prev) => ({ ...prev, [key]: [] }))
    setMapLineDraft((prev) => ({
      ...prev,
      [groupId]: {
        spare: kind === 'spare' ? product.product_code : prev[groupId]?.spare ?? '',
        source: kind === 'source' ? product.product_code : prev[groupId]?.source ?? '',
      },
    }))
  }

  async function deleteWmsMapGroup(groupId: string) {
    const ok = await showConfirm({
      title: 'ลบกลุ่มจับคู่',
      message: 'ลบกลุ่มนี้และรายการอะไหล่/สินค้าผลิตที่ผูกไว้ทั้งหมด?',
    })
    if (!ok) return
    try {
      const { error } = await supabase.from('wh_sub_wms_map_groups').delete().eq('id', groupId)
      if (error) throw error
      await loadRubberMapData()
      await refreshAllForSelected()
      showMessage({ title: 'สำเร็จ', message: 'ลบกลุ่มแล้ว' })
    } catch (e: any) {
      showMessage({ title: 'ผิดพลาด', message: e?.message || String(e) })
    }
  }

  async function updateWmsMapGroupName(groupId: string, name: string) {
    try {
      const { error } = await supabase
        .from('wh_sub_wms_map_groups')
        .update({ name: name.trim() || 'กลุ่มจับคู่' })
        .eq('id', groupId)
      if (error) throw error
      await loadRubberMapData()
    } catch (e: any) {
      showMessage({ title: 'ผิดพลาด', message: e?.message || String(e) })
    }
  }

  async function addWmsMapLine(groupId: string, kind: 'spare' | 'source') {
    const key = `${groupId}:${kind}`
    const selected = mapSelectedProducts[key]
    if (!selected) {
      showMessage({ message: 'กรุณาค้นหาและเลือกรายการสินค้าก่อน' })
      return
    }
    try {
      const table = kind === 'spare' ? 'wh_sub_wms_map_spares' : 'wh_sub_wms_map_sources'
      const { error } = await supabase.from(table).insert({
        group_id: groupId,
        product_id: selected.id,
      })
      if (error) throw error
      setMapLineDraft((d) => ({
        ...d,
        [groupId]: {
          spare: kind === 'spare' ? '' : d[groupId]?.spare ?? '',
          source: kind === 'source' ? '' : d[groupId]?.source ?? '',
        },
      }))
      setMapSelectedProducts((prev) => ({ ...prev, [key]: null }))
      await loadRubberMapData()
      await refreshAllForSelected()
    } catch (e: any) {
      const msg = e?.message || String(e)
      if (String(msg).includes('duplicate') || e?.code === '23505') {
        showMessage({ message: 'รายการซ้ำ (อะไหล่หนึ่งรหัสต่อหนึ่งกลุ่มเท่านั้น หรือสินค้าผลิตซ้ำในกลุ่มเดียวกัน)' })
        return
      }
      showMessage({ title: 'ผิดพลาด', message: msg })
    }
  }

  async function removeWmsMapLine(table: 'wh_sub_wms_map_spares' | 'wh_sub_wms_map_sources', rowId: string) {
    try {
      const { error } = await supabase.from(table).delete().eq('id', rowId)
      if (error) throw error
      await loadRubberMapData()
      await refreshAllForSelected()
    } catch (e: any) {
      showMessage({ title: 'ผิดพลาด', message: e?.message || String(e) })
    }
  }

  function openRubberMapSettings() {
    if (!selectedSubId) {
      showMessage({ message: 'กรุณาเลือกคลังย่อยก่อน' })
      return
    }
    setRubberMapModalOpen(true)
    void loadRubberMapData()
  }

  async function loadSubWarehouses() {
    setLoadingSubs(true)
    try {
      const { data, error } = await supabase
        .from('wh_sub_warehouses')
        .select('id, name, is_active, created_at')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
      if (error) throw error
      const list = (data || []) as SubWarehouse[]
      setSubWarehouses(list)
      if (!selectedSubId && list.length > 0) {
        setSelectedSubId(list[0].id)
      }
    } catch (e: any) {
      console.error('Load sub warehouses failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'โหลดคลังย่อยไม่สำเร็จ: ' + (e?.message || String(e)) })
    } finally {
      setLoadingSubs(false)
    }
  }

  async function loadAssignedProducts(subId: string) {
    setLoadingProducts(true)
    try {
      const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_balances', {
        p_sub_warehouse_id: subId,
      })
      if (error) throw error
      const rows = (data || []).map((r: any) => ({
        product_id: String(r.product_id),
        product_code: String(r.product_code || ''),
        product_name: String(r.product_name || ''),
        unit_name: r.unit_name != null ? String(r.unit_name) : null,
        qty_on_hand: Number(r.qty_on_hand || 0),
      })) as AssignedProductRow[]
      setProducts(rows)
    } catch (e: any) {
      console.error('Load assigned products failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'โหลดรายการสินค้าไม่สำเร็จ: ' + (e?.message || String(e)) })
      setProducts([])
    } finally {
      setLoadingProducts(false)
    }
  }

  async function reorderAssignedProducts(targetProductId: string) {
    const sourceProductId = draggingProductId
    setDraggingProductId(null)
    if (!selectedSubId || !sourceProductId || sourceProductId === targetProductId || warehouseProductSearch.trim() || savingProductOrder) return
    const fromIndex = products.findIndex((product) => product.product_id === sourceProductId)
    const toIndex = products.findIndex((product) => product.product_id === targetProductId)
    if (fromIndex < 0 || toIndex < 0) return

    const previousProducts = products
    const previousDailyRows = dailyRows
    const reordered = [...products]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    const order = new Map(reordered.map((product, index) => [product.product_id, index]))
    setProducts(reordered)
    setDailyRows((rows) => [...rows].sort((a, b) => (order.get(a.product_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.product_id) ?? Number.MAX_SAFE_INTEGER)))
    setSavingProductOrder(true)
    try {
      const { error } = await supabase.rpc('rpc_reorder_sub_warehouse_products', {
        p_sub_warehouse_id: selectedSubId,
        p_product_ids: reordered.map((product) => product.product_id),
      })
      if (error) throw error
    } catch (e: any) {
      setProducts(previousProducts)
      setDailyRows(previousDailyRows)
      showMessage({ title: 'ผิดพลาด', message: 'บันทึกลำดับสินค้าไม่สำเร็จ: ' + (e?.message || String(e)) })
    } finally {
      setSavingProductOrder(false)
    }
  }

  async function loadMoves(subId: string) {
    if (!dateFrom || !dateTo) return
    setLoadingMoves(true)
    try {
      const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_moves', {
        p_sub_warehouse_id: subId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        // Load every move in the selected period. History search is applied in the UI,
        // while the range summary must always use the complete period.
        p_product_code: null,
      })
      if (error) throw error
      const rows = (data || []).map((r: any) => ({
        id: String(r.id),
        created_at: String(r.created_at),
        created_by: r.created_by ? String(r.created_by) : null,
        product_id: String(r.product_id),
        product_code: String(r.product_code || ''),
        product_name: String(r.product_name || ''),
        unit_name: r.unit_name != null ? String(r.unit_name) : null,
        qty_delta: Number(r.qty_delta || 0),
        reason: r.reason != null ? String(r.reason) : null,
        note: r.note != null ? String(r.note) : null,
        balance_after: Number(r.balance_after || 0),
      })) as MoveRow[]
      setMoves(rows)
    } catch (e: any) {
      console.error('Load moves failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'โหลดประวัติไม่สำเร็จ: ' + (e?.message || String(e)) })
      setMoves([])
    } finally {
      setLoadingMoves(false)
    }
  }

  async function loadWmsCorrect() {
    if (!dateFrom || !dateTo) return
    setLoadingWms(true)
    try {
      const usageMap = await fetchWmsUsageBreakdown(dateFrom, dateTo, selectedSubId)
      setWmsUsageMap(usageMap)
      setWmsCorrectMap(Object.fromEntries(Object.entries(usageMap).map(([code, usage]) => [code, usage.total])))
    } catch (e: any) {
      console.error('Load WMS correct qty failed:', e)
      setWmsCorrectMap({})
      setWmsUsageMap({})
    } finally {
      setLoadingWms(false)
    }
  }

  async function loadDailySheet(subId: string) {
    if (!countDate) return
    setLoadingDaily(true)
    try {
      const [{ data, error }, usageMap] = await Promise.all([
        supabase.rpc('rpc_get_sub_warehouse_daily_stock_sheet', {
          p_sub_warehouse_id: subId,
          p_date: countDate,
        }),
        fetchWmsUsageBreakdown(countDate, countDate, subId),
      ])
      if (error) throw error
      const rows = (data || []).map((r: any) => ({
        product_id: String(r.product_id),
        product_code: String(r.product_code || ''),
        product_name: String(r.product_name || ''),
        unit_name: r.unit_name != null ? String(r.unit_name) : null,
        received_opening: Number(r.received_opening || 0),
        replenish_day: Number(r.replenish_day || 0),
        reduce_day: Number(r.reduce_day || 0),
        wms_opening: Number(r.wms_opening || 0),
        wms_day: Number(r.wms_day || 0),
        balance_opening: Number(r.balance_opening || 0),
        balance_eod: Number(r.balance_eod || 0),
      })) as DailySheetRow[]
      setDailyRows(rows)
      setDailyWmsUsageMap(usageMap)
    } catch (e: any) {
      console.error('Load daily stock sheet failed:', e)
      setDailyRows([])
      setDailyWmsUsageMap({})
      showMessage({
        title: 'ผิดพลาด',
        message: 'โหลดสรุปรายวันไม่สำเร็จ — ตรวจว่าได้รัน migration ล่าสุดของคลังย่อยแล้ว หรือลองรีเฟรช: ' + (e?.message || String(e)),
      })
    } finally {
      setLoadingDaily(false)
    }
  }

  async function loadPeriodBalances(subId: string) {
    if (!dateFrom || !dateTo) return
    setLoadingPeriodBalances(true)
    try {
      const loadForDate = async (date: string) => {
        const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_daily_stock_sheet', {
          p_sub_warehouse_id: subId,
          p_date: date,
        })
        if (error) throw error
        return data || []
      }
      const startRowsPromise = loadForDate(dateFrom)
      const endRowsPromise = dateFrom === dateTo ? startRowsPromise : loadForDate(dateTo)
      const [startRows, endRows] = await Promise.all([startRowsPromise, endRowsPromise])
      const next: Record<string, PeriodBalance> = {}
      ;(startRows as Array<{ product_id: string; balance_opening: number | string | null }>).forEach((row) => {
        next[String(row.product_id)] = {
          opening: Number(row.balance_opening || 0),
          closing: 0,
        }
      })
      ;(endRows as Array<{ product_id: string; balance_eod: number | string | null }>).forEach((row) => {
        const productId = String(row.product_id)
        next[productId] = {
          opening: next[productId]?.opening ?? 0,
          closing: Number(row.balance_eod || 0),
        }
      })
      setPeriodBalances(next)
    } catch (e) {
      console.error('Load period balances failed:', e)
      setPeriodBalances({})
    } finally {
      setLoadingPeriodBalances(false)
    }
  }

  const refreshAllForSelected = useCallback(async () => {
    if (!selectedSubId) return
    await Promise.all([
      loadAssignedProducts(selectedSubId),
      loadMoves(selectedSubId),
      loadWmsCorrect(),
      loadDailySheet(selectedSubId),
      loadPeriodBalances(selectedSubId),
    ])
  }, [selectedSubId, dateFrom, dateTo, countDate]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadSubWarehouses()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedSubId) return
    refreshAllForSelected()
  }, [selectedSubId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedSubId) return
    void loadDailySheet(selectedSubId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- countDate only; sub handled by refreshAll
  }, [countDate])

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!addProductModalOpen) return
    const term = productSearch.trim()
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(async () => {
      if (!term) {
        setProductOptions([])
        return
      }
      setProductSearchLoading(true)
      try {
        const { data, error } = await supabase
          .from('pr_products')
          .select('id, product_code, product_name, unit_name')
          .eq('is_active', true)
          .or(buildIlikeOr(term, ['product_code', 'product_name']))
          .order('product_code', { ascending: true })
          .limit(20)
        if (error) throw error
        setProductOptions((data || []) as ProductLookupRow[])
      } catch (e) {
        console.error('Search products failed:', e)
        setProductOptions([])
      } finally {
        setProductSearchLoading(false)
      }
    }, 300)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [productSearch, addProductModalOpen])

  const openAddProduct = () => {
    if (!selectedSubId) {
      showMessage({ message: 'กรุณาเลือกคลังย่อยก่อน' })
      return
    }
    setProductSearch('')
    setProductOptions([])
    setSelectedProductId('')
    setAddProductModalOpen(true)
  }

  const openAdjustForProduct = (productId: string) => {
    if (!canModifySubWarehouseStock) {
      showMessage({ message: 'บัญชีนี้มีสิทธิ์ดูข้อมูลคลังย่อยเท่านั้น' })
      return
    }
    setAdjustProductId(productId)
    setAdjustType('add')
    setAdjustQty('')
    setAdjustReason('เติมสต๊อค')
    setAdjustNote('')
    setAdjustModalOpen(true)
  }

  const selectAdjustType = (type: 'add' | 'remove') => {
    setAdjustType(type)
    setAdjustReason(type === 'add' ? 'เติมสต๊อค' : '')
    setAdjustNote('')
  }

  const createSubWarehouse = async () => {
    const name = newSubName.trim()
    if (!name) {
      showMessage({ message: 'กรุณากรอกชื่อคลังย่อย' })
      return
    }
    setCreatingSub(true)
    try {
      const { error } = await supabase.from('wh_sub_warehouses').insert([
        {
          name,
          created_by: user?.id || null,
          is_active: true,
        },
      ])
      if (error) throw error
      setCreateModalOpen(false)
      setNewSubName('')
      await loadSubWarehouses()
      showMessage({ title: 'สำเร็จ', message: 'เพิ่มคลังย่อยแล้ว' })
    } catch (e: any) {
      console.error('Create sub warehouse failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'เพิ่มคลังย่อยไม่สำเร็จ: ' + (e?.message || String(e)) })
    } finally {
      setCreatingSub(false)
    }
  }

  const addProductToSubWarehouse = async () => {
    if (!selectedSubId) return
    if (!selectedProductId) {
      showMessage({ message: 'กรุณาเลือกสินค้า' })
      return
    }
    setAddingProduct(true)
    try {
      const { error } = await supabase.from('wh_sub_warehouse_products').insert([
        {
          sub_warehouse_id: selectedSubId,
          product_id: selectedProductId,
        },
      ])
      if (error) throw error
      setAddProductModalOpen(false)
      await Promise.all([loadAssignedProducts(selectedSubId), loadDailySheet(selectedSubId)])
      showMessage({ title: 'สำเร็จ', message: 'เพิ่มสินค้าเข้าคลังย่อยแล้ว' })
    } catch (e: any) {
      console.error('Add product failed:', e)
      const errorMessage = e?.message || String(e)
      const isDuplicateProduct =
        e?.code === '23505' ||
        errorMessage.includes('wh_sub_warehouse_products_sub_warehouse_id_product_id_key')
      showMessage({
        title: 'ไม่สามารถเพิ่มสินค้าได้',
        message: isDuplicateProduct
          ? 'สินค้านี้มีอยู่ในคลังย่อยที่เลือกแล้ว กรุณาเลือกสินค้าอื่น'
          : 'เพิ่มสินค้าไม่สำเร็จ: ' + errorMessage,
      })
    } finally {
      setAddingProduct(false)
    }
  }

  const saveAdjust = async () => {
    if (!canModifySubWarehouseStock) {
      showMessage({ message: 'บัญชีนี้ไม่มีสิทธิ์เพิ่มหรือลดสต๊อคคลังย่อย' })
      return
    }
    if (!selectedSubId || !adjustProductId) return
    const q = Number(String(adjustQty || '').replace(/,/g, '').trim())
    if (!Number.isFinite(q) || q <= 0) {
      showMessage({ message: 'กรุณากรอกจำนวนให้ถูกต้อง' })
      return
    }
    if (!adjustReason.trim()) {
      showMessage({ message: 'กรุณาระบุเหตุผลในการปรับสต๊อก' })
      return
    }
    if (adjustType === 'remove' && !adjustNote.trim()) {
      showMessage({ message: 'กรุณากรอกรายละเอียดการลดมือ เพื่อใช้ตรวจสอบย้อนหลัง' })
      return
    }

    if (adjustType === 'remove') {
      const product = products.find((row) => row.product_id === adjustProductId)
      if (product) {
        try {
          const today = toLocalYmd(new Date())
          const todayUsage = await fetchWmsUsageBreakdown(today, today, selectedSubId)
          const wmsQty = todayUsage[product.product_code]?.total || 0
          if (wmsQty > 0 && Math.abs(wmsQty - q) < 0.000001) {
            const canOverrideDuplicate = user?.role === 'superadmin' || user?.role === 'admin'
            if (!canOverrideDuplicate) {
              showMessage({
                title: 'ไม่สามารถลดมือได้',
                message: `วันนี้สินค้า ${product.product_code} ถูกบันทึกในยอดตัดสต๊อกรวม จำนวน ${wmsQty.toLocaleString()} แล้ว ซึ่งตรงกับจำนวนที่กำลังลด กรุณาตรวจสอบรายการ WMS หรือให้ผู้ดูแลระบบดำเนินการหากเป็นคนละเหตุการณ์`,
              })
              return
            }
            const confirmed = await showConfirm({
              title: 'อาจเป็นการหักยอดซ้ำ',
              message: `วันนี้สินค้า ${product.product_code} ถูกบันทึกในยอดตัดสต๊อกรวม จำนวน ${wmsQty.toLocaleString()} แล้ว และตรงกับจำนวนที่กำลังลดมือ\n\nยืนยันว่าเป็นคนละเหตุการณ์และต้องการลดมือเพิ่มเติมหรือไม่?`,
            })
            if (!confirmed) return
          }
        } catch (e) {
          console.warn('Duplicate manual reduction check skipped:', e)
          showMessage({
            title: 'ยังตรวจสอบรายการ WMS ไม่สำเร็จ',
            message: 'ระบบยังยืนยันไม่ได้ว่ารายการนี้ซ้ำกับยอด WMS หรือไม่ กรุณาลองใหม่อีกครั้งเพื่อป้องกันยอดถูกหักซ้ำ',
          })
          return
        }
      }
    }
    const delta = adjustType === 'add' ? q : -q
    setAdjustSaving(true)
    try {
      const { error } = await supabase.from('wh_sub_warehouse_stock_moves').insert([
        {
          sub_warehouse_id: selectedSubId,
          product_id: adjustProductId,
          qty_delta: delta,
          reason: adjustReason.trim() || null,
          note: adjustNote.trim() || null,
          created_by: user?.id || null,
        },
      ])
      if (error) throw error
      setAdjustModalOpen(false)
      await Promise.all([loadAssignedProducts(selectedSubId), loadMoves(selectedSubId), loadDailySheet(selectedSubId)])
      showMessage({ title: 'สำเร็จ', message: 'บันทึกสต๊อคคลังย่อยแล้ว' })
    } catch (e: any) {
      console.error('Save adjust failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'บันทึกไม่สำเร็จ: ' + (e?.message || String(e)) })
    } finally {
      setAdjustSaving(false)
    }
  }

  const deleteAssignedProduct = async (productId: string) => {
    if (!canModifySubWarehouseStock) {
      showMessage({ message: 'บัญชีนี้ไม่มีสิทธิ์ลบสินค้าออกจากคลังย่อย' })
      return
    }
    if (!selectedSubId) return
    const ok = await showConfirm({
      title: 'ลบสินค้าออกจากคลังย่อย',
      message: 'ต้องการลบสินค้าออกจากคลังย่อยหรือไม่? (ประวัติการเคลื่อนไหวยังอยู่)',
    })
    if (!ok) return
    try {
      const { error } = await supabase
        .from('wh_sub_warehouse_products')
        .delete()
        .eq('sub_warehouse_id', selectedSubId)
        .eq('product_id', productId)
      if (error) throw error
      await Promise.all([loadAssignedProducts(selectedSubId), loadDailySheet(selectedSubId)])
      showMessage({ title: 'สำเร็จ', message: 'ลบสินค้าออกจากคลังย่อยแล้ว' })
    } catch (e: any) {
      console.error('Delete assigned product failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'ลบสินค้าไม่สำเร็จ: ' + (e?.message || String(e)) })
    }
  }

  const canQuery = !!selectedSubId && !!dateFrom && !!dateTo
  const headerTitle = selectedSub ? `คลังย่อย: ${selectedSub.name}` : 'คลังย่อย'

  const canSaveProductTableImage =
    productViewMode !== 'history' &&
    products.length > 0 &&
    !(productViewMode === 'daily' && !loadingDaily && dailyRows.length === 0)

  const saveProductTableImage = useCallback(async () => {
    const el = productStockExportRef.current
    if (!el) return
    if (!products.length) {
      showMessage({ message: 'ไม่มีรายการสินค้าให้บันทึกเป็นภาพ' })
      return
    }
    if (productViewMode === 'daily' && !loadingDaily && dailyRows.length === 0) {
      showMessage({ message: 'ไม่มีข้อมูลตารางให้บันทึกเป็นภาพ' })
      return
    }
    setSavingTableImage(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const canvas = await html2canvas(el, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
      })
      const subPart = sanitizeExportFilenamePart(selectedSub?.name || 'sub')
      const datePart = productViewMode === 'daily' ? countDate : `${dateFrom}_${dateTo}`
      const modePart = productViewMode === 'daily' ? 'daily' : 'range'
      const link = document.createElement('a')
      link.download = `${subPart}_${modePart}_${datePart}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (e) {
      console.error('Save table image failed:', e)
      showMessage({ title: 'ผิดพลาด', message: 'บันทึกภาพไม่สำเร็จ' })
    } finally {
      setSavingTableImage(false)
    }
  }, [
    products.length,
    productViewMode,
    loadingDaily,
    dailyRows.length,
    selectedSub?.name,
    countDate,
    dateFrom,
    dateTo,
    showMessage,
  ])

  const moveHistoryContent = loadingMoves || loadingPeriodBalances || loadingWms ? (
    <div className="py-10 text-center text-slate-400">กำลังโหลด...</div>
  ) : filteredMoves.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-14 text-center">
      <div className="text-base font-black text-slate-800">ไม่มีประวัติในช่วงวันที่ที่เลือก</div>
      <div className="text-sm text-slate-600 mt-2">ลองขยายช่วงวันที่ หรือกดรีเฟรชข้อมูลหลังมีการบันทึกสต๊อค</div>
    </div>
  ) : (
    <div className="space-y-5">
      <div className="overflow-x-auto rounded-xl border border-emerald-100">
        <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-3">
          <div className="font-black text-emerald-950">สรุปยอดในช่วงวันที่เลือก</div>
        </div>
        <table className="w-full min-w-[1250px] text-sm">
          <thead>
            <tr className="bg-white text-slate-600">
              <th className="p-3 text-left">รหัส / สินค้า</th>
              <th className="p-3 text-right">ยอดต้นช่วง</th>
              <th className="p-3 text-right">เติมรวม</th>
              <th className="p-3 text-right">ลดด้วยมือ</th>
              <th className="p-3 text-right">ใบงาน</th>
              <th className="p-3 text-right">ใบเบิก</th>
              <th className="p-3 text-right">อื่น ๆ</th>
              <th className="p-3 text-right">ตัดสต๊อกรวม</th>
              <th className="p-3 text-right">คงเหลือปลายช่วง</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-emerald-100">
            {historySummaryRows.map((row) => (
              <tr key={row.product_id} className="bg-emerald-50/30">
                <td className="p-3">
                  <div className="font-bold text-slate-900">{row.product_code}</div>
                  <div className="text-xs text-slate-600">{row.product_name}</div>
                </td>
                <td className="p-3 text-right font-semibold tabular-nums">{row.opening?.toLocaleString() ?? '-'}</td>
                <td className="p-3 text-right font-bold text-emerald-700 tabular-nums">+{row.added.toLocaleString()}</td>
                <td className="p-3 text-right font-bold text-red-700 tabular-nums">-{row.removed.toLocaleString()}</td>
                <td className="p-3 text-right tabular-nums">{row.workOrder.toLocaleString()}</td>
                <td className="p-3 text-right tabular-nums">{row.requisition.toLocaleString()}</td>
                <td className="p-3 text-right tabular-nums">
                  {row.other > 0 ? (
                    <button
                      type="button"
                      onClick={() => void openOtherWmsDetails({ productId: row.product_id, productCode: row.product_code, productName: row.product_name, from: dateFrom, to: dateTo })}
                      className="font-black text-orange-700 underline decoration-dotted underline-offset-4 hover:text-orange-900"
                      title="ตรวจสอบรายการ WMS ที่ยังจำแนกไม่ได้"
                    >
                      {row.other.toLocaleString()}
                    </button>
                  ) : '0'}
                </td>
                <td className="p-3 text-right font-bold text-amber-700 tabular-nums">-{row.wmsUsed.toLocaleString()}</td>
                <td className="p-3 text-right font-black text-slate-950 tabular-nums">{row.closing?.toLocaleString() ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <div className="mb-2 font-black text-slate-800">รายการเพิ่ม/ลดด้วยมือ</div>
        <table className="w-full min-w-[980px] text-sm">
          <thead><tr className="bg-emerald-600 text-white">
            <th className="p-3 text-left rounded-tl-xl">เวลา</th>
            <th className="p-3 text-left">รหัส / สินค้า</th>
            <th className="p-3 text-center">ประเภท</th>
            <th className="p-3 text-right">จำนวน</th>
            <th className="p-3 text-right">ยอดสุทธิจากการปรับมือ</th>
            <th className="p-3 text-left rounded-tr-xl">เหตุผล/หมายเหตุ</th>
          </tr></thead>
          <tbody className="divide-y">{chronologicalMoves.map((move) => {
            const delta = Number(move.qty_delta || 0)
            const isAdd = delta >= 0
            const savedReason = move.reason?.trim() || ''
            const displayReason = !isAdd && savedReason === 'เติมสต๊อค' ? 'ลดสต๊อค' : savedReason || '-'
            return <tr key={move.id} className="hover:bg-slate-50">
              <td className="p-3 whitespace-nowrap text-slate-600">{new Date(move.created_at).toLocaleString('th-TH')}</td>
              <td className="p-3"><div className="font-semibold">{move.product_code}</div><div className="text-xs text-slate-600">{move.product_name}</div></td>
              <td className="p-3 text-center"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${isAdd ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{isAdd ? 'เติม' : 'ลดมือ'}</span></td>
              <td className={`p-3 text-right font-bold tabular-nums ${isAdd ? 'text-emerald-700' : 'text-red-700'}`}>{Math.abs(delta).toLocaleString()}</td>
              <td className="p-3 text-right font-bold tabular-nums">{Number(move.balance_after || 0).toLocaleString()}</td>
              <td className="p-3 text-slate-600"><div className="font-semibold text-slate-700">{displayReason}</div>{move.note && <div className="text-xs text-slate-500">{move.note}</div>}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div className="mt-4">
      <div className="space-y-6">
        <div className="min-w-0 flex flex-col gap-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden w-full">
            <div className="px-7 py-5 bg-gradient-to-r from-emerald-50 via-white to-white border-b border-slate-200">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">{headerTitle}</div>
                </div>
                <div className="flex flex-wrap items-end justify-end gap-2">
                  <div className="min-w-[240px]">
                    <select
                      value={selectedSubId}
                      onChange={(e) => setSelectedSubId(e.target.value)}
                      disabled={loadingSubs || subWarehouses.length === 0}
                      className="min-h-[44px] w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-bold text-slate-800 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50"
                    >
                      {subWarehouses.length === 0 && <option value="">ยังไม่มีคลังย่อย</option>}
                      {subWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
                    </select>
                  </div>
                  {canManageSubWarehouseSettings && (
                    <button
                      type="button"
                      onClick={() => setCreateModalOpen(true)}
                      className="min-h-[44px] rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
                    >
                      + เพิ่มชื่อคลังย่อย
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={openAddProduct}
                    className="min-h-[44px] rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    + เพิ่มสินค้า
                  </button>
                  {canManageSubWarehouseSettings && (
                    <button
                      type="button"
                      onClick={openRubberMapSettings}
                      disabled={!selectedSubId}
                      className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                    >
                      ตั้งค่าหน้ายาง
                    </button>
                  )}
                  {productViewMode !== 'history' && <button
                    type="button"
                    onClick={() => void saveProductTableImage()}
                    disabled={!canSaveProductTableImage || savingTableImage || loadingProducts}
                    className="min-h-[44px] rounded-xl border border-emerald-300 bg-white px-4 py-2.5 text-sm font-bold text-emerald-800 shadow-sm hover:bg-emerald-50 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {savingTableImage ? 'กำลังบันทึก…' : 'บันทึกภาพ'}
                  </button>}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <div className="inline-flex max-w-full overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
                  {([
                    ['daily', 'นับสต๊อครายวัน'],
                    ['history', 'ประวัติการเติม/ลด'],
                    ['range', 'ยอดรวมในช่วง'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setProductViewMode(mode)}
                      className={`min-h-[42px] whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-bold transition-colors ${
                        productViewMode === mode ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
                {productViewMode === 'daily' ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs font-bold text-slate-600">
                      วันที่นับ
                      <input
                        type="date"
                        value={countDate}
                        onChange={(e) => setCountDate(e.target.value)}
                        className="mt-1 min-h-[42px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                      />
                    </label>
                    {loadingDaily && <span className="pb-2 text-sm text-slate-400">กำลังคำนวณรายวัน…</span>}
                  </div>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="w-full text-xs font-bold text-slate-600 sm:w-[180px]">
                      จากวันที่
                      <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                    </label>
                    <label className="w-full text-xs font-bold text-slate-600 sm:w-[180px]">
                      ถึงวันที่
                      <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                    </label>
                    {productViewMode === 'history' && (
                      <label className="w-full text-xs font-bold text-slate-600 md:w-[420px]">
                        ค้นหารหัส/ชื่อสินค้า
                        <input type="search" value={historyProductCode} onChange={(e) => setHistoryProductCode(e.target.value)} placeholder="เช่น 110000001 หรือ PCA" className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                      </label>
                    )}
                    <button
                      type="button"
                      disabled={!canQuery || loadingMoves || loadingWms || loadingProducts || loadingPeriodBalances}
                      onClick={refreshAllForSelected}
                      className="min-h-[42px] w-auto shrink-0 rounded-xl bg-emerald-700 px-5 py-2 text-sm font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                    >
                      {(loadingMoves || loadingWms || loadingPeriodBalances) ? 'กำลังโหลด…' : 'แสดงข้อมูล'}
                    </button>
                  </div>
                )}
              </div>

              {productViewMode === 'range' && <div className="mt-3 max-w-5xl rounded-xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-sm text-slate-700">
                สรุปเฉพาะช่วงวันที่เลือก: <span className="font-bold">เติม − ลดด้วยมือ − ตัดสต๊อกรวม = เปลี่ยนแปลงสุทธิในช่วง</span>
              </div>}
            </div>

            <div className="p-6">
            {productViewMode !== 'history' && (
              <div className="mb-4">
                <label className="text-sm font-semibold text-slate-700">ค้นหาสินค้าในคลังย่อย</label>
                <input
                  type="search"
                  value={warehouseProductSearch}
                  onChange={(e) => setWarehouseProductSearch(e.target.value)}
                  placeholder="ค้นหาด้วยรหัสหรือชื่อสินค้า"
                  className="w-full mt-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>
            )}
            <div
              ref={productStockExportRef}
              className="rounded-xl border border-slate-100 bg-white p-3 sm:p-4 shadow-sm"
            >
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 pb-3">
                <div className="text-sm font-black text-slate-800">
                  {productViewMode === 'history' ? 'ประวัติการเติม/ลดสต๊อค' : productViewMode === 'range' ? 'ยอดรวมในช่วง' : 'รายการสินค้า'}
                </div>
              </div>
              {productViewMode !== 'history' && products.length > 1 && (warehouseProductSearch.trim() || savingProductOrder) && (
                <div className="mb-3 text-xs text-slate-500">
                  {warehouseProductSearch.trim() ? 'ล้างคำค้นหาเพื่อจัดลำดับสินค้า' : 'กำลังบันทึกลำดับ…'}
                </div>
              )}
            {productViewMode === 'history' ? (
              moveHistoryContent
            ) : loadingProducts ? (
              <div className="py-10 text-center text-slate-400">กำลังโหลด...</div>
            ) : products.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-14 text-center">
                <div className="text-base font-black text-slate-800">ยังไม่มีสินค้าในคลังย่อย</div>
                <div className="text-sm text-slate-600 mt-2 max-w-xl mx-auto">
                  กดปุ่ม <span className="font-bold text-blue-700">+ เพิ่มสินค้า</span> แล้วค้นหาด้วยรหัสสินค้าในระบบเพื่อเริ่มจดบันทึกสต๊อคคลังย่อย
                </div>
              </div>
            ) : productViewMode === 'daily' ? (
              loadingDaily && dailyRows.length === 0 ? (
                <div className="py-14 text-center text-slate-400 font-semibold">กำลังโหลดสรุปรายวัน…</div>
              ) : dailyRows.length === 0 ? (
                <div className="py-14 text-center text-slate-500 text-sm">
                  ไม่มีรายการสินค้า หรือโหลดสรุปรายวันไม่สำเร็จ — ลองกด <span className="font-bold text-slate-800">รีเฟรชข้อมูล</span>
                </div>
              ) : filteredDailyRows.length === 0 ? (
                <div className="py-14 text-center text-slate-500 text-sm">ไม่พบสินค้าที่ตรงกับคำค้นหา</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[1250px]">
                    <thead>
                      <tr className="bg-emerald-600 text-white">
                        <th className="p-3 text-center rounded-tl-xl w-12" aria-label="จัดลำดับ" />
                        <th className="p-3 text-left">รูป</th>
                        <th className="p-3 text-left">รหัสสินค้า</th>
                        <th className="p-3 text-left">ชื่อสินค้า</th>
                        <th className="p-3 text-center">หน่วย</th>
                        <th className="p-3 text-center whitespace-nowrap">คงเหลือต้นวัน</th>
                        <th className="p-3 text-center whitespace-nowrap">เติมสต๊อค</th>
                        <th className="p-3 text-center whitespace-nowrap">ลด (มือ)</th>
                        <th className="p-3 text-center whitespace-nowrap">ใบงาน</th>
                        <th className="p-3 text-center whitespace-nowrap">ใบเบิก</th>
                        <th className="p-3 text-center whitespace-nowrap">อื่น ๆ</th>
                        <th className="p-3 text-center whitespace-nowrap">ตัดสต๊อกรวม</th>
                        <th className="p-3 text-center whitespace-nowrap">คงเหลือ (สิ้นวัน)</th>
                        {canModifySubWarehouseStock && <th className="p-3 text-center rounded-tr-xl">จัดการ</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredDailyRows.map((p) => {
                        const dash = loadingDaily
                        const dailyUsage = dailyWmsUsageMap[p.product_code] || EMPTY_WMS_USAGE
                        return (
                          <tr
                            key={p.product_id}
                            onDragOver={(event) => { if (draggingProductId && !warehouseProductSearch.trim()) event.preventDefault() }}
                            onDrop={(event) => { event.preventDefault(); void reorderAssignedProducts(p.product_id) }}
                            className={`hover:bg-emerald-50 transition ${draggingProductId === p.product_id ? 'opacity-40' : ''}`}
                          >
                            <td className="p-2 text-center">
                              <button type="button" draggable={!savingProductOrder && !warehouseProductSearch.trim()} onDragStart={(event) => { setDraggingProductId(p.product_id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', p.product_id) }} onDragEnd={() => setDraggingProductId(null)} disabled={savingProductOrder || !!warehouseProductSearch.trim()} aria-label={`ลากจัดลำดับ ${p.product_name}`} title="ลากเพื่อเปลี่ยนลำดับ" className="cursor-grab rounded-lg px-2 py-1 text-xl leading-none text-slate-400 hover:bg-slate-100 hover:text-emerald-600 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30">≡</button>
                            </td>
                            <td className="p-3">
                              <ProductImage code={p.product_code} name={p.product_name} />
                            </td>
                            <td className="p-3 font-semibold">{p.product_code}</td>
                            <td className="p-3">{p.product_name}</td>
                            <td className="p-3 text-center text-slate-500">{p.unit_name || '-'}</td>
                            <td
                              className={`p-3 text-center font-semibold tabular-nums ${
                                !dash && p.balance_opening < 0 ? 'text-red-600' : ''
                              }`}
                            >
                              {dash ? '…' : p.balance_opening.toLocaleString()}
                            </td>
                            <td className="p-3 text-center tabular-nums text-emerald-800 font-semibold">
                              {dash ? '…' : p.replenish_day.toLocaleString()}
                            </td>
                            <td className="p-3 text-center tabular-nums text-slate-600">
                              {dash ? '…' : Math.abs(p.reduce_day).toLocaleString()}
                            </td>
                            <td className="p-3 text-center tabular-nums text-slate-700">{dash ? '…' : dailyUsage.workOrder.toLocaleString()}</td>
                            <td className="p-3 text-center tabular-nums text-slate-700">{dash ? '…' : dailyUsage.requisition.toLocaleString()}</td>
                            <td className="p-3 text-center tabular-nums">
                              {dash ? '…' : dailyUsage.other > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => void openOtherWmsDetails({ productId: p.product_id, productCode: p.product_code, productName: p.product_name, from: countDate, to: countDate })}
                                  className="font-black text-orange-700 underline decoration-dotted underline-offset-4 hover:text-orange-900"
                                  title="ตรวจสอบรายการ WMS ที่ยังจำแนกไม่ได้"
                                >
                                  {dailyUsage.other.toLocaleString()}
                                </button>
                              ) : <span className="text-slate-500">0</span>}
                            </td>
                            <td className="p-3 text-center tabular-nums font-semibold text-amber-700">
                              {dash ? '…' : p.wms_day.toLocaleString()}
                            </td>
                            <td
                              className={`p-3 text-center font-bold tabular-nums ${
                                !dash && p.balance_eod < 0 ? 'text-red-600' : 'text-slate-900'
                              }`}
                            >
                              {dash ? '…' : p.balance_eod.toLocaleString()}
                            </td>
                            {canModifySubWarehouseStock && (
                              <td className="p-3">
                                <div className="flex min-w-[10rem] items-center justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => openAdjustForProduct(p.product_id)}
                                    className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold"
                                  >
                                    เพิ่ม/ลด
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => deleteAssignedProduct(p.product_id)}
                                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold"
                                  >
                                    ลบ
                                  </button>
                                </div>
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : filteredWarehouseProducts.length === 0 ? (
              <div className="py-14 text-center text-slate-500 text-sm">ไม่พบสินค้าที่ตรงกับคำค้นหา</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1200px] text-sm">
                  <thead>
                    <tr className="bg-emerald-600 text-white">
                      <th className="p-3 text-center rounded-tl-xl w-12" aria-label="จัดลำดับ" />
                      <th className="p-3 text-left">รูป</th>
                      <th className="p-3 text-left">รหัสสินค้า</th>
                      <th className="p-3 text-left">ชื่อสินค้า</th>
                      <th className="p-3 text-center">หน่วย</th>
                      <th className="p-3 text-center">เติมในช่วง</th>
                      <th className="p-3 text-center">ลดด้วยมือ</th>
                      <th className="p-3 text-center">ใบงาน</th>
                      <th className="p-3 text-center">ใบเบิก</th>
                      <th className="p-3 text-center">อื่น ๆ</th>
                      <th className="p-3 text-center">ตัดสต๊อกรวม</th>
                      <th className="p-3 text-center">เปลี่ยนแปลงสุทธิ</th>
                      {canModifySubWarehouseStock && <th className="p-3 text-center rounded-tr-xl">จัดการ</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredWarehouseProducts.map((p) => {
                      const moveTotals = rangeMoveTotals.get(p.product_id) || { added: 0, removed: 0 }
                      const wmsQty = wmsCorrectMap[p.product_code] ?? 0
                      const wmsUsage = wmsUsageMap[p.product_code] || EMPTY_WMS_USAGE
                      const netChange = moveTotals.added - moveTotals.removed - Number(wmsQty || 0)
                      return (
                        <tr
                          key={p.product_id}
                          onDragOver={(event) => { if (draggingProductId && !warehouseProductSearch.trim()) event.preventDefault() }}
                          onDrop={(event) => { event.preventDefault(); void reorderAssignedProducts(p.product_id) }}
                          className={`hover:bg-emerald-50 transition ${draggingProductId === p.product_id ? 'opacity-40' : ''}`}
                        >
                          <td className="p-2 text-center">
                            <button type="button" draggable={!savingProductOrder && !warehouseProductSearch.trim()} onDragStart={(event) => { setDraggingProductId(p.product_id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', p.product_id) }} onDragEnd={() => setDraggingProductId(null)} disabled={savingProductOrder || !!warehouseProductSearch.trim()} aria-label={`ลากจัดลำดับ ${p.product_name}`} title="ลากเพื่อเปลี่ยนลำดับ" className="cursor-grab rounded-lg px-2 py-1 text-xl leading-none text-slate-400 hover:bg-slate-100 hover:text-emerald-600 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30">≡</button>
                          </td>
                          <td className="p-3">
                            <ProductImage code={p.product_code} name={p.product_name} />
                          </td>
                          <td className="p-3 font-semibold">{p.product_code}</td>
                          <td className="p-3">{p.product_name}</td>
                          <td className="p-3 text-center text-slate-500">{p.unit_name || '-'}</td>
                          <td className="p-3 text-center font-bold tabular-nums">
                            {moveTotals.added.toLocaleString()}
                          </td>
                          <td className="p-3 text-center tabular-nums text-red-600">
                            {moveTotals.removed.toLocaleString()}
                          </td>
                          <td className="p-3 text-center tabular-nums">{loadingWms ? '-' : wmsUsage.workOrder.toLocaleString()}</td>
                          <td className="p-3 text-center tabular-nums">{loadingWms ? '-' : wmsUsage.requisition.toLocaleString()}</td>
                          <td className="p-3 text-center tabular-nums">
                            {loadingWms ? '-' : wmsUsage.other > 0 ? (
                              <button
                                type="button"
                                onClick={() => void openOtherWmsDetails({ productId: p.product_id, productCode: p.product_code, productName: p.product_name, from: dateFrom, to: dateTo })}
                                className="font-black text-orange-700 underline decoration-dotted underline-offset-4 hover:text-orange-900"
                                title="ตรวจสอบรายการ WMS ที่ยังจำแนกไม่ได้"
                              >
                                {wmsUsage.other.toLocaleString()}
                              </button>
                            ) : <span className="text-slate-500">0</span>}
                          </td>
                          <td className="p-3 text-center font-semibold text-amber-700 tabular-nums">
                            {loadingWms ? '-' : Number(wmsQty || 0).toLocaleString()}
                          </td>
                          <td
                            className={`p-3 text-center font-bold tabular-nums ${
                              !loadingWms && netChange < 0 ? 'text-red-600' : 'text-slate-900'
                            }`}
                          >
                            {loadingWms ? '-' : netChange.toLocaleString()}
                          </td>
                          {canModifySubWarehouseStock && (
                            <td className="p-3">
                              <div className="flex min-w-[10rem] items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => openAdjustForProduct(p.product_id)}
                                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold"
                                >
                                  เพิ่ม/ลด
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteAssignedProduct(p.product_id)}
                                  className="px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold"
                                >
                                  ลบ
                                </button>
                              </div>
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
          </div>

        </div>
      </div>

      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-xl w-full"
      >
        <div className="p-6 space-y-5 text-slate-900">
          <div className="flex items-start gap-3 pr-14">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่มชื่อคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                สร้างคลังย่อยเพื่อใช้จดบันทึกจำนวนสต๊อคแยกจากสต๊อคหลัก
              </div>
            </div>
          </div>
          <div className="h-px bg-slate-200" />
          <div>
            <label className="text-sm font-semibold text-slate-700">ชื่อคลังย่อย</label>
            <input
              type="text"
              value={newSubName}
              onChange={(e) => setNewSubName(e.target.value)}
              placeholder="เช่น คลังย่อยหน้าร้าน"
              className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={creatingSub}
              onClick={createSubWarehouse}
              className="px-5 py-2.5 rounded-xl font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shadow-sm"
            >
              {creatingSub ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={addProductModalOpen}
        onClose={() => setAddProductModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-2xl w-full"
      >
        <div className="p-6 space-y-5 text-slate-900">
          <div className="flex items-start gap-3 pr-14">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่มสินค้าเข้าคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                ค้นหาด้วยรหัสสินค้าในระบบ แล้วเลือกเพื่อเพิ่มเข้า “{selectedSub?.name || 'คลังย่อย'}”
              </div>
            </div>
          </div>
          <div className="h-px bg-slate-200" />
          <div>
            <label className="text-sm font-semibold text-slate-700">ค้นหาด้วยรหัส/ชื่อสินค้า</label>
            <input
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="พิมพ์รหัสสินค้า..."
              className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              autoFocus
            />
            {productSearchLoading && (
              <div className="text-xs text-slate-400 mt-1">กำลังค้นหา...</div>
            )}
          </div>

          {productOptions.length > 0 && (
            <div className="max-h-72 overflow-auto border border-slate-200 rounded-2xl bg-white">
              <div className="divide-y">
                {productOptions.map((p) => {
                  const active = p.id === selectedProductId
                  return (
                    <button
                      type="button"
                      key={p.id}
                      onClick={() => setSelectedProductId(p.id)}
                      className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                        active ? 'bg-blue-50' : 'bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-black text-slate-900">{p.product_code}</div>
                          <div className="text-sm text-slate-600">{p.product_name}</div>
                        </div>
                        <div className="text-xs font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded-lg whitespace-nowrap">
                          {p.unit_name || '-'}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={addingProduct || !selectedProductId}
              onClick={addProductToSubWarehouse}
              className="px-5 py-2.5 rounded-xl font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 shadow-sm"
            >
              {addingProduct ? 'กำลังเพิ่ม...' : 'เพิ่มสินค้า'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={otherWmsModalOpen}
        onClose={() => setOtherWmsModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-6xl w-full max-h-[90vh] overflow-hidden"
      >
        <div className="flex max-h-[90vh] flex-col text-slate-900">
          <div className="border-b border-orange-100 bg-orange-50 px-6 py-5 pr-16">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-xl font-black text-orange-950">ตรวจสอบรายการ WMS ประเภท “อื่น ๆ”</div>
                <div className="mt-1 text-sm text-slate-700">
                  {otherWmsContext?.productCode} — {otherWmsContext?.productName}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  ช่วงวันที่ {otherWmsContext?.from} ถึง {otherWmsContext?.to}
                </div>
              </div>
              <div className="rounded-xl border border-orange-200 bg-white px-4 py-2 text-right">
                <div className="text-xs font-semibold text-slate-500">รวมที่ต้องตรวจสอบ</div>
                <div className="text-xl font-black text-orange-700">
                  {otherWmsRows.reduce((sum, row) => sum + row.qty, 0).toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-auto p-6">
            {otherWmsLoading ? (
              <div className="py-12 text-center font-semibold text-slate-400">กำลังโหลดรายละเอียด...</div>
            ) : otherWmsRows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center text-sm text-slate-600">
                ไม่พบรายการที่ยังจำแนกไม่ได้ในช่วงวันที่นี้ กรุณารีเฟรชหน้าคลังย่อยอีกครั้ง
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-orange-100">
                <table className="w-full min-w-[1050px] text-sm">
                  <thead>
                    <tr className="bg-orange-100 text-orange-950">
                      <th className="p-3 text-left">วันเวลา</th>
                      <th className="p-3 text-left">เลขอ้างอิง WMS</th>
                      <th className="p-3 text-left">สินค้าใน WMS</th>
                      <th className="p-3 text-right">จำนวน</th>
                      <th className="p-3 text-left">รูปแบบการจ่าย</th>
                      <th className="p-3 text-left">ผู้หยิบ</th>
                      <th className="p-3 text-left">สาเหตุ</th>
                      <th className="p-3 text-center">ตรวจต้นทาง</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {otherWmsRows.map((row) => (
                      <tr key={row.wms_order_id} className="hover:bg-orange-50/60">
                        <td className="p-3 whitespace-nowrap text-slate-600">
                          {row.used_at ? new Date(row.used_at).toLocaleString('th-TH') : '-'}
                        </td>
                        <td className="p-3 font-bold text-slate-900">{row.order_reference || '-'}</td>
                        <td className="p-3">
                          <div className="font-semibold">{row.product_code}</div>
                          <div className="text-xs text-slate-500">{row.product_name}</div>
                        </td>
                        <td className="p-3 text-right font-black tabular-nums">
                          {row.qty.toLocaleString()} {row.unit_name || ''}
                        </td>
                        <td className="p-3 text-slate-600">{row.fulfillment_mode || 'รายการเดิม'}</td>
                        <td className="p-3 text-slate-600">{row.picker_name || '-'}</td>
                        <td className="p-3 font-semibold text-orange-800">{row.classification_reason}</td>
                        <td className="p-3 text-center">
                          <a
                            href="/wms"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-100"
                          >
                            เปิด WMS
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-900">
              วิธีแก้: ตรวจเลขอ้างอิงกับใบงานหรือใบเบิกต้นทาง แล้วแก้การเชื่อมโยงให้ถูกต้อง รายการจะย้ายออกจาก “อื่น ๆ” อัตโนมัติหลังรีเฟรช
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={adjustModalOpen}
        onClose={() => setAdjustModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-2xl w-full"
      >
        <div className="p-6 space-y-5 text-slate-900">
          <div className="flex items-start gap-3 pr-14">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่ม/ลดสต๊อคคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                บันทึกรับเข้า/ลดยอดในคลังย่อย (ไม่ตัด/ไม่เพิ่มสต๊อคหลัก)
              </div>
            </div>
          </div>
          <div className="h-px bg-slate-200" />
          <div>
            <label className="text-sm font-semibold text-slate-700">ประเภท</label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => selectAdjustType('add')}
                className={`px-4 py-2 rounded-xl font-semibold border ${
                  adjustType === 'add'
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                    : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                }`}
              >
                เพิ่ม
              </button>
              <button
                type="button"
                onClick={() => selectAdjustType('remove')}
                className={`px-4 py-2 rounded-xl font-semibold border ${
                  adjustType === 'remove'
                    ? 'bg-red-600 text-white border-red-600 shadow-sm'
                    : 'bg-white text-red-700 border-red-200 hover:bg-red-50'
                }`}
              >
                ลด
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold text-slate-700">จำนวน</label>
              <input
                type="number"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
                placeholder="เช่น 10"
                className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
              />
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700">เหตุผล <span className="text-red-600">*</span></label>
              {adjustType === 'remove' ? (
                <select
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                >
                  <option value="">เลือกเหตุผลการลดมือ</option>
                  {MANUAL_REMOVE_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="เช่น เติมสต๊อค"
                  className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
                />
              )}
            </div>
          </div>

          {adjustType === 'remove' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="font-bold">ใช้ “ลดมือ” เฉพาะเหตุการณ์ที่ไม่ได้ถูกบันทึกในยอดตัดสต๊อกรวม</div>
              <div className="mt-1">รายการใบงานหรือใบเบิกที่ตรวจเป็น “ถูกต้อง” จะถูกรวมในยอดตัดสต๊อกรวมอัตโนมัติแล้ว</div>
            </div>
          )}

          <div>
            <label className="text-sm font-semibold text-slate-700">
              รายละเอียด {adjustType === 'remove' ? <span className="text-red-600">*</span> : <span className="font-normal text-slate-500">(ไม่บังคับ)</span>}
            </label>
            <input
              type="text"
              value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
              placeholder={adjustType === 'remove' ? 'ระบุเหตุการณ์หรือเอกสารอ้างอิง เพื่อให้ตรวจสอบย้อนหลังได้' : 'รายละเอียดเพิ่มเติม...'}
              className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={adjustSaving}
              onClick={saveAdjust}
              className="px-5 py-2.5 rounded-xl font-semibold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 shadow-sm"
            >
              {adjustSaving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={rubberMapModalOpen}
        onClose={() => setRubberMapModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-4xl w-full max-h-[90vh] overflow-y-auto"
      >
        <div className="p-6 space-y-5 text-slate-900">
          <div className="flex items-start gap-3 pr-14">
            <div>
              <div className="text-xl font-black text-slate-900">ตั้งค่าหน้ายาง</div>
              <div className="text-sm text-slate-500 mt-1">
                จับคู่ <span className="font-semibold">สินค้าอะไหล่</span> ในคลังย่อย กับ{' '}
                <span className="font-semibold">สินค้าผลิต</span>
              </div>
              <div className="text-sm text-slate-500 mt-1">
                คลังที่เลือก: <span className="font-bold text-slate-800">{selectedSub?.name || '-'}</span> · แสดงกลุ่มที่ใช้กับคลังนี้หรือกลุ่ม “ทุกคลังย่อย”
              </div>
            </div>
          </div>
          <div className="h-px bg-slate-200" />

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div className="text-sm font-black text-slate-800">สร้างกลุ่มจับคู่ใหม่</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-600">ชื่อกลุ่ม</label>
                <input
                  type="text"
                  value={mapNewGroupName}
                  onChange={(e) => setMapNewGroupName(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200 bg-white"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600">ขอบเขต</label>
                <select
                  value={mapNewGroupScope}
                  onChange={(e) => setMapNewGroupScope(e.target.value as 'current' | 'all')}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200 bg-white font-semibold"
                >
                  <option value="current">เฉพาะคลังย่อยที่เลือก</option>
                  <option value="all">ทุกคลังย่อย</option>
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void createWmsMapGroup()}
              className="px-4 py-2 rounded-xl font-bold text-sm bg-emerald-600 text-white hover:bg-emerald-700"
            >
              สร้างกลุ่ม
            </button>
          </div>

          <div>
            <label className="text-xs font-bold text-slate-600">ค้นหาชื่อกลุ่ม</label>
            <input
              type="search"
              value={mapGroupSearch}
              onChange={(e) => setMapGroupSearch(e.target.value)}
              placeholder="พิมพ์ชื่อกลุ่มที่ต้องการค้นหา"
              className="w-full mt-1 px-4 py-2.5 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {mapModalLoading ? (
            <div className="py-12 text-center text-slate-400 font-semibold">กำลังโหลด...</div>
          ) : mapUiGroups.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-sm">ยังไม่มีกลุ่ม — สร้างกลุ่มแล้วเพิ่มรหัสอะไหล่และสินค้าผลิตได้เลย</div>
          ) : filteredMapUiGroups.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-sm">ไม่พบกลุ่มที่ตรงกับคำค้นหา</div>
          ) : (
            <div className="space-y-3">
              {filteredMapUiGroups.map((g) => {
                const isExpanded = Boolean(expandedMapGroups[g.id])
                return (
                <div
                  key={g.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => void reorderWmsMapGroups(g.id)}
                  className={`relative rounded-2xl border bg-white transition-colors ${
                    isExpanded ? 'z-30 overflow-visible' : 'z-0 overflow-hidden'
                  } ${
                    draggingMapGroupId === g.id ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-stretch">
                    <div
                      draggable={!mapGroupSearch.trim()}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move'
                        setDraggingMapGroupId(g.id)
                      }}
                      onDragEnd={() => setDraggingMapGroupId(null)}
                      title={mapGroupSearch.trim() ? 'ล้างคำค้นหาก่อนปรับลำดับ' : 'ลากเพื่อปรับลำดับ'}
                      className={`px-3 flex items-center justify-center text-slate-400 select-none ${
                        mapGroupSearch.trim() ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing hover:text-emerald-600'
                      }`}
                      aria-label="ลากเพื่อปรับลำดับกลุ่ม"
                    >
                      ⋮⋮
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedMapGroups((prev) => ({ ...prev, [g.id]: !prev[g.id] }))}
                      className="flex-1 p-4 pl-1 flex items-center justify-between gap-3 text-left hover:bg-slate-50"
                      aria-expanded={isExpanded}
                    >
                      <div className="min-w-0">
                        <div className="font-black text-slate-900 truncate">{g.name}</div>
                        <div className="text-xs text-slate-500 mt-1">
                          อะไหล่ {g.spares.length} รายการ · สินค้าผลิต {g.sources.length} รายการ
                        </div>
                      </div>
                      <span className="text-xl text-slate-500 shrink-0" aria-hidden="true">{isExpanded ? '⌃' : '⌄'}</span>
                    </button>
                  </div>
                  {isExpanded && <div className="p-4 pt-0 space-y-4 border-t border-slate-100">
                  <div className="flex flex-wrap items-start justify-between gap-2 pt-4">
                    <div className="min-w-0 flex-1">
                      <label className="text-xs font-bold text-slate-600">ชื่อกลุ่ม</label>
                      <input
                        type="text"
                        defaultValue={g.name}
                        key={`${g.id}-name`}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          if (v && v !== g.name) void updateWmsMapGroupName(g.id, v)
                        }}
                        className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200 font-semibold"
                      />
                      <div className="text-xs text-slate-500 mt-1">
                        {g.sub_warehouse_id
                          ? `เฉพาะคลัง: ${subWarehouses.find((s) => s.id === g.sub_warehouse_id)?.name || g.sub_warehouse_id}`
                          : 'ใช้ได้ทุกคลังย่อย (เมื่อมีสินค้านั้นในรายการ)'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deleteWmsMapGroup(g.id)}
                      className="mt-7 px-3 py-2 rounded-xl text-sm font-bold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 shrink-0"
                    >
                      ลบกลุ่ม
                    </button>
                  </div>

                  <div>
                    <div className="text-sm font-black text-slate-800 mb-2">สินค้าอะไหล่ (หลายรายการได้)</div>
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-100 text-left">
                            <th className="p-2">รหัส</th>
                            <th className="p-2">ชื่อ</th>
                            <th className="p-2 w-24"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.spares.map((r) => (
                            <tr key={r.id} className="border-t border-slate-100">
                              <td className="p-2 font-mono font-semibold">{r.product_code}</td>
                              <td className="p-2 text-slate-700">{r.product_name}</td>
                              <td className="p-2">
                                <button
                                  type="button"
                                  onClick={() => void removeWmsMapLine('wh_sub_wms_map_spares', r.id)}
                                  className="text-red-600 font-bold text-xs hover:underline"
                                >
                                  ลบ
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex items-start gap-2">
                      <div className="relative min-w-[10rem] flex-1">
                      <input
                        type="search"
                        placeholder="ค้นหารหัสหรือชื่อสินค้าอะไหล่"
                        value={mapLineDraft[g.id]?.spare ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setMapLineDraft((prev) => ({
                            ...prev,
                            [g.id]: { spare: value, source: prev[g.id]?.source ?? '' },
                          }))
                          void searchWmsMapProducts(g.id, 'spare', value)
                        }}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200"
                      />
                      {mapProductSearchLoading[`${g.id}:spare`] && <div className="text-xs text-slate-400 mt-1">กำลังค้นหา...</div>}
                      {(mapProductOptions[`${g.id}:spare`] || []).length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                          {mapProductOptions[`${g.id}:spare`].map((product) => (
                            <button key={product.id} type="button" onClick={() => selectWmsMapProduct(g.id, 'spare', product)} className="w-full px-3 py-2 text-left hover:bg-emerald-50 border-b border-slate-100 last:border-0">
                              <div className="font-mono text-sm font-bold">{product.product_code}</div>
                              <div className="text-xs text-slate-600">{product.product_name}</div>
                            </button>
                          ))}
                        </div>
                      )}
                      </div>
                      <button
                        type="button"
                        disabled={!mapSelectedProducts[`${g.id}:spare`]}
                        onClick={() => void addWmsMapLine(g.id, 'spare')}
                        className="px-3 py-2 rounded-xl font-bold text-sm bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        เพิ่มอะไหล่
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-black text-slate-800 mb-2">สินค้าผลิต (รวมยอด WMS)</div>
                    <div className="overflow-x-auto rounded-xl border border-slate-100">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-100 text-left">
                            <th className="p-2">รหัส</th>
                            <th className="p-2">ชื่อ</th>
                            <th className="p-2 w-24"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.sources.map((r) => (
                            <tr key={r.id} className="border-t border-slate-100">
                              <td className="p-2 font-mono font-semibold">{r.product_code}</td>
                              <td className="p-2 text-slate-700">{r.product_name}</td>
                              <td className="p-2">
                                <button
                                  type="button"
                                  onClick={() => void removeWmsMapLine('wh_sub_wms_map_sources', r.id)}
                                  className="text-red-600 font-bold text-xs hover:underline"
                                >
                                  ลบ
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex items-start gap-2">
                      <div className="relative min-w-[10rem] flex-1">
                      <input
                        type="search"
                        placeholder="ค้นหารหัสหรือชื่อสินค้าผลิต"
                        value={mapLineDraft[g.id]?.source ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setMapLineDraft((prev) => ({
                            ...prev,
                            [g.id]: { spare: prev[g.id]?.spare ?? '', source: value },
                          }))
                          void searchWmsMapProducts(g.id, 'source', value)
                        }}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200"
                      />
                      {mapProductSearchLoading[`${g.id}:source`] && <div className="text-xs text-slate-400 mt-1">กำลังค้นหา...</div>}
                      {(mapProductOptions[`${g.id}:source`] || []).length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                          {mapProductOptions[`${g.id}:source`].map((product) => (
                            <button key={product.id} type="button" onClick={() => selectWmsMapProduct(g.id, 'source', product)} className="w-full px-3 py-2 text-left hover:bg-emerald-50 border-b border-slate-100 last:border-0">
                              <div className="font-mono text-sm font-bold">{product.product_code}</div>
                              <div className="text-xs text-slate-600">{product.product_name}</div>
                            </button>
                          ))}
                        </div>
                      )}
                      </div>
                      <button
                        type="button"
                        disabled={!mapSelectedProducts[`${g.id}:source`]}
                        onClick={() => void addWmsMapLine(g.id, 'source')}
                        className="px-3 py-2 rounded-xl font-bold text-sm bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        เพิ่มสินค้าผลิต
                      </button>
                    </div>
                  </div>
                  </div>}
                </div>
              )})}
            </div>
          )}

        </div>
      </Modal>

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}

function ProductImage({ code, name }: { code: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const url = code ? getProductImageUrl(code) : ''
  const displayUrl = url && !failed ? url : ''
  if (!displayUrl) {
    return (
      <div className="w-10 h-10 bg-slate-200 rounded-lg flex items-center justify-center text-slate-400 text-[10px]">
        ไม่มีรูป
      </div>
    )
  }
  return (
    <a
      href={displayUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-10 h-10 rounded-lg overflow-hidden hover:ring-2 hover:ring-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
      title="คลิกเพื่อเปิดรูปในแท็บใหม่"
    >
      <img
        src={displayUrl}
        alt={name}
        className="w-10 h-10 object-cover"
        onError={() => setFailed(true)}
      />
    </a>
  )
}

