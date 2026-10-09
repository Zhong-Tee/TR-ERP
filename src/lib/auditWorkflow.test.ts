import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudit, createAdjustmentFromAudit, fetchMovementAuditProductIds } from './auditApi'
import type { AuditType } from '../types'

type Row = Record<string, unknown>
const backend = vi.hoisted(() => ({ rows: {} as Record<string, Row[]>, moved: [] as string[], failItems: false, adjustmentItems: [] as Row[] }))
vi.mock('./supabase', () => {
  class Query {
    filters: Array<(row: Row) => boolean> = []
    operation = 'read'
    payload: Row[] = []
    one = false
    start = 0
    end = Infinity
    table: string
    constructor(table: string) { this.table = table }
    select() { return this }
    order() { return this }
    eq(key: string, value: unknown) { this.filters.push(row => row[key] === value); return this }
    in(key: string, values: unknown[]) { this.filters.push(row => values.includes(row[key])); return this }
    like() { return this }
    range(start: number, end: number) { this.start = start; this.end = end; return this }
    single() { this.one = true; return this }
    insert(values: Row | Row[]) { this.operation = 'insert'; this.payload = Array.isArray(values) ? values : [values]; return this }
    update(value: Row) { this.operation = 'update'; this.payload = [value]; return this }
    delete() { this.operation = 'delete'; return this }
    then(resolve: (value: { data: Row[] | Row | null; error: { message: string } | null }) => unknown) {
      const rows = backend.rows[this.table] ||= []
      if (this.operation === 'insert' && this.table === 'inv_audit_items' && backend.failItems) return Promise.resolve(resolve({ data: null, error: { message: 'item insert failed' } }))
      let result = rows.filter(row => this.filters.every(filter => filter(row)))
      if (this.operation === 'insert') {
        result = this.payload.map((row, index) => ({ id: `${this.table}-${rows.length + index}`, ...row }))
        rows.push(...result)
      } else if (this.operation === 'update') result.forEach(row => Object.assign(row, this.payload[0]))
      else if (this.operation === 'delete') backend.rows[this.table] = rows.filter(row => !result.includes(row))
      result = result.slice(this.start, this.end + 1)
      return Promise.resolve(resolve({ data: this.one ? result[0] || null : result, error: null }))
    }
  }
  return { supabase: {
    from: (table: string) => new Query(table),
    rpc: (name: string, values: Row) => {
      if (name === 'rpc_audit_movement_products') {
        backend.rows.movement_rpc = backend.moved.map(product_id => ({ product_id }))
        return new Query('movement_rpc')
      }
      if (name === 'rpc_create_inventory_adjustment') {
        backend.adjustmentItems = values.p_items as Row[]
        return Promise.resolve({ data: { adjustment_id: 'adjustment', adjust_no: 'ADJ-TEST' }, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  } }
})
vi.mock('./productLocationLabels', async () => {
  const actual = await vi.importActual<typeof import('./productLocationLabels')>('./productLocationLabels')
  return { ...actual, loadProductLocationSnapshotMap: async (products: Row[]) => Object.fromEntries(products.map(product => [product.id, [{ key: `storage:${product.storage_location}`, label_type: 'storage', location_id: product.storage_location, code: product.storage_location, name: product.storage_location, qty: 100 }]])) }
})

beforeEach(() => {
  backend.rows = {
    pr_products: [
      { id: 'rm', product_code: 'RM001', product_type: 'RM', is_active: true, product_category: 'raw', storage_location: 'A' },
      { id: 'physical-fg', product_code: 'FG001', product_type: 'FG', is_active: true, product_category: 'finished', storage_location: 'B' },
      { id: 'derived', product_code: 'FG002', product_type: 'FG', is_active: true, product_category: 'finished', storage_location: 'A' },
      { id: 'st', product_code: 'ST001', product_type: 'FG', is_active: true, product_category: 'finished', storage_location: 'C' },
    ],
    roll_material_configs: [{ id: 'config', fg_product_id: 'derived' }],
    wh_sub_wms_map_spares: [{ group_id: 'group', product_id: 'st' }],
    wh_sub_wms_map_sources: [{ group_id: 'group', product_id: 'rm' }],
    inv_stock_balances: [{ product_id: 'rm', on_hand: 100, safety_stock: 20, reserved: 7 }],
  }
  backend.moved = ['rm', 'derived', 'st']
  backend.failItems = false
  backend.adjustmentItems = []
})

describe('Audit creation across scopes', () => {
  const cases: Array<[AuditType, Record<string, string[]> | undefined, string[]]> = [
    ['full', undefined, ['rm','physical-fg','st']],
    ['category', { categories: ['finished'] }, ['physical-fg','st']],
    ['location', { locations: ['B'] }, ['physical-fg']],
    ['custom', { product_ids: ['rm','derived'] }, ['rm']],
    ['movement', { dates: ['2026-10-08','2026-10-08'] }, ['rm','st']],
  ]
  it.each(cases)('%s includes physical products, excludes derived FG and retains ST', async (auditType, scopeFilter, expected) => {
    const audit = await createAudit({ auditType, scopeFilter, assignedTo: ['auditor'], userId: 'store' })
    const items = backend.rows.inv_audit_items
    expect(items.map(row => row.product_id)).toEqual(expected)
    expect(audit.total_items).toBe(expected.length)
    expect(items.every(row => row.count_mode === 'separate')).toBe(true)
    const st = items.find(row => row.product_id === 'st')
    if (st) expect(st).toMatchObject({ product_type: 'ST', system_qty: 120, system_safety_stock: null, system_reserved: 7 })
  })
  it('does not leave a header when the scope has no physical products', async () => {
    await expect(createAudit({ auditType: 'custom', scopeFilter: { product_ids: ['derived'] }, assignedTo: ['auditor'], userId: 'store' })).rejects.toThrow('ไม่พบสินค้า')
    expect(backend.rows.inv_audits).toHaveLength(0)
  })
  it('does not create a header for an empty movement period', async () => {
    backend.moved = []
    await expect(createAudit({ auditType: 'movement', scopeFilter: { dates: ['2026-10-08','2026-10-08'] }, assignedTo: ['auditor'], userId: 'store' })).rejects.toThrow('ไม่พบสินค้า')
    expect(backend.rows.inv_audits || []).toHaveLength(0)
  })
  it('loads every movement product beyond the API page limit', async () => {
    backend.moved = Array.from({ length: 1005 }, (_, index) => `product-${index}`)
    const ids = await fetchMovementAuditProductIds('2026-10-08','2026-10-08')
    expect(ids).toHaveLength(1005)
    expect(ids[1004]).toBe('product-1004')
  })
  it('cleans up the header when item insertion fails', async () => {
    backend.failItems = true
    await expect(createAudit({ auditType: 'full', assignedTo: ['auditor'], userId: 'store' })).rejects.toThrow('item insert failed')
    expect(backend.rows.inv_audits).toHaveLength(0)
  })
  it('creates an adjustment for a safety-only discrepancy without subtracting safety from normal stock', async () => {
    backend.rows.inv_audits = [{ id: 'audit', audit_no: 'AUDIT-TEST', status: 'review' }]
    backend.rows.inv_audit_items = [{ id: 'item', audit_id: 'audit', product_id: 'rm', system_qty: 100, counted_qty: 100, variance: 0, count_mode: 'separate', system_safety_stock: 20, counted_safety_stock: 15, is_counted: true }]
    await createAdjustmentFromAudit('audit')
    expect(backend.adjustmentItems).toEqual([{ product_id: 'rm', target_on_hand: 100, target_safety: 15 }])
    expect(backend.rows.inv_audits[0].adjustment_id).toBe('adjustment')
  })
})
