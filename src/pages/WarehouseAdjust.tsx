import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import { getProductImageUrl } from '../components/wms/wmsUtils'
import { useAuthContext } from '../contexts/AuthContext'
import { InventoryAdjustment, InventoryAdjustmentItem, Product } from '../types'

interface DraftItem {
  product_id: string
  qty: number
  safety_stock: number | null
  order_point: number | null
}

interface StockBalance {
  product_id: string
  on_hand: number
  safety_stock: number | null
}

interface RollMapping {
  config_id: string
  rm_product_id: string
  fg_product_id: string
  sheets_per_roll: number
}

type AdjustmentType = 'audit_adjustment' | 'stocktake_reconcile' | 'safety_reclass'

const ADJUSTMENT_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: 'รออนุมัติ', className: 'bg-amber-500 text-white' },
  approved: { label: 'อนุมัติแล้ว', className: 'bg-green-500 text-white' },
  cancelled: { label: 'ยกเลิก', className: 'bg-gray-400 text-white' },
}

const TEMPLATE_HEADERS = ['product_code', 'on_hand', 'safety_stock'] as const

type ImportColumn = 'product_code' | 'qty' | 'on_hand' | 'safety_stock' | 'order_point'

const IMPORT_HEADER_ALIASES: Record<ImportColumn, string[]> = {
  product_code: ['product_code', 'productcode', 'sku', 'รหัสสินค้า', 'รหัส_สินค้า'],
  qty: ['qty', 'quantity', 'จำนวน', 'จำนวนจริง', 'สต๊อกใหม่', 'สต็อกใหม่'],
  on_hand: ['on_hand', 'onhand', 'current_stock', 'สต๊อกปัจจุบัน', 'สต็อกปัจจุบัน', 'คงเหลือ', 'ยอดคงเหลือ'],
  safety_stock: ['safety_stock', 'safetystock', 'safety', 'สต๊อกสำรอง', 'สต็อกสำรอง'],
  order_point: ['order_point', 'orderpoint', 'reorder_point', 'จุดสั่งซื้อ', 'จุดสั่งซื้อใหม่'],
}

function normalizeImportHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
    .replace(/[().]/g, '')
}

function canonicalImportHeader(value: unknown): ImportColumn | null {
  const normalized = normalizeImportHeader(value)
  for (const [column, aliases] of Object.entries(IMPORT_HEADER_ALIASES) as [ImportColumn, string[]][]) {
    if (aliases.includes(normalized)) return column
  }
  return null
}

function normalizeImportProductCode(value: unknown): string {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toUpperCase()
}

function parseImportNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === '') return null
  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

export default function WarehouseAdjust() {
  const { user } = useAuthContext()
  const canSeeCost = ['superadmin', 'account'].includes(user?.role || '')
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [balances, setBalances] = useState<Record<string, StockBalance>>({})
  const [nonAdjustableProductIds, setNonAdjustableProductIds] = useState<Set<string>>(new Set())
  const [rollMappings, setRollMappings] = useState<RollMapping[]>([])
  const [userMap, setUserMap] = useState<Record<string, string>>({})
  const [itemCountMap, setItemCountMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', qty: 0, safety_stock: null, order_point: null }])
  const [note, setNote] = useState('')
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('audit_adjustment')
  const [reasonCode, setReasonCode] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [viewing, setViewing] = useState<InventoryAdjustment | null>(null)
  const [viewItems, setViewItems] = useState<InventoryAdjustmentItem[]>([])
  const [viewSearch, setViewSearch] = useState('')
  const [viewBalanceMap, setViewBalanceMap] = useState<Record<string, StockBalance>>({})
  const [updating, setUpdating] = useState<string | null>(null)
  const [approveTarget, setApproveTarget] = useState<InventoryAdjustment | null>(null)
  const [approveDriftCount, setApproveDriftCount] = useState(0)
  const [approveSaving, setApproveSaving] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<InventoryAdjustment | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelSaving, setCancelSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Notification modal state
  const [notifyModal, setNotifyModal] = useState<{ open: boolean; type: 'success' | 'error' | 'warning'; title: string; message: string }>({
    open: false, type: 'success', title: '', message: '',
  })

  function showNotify(type: 'success' | 'error' | 'warning', title: string, message: string = '') {
    setNotifyModal({ open: true, type, title, message })
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [adjustRes, productRes, balanceRes, usersRes, itemCountRes, specialTrackedRes, rollConfigRes, rollRmRes] = await Promise.all([
        supabase.from('inv_adjustments').select('*').order('created_at', { ascending: false }),
        supabase.from('pr_products').select('id, product_code, product_name, order_point, unit_name').eq('is_active', true).order('product_code', { ascending: true }),
        supabase.from('inv_stock_balances').select('product_id, on_hand, safety_stock'),
        supabase.from('us_users').select('id, username'),
        supabase.rpc('rpc_inventory_adjustment_item_counts'),
        supabase.from('wh_sub_wms_map_spares').select('product_id'),
        supabase.from('roll_material_configs').select('id, fg_product_id, sheets_per_roll'),
        supabase.from('roll_material_config_rms').select('config_id, rm_product_id'),
      ])
      if (adjustRes.error) throw adjustRes.error
      if (productRes.error) throw productRes.error
      if (itemCountRes.error) throw itemCountRes.error
      setAdjustments((adjustRes.data || []) as InventoryAdjustment[])
      setProducts((productRes.data || []) as Product[])
      if (specialTrackedRes.error) throw specialTrackedRes.error
      if (rollConfigRes.error) throw rollConfigRes.error
      if (rollRmRes.error) throw rollRmRes.error
      setNonAdjustableProductIds(new Set((specialTrackedRes.data || []).map((row: { product_id: string }) => row.product_id)))
      const configMap = new Map((rollConfigRes.data || []).map((row) => [row.id, row]))
      setRollMappings((rollRmRes.data || []).flatMap((row) => {
        const config = configMap.get(row.config_id)
        if (!config) return []
        return [{
          config_id: row.config_id,
          rm_product_id: row.rm_product_id,
          fg_product_id: config.fg_product_id,
          sheets_per_roll: Number(config.sheets_per_roll || 0),
        }]
      }))

      // stock balances map
      const bMap: Record<string, StockBalance> = {}
      ;(balanceRes.data || []).forEach((row: any) => {
        bMap[row.product_id] = { product_id: row.product_id, on_hand: Number(row.on_hand || 0), safety_stock: row.safety_stock != null ? Number(row.safety_stock) : null }
      })
      setBalances(bMap)

      // users map
      const uMap: Record<string, string> = {}
      ;(usersRes.data || []).forEach((u: any) => { uMap[u.id] = u.username || u.id })
      setUserMap(uMap)

      // item count per adjustment
      const cMap: Record<string, number> = {}
      ;(itemCountRes.data || []).forEach((row: { adjustment_id: string; item_count: number | string }) => {
        cMap[row.adjustment_id] = Number(row.item_count) || 0
      })
      setItemCountMap(cMap)
    } catch (e) {
      console.error('Load adjustments failed:', e)
    } finally {
      setLoading(false)
    }
  }

  const derivedRollFgIds = useMemo(
    () => new Set(rollMappings.map((mapping) => mapping.fg_product_id)),
    [rollMappings],
  )

  const ambiguousRollRmIds = useMemo(() => {
    const configsByRm = new Map<string, Set<string>>()
    rollMappings.forEach((mapping) => {
      const configIds = configsByRm.get(mapping.rm_product_id) || new Set<string>()
      configIds.add(mapping.config_id)
      configsByRm.set(mapping.rm_product_id, configIds)
    })
    return new Set([...configsByRm.entries()].filter(([, ids]) => ids.size > 1).map(([id]) => id))
  }, [rollMappings])

  const productOptions = useMemo(
    () =>
      products.filter((p) =>
        !nonAdjustableProductIds.has(p.id)
        && (adjustmentType !== 'stocktake_reconcile' || !derivedRollFgIds.has(p.id))
      ).map((p) => ({
        value: p.id,
        label: `${p.product_code} - ${p.product_name} (${p.unit_name || 'ชิ้น'})`,
      })),
    [products, nonAdjustableProductIds, adjustmentType, derivedRollFgIds]
  )

  const filteredProductOptions = useMemo(() => {
    const keyword = productSearch.trim().toLowerCase()
    if (!keyword) return productOptions
    return productOptions.filter((opt) => opt.label.toLowerCase().includes(keyword))
  }, [productOptions, productSearch])

  const visibleDraftCount = useMemo(() => {
    const keyword = productSearch.trim().toLowerCase()
    if (!keyword) return draftItems.length
    return draftItems.filter((item) => {
      if (!item.product_id) return true
      const product = products.find((candidate) => candidate.id === item.product_id)
      return `${product?.product_code || ''} ${product?.product_name || ''}`.toLowerCase().includes(keyword)
    }).length
  }, [draftItems, productSearch, products])

  const productCodeMap = useMemo(() => {
    const map: Record<string, Product> = {}
    products.forEach((p) => {
      map[normalizeImportProductCode(p.product_code)] = p
    })
    return map
  }, [products])

  const productIdMap = useMemo(() => {
    const map: Record<string, Product> = {}
    products.forEach((p) => { map[p.id] = p })
    return map
  }, [products])

  const rollImpacts = useMemo(() => {
    if (adjustmentType !== 'stocktake_reconcile') return []
    const targetByProduct = new Map(draftItems.map((item) => [item.product_id, item.qty]))
    const impactedConfigIds = new Set(
      rollMappings
        .filter((mapping) => targetByProduct.has(mapping.rm_product_id))
        .map((mapping) => mapping.config_id),
    )
    return [...impactedConfigIds].map((configId) => {
      const mappings = rollMappings.filter((mapping) => mapping.config_id === configId)
      const first = mappings[0]
      const rmTotal = mappings.reduce((sum, mapping) => (
        sum + (targetByProduct.get(mapping.rm_product_id) ?? balances[mapping.rm_product_id]?.on_hand ?? 0)
      ), 0)
      return {
        configId,
        fgProductId: first.fg_product_id,
        sheetsPerRoll: first.sheets_per_roll,
        rmTotal,
        fgTarget: rmTotal * first.sheets_per_roll,
      }
    })
  }, [adjustmentType, balances, draftItems, rollMappings])

  async function formatApprovalError(error: unknown): Promise<{ title: string; message: string }> {
    const rawMessage = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? error)
    const fifoMatch = rawMessage.match(
      /(?:fn_consume_stock_fifo:\s*)?insufficient(?:\s+sellable)?\s+lots\s+for\s+product\s+([0-9a-f-]{36}),?\s*short\s+by\s+([0-9]+(?:\.[0-9]+)?)(?:\s+units?)?/i,
    )

    if (!fifoMatch) {
      if (rawMessage.includes('no items')) {
        return { title: 'ไม่มีรายการสินค้า', message: 'ใบปรับสต๊อกนี้ไม่มีรายการสินค้า กรุณายกเลิกใบนี้แล้วสร้างใหม่' }
      }
      if (rawMessage.includes('already has stock movements')) {
        return { title: 'ไม่ดำเนินการซ้ำ', message: 'ใบปรับสต๊อกนี้มีรายการเคลื่อนไหวสต๊อกแล้ว กรุณารีเฟรชและตรวจสอบสถานะล่าสุด' }
      }
      if (rawMessage.includes('Only a pending')) {
        return { title: 'สถานะเปลี่ยนแปลงแล้ว', message: 'อนุมัติได้เฉพาะใบที่อยู่ในสถานะรออนุมัติ กรุณารีเฟรชข้อมูลล่าสุด' }
      }
      return { title: 'อนุมัติไม่สำเร็จ', message: rawMessage }
    }

    const [, productId, shortText] = fifoMatch
    let product: Product | undefined = productIdMap[productId]
    if (!product) {
      const { data } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, unit_name')
        .eq('id', productId)
        .maybeSingle()
      if (data) product = data as Product
    }

    const shortQty = Number(shortText)
    const formattedShort = Number.isFinite(shortQty)
      ? shortQty.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : shortText
    const productLabel = product
      ? `${product.product_code} - ${product.product_name}`
      : 'สินค้ารายการนี้'
    const unit = product?.unit_name || 'หน่วย'

    return {
      title: 'สต๊อกสินค้าไม่เพียงพอ',
      message: `สินค้า ${productLabel}\nสต๊อกที่สามารถตัดได้ไม่เพียงพอ ขาดอีก ${formattedShort} ${unit}\n\nกรุณาตรวจสอบยอดล่าสุด หรือยกเลิกใบเดิมแล้วสร้างใบปรับสต๊อกใหม่`,
    }
  }

  function addDraftItem() {
    setDraftItems((prev) => [...prev, { product_id: '', qty: 0, safety_stock: null, order_point: null }])
  }

  const updateDraftItem = useCallback((index: number, patch: Partial<DraftItem>) => {
    setDraftItems((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    )
  }, [])

  const removeDraftItem = useCallback((index: number) => {
    setDraftItems((prev) => prev.filter((_, idx) => idx !== index))
  }, [])

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS as unknown as string[]])
    ws['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 16 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'ปรับสต๊อค')
    XLSX.writeFile(wb, 'Template_ปรับสต๊อค.xlsx')
  }

  function downloadCurrentProducts() {
    const headers = ['product_code', 'product_name', 'unit_name', 'on_hand', 'safety_stock', 'order_point']
    const rows = products.filter((p) => !nonAdjustableProductIds.has(p.id)).map((p) => {
      const b = balances[p.id]
      const op = p.order_point != null ? Number(p.order_point) : 0
      return [
        p.product_code,
        p.product_name,
        p.unit_name || 'ชิ้น',
        b ? b.on_hand : 0,
        b?.safety_stock ?? 0,
        Number.isFinite(op) ? op : 0,
      ]
    })
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = [
      { wch: 15 }, // product_code
      { wch: 30 }, // product_name
      { wch: 12 }, // unit_name
      { wch: 12 }, // on_hand
      { wch: 14 }, // safety_stock
      { wch: 14 }, // order_point
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'สินค้าปัจจุบัน')
    XLSX.writeFile(wb, `สินค้าปัจจุบัน_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  async function handleImport(file: File) {
    setImporting(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
      const firstSheet = wb.SheetNames[0]
      if (!firstSheet) throw new Error('ไม่มีชีตในไฟล์')
      const sheet = wb.Sheets[firstSheet]
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
      if (!grid.length) throw new Error('ไม่มีข้อมูลในไฟล์')

      let headerRowIndex = -1
      let columnIndex: Partial<Record<ImportColumn, number>> = {}
      for (let rowIndex = 0; rowIndex < Math.min(grid.length, 20); rowIndex++) {
        const candidate: Partial<Record<ImportColumn, number>> = {}
        ;(grid[rowIndex] || []).forEach((cell, index) => {
          const canonical = canonicalImportHeader(cell)
          if (canonical && candidate[canonical] == null) candidate[canonical] = index
        })
        if (candidate.product_code != null && (candidate.qty != null || candidate.on_hand != null)) {
          headerRowIndex = rowIndex
          columnIndex = candidate
          break
        }
      }
      if (headerRowIndex < 0) {
        throw new Error('ไม่พบหัวคอลัมน์รหัสสินค้าและจำนวน (product_code + qty หรือ on_hand) ใน 20 แถวแรก')
      }

      const qtyIndex = columnIndex.qty ?? columnIndex.on_hand
      const nextItemByProductId = new Map<string, DraftItem>()
      const blockedCodes: string[] = []
      const skippedDerivedFgCodes: string[] = []
      const ambiguousRmCodes: string[] = []
      const unknownCodes: string[] = []
      const invalidRows: string[] = []
      let duplicateCount = 0
      grid.slice(headerRowIndex + 1).forEach((row, offset) => {
        const excelRow = headerRowIndex + offset + 2
        const code = normalizeImportProductCode(row[columnIndex.product_code!])
        if (!code) return
        const product = productCodeMap[code]
        if (!product) {
          unknownCodes.push(`${code} (แถว ${excelRow})`)
          return
        }
        if (nonAdjustableProductIds.has(product.id)) {
          blockedCodes.push(code)
          return
        }
        if (derivedRollFgIds.has(product.id)) {
          skippedDerivedFgCodes.push(code)
          return
        }
        if (ambiguousRollRmIds.has(product.id)) {
          ambiguousRmCodes.push(code)
          return
        }
        const qty = parseImportNumber(row[qtyIndex!])
        if (qty == null || qty < 0) {
          invalidRows.push(`แถว ${excelRow}: ${code} จำนวนไม่ถูกต้อง`)
          return
        }
        const safetyRaw = columnIndex.safety_stock != null ? row[columnIndex.safety_stock] : ''
        const ss = parseImportNumber(safetyRaw)
        if (String(safetyRaw ?? '').trim() !== '' && (ss == null || ss < 0)) {
          invalidRows.push(`แถว ${excelRow}: ${code} Safety Stock ไม่ถูกต้อง`)
          return
        }
        const orderPointRaw = columnIndex.order_point != null ? row[columnIndex.order_point] : ''
        const opRaw = parseImportNumber(orderPointRaw)
        const op = opRaw != null && Number.isFinite(opRaw) ? opRaw : (product.order_point != null ? Number(product.order_point) || null : null)
        const targetSafety = ss ?? balances[product.id]?.safety_stock ?? 0
        if (nextItemByProductId.has(product.id)) duplicateCount++
        nextItemByProductId.set(product.id, { product_id: product.id, qty, safety_stock: targetSafety, order_point: op })
      })
      if (unknownCodes.length) {
        throw new Error(`ไม่พบรหัสสินค้าในระบบ: ${unknownCodes.slice(0, 10).join(', ')}${unknownCodes.length > 10 ? ` และอีก ${unknownCodes.length - 10} รายการ` : ''}`)
      }
      if (invalidRows.length) throw new Error(invalidRows.slice(0, 10).join('\n'))
      if (blockedCodes.length) {
        throw new Error(`ไม่สามารถปรับสินค้า ST ได้ กรุณาปรับ SKU สินค้าผลิตที่ผูกไว้แทน: ${blockedCodes.join(', ')}`)
      }
      if (ambiguousRmCodes.length) {
        throw new Error(`RM ถูกผูกกับสูตร FG มากกว่าหนึ่งรายการ กรุณาแก้การตั้งค่า Roll Material Calculator ก่อน: ${ambiguousRmCodes.join(', ')}`)
      }
      const nextItems = [...nextItemByProductId.values()]
      if (!nextItems.length) throw new Error('ไม่มีแถวที่ valid (ต้องมี product_code)')
      setDraftItems(nextItems)
      setAdjustmentType('stocktake_reconcile')
      setReasonCode('stocktake_import')
      setProductSearch('')
      setCreateOpen(true)
      const importWarnings: string[] = []
      if (skippedDerivedFgCodes.length > 0) {
        importWarnings.push(`ข้าม FG ที่คำนวณจาก RM ${skippedDerivedFgCodes.length} รายการ: ${skippedDerivedFgCodes.slice(0, 10).join(', ')}`)
      }
      if (duplicateCount > 0) {
        importWarnings.push(`พบรหัสซ้ำ ${duplicateCount} แถว ระบบใช้ค่าจากแถวสุดท้าย`)
      }
      if (importWarnings.length > 0) {
        showNotify('warning', 'นำเข้ายอดตรวจนับแล้ว', importWarnings.join('\n'))
      }
    } catch (e: any) {
      console.error('Import error:', e)
      showNotify('error', 'นำเข้าไม่สำเร็จ', e?.message || String(e))
    } finally {
      setImporting(false)
      importInputRef.current && (importInputRef.current.value = '')
    }
  }

  async function createAdjustment() {
    if (!note.trim()) {
      showNotify('warning', 'กรุณากรอกหัวข้อการปรับ')
      return
    }
    const blockedDraft = draftItems.find((item) => item.product_id && nonAdjustableProductIds.has(item.product_id))
    if (blockedDraft) {
      showNotify('warning', 'ไม่สามารถปรับสินค้า ST ได้', 'กรุณาปรับ SKU สินค้าผลิตที่ผูกไว้ในหน้าตั้งค่าหน้ายางแทน')
      return
    }
    if (adjustmentType === 'stocktake_reconcile') {
      const derivedFg = draftItems.find((item) => item.product_id && derivedRollFgIds.has(item.product_id))
      if (derivedFg) {
        const product = productIdMap[derivedFg.product_id]
        showNotify('warning', 'ไม่รับยอด FG ที่คำนวณจากม้วน', `${product?.product_code || 'FG รายการนี้'} จะคำนวณจากยอด RM โดยอัตโนมัติ`)
        return
      }
      const ambiguousRm = draftItems.find((item) => item.product_id && ambiguousRollRmIds.has(item.product_id))
      if (ambiguousRm) {
        const product = productIdMap[ambiguousRm.product_id]
        showNotify('warning', 'การผูกสูตร RM ไม่ชัดเจน', `${product?.product_code || 'RM รายการนี้'} ถูกผูกกับ FG มากกว่าหนึ่งสูตร กรุณาแก้การตั้งค่าก่อน`)
        return
      }
      const invalidRollFormula = rollImpacts.find((impact) => impact.sheetsPerRoll <= 0)
      if (invalidRollFormula) {
        const fg = productIdMap[invalidRollFormula.fgProductId]
        showNotify('warning', 'สูตรจำนวนแผ่นต่อม้วนไม่ถูกต้อง', `${fg?.product_code || 'FG รายการนี้'} ยังไม่ได้กำหนดจำนวนแผ่นต่อม้วน กรุณาแก้ใน Roll Material Calculator ก่อน`)
        return
      }
    }
    // กรองรายการที่มีสินค้า และมีการเปลี่ยนแปลงตามประเภทเอกสาร
    const validItems = draftItems.filter((i) => {
      if (!i.product_id) return false
      if (adjustmentType === 'stocktake_reconcile') return true
      const currentOnHand = balances[i.product_id]?.on_hand ?? 0
      const currentSafety = balances[i.product_id]?.safety_stock ?? 0
      const targetSafety = i.safety_stock ?? 0
      const qtyChanged = i.qty !== currentOnHand
      const safetyChanged = targetSafety !== currentSafety
      if (adjustmentType === 'safety_reclass') return safetyChanged
      return qtyChanged || safetyChanged
    })
    if (!validItems.length) {
      showNotify('warning', 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการที่มีค่าเปลี่ยนแปลง')
      return
    }
    setSaving(true)
    try {
      const rpcItems = validItems.map((item) => ({
        product_id: item.product_id,
        target_on_hand: item.qty,
        target_safety: item.safety_stock ?? 0,
      }))
      const { data: createResult, error: createError } = await supabase.rpc(
        'rpc_create_inventory_adjustment',
        {
          p_adjustment_type: adjustmentType,
          p_reason_code: reasonCode.trim() || null,
          p_note: note.trim(),
          p_items: rpcItems,
        },
      )
      if (createError) throw createError

      const createdItemCount = Number(createResult?.item_count ?? validItems.length)

      // ไม่อัปเดตทันที — ทุกค่ารออนุมัติก่อน

      setDraftItems([{ product_id: '', qty: 0, safety_stock: null, order_point: null }])
      setNote('')
      setAdjustmentType('audit_adjustment')
      setReasonCode('')
      setProductSearch('')
      setCreateOpen(false)
      await loadAll()
      showNotify('success', 'สร้างใบปรับสต๊อคเรียบร้อย', `${createdItemCount} รายการ — รออนุมัติ`)
    } catch (e: any) {
      console.error('Create adjustment failed:', e)
      showNotify('error', 'สร้างใบปรับสต๊อคไม่สำเร็จ', e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  async function openApproveAdjustment(adjustment: InventoryAdjustment) {
    if ((itemCountMap[adjustment.id] || 0) === 0) {
      showNotify('warning', 'ไม่สามารถอนุมัติได้', 'ใบปรับสต๊อกนี้ไม่มีรายการสินค้า กรุณายกเลิกใบนี้แล้วสร้างใหม่')
      return
    }
    setApproveDriftCount(0)
    if (adjustment.adjustment_type === 'stocktake_reconcile') {
      const { data: itemRows, error: itemError } = await supabase
        .from('inv_adjustment_items')
        .select('product_id, before_on_hand, before_safety_stock')
        .eq('adjustment_id', adjustment.id)
        .eq('is_system_generated', false)
      if (itemError) {
        showNotify('error', 'ตรวจสอบยอดล่าสุดไม่สำเร็จ', itemError.message)
        return
      }
      const productIds = (itemRows || []).map((item) => item.product_id)
      const { data: balanceRows, error: balanceError } = productIds.length
        ? await supabase.from('inv_stock_balances').select('product_id, on_hand, safety_stock').in('product_id', productIds)
        : { data: [], error: null }
      if (balanceError) {
        showNotify('error', 'ตรวจสอบยอดล่าสุดไม่สำเร็จ', balanceError.message)
        return
      }
      const liveByProduct = new Map((balanceRows || []).map((row) => [row.product_id, row]))
      const changedCount = (itemRows || []).filter((item) => {
        const live = liveByProduct.get(item.product_id)
        return Number(item.before_on_hand || 0) !== Number(live?.on_hand || 0)
          || Number(item.before_safety_stock || 0) !== Number(live?.safety_stock || 0)
      }).length
      setApproveDriftCount(changedCount)
    }
    setApproveTarget(adjustment)
  }

  async function confirmApproveAdjustment() {
    if (!approveTarget) return
    setApproveSaving(true)
    setUpdating(approveTarget.id)
    try {
      const { error } = await supabase.rpc('rpc_approve_inventory_adjustment', {
        p_adjustment_id: approveTarget.id,
      })
      if (error) throw error

      const approvedNo = approveTarget.adjust_no
      setApproveTarget(null)
      await loadAll()
      window.dispatchEvent(new Event('sidebar-refresh-counts'))
      showNotify('success', 'อนุมัติการปรับสต๊อกเรียบร้อย', approvedNo)
    } catch (e: unknown) {
      console.error('Approve adjustment failed:', e)
      const readableError = await formatApprovalError(e)
      showNotify('error', readableError.title, readableError.message)
    } finally {
      setApproveSaving(false)
      setUpdating(null)
    }
  }

  function openCancelAdjustment(adjustment: InventoryAdjustment) {
    setCancelTarget(adjustment)
    setCancelReason('')
  }

  async function confirmCancelAdjustment() {
    if (!cancelTarget) return
    const reason = cancelReason.trim()
    if (reason.length < 3) {
      showNotify('warning', 'กรุณาระบุเหตุผล', 'เหตุผลการยกเลิกต้องมีอย่างน้อย 3 ตัวอักษร')
      return
    }

    setCancelSaving(true)
    try {
      const { error } = await supabase.rpc('rpc_cancel_inventory_adjustment', {
        p_adjustment_id: cancelTarget.id,
        p_reason: reason,
      })
      if (error) throw error
      const cancelledNo = cancelTarget.adjust_no
      setCancelTarget(null)
      setCancelReason('')
      await loadAll()
      showNotify('success', 'ยกเลิกใบปรับสต๊อกแล้ว', cancelledNo)
    } catch (error: unknown) {
      console.error('Cancel adjustment failed:', error)
      const rawMessage = error instanceof Error
        ? error.message
        : String((error as { message?: unknown } | null)?.message ?? error)
      const friendlyMessage = rawMessage.includes('stock movements')
        ? 'ใบปรับสต๊อกนี้มีรายการเคลื่อนไหวสต๊อกแล้ว จึงไม่สามารถยกเลิกได้'
        : rawMessage.includes('Only a pending')
          ? 'ยกเลิกได้เฉพาะใบปรับสต๊อกที่อยู่ในสถานะรออนุมัติเท่านั้น'
          : rawMessage
      showNotify('error', 'ยกเลิกไม่สำเร็จ', friendlyMessage)
    } finally {
      setCancelSaving(false)
    }
  }

  async function openView(adjustment: InventoryAdjustment) {
    setViewSearch('')
    setViewing(adjustment)
    const { data, error } = await supabase
      .from('inv_adjustment_items')
      .select(`id, adjustment_id, product_id, qty_delta, approved_qty_delta, new_safety_stock, new_order_point, before_on_hand, after_on_hand, before_safety_stock, after_safety_stock${canSeeCost ? ', estimated_total_cost_impact, approved_total_cost_impact' : ''}, pr_products(product_code, product_name, unit_name)`)
      .eq('adjustment_id', adjustment.id)
    if (!error) {
      const rows = (data || []) as unknown as InventoryAdjustmentItem[]
      setViewItems(rows)

      const productIds = [...new Set(rows.map((r: any) => r.product_id).filter(Boolean))]
      if (!productIds.length) {
        setViewBalanceMap({})
        return
      }

      const { data: bRows, error: bError } = await supabase
        .from('inv_stock_balances')
        .select('product_id, on_hand, safety_stock')
        .in('product_id', productIds)

      if (bError) {
        setViewBalanceMap({})
        return
      }

      const map: Record<string, StockBalance> = {}
      ;(bRows || []).forEach((row: any) => {
        map[row.product_id] = {
          product_id: row.product_id,
          on_hand: Number(row.on_hand || 0),
          safety_stock: row.safety_stock != null ? Number(row.safety_stock) : 0,
        }
      })
      setViewBalanceMap(map)
    }
  }

  const filteredViewItems = useMemo(() => {
    const keyword = viewSearch.trim().toLocaleLowerCase('th')
    if (!keyword) return viewItems

    return viewItems.filter((item) => {
      const product = (item as InventoryAdjustmentItem & {
        pr_products?: { product_code?: string | null; product_name?: string | null }
      }).pr_products
      return `${product?.product_code || ''} ${product?.product_name || ''}`
        .toLocaleLowerCase('th')
        .includes(keyword)
    })
  }, [viewItems, viewSearch])

  return (
    <div className="space-y-6 mt-12">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={downloadTemplate}
          className="px-4 py-2 bg-gray-600 text-white rounded-xl hover:bg-gray-700 font-semibold text-sm"
        >
          ดาวน์โหลดฟอร์ม
        </button>
        <button
          type="button"
          onClick={downloadCurrentProducts}
          className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-semibold text-sm"
        >
          ดาวน์โหลดสินค้าปัจจุบัน
        </button>
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          disabled={importing || loading}
          className="px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          {importing ? 'กำลัง Import...' : 'Import ยอดตรวจนับ'}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImport(file)
          }}
        />
        <button
          type="button"
          onClick={() => {
            setAdjustmentType('audit_adjustment')
            setReasonCode('')
            setCreateOpen(true)
          }}
          className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold"
        >
          + สร้างใบปรับสต๊อค
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
          </div>
        ) : adjustments.length === 0 ? (
          <div className="text-center py-12 text-gray-500">ยังไม่มีการปรับสต๊อค</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">เลขที่ปรับสต๊อค</th>
                  <th className="p-3 text-left font-semibold">ประเภท</th>
                  <th className="p-3 text-left font-semibold">หัวข้อการปรับ</th>
                  <th className="p-3 text-left font-semibold">สถานะ</th>
                  <th className="p-3 text-left font-semibold">วันที่สร้าง</th>
                  <th className="p-3 text-left font-semibold">ผู้สร้าง</th>
                  <th className="p-3 text-left font-semibold">ผู้อนุมัติ</th>
                  <th className="p-3 text-center font-semibold">จำนวนรายการ</th>
                  <th className="p-3 text-right font-semibold rounded-tr-xl">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment, idx) => (
                  <tr key={adjustment.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{adjustment.adjust_no}</td>
                    <td className="p-3 text-sm text-gray-700">
                      {adjustment.adjustment_type === 'safety_reclass'
                        ? 'โยก Safety'
                        : adjustment.adjustment_type === 'stocktake_reconcile'
                          ? 'ตั้งยอดตามการตรวจนับ'
                          : 'ปรับเพิ่ม/ลดทั่วไป'}
                    </td>
                    <td className="p-3 text-sm text-gray-700">{adjustment.note || '-'}</td>
                    <td className="p-3">
                      <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold ${ADJUSTMENT_STATUS[adjustment.status]?.className || 'bg-gray-200 text-gray-700'}`}>
                        {updating === adjustment.id ? 'กำลังอนุมัติ...' : (ADJUSTMENT_STATUS[adjustment.status]?.label || adjustment.status)}
                      </span>
                    </td>
                    <td className="p-3">{new Date(adjustment.created_at).toLocaleString()}</td>
                    <td className="p-3 text-sm">{adjustment.created_by ? (userMap[adjustment.created_by] || '-') : '-'}</td>
                    <td className="p-3 text-sm">{adjustment.approved_by ? (userMap[adjustment.approved_by] || '-') : '-'}</td>
                    <td className="p-3 text-center">{itemCountMap[adjustment.id] || 0}</td>
                    <td className="p-3 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={() => openView(adjustment)}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
                        >
                          ดูรายละเอียด
                        </button>
                        {adjustment.status === 'pending' && (
                          <>
                            <button
                              type="button"
                              onClick={() => openCancelAdjustment(adjustment)}
                              disabled={updating === adjustment.id}
                              className="px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 text-sm font-semibold disabled:opacity-50"
                            >
                              ยกเลิก
                            </button>
                            <button
                              type="button"
                              onClick={() => void openApproveAdjustment(adjustment)}
                              disabled={updating === adjustment.id}
                              className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold disabled:opacity-50"
                            >
                              {updating === adjustment.id ? 'กำลังอนุมัติ...' : 'อนุมัติ'}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} contentClassName="w-[96vw] max-w-7xl !overflow-hidden flex flex-col">
        {/* Sticky Header */}
        <div className="px-6 pt-6 pb-3 border-b border-surface-200 shrink-0">
          <h2 className="text-xl font-bold">สร้างใบปรับสต๊อค</h2>
          <p className="text-sm text-gray-500 mt-1">
            {adjustmentType === 'stocktake_reconcile'
              ? 'จำนวนที่กรอกคือยอดคงเหลือใหม่หลังอนุมัติ ระบบจะปรับ Balance และ FIFO ให้ตรงกับยอดตรวจนับ'
              : 'กรอกเป้าหมายสต๊อคปัจจุบัน (เคลื่อนไหว + Safety Stock) ระบบคำนวณผลรวมและส่วนต่างให้อัตโนมัติ'}
            {' '}— รายการทั้งหมด {draftItems.length} รายการ
          </p>
          <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-700">สินค้า ST ไม่สามารถสร้างใบปรับสต๊อคได้ กรุณาปรับที่ SKU สินค้าผลิตซึ่งผูกไว้ใน “ตั้งค่าหน้ายาง”</p>
          {/* หัวข้อการปรับ (บังคับกรอก) */}
          <div className="mt-3 grid grid-cols-12 gap-2">
            <div className="col-span-4">
              <label className="block text-sm font-semibold text-gray-700 mb-1">ประเภทใบปรับ</label>
              <select
                value={adjustmentType}
                onChange={(e) => setAdjustmentType(e.target.value as AdjustmentType)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="audit_adjustment">ปรับยอดทั่วไป (ใช้ FIFO เดิม)</option>
                <option value="stocktake_reconcile">ตั้งยอดตามการตรวจนับ (ปรับ Balance และ FIFO ให้ตรง)</option>
                <option value="safety_reclass">โยก On-hand &lt;-&gt; Safety (ไม่เปลี่ยนมูลค่ารวม)</option>
              </select>
            </div>
            <div className="col-span-8">
              <label className="block text-sm font-semibold text-gray-700 mb-1">Reason Code (ไม่บังคับ)</label>
              <input
                type="text"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                placeholder="เช่น audit_count_mismatch, damaged, safety_rebalance"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-semibold text-gray-700 whitespace-nowrap">หัวข้อการปรับ <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="เช่น ปรับสต๊อคตามนับจริง, ปรับจากรายงาน Audit"
                className={`flex-1 px-3 py-2 border rounded-lg text-sm ${!note.trim() ? 'border-red-300' : 'border-gray-300'}`}
              />
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-semibold text-gray-700 whitespace-nowrap">ค้นหาสินค้า</label>
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="ค้นหารหัสหรือชื่อสินค้า เช่น P001, แก้ว 16oz"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
              <span className="text-xs text-gray-500 whitespace-nowrap">
                แสดง {visibleDraftCount.toLocaleString()} จาก {draftItems.length.toLocaleString()} แถว
              </span>
            </div>
          </div>
          {/* Column Headers */}
          <div className="grid grid-cols-12 gap-2 items-center text-sm font-semibold text-gray-600 mt-3">
            <div className="col-span-4">สินค้า</div>
            <div className="col-span-2 text-center">สต๊อคเคลื่อนไหว</div>
            <div className="col-span-2 text-center">Safety Stock</div>
            <div className="col-span-2 text-center">ยอดคงเหลือรวม</div>
            <div className="col-span-2 text-center">จัดการ</div>
          </div>
        </div>
        {/* Scrollable Body */}
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <DraftItemsList
            items={draftItems}
            productOptions={filteredProductOptions}
            balances={balances}
            productIdMap={productIdMap}
            adjustmentType={adjustmentType}
            searchTerm={productSearch}
            onUpdate={updateDraftItem}
            onRemove={removeDraftItem}
          />
          {adjustmentType === 'stocktake_reconcile' && rollImpacts.length > 0 && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <h3 className="text-sm font-bold text-emerald-900">FG ที่ระบบจะคำนวณจาก RM</h3>
              <div className="mt-2 space-y-2">
                {rollImpacts.map((impact) => {
                  const fg = productIdMap[impact.fgProductId]
                  const currentFg = balances[impact.fgProductId]?.on_hand ?? 0
                  return (
                    <div key={impact.configId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm">
                      <span className="font-medium text-gray-800">
                        {fg?.product_code || impact.fgProductId} - {fg?.product_name || 'FG'}
                      </span>
                      <span className="text-gray-600">
                        {impact.rmTotal.toLocaleString()} ม้วน × {impact.sheetsPerRoll.toLocaleString()} ={' '}
                        <strong className="text-emerald-700">{impact.fgTarget.toLocaleString()} แผ่น</strong>
                        {' '}({currentFg.toLocaleString()} → {impact.fgTarget.toLocaleString()})
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        {/* Sticky Footer */}
        <div className="px-6 py-4 border-t border-surface-200 shrink-0">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addDraftItem}
              className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
            >
              + เพิ่มรายการ
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={createAdjustment}
                disabled={saving || !note.trim()}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึกการปรับสต๊อค'}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={!!viewing} onClose={() => { setViewing(null); setViewSearch('') }} contentClassName="max-w-6xl">
        <div className="p-6 space-y-4">
          <h2 className="text-xl font-bold">รายละเอียดการปรับสต๊อค</h2>
          {viewing && (
            <div className="text-sm text-gray-600">
              เลขที่: <span className="font-medium text-gray-900">{viewing.adjust_no}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <input
              type="search"
              value={viewSearch}
              onChange={(event) => setViewSearch(event.target.value)}
              placeholder="ค้นหารหัสหรือชื่อสินค้า"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <span className="shrink-0 text-xs text-gray-500">
              แสดง {filteredViewItems.length.toLocaleString()} จาก {viewItems.length.toLocaleString()} รายการ
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 text-left">สินค้า</th>
                  <th className="p-2 text-center">สต๊อคเคลื่อนไหว (เดิม -&gt; ใหม่)</th>
                  <th className="p-2 text-right">Safety Stock (เดิม -&gt; ใหม่)</th>
                  <th className="p-2 text-right">จำนวนที่ปรับ</th>
                  {canSeeCost && <th className="p-2 text-right">ผลกระทบมูลค่า</th>}
                </tr>
              </thead>
              <tbody>
                {filteredViewItems.map((item: any) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={getProductImageUrl(item.pr_products?.product_code)}
                          alt={item.pr_products?.product_name || 'product'}
                          className="w-10 h-10 rounded-md object-cover border bg-gray-100 shrink-0"
                          onError={(e) => {
                            const target = e.currentTarget
                            target.style.display = 'none'
                          }}
                        />
                        <span>
                          {item.pr_products?.product_code} - {item.pr_products?.product_name}
                          {item.is_system_generated && (
                            <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">คำนวณจาก RM</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td className={`p-2 text-center font-medium ${Number(item.qty_delta) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {(() => {
                        const oldOnHand = item.before_on_hand != null
                          ? Number(item.before_on_hand)
                          : Number(viewBalanceMap[item.product_id]?.on_hand || 0) - Number(item.qty_delta || 0)
                        const newOnHand = item.after_on_hand != null
                          ? Number(item.after_on_hand)
                          : oldOnHand + Number(item.qty_delta || 0)
                        return `${oldOnHand.toLocaleString()} -> ${newOnHand.toLocaleString()} ${item.pr_products?.unit_name || 'ชิ้น'}`
                      })()}
                    </td>
                    <td className="p-2 text-right text-gray-600">
                      {(() => {
                        const oldSafety = item.before_safety_stock != null
                          ? Number(item.before_safety_stock)
                          : Number(viewBalanceMap[item.product_id]?.safety_stock || 0)
                        const newSafety = item.after_safety_stock != null
                          ? Number(item.after_safety_stock)
                          : Number(item.new_safety_stock ?? oldSafety)
                        return `${oldSafety.toLocaleString()} -> ${newSafety.toLocaleString()} ${item.pr_products?.unit_name || 'ชิ้น'}`
                      })()}
                    </td>
                    <td className={`p-2 text-right font-medium ${Number(item.approved_qty_delta ?? item.qty_delta) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {Number(item.approved_qty_delta ?? item.qty_delta) > 0 ? '+' : ''}{Number(item.approved_qty_delta ?? item.qty_delta).toLocaleString()} {item.pr_products?.unit_name || 'ชิ้น'}
                    </td>
                    {canSeeCost && <td className="p-2 text-right font-medium text-gray-700">
                      {Number(item.approved_total_cost_impact ?? item.estimated_total_cost_impact ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>}
                  </tr>
                ))}
                {!filteredViewItems.length && (
                  <tr>
                    <td className="p-2 text-center text-gray-500" colSpan={canSeeCost ? 5 : 4}>
                      {viewSearch.trim() ? 'ไม่พบสินค้าที่ค้นหา' : 'ไม่มีรายการ'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      {/* Approve adjustment confirmation */}
      <Modal
        open={Boolean(approveTarget)}
        onClose={() => !approveSaving && setApproveTarget(null)}
        closeOnBackdropClick={!approveSaving}
        contentClassName="max-w-md"
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600">
              <i className="fas fa-check" aria-hidden="true"></i>
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">ยืนยันอนุมัติใบปรับสต๊อก</h2>
              <p className="mt-1 text-sm text-gray-600">
                <span className="font-semibold text-gray-900">{approveTarget?.adjust_no}</span>
                {' '}จำนวน {(approveTarget ? itemCountMap[approveTarget.id] || 0 : 0).toLocaleString()} รายการ
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {approveTarget?.adjustment_type === 'stocktake_reconcile'
              ? 'ระบบจะตั้งยอดตามผลตรวจนับ ปรับ FIFO ให้ตรง และคำนวณ FG จาก RM ใหม่ ทุกขั้นตอนทำพร้อมกัน หากผิดพลาดจะไม่มีการเปลี่ยนแปลงทั้งใบ'
              : 'ระบบจะคำนวณจากยอดสต๊อกล่าสุด และดำเนินการทุกขั้นตอนพร้อมกัน หากรายการใดผิดพลาดจะไม่มีการเปลี่ยนแปลงทั้งใบ'}
          </div>
          {approveTarget?.adjustment_type === 'stocktake_reconcile' && approveDriftCount > 0 && (
            <div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-800">
              ยอดปัจจุบันเปลี่ยนหลังสร้างใบ {approveDriftCount.toLocaleString()} รายการ ระบบยังคงตั้งยอดปลายทางตามผลตรวจนับในใบนี้ กรุณาตรวจสอบก่อนอนุมัติ
            </div>
          )}

          <div className="flex justify-end gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => setApproveTarget(null)}
              disabled={approveSaving}
              className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              ย้อนกลับ
            </button>
            <button
              type="button"
              onClick={confirmApproveAdjustment}
              disabled={approveSaving}
              className="rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {approveSaving ? 'กำลังอนุมัติ...' : 'ยืนยันอนุมัติ'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Cancel pending adjustment confirmation */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => !cancelSaving && setCancelTarget(null)}
        closeOnBackdropClick={!cancelSaving}
        contentClassName="max-w-md"
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
              <i className="fas fa-ban" aria-hidden="true"></i>
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">ยกเลิกใบปรับสต๊อก</h2>
              <p className="mt-1 text-sm text-gray-600">
                ต้องการยกเลิก <span className="font-semibold text-gray-900">{cancelTarget?.adjust_no}</span> ใช่หรือไม่
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            ยกเลิกได้เฉพาะใบที่ยังไม่อนุมัติและยังไม่มีการเคลื่อนไหวสต๊อก
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-gray-700">
              เหตุผลการยกเลิก <span className="text-red-500">*</span>
            </label>
            <textarea
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              rows={3}
              maxLength={500}
              disabled={cancelSaving}
              placeholder="เช่น ยอดสต๊อกเปลี่ยนแปลงก่อนอนุมัติ ต้องสร้างใบใหม่"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
            />
            <p className="mt-1 text-xs text-gray-400">อย่างน้อย 3 ตัวอักษร</p>
          </div>

          <div className="flex justify-end gap-3 border-t pt-4">
            <button
              type="button"
              onClick={() => setCancelTarget(null)}
              disabled={cancelSaving}
              className="rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              ปิด
            </button>
            <button
              type="button"
              onClick={confirmCancelAdjustment}
              disabled={cancelSaving || cancelReason.trim().length < 3}
              className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancelSaving ? 'กำลังยกเลิก...' : 'ยืนยันยกเลิกใบปรับ'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Notification Modal */}
      <Modal open={notifyModal.open} onClose={() => setNotifyModal((p) => ({ ...p, open: false }))} closeOnBackdropClick contentClassName="max-w-sm">
        <div className="p-6 text-center">
          <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center mb-4 ${
            notifyModal.type === 'success' ? 'bg-green-100' : notifyModal.type === 'error' ? 'bg-red-100' : 'bg-amber-100'
          }`}>
            {notifyModal.type === 'success' && (
              <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
            {notifyModal.type === 'error' && (
              <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            {notifyModal.type === 'warning' && (
              <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>
          <h3 className={`text-lg font-bold mb-1 ${
            notifyModal.type === 'success' ? 'text-green-800' : notifyModal.type === 'error' ? 'text-red-800' : 'text-amber-800'
          }`}>
            {notifyModal.title}
          </h3>
          {notifyModal.message && (
            <p className="text-sm text-gray-600 mt-2 whitespace-pre-line leading-relaxed">{notifyModal.message}</p>
          )}
          <button
            type="button"
            onClick={() => setNotifyModal((p) => ({ ...p, open: false }))}
            className={`mt-5 px-6 py-2.5 rounded-xl font-semibold text-white transition-colors ${
              notifyModal.type === 'success' ? 'bg-green-600 hover:bg-green-700'
                : notifyModal.type === 'error' ? 'bg-red-600 hover:bg-red-700'
                : 'bg-amber-500 hover:bg-amber-600'
            }`}
          >
            ตกลง
          </button>
        </div>
      </Modal>
    </div>
  )
}

/** Memoized list เพื่อไม่ให้ re-render ทุก keystroke เมื่อพิมพ์ "หัวข้อการปรับ" */
const DraftItemsList = React.memo(function DraftItemsList({
  items,
  productOptions,
  balances,
  productIdMap,
  adjustmentType,
  searchTerm,
  onUpdate,
  onRemove,
}: {
  items: DraftItem[]
  productOptions: { value: string; label: string }[]
  balances: Record<string, StockBalance>
  productIdMap: Record<string, Product>
  adjustmentType: AdjustmentType
  searchTerm: string
  onUpdate: (index: number, patch: Partial<DraftItem>) => void
  onRemove: (index: number) => void
}) {
  const keyword = searchTerm.trim().toLowerCase()
  const visibleItems = items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => {
      if (!keyword || !item.product_id) return true
      const product = productIdMap[item.product_id]
      return `${product?.product_code || ''} ${product?.product_name || ''}`.toLowerCase().includes(keyword)
    })

  return (
    <div className="space-y-3">
      {visibleItems.map(({ item, originalIndex: index }) => (
        <div key={`draft-${index}`} className="space-y-1">
          <div className="grid grid-cols-12 gap-2 items-center">
            <div className="col-span-4">
              {(() => {
                const selectedProduct = item.product_id ? productIdMap[item.product_id] : null
                const selectedOpt = selectedProduct
                  ? { value: selectedProduct.id, label: `${selectedProduct.product_code} - ${selectedProduct.product_name} (${selectedProduct.unit_name || 'ชิ้น'})` }
                  : null
                const rowOptions = selectedOpt && !productOptions.some((opt) => opt.value === item.product_id)
                  ? [selectedOpt, ...productOptions]
                  : productOptions
                return (
              <select
                value={item.product_id}
                onChange={(e) => {
                  const pid = e.target.value
                  const b = pid ? balances[pid] : null
                  const p = pid ? productIdMap[pid] : null
                  onUpdate(index, {
                    product_id: pid,
                    qty: b ? b.on_hand : 0,
                    safety_stock: b?.safety_stock ?? 0,
                    order_point: p?.order_point != null ? (Number(p.order_point) || null) : null,
                  })
                }}
                className="w-full px-3 py-2 border rounded-lg bg-white text-sm"
              >
                <option value="">เลือกสินค้า</option>
                {rowOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
                )
              })()}
            </div>
            <div className="col-span-2">
              <input
                type="number"
                min="0"
                value={item.qty}
                onChange={(e) => onUpdate(index, { qty: Number(e.target.value) || 0 })}
                placeholder="จำนวนใช้งานที่ต้องการให้เป็นตอนนี้"
                disabled={adjustmentType === 'safety_reclass'}
                className="w-full px-3 py-2 border rounded-lg text-center text-sm disabled:bg-gray-100 disabled:text-gray-400"
              />
            </div>
            <div className="col-span-2">
              <input
                type="number"
                min="0"
                value={item.safety_stock ?? ''}
                onChange={(e) => onUpdate(index, { safety_stock: e.target.value !== '' ? Number(e.target.value) : null })}
                placeholder="จำนวนสำรองที่ต้องการให้เป็นตอนนี้"
                className="w-full px-3 py-2 border rounded-lg text-center text-sm"
              />
            </div>
            <div className="col-span-2">
              <input
                type="text"
                readOnly
                value={((item.qty || 0) + (item.safety_stock ?? 0)).toLocaleString()}
                className="w-full px-3 py-2 border rounded-lg text-center text-sm bg-gray-50 text-gray-700"
              />
            </div>
            <div className="col-span-2">
              <button
                type="button"
                onClick={() => onRemove(index)}
                disabled={items.length === 1}
                className="px-3 py-2 bg-red-100 text-red-600 rounded hover:bg-red-200 disabled:opacity-50 w-full text-sm"
              >
                ลบ
              </button>
            </div>
          </div>

          {item.product_id && (() => {
            const currentOnHand = balances[item.product_id]?.on_hand ?? 0
            const currentSafety = balances[item.product_id]?.safety_stock ?? 0
            const currentTotal = currentOnHand + currentSafety
            const targetOnHand = adjustmentType === 'safety_reclass'
              ? currentOnHand - ((item.safety_stock ?? 0) - currentSafety)
              : (item.qty || 0)
            const targetSafety = item.safety_stock ?? 0
            const targetTotal = targetOnHand + targetSafety
            const deltaOnHand = targetOnHand - currentOnHand
            const deltaSafety = targetSafety - currentSafety
            const formatDelta = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString()}`

            return (
              <p className="text-xs text-gray-500">
                หน่วย: {productIdMap[item.product_id]?.unit_name || 'ชิ้น'} • ปัจจุบัน: เคลื่อนไหว {currentOnHand.toLocaleString()} | Safety {currentSafety.toLocaleString()} | รวม {currentTotal.toLocaleString()} {' '}
                • หลังปรับ: เคลื่อนไหว {targetOnHand.toLocaleString()} | Safety {targetSafety.toLocaleString()} | รวม {targetTotal.toLocaleString()} {' '}
                • ระบบจะปรับ: เคลื่อนไหว {formatDelta(deltaOnHand)} | Safety {formatDelta(deltaSafety)}
              </p>
            )
          })()}
        </div>
      ))}
      {visibleItems.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500">
          ไม่พบสินค้าในรายการที่ตรงกับ “{searchTerm}”
        </div>
      )}
    </div>
  )
})
