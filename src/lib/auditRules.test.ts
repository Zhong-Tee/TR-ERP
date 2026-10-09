import { describe, expect, it } from 'vitest'
import { auditAdjustmentTarget, auditDateBounds, auditDateRange, compareAuditItems, hasAuditStockDifference } from './auditRules'
import type { InventoryAuditItem } from '../types'

const item = (values: Partial<InventoryAuditItem> = {}): InventoryAuditItem => ({ id: '1', audit_id: 'a', product_id: 'p', system_qty: 100, counted_qty: 100, variance: 0, system_safety_stock: 20, counted_safety_stock: 20, count_mode: 'separate', is_counted: true, created_at: '', ...values })

describe('Audit counts and movement dates', () => {
  it('keeps normal and safety targets separate without subtracting twice', () => {
    expect(auditAdjustmentTarget(item())).toEqual({ product_id: 'p', target_on_hand: 100, target_safety: 20 })
    expect(hasAuditStockDifference(item())).toBe(false)
  })
  it('includes a safety-only difference even when the total stays unchanged', () => {
    expect(hasAuditStockDifference(item({ counted_safety_stock: 15 }))).toBe(true)
    expect(hasAuditStockDifference(item({ counted_qty: 105, variance: 5, counted_safety_stock: 15 }))).toBe(true)
    expect(auditAdjustmentTarget(item({ counted_qty: 105, counted_safety_stock: 15 })).target_on_hand).toBe(105)
  })
  it('handles zero safety and preserves the legacy total interpretation', () => {
    expect(auditAdjustmentTarget(item({ counted_safety_stock: 0 })).target_safety).toBe(0)
    expect(auditAdjustmentTarget(item({ count_mode: 'legacy', counted_qty: 120 })).target_on_hand).toBe(100)
  })
  it('rejects invalid targets', () => {
    expect(() => auditAdjustmentTarget(item({ counted_qty: -1 }))).toThrow()
    expect(() => auditAdjustmentTarget(item({ counted_safety_stock: NaN }))).toThrow()
  })
  it('uses complete Bangkok days and excludes the next midnight', () => {
    expect(auditDateRange(1, new Date('2026-10-08T18:00:00Z'))).toEqual({ start: '2026-10-08', end: '2026-10-08' })
    expect(auditDateRange(7, new Date('2026-10-08T18:00:00Z'))).toEqual({ start: '2026-10-02', end: '2026-10-08' })
    expect(auditDateBounds('2026-10-08', '2026-10-08')).toEqual({ from: '2026-10-07T17:00:00.000Z', to: '2026-10-08T17:00:00.000Z' })
    expect(() => auditDateBounds('2026-02-30', '2026-03-01')).toThrow()
    expect(() => auditDateBounds('2026-10-09', '2026-10-08')).toThrow()
  })
  it('orders locations before RM, FG, ST and puts missing locations last', () => {
    const located = (id: string, type: string, code: string, order = 0) => item({ id, product_type: type, location_snapshot: [{ key: code, label_type: 'storage', location_id: code, code, name: code, qty: 1, sort_order: order }] })
    const rows = [located('st', 'ST', 'A'), located('b', 'RM', 'B', 1), located('fg', 'FG', 'A'), item({ id: 'missing', product_type: 'RM' }), located('rm', 'RM', 'A')]
    expect(rows.sort(compareAuditItems).map(row => row.id)).toEqual(['rm', 'fg', 'st', 'b', 'missing'])
  })
})
