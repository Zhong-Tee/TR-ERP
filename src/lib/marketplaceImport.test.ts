import { describe, expect, it } from 'vitest'
import { parseBangkokDateTime } from './marketplaceImport'

describe('parseBangkokDateTime', () => {
  it('parses TikTok day/month/year payment time as Bangkok time', () => {
    expect(parseBangkokDateTime('31/07/2026 19:24:46')).toBe('2026-07-31T12:24:46.000Z')
  })

  it('parses TikTok payment time without seconds', () => {
    expect(parseBangkokDateTime('31/07/2026 19:24')).toBe('2026-07-31T12:24:00.000Z')
  })

  it('keeps supporting the existing year-month-day format', () => {
    expect(parseBangkokDateTime('2026-07-31 19:24:46')).toBe('2026-07-31T12:24:46.000Z')
  })
})
