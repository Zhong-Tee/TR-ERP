import { describe, expect, it } from 'vitest'
import {
  formatLocationSnapshot,
  getMoveLocationInputName,
  locationSnapshotMatches,
  type AuditLocationSnapshotEntry,
  type ProductLocationLabelInput,
} from './productLocationLabels'

const snapshot: AuditLocationSnapshotEntry[] = [
  { key: 'storage:move', label_type: 'storage', location_id: 'move', code: 'MOVE', name: 'จุดหยิบ A2', qty: 70 },
  { key: 'storage:st02', label_type: 'storage', location_id: 'st02', code: 'ST-02', name: 'คลังสำรอง A2', qty: 300 },
  { key: 'safety', label_type: 'safety', location_id: null, code: 'SAFETY', name: 'ชั้น Safety A2', qty: 100 },
]

describe('product location audit snapshot', () => {
  it('formats every bucket without losing its code or product-specific name', () => {
    expect(formatLocationSnapshot(snapshot)).toBe(
      'MOVE: จุดหยิบ A2 · ST-02: คลังสำรอง A2 · SAFETY: ชั้น Safety A2',
    )
  })

  it('matches an audit location scope by code or product-specific name', () => {
    expect(locationSnapshotMatches(snapshot, ['ST-02'])).toBe(true)
    expect(locationSnapshotMatches(snapshot, ['safety a2'])).toBe(true)
    expect(locationSnapshotMatches(snapshot, ['คลังอื่น'])).toBe(false)
  })
})

describe('MOVE product location name', () => {
  const rows: ProductLocationLabelInput[] = [
    {
      label_type: 'storage', location_id: 'move', code: 'MOVE', default_name: 'Primary',
      display_name: 'Primary', configured_name: 'TEST-A5-S01-B03', qty: 70, sort_order: 0,
      input_name: ' TEST-A5-S01-B03 ',
    },
    {
      label_type: 'storage', location_id: 'st02', code: 'ST-02', default_name: 'Store 2',
      display_name: 'Store 2', configured_name: 'Reserve A2', qty: 300, sort_order: 1,
      input_name: 'Reserve A2',
    },
  ]

  it('uses the configured name of the MOVE storage bucket', () => {
    expect(getMoveLocationInputName(rows, 'legacy')).toBe('TEST-A5-S01-B03')
  })

  it('uses the legacy value only when MOVE is unavailable', () => {
    expect(getMoveLocationInputName(rows.filter((row) => row.code !== 'MOVE'), ' legacy ')).toBe('legacy')
  })
})
