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
  return `${ymd}T00:00:00`
}

function endOfDayIso(ymd: string): string {
  return `${ymd}T23:59:59`
}

export default function WarehouseSub() {
  const { user } = useAuthContext()
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  const [subWarehouses, setSubWarehouses] = useState<SubWarehouse[]>([])
  const [loadingSubs, setLoadingSubs] = useState(false)
  const [selectedSubId, setSelectedSubId] = useState<string>('')

  const [products, setProducts] = useState<AssignedProductRow[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)

  const [moves, setMoves] = useState<MoveRow[]>([])
  const [loadingMoves, setLoadingMoves] = useState(false)

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return toLocalYmd(d)
  })
  const [dateTo, setDateTo] = useState(() => toLocalYmd(new Date()))
  const [historyProductCode, setHistoryProductCode] = useState('')

  const [wmsCorrectMap, setWmsCorrectMap] = useState<Record<string, number>>({})
  const [loadingWms, setLoadingWms] = useState(false)

  /** วันที่นับสต๊อครายวัน (เขตเวลาไทย — ฝั่ง RPC) */
  const [countDate, setCountDate] = useState(() => toLocalYmd(new Date()))
  const [productViewMode, setProductViewMode] = useState<'daily' | 'history' | 'range'>('daily')
  const [warehouseProductSearch, setWarehouseProductSearch] = useState('')
  const [dailyRows, setDailyRows] = useState<DailySheetRow[]>([])
  const [loadingDaily, setLoadingDaily] = useState(false)

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
    if (!term) return dailyRows
    return dailyRows.filter((product) =>
      `${product.product_code} ${product.product_name}`.toLocaleLowerCase('th').includes(term),
    )
  }, [dailyRows, warehouseProductSearch])

  async function applyDynamicWmsMapsToCorrectMap(map: Record<string, number>, subId: string) {
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
      const sumByGroup: Record<string, number> = {}
      gids.forEach((gid) => {
        sumByGroup[gid] = 0
      })
      ;(sourceRows || []).forEach((s: { group_id: string; product_id: string }) => {
        const code = idToCode[String(s.product_id)]
        if (!code) return
        const gid = String(s.group_id)
        sumByGroup[gid] = (sumByGroup[gid] ?? 0) + (map[code] ?? 0)
      })
      spareRows.forEach((s: { group_id: string; product_id: string }) => {
        const code = idToCode[String(s.product_id)]
        if (!code) return
        const gid = String(s.group_id)
        map[code] = sumByGroup[gid] ?? 0
      })
    } catch (e) {
      console.warn('applyDynamicWmsMapsToCorrectMap skipped:', e)
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

  async function loadMoves(subId: string) {
    if (!dateFrom || !dateTo) return
    setLoadingMoves(true)
    try {
      const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_moves', {
        p_sub_warehouse_id: subId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_product_code: historyProductCode.trim() || null,
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
      const fromIso = startOfDayIso(dateFrom)
      const toIso = endOfDayIso(dateTo)
      const { data, error } = await supabase.rpc('rpc_get_wms_correct_qty_by_product', {
        p_from: fromIso,
        p_to: toIso,
      })
      if (error) throw error
      const map: Record<string, number> = {}
      ;(data || []).forEach((r: any) => {
        const code = String(r.product_code || '')
        if (!code) return
        map[code] = Number(r.correct_qty || 0)
      })
      await applyDynamicWmsMapsToCorrectMap(map, selectedSubId)
      setWmsCorrectMap(map)
    } catch (e: any) {
      console.error('Load WMS correct qty failed:', e)
      setWmsCorrectMap({})
    } finally {
      setLoadingWms(false)
    }
  }

  async function loadDailySheet(subId: string) {
    if (!countDate) return
    setLoadingDaily(true)
    try {
      const { data, error } = await supabase.rpc('rpc_get_sub_warehouse_daily_stock_sheet', {
        p_sub_warehouse_id: subId,
        p_date: countDate,
      })
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
    } catch (e: any) {
      console.error('Load daily stock sheet failed:', e)
      setDailyRows([])
      showMessage({
        title: 'ผิดพลาด',
        message: 'โหลดสรุปรายวันไม่สำเร็จ — ตรวจว่าได้รัน migration ล่าสุดของคลังย่อยแล้ว หรือลองรีเฟรช: ' + (e?.message || String(e)),
      })
    } finally {
      setLoadingDaily(false)
    }
  }

  const refreshAllForSelected = useCallback(async () => {
    if (!selectedSubId) return
    await Promise.all([
      loadAssignedProducts(selectedSubId),
      loadMoves(selectedSubId),
      loadWmsCorrect(),
      loadDailySheet(selectedSubId),
    ])
  }, [selectedSubId, dateFrom, dateTo, historyProductCode, countDate]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setAdjustProductId(productId)
    setAdjustType('add')
    setAdjustQty('')
    setAdjustReason('เติมสต๊อค')
    setAdjustNote('')
    setAdjustModalOpen(true)
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
    if (!selectedSubId || !adjustProductId) return
    const q = Number(String(adjustQty || '').replace(/,/g, '').trim())
    if (!Number.isFinite(q) || q <= 0) {
      showMessage({ message: 'กรุณากรอกจำนวนให้ถูกต้อง' })
      return
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

  const moveHistoryContent = loadingMoves ? (
    <div className="py-10 text-center text-slate-400">กำลังโหลด...</div>
  ) : moves.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-14 text-center">
      <div className="text-base font-black text-slate-800">ไม่มีประวัติในช่วงวันที่ที่เลือก</div>
      <div className="text-sm text-slate-600 mt-2">ลองขยายช่วงวันที่ หรือกดรีเฟรชข้อมูลหลังมีการบันทึกสต๊อค</div>
    </div>
  ) : (
    <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead><tr className="bg-slate-900 text-white">
        <th className="p-3 text-left rounded-tl-xl">เวลา</th><th className="p-3 text-left">รหัส</th>
        <th className="p-3 text-left">สินค้า</th><th className="p-3 text-right">+/-</th>
        <th className="p-3 text-right">คงเหลือหลังรายการ</th><th className="p-3 text-left rounded-tr-xl">เหตุผล/หมายเหตุ</th>
      </tr></thead>
      <tbody className="divide-y">{moves.map((move) => {
        const delta = Number(move.qty_delta || 0)
        return <tr key={move.id} className="hover:bg-slate-50">
          <td className="p-3 whitespace-nowrap text-slate-600">{new Date(move.created_at).toLocaleString('th-TH')}</td>
          <td className="p-3 font-semibold">{move.product_code}</td><td className="p-3">{move.product_name}</td>
          <td className={`p-3 text-right font-bold tabular-nums ${delta > 0 ? 'text-emerald-700' : 'text-red-700'}`}>{delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString()}</td>
          <td className="p-3 text-right font-bold tabular-nums">{Number(move.balance_after || 0).toLocaleString()}</td>
          <td className="p-3 text-slate-600"><div className="font-semibold text-slate-700">{move.reason || '-'}</div>{move.note && <div className="text-xs text-slate-500">{move.note}</div>}</td>
        </tr>
      })}</tbody>
    </table></div>
  )

  return (
    <div className="space-y-6 mt-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black text-slate-800">{headerTitle}</h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="px-4 py-2 rounded-xl font-semibold text-sm bg-emerald-600 text-white hover:bg-emerald-700"
          >
            + เพิ่มชื่อคลังย่อย
          </button>
          <button
            type="button"
            onClick={openAddProduct}
            className="px-4 py-2 rounded-xl font-semibold text-sm bg-blue-600 text-white hover:bg-blue-700"
          >
            + เพิ่มสินค้า
          </button>
          <button
            type="button"
            onClick={openRubberMapSettings}
            disabled={!selectedSubId}
            className="px-4 py-2 rounded-xl font-semibold text-sm bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >
            ตั้งค่าหน้ายาง
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Top controls: split left/right (รายชื่อคลังย่อย / ตัวกรองประวัติ) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="min-w-0 bg-white p-5 rounded-2xl shadow-sm border">
            <div className="flex items-center justify-between mb-3">
              <div className="font-black text-slate-800">รายชื่อคลังย่อย</div>
              {loadingSubs && <div className="text-xs text-slate-400">กำลังโหลด...</div>}
            </div>
            {subWarehouses.length === 0 ? (
              <div className="text-sm text-slate-500">ยังไม่มีคลังย่อย</div>
            ) : (
              <div className="space-y-2">
                {subWarehouses.map((s) => {
                  const active = s.id === selectedSubId
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedSubId(s.id)}
                      className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${
                        active
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900 font-bold'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {s.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="min-w-0 bg-white p-5 rounded-2xl shadow-sm border">
            <div className="font-black text-slate-800 mb-3">ตัวกรองประวัติ/ยอดผลิต</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-600">จากวันที่</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600">ถึงวันที่</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs font-bold text-slate-600">ค้นหารหัส/ชื่อสินค้า (เฉพาะประวัติ)</label>
                <input
                  type="text"
                  value={historyProductCode}
                  onChange={(e) => setHistoryProductCode(e.target.value)}
                  placeholder="เช่น 110000001 หรือ PCA"
                  className="w-full mt-1 px-3 py-2 rounded-xl border border-slate-200"
                />
              </div>
              <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap">
                <button
                  type="button"
                  disabled={!canQuery || loadingMoves || loadingWms || loadingProducts || loadingDaily}
                  onClick={refreshAllForSelected}
                  className="px-4 py-2 rounded-xl font-semibold text-sm bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 w-full sm:w-auto"
                >
                  รีเฟรชข้อมูล
                </button>
                {(loadingMoves || loadingWms || loadingDaily) && (
                  <div className="text-xs text-slate-400">กำลังโหลดข้อมูล…</div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right side data should expand full width */}
        <div className="min-w-0 flex flex-col gap-6">
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden w-full">
            <div className="px-7 py-5 bg-gradient-to-r from-emerald-50 via-white to-white border-b border-slate-200">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">สินค้าในคลังย่อย</div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <div className="inline-flex rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
                      <button
                        type="button"
                        onClick={() => setProductViewMode('daily')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-colors min-h-[44px] sm:min-h-0 ${
                          productViewMode === 'daily'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        นับสต๊อครายวัน
                      </button>
                      <button
                        type="button"
                        onClick={() => setProductViewMode('history')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-colors min-h-[44px] sm:min-h-0 ${
                          productViewMode === 'history'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        ประวัติการเติม/ลด
                      </button>
                      <button
                        type="button"
                        onClick={() => setProductViewMode('range')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-colors min-h-[44px] sm:min-h-0 ${
                          productViewMode === 'range'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        ยอดรวมในช่วง
                      </button>
                    </div>
                    {productViewMode === 'daily' && (
                      <label className="flex items-center gap-3 text-sm font-bold text-slate-600">
                        <span className="whitespace-nowrap">วันที่นับ</span>
                        <input
                          type="date"
                          value={countDate}
                          onChange={(e) => setCountDate(e.target.value)}
                          className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm"
                        />
                      </label>
                    )}
                    {productViewMode === 'daily' && loadingDaily && (
                      <span className="text-sm text-slate-400">กำลังคำนวณรายวัน…</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
                  {productViewMode !== 'history' && <button
                    type="button"
                    onClick={() => void saveProductTableImage()}
                    disabled={!canSaveProductTableImage || savingTableImage || loadingProducts}
                    className="px-4 py-2.5 rounded-xl text-sm font-bold bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-50 disabled:opacity-50 disabled:pointer-events-none shadow-sm whitespace-nowrap min-h-[44px]"
                  >
                    {savingTableImage ? 'กำลังบันทึก…' : 'บันทึกภาพ'}
                  </button>}
                  <div className="text-sm text-slate-500 bg-white/70 border border-slate-200 rounded-2xl px-4 py-2.5">
                    คลังที่เลือก: <span className="font-bold text-slate-800">{selectedSub?.name || '-'}</span>
                  </div>
                </div>
              </div>
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
                  {productViewMode === 'history' ? 'ประวัติการเติม/ลดสต๊อค' : 'สินค้าในคลังย่อย'}
                </div>
                <div className="text-xs text-slate-500">
                  {selectedSub?.name || '-'}
                  {productViewMode === 'daily'
                    ? ` · รายวัน ${countDate}`
                    : productViewMode === 'history'
                      ? ` · ประวัติ ${dateFrom} – ${dateTo}`
                      : ` · รวมช่วง ${dateFrom} – ${dateTo}`}
                </div>
              </div>
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
                  <table className="w-full text-sm min-w-[920px]">
                    <thead>
                      <tr className="bg-emerald-600 text-white">
                        <th className="p-3 text-left rounded-tl-xl">รูป</th>
                        <th className="p-3 text-left">รหัสสินค้า</th>
                        <th className="p-3 text-left">ชื่อสินค้า</th>
                        <th className="p-3 text-center">หน่วย</th>
                        <th className="p-3 text-center whitespace-nowrap">คงเหลือต้นวัน</th>
                        <th className="p-3 text-center whitespace-nowrap">เติมสต๊อค</th>
                        <th className="p-3 text-center whitespace-nowrap">ลด (มือ)</th>
                        <th className="p-3 text-center whitespace-nowrap">ผลิตใช้ไป</th>
                        <th className="p-3 text-center whitespace-nowrap">คงเหลือ (สิ้นวัน)</th>
                        <th className="p-3 text-center rounded-tr-xl">จัดการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredDailyRows.map((p) => {
                        const dash = loadingDaily
                        return (
                          <tr key={p.product_id} className="hover:bg-emerald-50">
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
                              {dash ? '…' : p.reduce_day === 0 ? '0' : p.reduce_day.toLocaleString()}
                            </td>
                            <td className="p-3 text-center tabular-nums text-slate-800">
                              {dash ? '…' : p.wms_day.toLocaleString()}
                            </td>
                            <td
                              className={`p-3 text-center font-bold tabular-nums ${
                                !dash && p.balance_eod < 0 ? 'text-red-600' : 'text-slate-900'
                              }`}
                            >
                              {dash ? '…' : p.balance_eod.toLocaleString()}
                            </td>
                            <td className="p-3">
                              <div className="grid w-full min-w-[13rem] grid-cols-3 items-center gap-1">
                                <div aria-hidden className="min-w-0" />
                                <div className="flex justify-center min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => openAdjustForProduct(p.product_id)}
                                    className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold"
                                  >
                                    เพิ่ม/ลด
                                  </button>
                                </div>
                                <div className="flex justify-end min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => deleteAssignedProduct(p.product_id)}
                                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold"
                                  >
                                    ลบ
                                  </button>
                                </div>
                              </div>
                            </td>
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
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-emerald-600 text-white">
                      <th className="p-3 text-left rounded-tl-xl">รูป</th>
                      <th className="p-3 text-left">รหัสสินค้า</th>
                      <th className="p-3 text-left">ชื่อสินค้า</th>
                      <th className="p-3 text-center">หน่วย</th>
                      <th className="p-3 text-center">รับเข้า</th>
                      <th className="p-3 text-center">ยอดผลิต (WMS)</th>
                      <th className="p-3 text-center">คงเหลือ</th>
                      <th className="p-3 text-center rounded-tr-xl">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredWarehouseProducts.map((p) => {
                      const receivedIn = Number(p.qty_on_hand || 0)
                      const wmsQty = wmsCorrectMap[p.product_code] ?? 0
                      const onHand = receivedIn - Number(wmsQty || 0)
                      return (
                        <tr key={p.product_id} className="hover:bg-emerald-50">
                          <td className="p-3">
                            <ProductImage code={p.product_code} name={p.product_name} />
                          </td>
                          <td className="p-3 font-semibold">{p.product_code}</td>
                          <td className="p-3">{p.product_name}</td>
                          <td className="p-3 text-center text-slate-500">{p.unit_name || '-'}</td>
                          <td className="p-3 text-center font-bold tabular-nums">
                            {receivedIn.toLocaleString()}
                          </td>
                          <td className="p-3 text-center tabular-nums">
                            {loadingWms ? '-' : Number(wmsQty || 0).toLocaleString()}
                          </td>
                          <td
                            className={`p-3 text-center font-bold tabular-nums ${
                              !loadingWms && onHand < 0 ? 'text-red-600' : 'text-slate-900'
                            }`}
                          >
                            {loadingWms ? '-' : onHand.toLocaleString()}
                          </td>
                          <td className="p-3">
                            <div className="grid w-full min-w-[13rem] grid-cols-3 items-center gap-1">
                              <div aria-hidden className="min-w-0" />
                              <div className="flex justify-center min-w-0">
                                <button
                                  type="button"
                                  onClick={() => openAdjustForProduct(p.product_id)}
                                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold"
                                >
                                  เพิ่ม/ลด
                                </button>
                              </div>
                              <div className="flex justify-end min-w-0">
                                <button
                                  type="button"
                                  onClick={() => deleteAssignedProduct(p.product_id)}
                                  className="px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-semibold"
                                >
                                  ลบ
                                </button>
                              </div>
                            </div>
                          </td>
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
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่มชื่อคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                สร้างคลังย่อยเพื่อใช้จดบันทึกจำนวนสต๊อคแยกจากสต๊อคหลัก
              </div>
            </div>
            <button
              type="button"
              onClick={() => setCreateModalOpen(false)}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center"
              aria-label="ปิด"
              title="ปิด"
            >
              ×
            </button>
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
              onClick={() => setCreateModalOpen(false)}
              className="px-4 py-2.5 rounded-xl font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"
            >
              ยกเลิก
            </button>
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
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่มสินค้าเข้าคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                ค้นหาด้วยรหัสสินค้าในระบบ แล้วเลือกเพื่อเพิ่มเข้า “{selectedSub?.name || 'คลังย่อย'}”
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAddProductModalOpen(false)}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center"
              aria-label="ปิด"
              title="ปิด"
            >
              ×
            </button>
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
              onClick={() => setAddProductModalOpen(false)}
              className="px-4 py-2.5 rounded-xl font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"
            >
              ยกเลิก
            </button>
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
        open={adjustModalOpen}
        onClose={() => setAdjustModalOpen(false)}
        closeOnBackdropClick
        contentClassName="max-w-2xl w-full"
      >
        <div className="p-6 space-y-5 text-slate-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-black text-slate-900">เพิ่ม/ลดสต๊อคคลังย่อย</div>
              <div className="text-sm text-slate-500 mt-1">
                บันทึกรับเข้า/ลดยอดในคลังย่อย (ไม่ตัด/ไม่เพิ่มสต๊อคหลัก)
              </div>
            </div>
            <button
              type="button"
              onClick={() => setAdjustModalOpen(false)}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center"
              aria-label="ปิด"
              title="ปิด"
            >
              ×
            </button>
          </div>
          <div className="h-px bg-slate-200" />
          <div>
            <label className="text-sm font-semibold text-slate-700">ประเภท</label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setAdjustType('add')}
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
                onClick={() => setAdjustType('remove')}
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
              <label className="text-sm font-semibold text-slate-700">เหตุผล</label>
              <input
                type="text"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="เช่น เติมสต๊อค"
                className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-semibold text-slate-700">หมายเหตุ (ไม่บังคับ)</label>
            <input
              type="text"
              value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
              placeholder="รายละเอียดเพิ่มเติม..."
              className="w-full mt-2 px-4 py-3 rounded-xl border border-slate-200 bg-white outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAdjustModalOpen(false)}
              className="px-4 py-2.5 rounded-xl font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"
            >
              ยกเลิก
            </button>
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
          <div className="flex items-start justify-between gap-3">
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
            <button
              type="button"
              onClick={() => setRubberMapModalOpen(false)}
              className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center shrink-0"
              aria-label="ปิด"
            >
              ×
            </button>
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

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setRubberMapModalOpen(false)}
              className="px-5 py-2.5 rounded-xl font-semibold bg-slate-900 text-white hover:bg-slate-800"
            >
              ปิด
            </button>
          </div>
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

