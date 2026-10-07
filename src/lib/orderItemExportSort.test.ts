import { describe, expect, it } from 'vitest'
import { sortOrderItemsForEditing, sortOrderItemsForBillDisplay, sortOrderItemsForExport } from './orderItemExportSort'

describe('stable bill item order', () => {
  const sequence = [5,10,6,9,13,2,1,4,8,12,14,11,7,3]
  const rows = sequence.map((n, index) => ({ id: String(index).padStart(2, '0'), item_uid: `PUMP26100054-${n}`, created_at: '2026-10-07T00:00:00Z', product_name: 'ตรายาง QM4 ชมพู' }))
  it('orders the reported bill numerically in editing, display and export', () => {
    for (const sort of [sortOrderItemsForEditing, sortOrderItemsForBillDisplay, sortOrderItemsForExport]) {
      expect(sort(rows).map(r => r.item_uid)).toEqual(Array.from({length:14}, (_,i) => `PUMP26100054-${i+1}`))
      expect(sort([...rows].reverse())).toEqual(sort(rows))
    }
    expect(rows.map(r => Number(r.item_uid.split('-').at(-1)))).toEqual(sequence)
  })
  it('preserves saved order independently of UID, timestamp and deleted gaps', () => {
    const items = [{id:'a',item_uid:'B-10',sort_order:3}, {id:'z',item_uid:'B-12',sort_order:1}, {id:'c',item_uid:'B-15',sort_order:4}]
    for (const sort of [sortOrderItemsForEditing, sortOrderItemsForBillDisplay, sortOrderItemsForExport]) {
      expect(sort(items).map(r => r.item_uid)).toEqual(['B-12','B-10','B-15'])
    }
  })
})
