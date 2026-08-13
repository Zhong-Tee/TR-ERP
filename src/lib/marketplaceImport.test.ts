import { describe, expect, it } from 'vitest'
import { buildMpItemRows, isLazadaImport, parseBangkokDateTime, type MpParsedItem } from './marketplaceImport'

function item(partial: Partial<MpParsedItem>): MpParsedItem {
  return {
    line_index: 0,
    product_name_raw: 'สินค้า',
    sku_ref: null,
    variation: null,
    qty: 1,
    unit_price: 10,
    line_total: 10,
    raw_snapshot: {},
    ...partial,
  }
}

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

describe('buildMpItemRows', () => {
  it('เก็บจำนวนตามไฟล์ไว้ 1 แถวต่อ 1 รายการ (ไม่แตกเป็นแถวละชิ้น)', () => {
    const { rows } = buildMpItemRows('mp-1', [item({ qty: 3, line_total: 57 })], new Map())
    expect(rows).toHaveLength(1)
    expect(rows[0].qty).toBe(3)
    expect(rows[0].line_total).toBe(57)
  })

  it('ให้ line_index เรียงตามลำดับในไฟล์', () => {
    const { rows } = buildMpItemRows(
      'mp-1',
      [item({ qty: 2 }), item({ qty: 1 }), item({ qty: 5 })],
      new Map(),
    )
    expect(rows.map((r) => r.line_index)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.qty)).toEqual([2, 1, 5])
  })

  it('จำนวนที่ว่าง/ผิดรูปแบบ ปัดขึ้นเป็นอย่างน้อย 1', () => {
    const { rows } = buildMpItemRows('mp-1', [item({ qty: null }), item({ qty: 0 })], new Map())
    expect(rows.map((r) => r.qty)).toEqual([1, 1])
  })

  it('จับคู่ SKU กับสินค้าในระบบแบบไม่สนตัวพิมพ์ และนับแถวที่จับคู่ไม่ได้', () => {
    const skuMap = new Map([['a011', 'product-a011']])
    const { rows, unmatchedSku } = buildMpItemRows(
      'mp-1',
      [item({ sku_ref: ' A011 ' }), item({ sku_ref: 'ไม่มีในระบบ' }), item({ sku_ref: null })],
      skuMap,
    )
    expect(rows.map((r) => r.product_id)).toEqual(['product-a011', null, null])
    expect(unmatchedSku).toBe(2)
  })

  it('ไม่คัดลอกชื่อตัวเลือกจากไฟล์มาใส่ช่องลาย', () => {
    const { rows } = buildMpItemRows('mp-1', [item({ variation: 'SET B,FPB01สีฟ้า' })], new Map())
    expect(rows[0].variation).toBe('SET B,FPB01สีฟ้า')
    expect(rows[0].cartoon_pattern).toBeNull()
  })
})

describe('isLazadaImport', () => {
  it('recognizes Lazada from the config name or common LZ channel codes', () => {
    expect(isLazadaImport({ name: 'Lazada', channel_code: 'TR' })).toBe(true)
    expect(isLazadaImport({ name: null, channel_code: 'LZTR' })).toBe(true)
  })

  it('does not apply the Lazada quantity rule to other marketplaces', () => {
    expect(isLazadaImport({ name: 'Shopee', channel_code: 'SPTR' })).toBe(false)
    expect(isLazadaImport({ name: 'TikTok Shop', channel_code: 'TTTR' })).toBe(false)
  })
})
