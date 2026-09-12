import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  buildMpItemRows,
  isLazadaImport,
  normalizeMarketplaceSkuForProductMatch,
  parseBangkokDateTime,
  parseMarketplaceWorkbook,
  type MpParsedItem,
} from './marketplaceImport'

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

  it('parses Lazada createTime with an English abbreviated month as Bangkok time', () => {
    expect(parseBangkokDateTime('12 Aug 2026 13:05')).toBe('2026-08-12T06:05:00.000Z')
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

  it('จับคู่ seller SKU ที่มี suffix หลังรหัสสินค้าเลข 9 หลัก', () => {
    const skuMap = new Map([['110000242', 'product-110000242']])
    const { rows, unmatchedSku } = buildMpItemRows(
      'mp-1',
      [item({ sku_ref: '110000242-4' }), item({ sku_ref: ' 110000242-ชุดพิเศษ ' })],
      skuMap,
    )
    expect(rows.map((r) => r.product_id)).toEqual(['product-110000242', 'product-110000242'])
    expect(rows.map((r) => r.sku_ref)).toEqual(['110000242-4', ' 110000242-ชุดพิเศษ '])
    expect(unmatchedSku).toBe(0)
  })

  it('ให้ SKU เต็มที่มีขีดในระบบชนะรหัสฐาน', () => {
    const skuMap = new Map([
      ['110000242-4', 'exact-product'],
      ['110000242', 'base-product'],
    ])
    const { rows } = buildMpItemRows('mp-1', [item({ sku_ref: '110000242-4' })], skuMap)
    expect(rows[0].product_id).toBe('exact-product')
  })

  it('ไม่คัดลอกชื่อตัวเลือกจากไฟล์มาใส่ช่องลาย', () => {
    const { rows } = buildMpItemRows('mp-1', [item({ variation: 'SET B,FPB01สีฟ้า' })], new Map())
    expect(rows[0].variation).toBe('SET B,FPB01สีฟ้า')
    expect(rows[0].cartoon_pattern).toBeNull()
  })
})

describe('normalizeMarketplaceSkuForProductMatch', () => {
  it('ตัด suffix เมื่อขึ้นต้นด้วยเลขสินค้า 9 หลักตามด้วยขีด', () => {
    expect(normalizeMarketplaceSkuForProductMatch(' 110000333-3 ')).toBe('110000333')
  })

  it('ไม่ตัด SKU รูปแบบอื่นเพื่อป้องกันการจับคู่ผิด', () => {
    expect(normalizeMarketplaceSkuForProductMatch('ABC-1')).toBe('abc-1')
    expect(normalizeMarketplaceSkuForProductMatch('1100003333-1')).toBe('1100003333-1')
  })
})

describe('parseMarketplaceWorkbook shipping rule', () => {
  it('ส่งต่อการตั้งค่าเลขรับพัสดุด่วนจากกฎที่จับคู่ได้ไปยังออเดอร์', async () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['เลขคำสั่งซื้อ', 'เวลาชำระ', 'ตัวเลือกการจัดส่ง', 'SKU', 'จำนวน'],
      ['ORDER-1', '31/08/2026 23:14', 'Express Delivery', '110000242', 1],
    ]), 'orders')
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = { arrayBuffer: async () => bytes } as File

    const result = await parseMarketplaceWorkbook(file, {
      sheet_name: 'orders',
      header_row: 0,
      channel_code: 'SPTR',
      column_map: [
        { field_key: 'order_no', source_type: 'header_exact', source_value: 'เลขคำสั่งซื้อ', priority: 0 },
        { field_key: 'payment_time', source_type: 'header_exact', source_value: 'เวลาชำระ', priority: 0 },
        { field_key: 'sku_ref', source_type: 'header_exact', source_value: 'SKU', priority: 0 },
        { field_key: 'qty', source_type: 'header_exact', source_value: 'จำนวน', priority: 0 },
      ],
      shipping_rules: [{
        source_type: 'header_exact',
        source_value: 'ตัวเลือกการจัดส่ง',
        match_type: 'contains',
        match_value: 'Express',
        channel_code: 'FSPTR',
        label: 'ส่งด่วน',
        color: 'orange',
        requires_express_receipt_number: true,
      }],
    })

    expect(result.orders[0].channel_code).toBe('FSPTR')
    expect(result.orders[0].requires_express_receipt_number).toBe(true)
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
