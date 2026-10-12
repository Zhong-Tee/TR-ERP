import { describe, expect, it } from 'vitest'
import { partitionTransportOrders } from './transportVerificationOrders'

describe('transport verification population', () => {
  it('separates the verified FLASH bill whose status regressed, keeping progress and rows consistent', () => {
    const shipped = Array.from({ length: 25 }, (_, index) => ({ id: `flash-${index}`, status: 'จัดส่งแล้ว', transport_meta: { verified: true } }))
    const regressed = { id: 'FBTR26100104', status: 'ใบสั่งงาน', shipped_time: '2026-10-12T08:16:48Z', transport_meta: { verified: true } }
    const { eligible, anomalies } = partitionTransportOrders([...shipped, regressed])
    expect(eligible).toHaveLength(25)
    expect(eligible.filter((o) => o.transport_meta.verified)).toHaveLength(25)
    expect(anomalies).toEqual([regressed])
    expect(partitionTransportOrders([...shipped, { ...regressed, status: 'จัดส่งแล้ว' }]).eligible).toHaveLength(26)
  })
  it('does not flag unshipped work or cancelled bills, but exposes stale packing evidence', () => {
    const rows = [{ status: 'ใบสั่งงาน' }, { status: 'ยกเลิก', transport_meta: { verified: true } }, { status: 'ใบงานกำลังผลิต', shipped_time: '2026-10-12T08:16:48Z' }]
    expect(partitionTransportOrders(rows).anomalies).toEqual([rows[2]])
  })
})
