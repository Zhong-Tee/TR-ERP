import { supabase } from './supabase'
import { fetchAllSupabasePages } from './supabasePagination'
import type { InventoryAuditItem } from '../types'

export type ProductLocationLabelType = 'movement' | 'storage' | 'safety'

export interface ProductLocationLabelRow {
  label_type: ProductLocationLabelType
  location_id: string | null
  code: string
  default_name: string
  display_name: string
  configured_name: string | null
  qty: number
  sort_order: number
}

export interface ProductLocationLabelInput extends ProductLocationLabelRow {
  input_name: string
}

export interface AuditLocationSnapshotEntry {
  key: string
  label_type: ProductLocationLabelType
  location_id: string | null
  code: string
  name: string
  qty: number
}

type SnapshotProduct = {
  id: string
  storage_location?: string | null
}

type SnapshotBalance = {
  systemQty: number
  systemSafetyStock: number
}

export async function fetchProductLocationLabels(productId: string): Promise<ProductLocationLabelRow[]> {
  const { data, error } = await supabase.rpc('rpc_get_product_location_labels', {
    p_product_id: productId,
  })
  if (error) throw error
  return (data || []).map((row: ProductLocationLabelRow) => ({
    ...row,
    qty: Number(row.qty || 0),
    sort_order: Number(row.sort_order || 0),
  }))
}

export async function saveProductLocationLabels(productId: string, rows: ProductLocationLabelInput[]) {
  const labels = rows
    .map((row) => ({
      label_type: row.label_type,
      location_id: row.location_id,
      display_name: row.input_name.trim(),
    }))
    .filter((row) => row.display_name !== '')

  const { error } = await supabase.rpc('rpc_set_product_location_labels', {
    p_product_id: productId,
    p_labels: labels,
  })
  if (error) throw error
}

export function toProductLocationLabelInputs(rows: ProductLocationLabelRow[]): ProductLocationLabelInput[] {
  return rows.map((row) => ({
    ...row,
    input_name: row.label_type === 'movement'
      ? (row.configured_name || row.display_name)
      : (row.configured_name || ''),
  }))
}

export function getMoveLocationInputName(
  rows: ProductLocationLabelInput[],
  legacyLocation = '',
): string {
  const moveRow = rows.find((row) => (
    row.label_type === 'storage' && row.code.trim().toUpperCase() === 'MOVE'
  ))
  return moveRow ? moveRow.input_name.trim() : legacyLocation.trim()
}

function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

export async function loadProductLocationSnapshotMap(
  products: SnapshotProduct[],
  balances: Record<string, SnapshotBalance>,
): Promise<Record<string, AuditLocationSnapshotEntry[]>> {
  if (products.length === 0) return {}

  const productIds = products.map((product) => product.id)
  const [{ data: locations, error: locationsError }, labelPages, stockPages] = await Promise.all([
    supabase
      .from('wh_storage_locations')
      .select('id, code, name, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .order('code'),
    Promise.all(chunks(productIds).map(async (ids) => {
      const { data, error } = await supabase
        .from('wh_product_location_labels')
        .select('product_id, label_type, location_id, display_name')
        .in('product_id', ids)
      if (error) throw error
      return data || []
    })),
    Promise.all(chunks(productIds).map(async (ids) => {
      const { data, error } = await supabase
        .from('wh_location_stock')
        .select('product_id, location_id, qty')
        .in('product_id', ids)
        .gt('qty', 0)
      if (error) throw error
      return data || []
    })),
  ])
  if (locationsError) throw locationsError

  const locationById = new Map((locations || []).map((location) => [location.id, location]))
  const labelsByProduct = new Map<string, Array<{ label_type: ProductLocationLabelType; location_id: string | null; display_name: string }>>()
  labelPages.flat().forEach((label) => {
    const rows = labelsByProduct.get(label.product_id) || []
    rows.push(label as { label_type: ProductLocationLabelType; location_id: string | null; display_name: string })
    labelsByProduct.set(label.product_id, rows)
  })
  const stockByProduct = new Map<string, Array<{ location_id: string; qty: number }>>()
  stockPages.flat().forEach((stock) => {
    const rows = stockByProduct.get(stock.product_id) || []
    rows.push({ location_id: stock.location_id, qty: Number(stock.qty || 0) })
    stockByProduct.set(stock.product_id, rows)
  })

  const result: Record<string, AuditLocationSnapshotEntry[]> = {}
  products.forEach((product) => {
    const labels = labelsByProduct.get(product.id) || []
    const safetyLabel = labels.find((label) => label.label_type === 'safety')
    const storageLabels = new Map(
      labels
        .filter((label) => label.label_type === 'storage' && label.location_id)
        .map((label) => [label.location_id as string, label.display_name]),
    )
    const stocks = new Map((stockByProduct.get(product.id) || []).map((stock) => [stock.location_id, stock.qty]))
    const storageIds = new Set([...storageLabels.keys(), ...stocks.keys()])
    const balance = balances[product.id] || { systemQty: 0, systemSafetyStock: 0 }

    const entries: AuditLocationSnapshotEntry[] = []

    ;[...storageIds]
      .map((locationId) => ({ locationId, location: locationById.get(locationId) }))
      .filter((row) => row.location)
      .sort((a, b) => {
        const sortDiff = Number(a.location?.sort_order || 0) - Number(b.location?.sort_order || 0)
        return sortDiff || String(a.location?.code || '').localeCompare(String(b.location?.code || ''))
      })
      .forEach(({ locationId, location }) => {
        if (!location) return
        entries.push({
          key: `storage:${locationId}`,
          label_type: 'storage',
          location_id: locationId,
          code: location.code,
          name: storageLabels.get(locationId) || location.name || location.code,
          qty: Number(stocks.get(locationId) || 0),
        })
      })

    entries.push({
      key: 'safety',
      label_type: 'safety',
      location_id: null,
      code: 'SAFETY',
      name: safetyLabel?.display_name || 'Safety stock',
      qty: Number(balance.systemSafetyStock || 0),
    })
    result[product.id] = entries
  })

  return result
}

export function formatLocationSnapshot(entries: AuditLocationSnapshotEntry[] | null | undefined): string {
  if (!Array.isArray(entries) || entries.length === 0) return '-'
  return entries.map((entry) => `${entry.code}: ${entry.name}`).join(' · ')
}

export function getAuditedLocationName(item: InventoryAuditItem): string {
  const rows = Array.isArray(item.location_snapshot) ? item.location_snapshot : []
  const matched = rows.find((entry) => entry.key === (item.actual_location_key || 'movement'))
  return matched ? `${matched.code} · ${matched.name}` : (item.system_location || item.storage_location || '-')
}

export function locationSnapshotMatches(entries: AuditLocationSnapshotEntry[], selectedNames: string[]): boolean {
  const filters = selectedNames.map((name) => name.trim().toLocaleLowerCase()).filter(Boolean)
  if (filters.length === 0) return true
  return entries.some((entry) => {
    const values = [entry.code, entry.name].map((value) => value.toLocaleLowerCase())
    return filters.some((filter) => values.some((value) => value.includes(filter)))
  })
}

export async function fetchDistinctProductLocationNames(): Promise<string[]> {
  const [products, labels, locations] = await Promise.all([
    fetchAllSupabasePages<{ storage_location: string | null }>((from, to) => supabase
      .from('pr_products')
      .select('storage_location')
      .eq('is_active', true)
      .order('id')
      .range(from, to)),
    fetchAllSupabasePages<{ display_name: string }>((from, to) => supabase
      .from('wh_product_location_labels')
      .select('display_name')
      .order('display_name')
      .range(from, to)),
    fetchAllSupabasePages<{ code: string; name: string | null }>((from, to) => supabase
      .from('wh_storage_locations')
      .select('code, name')
      .eq('is_active', true)
      .order('sort_order')
      .order('code')
      .range(from, to)),
  ])

  const names = new Set<string>(['Safety stock'])
  products.forEach((product) => {
    if (product.storage_location?.trim()) names.add(product.storage_location.trim())
  })
  labels.forEach((label) => {
    if (label.display_name?.trim()) names.add(label.display_name.trim())
  })
  locations.forEach((location) => {
    if (location.code?.trim()) names.add(location.code.trim())
    if (location.name?.trim()) names.add(location.name.trim())
  })
  return [...names].sort((a, b) => a.localeCompare(b, 'th'))
}
