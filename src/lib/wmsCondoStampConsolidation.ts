/** รายการสินค้าที่ให้แสดงรวมเป็นแถวเดียวใน WMS (รายการใบงาน / ตรวจสินค้า / Picker) */
export const CONDO_STAMP_CONSOLIDATE_PRODUCT_NAMES = new Set([
  'ตรายางคอนโด TWP ชมพู',
  'ตรายางคอนโด TWB ฟ้า',
])

export function normalizeWmsProductNameLabel(name: string | null | undefined): string {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeWmsLocationKey(loc: string | null | undefined): string {
  return String(loc || '')
    .trim()
    .replace(/\s+/g, '')
}

export function isConsolidatableCondoStampWmsRow(row: { product_name?: string | null }): boolean {
  return CONDO_STAMP_CONSOLIDATE_PRODUCT_NAMES.has(normalizeWmsProductNameLabel(row.product_name))
}

function groupKeyForCondoStampRow(row: {
  product_code?: string | null
  product_name?: string | null
  location?: string | null
}): string {
  return [
    String(row.product_code || '').trim(),
    normalizeWmsLocationKey(row.location),
    normalizeWmsProductNameLabel(row.product_name),
  ].join('\u0001')
}

export function getWmsConsolidatedRowIds(row: {
  id?: string | null
  _consolidated_wms_ids?: string[] | null
}): string[] {
  const extra = row._consolidated_wms_ids
  if (Array.isArray(extra) && extra.length > 0) return extra.map(String)
  if (row.id) return [String(row.id)]
  return []
}

type ConsolidatableRow = {
  id: string
  product_name?: string | null
  product_code?: string | null
  location?: string | null
  qty?: number | null
  status?: string | null
  created_at?: string | null
  unit_name?: string | null
  /** แคช optional จากการรวมรอบก่อนหน้า */
  _consolidated_wms_ids?: string[] | null
  _consolidated_line_count?: number | null
}

/** รวมแถวที่เป็นสินค้า condo stamp ชุดเดียวกัน (รหัส + จุดเก็บ + ชื่อ) และสถานะเดียวกันทุกแถว */
export function consolidateCondoStampWmsDisplayRows<T extends ConsolidatableRow>(
  rows: T[]
): (T & { _consolidated_wms_ids?: string[]; _consolidated_line_count?: number })[] {
  if (!rows || rows.length === 0) return []

  const byKey = new Map<string, T[]>()
  for (const r of rows) {
    if (!isConsolidatableCondoStampWmsRow(r)) continue
    const k = groupKeyForCondoStampRow(r)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }

  const mergedKeysHandled = new Set<string>()
  const out: (T & { _consolidated_wms_ids?: string[]; _consolidated_line_count?: number })[] = []

  for (const r of rows) {
    if (!isConsolidatableCondoStampWmsRow(r)) {
      out.push(r)
      continue
    }
    const k = groupKeyForCondoStampRow(r)
    if (mergedKeysHandled.has(k)) continue

    const group = byKey.get(k)!
    if (group.length <= 1) {
      out.push(group[0])
      mergedKeysHandled.add(k)
      continue
    }

    const status0 = String(group[0].status ?? '')
    const allSameStatus = group.every((g) => String(g.status ?? '') === status0)
    if (!allSameStatus) {
      for (const g of group) {
        out.push(g)
      }
      mergedKeysHandled.add(k)
      continue
    }

    const ordered = [...group].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0
      if (ta !== tb) return ta - tb
      return String(a.id).localeCompare(String(b.id))
    })

    const ids = ordered.map((g) => String(g.id))
    const qtySum = ordered.reduce((s, g) => s + Number(g.qty ?? 0), 0)
    const base = { ...ordered[0], qty: qtySum }
    out.push({
      ...base,
      _consolidated_wms_ids: ids,
      _consolidated_line_count: ids.length,
    })
    mergedKeysHandled.add(k)
  }

  return out
}

function groupKeyForDuplicateRow(row: {
  product_code?: string | null
  product_name?: string | null
  location?: string | null
  unit_name?: string | null
}): string {
  return [
    String(row.product_code || '').trim(),
    normalizeWmsLocationKey(row.location),
    normalizeWmsProductNameLabel(row.product_name),
    String(row.unit_name || '').trim(),
  ].join('\u0001')
}

/**
 * รวม “รายการที่เหมือนกัน” ให้เป็นแถวเดียว (สินค้า + จุดเก็บ + ชื่อ + หน่วย)
 * - รวม qty (ผลรวมของ qty ทุกแถว)
 * - รวม id ทั้งหมดไว้ใน `_consolidated_wms_ids` เพื่อให้ update/delete ทำทีเดียวได้
 * - ถ้าสถานะไม่เหมือนกันทั้งหมด จะตั้ง status = `mixed` และเก็บรายการสถานะไว้ใน `_consolidated_statuses`
 *
 * หมายเหตุ: แถว condo stamp ที่ถูก consolidate แบบพิเศษอยู่แล้ว จะไม่ถูกรวมซ้ำด้วยฟังก์ชันนี้
 */
export function consolidateDuplicateWmsRows<T extends ConsolidatableRow>(
  rows: T[]
): (T & { _consolidated_wms_ids?: string[]; _consolidated_line_count?: number; _consolidated_statuses?: string[] })[] {
  if (!rows || rows.length === 0) return []

  const byKey = new Map<string, T[]>()
  for (const r of rows) {
    // condo stamp: ให้คงพฤติกรรมเดิม (ไม่รวมซ้ำ)
    if (isConsolidatableCondoStampWmsRow(r)) continue
    const k = groupKeyForDuplicateRow(r)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }

  const mergedKeysHandled = new Set<string>()
  const out: (T & {
    _consolidated_wms_ids?: string[]
    _consolidated_line_count?: number
    _consolidated_statuses?: string[]
  })[] = []

  for (const r of rows) {
    if (isConsolidatableCondoStampWmsRow(r)) {
      out.push(r)
      continue
    }
    const k = groupKeyForDuplicateRow(r)
    if (mergedKeysHandled.has(k)) continue

    const group = byKey.get(k) || [r]
    if (group.length <= 1) {
      out.push(group[0])
      mergedKeysHandled.add(k)
      continue
    }

    const ordered = [...group].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0
      if (ta !== tb) return ta - tb
      return String(a.id).localeCompare(String(b.id))
    })

    const ids = ordered.flatMap((g) => getWmsConsolidatedRowIds(g))
    const qtySum = ordered.reduce((s, g) => s + Number(g.qty ?? 0), 0)
    const statuses = ordered.map((g) => String(g.status ?? '')).filter((s) => s !== '')
    const status0 = statuses[0] ?? ''
    const allSameStatus = statuses.length > 0 && statuses.every((s) => s === status0)

    const base = { ...ordered[0], qty: qtySum }
    out.push({
      ...(base as any),
      status: allSameStatus ? status0 : ('mixed' as any),
      _consolidated_wms_ids: ids,
      _consolidated_line_count: ids.length,
      _consolidated_statuses: allSameStatus ? undefined : Array.from(new Set(statuses)),
    })
    mergedKeysHandled.add(k)
  }

  return out
}

type CondoStampQtyItem = {
  product_name?: string | null
  qty?: number | null
  _consolidated_line_count?: number
}

/** จำนวนที่แสดงใน UI — รวมหลายบรรทัดของ condo stamp → แสดง 1 ชิ้น (หยิบจริงตามบริบท) */
export function getCondoStampDisplayQty(item: CondoStampQtyItem): number {
  if (isConsolidatableCondoStampWmsRow(item) && Number(item._consolidated_line_count || 0) > 1) {
    return 1
  }
  return Number(item.qty ?? 0)
}

/** วงเล็บจำนวนชั้น เช่น (5ชั้น) — เมื่อรวมหลายบรรทัดในระบบ */
export function getCondoStampLayersLabel(item: CondoStampQtyItem): string | null {
  if (!isConsolidatableCondoStampWmsRow(item)) return null
  const n = Number(item._consolidated_line_count || 0)
  if (n > 1) return `(${n}ชั้น)`
  return null
}

/** จำนวนแถว wms_orders หลังรวม condo stamp สำหรับ dashboard / badge */
export function countWmsOrdersAsDisplayLines(rows: ConsolidatableRow[]): number {
  if (!rows || rows.length === 0) return 0
  return consolidateCondoStampWmsDisplayRows(rows).length
}
