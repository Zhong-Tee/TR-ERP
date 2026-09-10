import { describe, expect, it } from 'vitest'
import { evaluatePromotion, evaluatePromotions, promotionMatchesChannel, type PromotionDefinition } from './promotionRules'

const base: PromotionDefinition = {
  id: 'p1', name: 'โปรทดสอบ', is_active: true, validation_enabled: true,
  rule_type: 'spend_percent', channel_codes: ['FBTR'], allow_stack: true, version: 1,
  rule_config: { threshold_amount: 500, discount_value: 10 },
}

const items = [
  { product_id: 'a', product_category: 'แก้ว', quantity: 2, unit_price: 300, is_free: false },
]

describe('promotion rules', () => {
  it('คำนวณส่วนลดเปอร์เซ็นต์เมื่อยอดและช่องทางผ่าน', () => {
    const result = evaluatePromotion(base, items, { channel_code: 'FBTR', order_date: '2026-09-09' })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(60)
  })

  it('ปิดการตรวจยังคำนวณส่วนลด แต่ไม่บังคับ Popup', () => {
    const result = evaluatePromotion({ ...base, validation_enabled: false }, items, { channel_code: 'FBTR' })
    expect(result.checked).toBe(false)
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(60)
  })

  it('แจ้งยอดไม่ถึงและช่องทางไม่ตรง', () => {
    const result = evaluatePromotion(base, [{ ...items[0], quantity: 1 }], { channel_code: 'PUMP' })
    expect(result.passed).toBe(false)
    expect(result.messages.join(' ')).toContain('ไม่รองรับช่องทาง')
  })

  it('รองรับ AND ระหว่างกลุ่มและ OR ภายในกลุ่มโดยไม่นับจำนวนซ้ำ', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'bundle_fixed_price',
      rule_config: {
        set_price: 599,
        condition_groups: [
          { id: 'A', quantity: 1, options: [{ selector_type: 'category', category: 'แก้ว' }] },
          { id: 'B', quantity: 1, options: [{ selector_type: 'sku', product_id: 'b' }] },
        ],
      },
    }
    const result = evaluatePromotion(promo, [
      ...items,
      { product_id: 'b', product_category: 'หมึก', quantity: 1, unit_price: 100, is_free: false },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(0)
  })

  it('โปรเซ็ตเลือกสินค้าที่ตรงเงื่อนไขราคาสูงสุดไปคำนวณส่วนลด', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'bundle_fixed_price',
      rule_config: {
        set_price: 100,
        condition_groups: [{ id: 'สินค้าในเซ็ต', quantity: 1, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
      },
    }
    const result = evaluatePromotion(promo, [
      { product_id: 'cheap', product_category: 'แก้ว', quantity: 1, unit_price: 200, is_free: false },
      { product_id: 'expensive', product_category: 'แก้ว', quantity: 1, unit_price: 500, is_free: false },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(400)
  })

  it('ซื้อ X สินค้า ลด X บาท ให้ส่วนลดครั้งเดียวเมื่อจำนวนครบ', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'quantity_fixed',
      rule_config: {
        discount_value: 120,
        condition_groups: [{ id: 'แก้ว 2 ใบ', quantity: 2, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
      },
    }
    const failed = evaluatePromotion(promo, [{ ...items[0], quantity: 1 }], { channel_code: 'FBTR' })
    const passed = evaluatePromotion(promo, [{ ...items[0], quantity: 4 }], { channel_code: 'FBTR' })
    expect(failed.passed).toBe(false)
    expect(passed.passed).toBe(true)
    expect(passed.application_count).toBe(1)
    expect(passed.expected_discount).toBe(120)
  })

  it('เลือกสินค้าราคาสูงสุดโดยยังจัดสรรครบทุกกลุ่มที่เงื่อนไขซ้อนกัน', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'bundle_fixed_price',
      rule_config: {
        set_price: 100,
        condition_groups: [
          { id: 'หมวดแก้ว', quantity: 1, options: [{ selector_type: 'category', category: 'แก้ว' }] },
          { id: 'SKU X', quantity: 1, options: [{ selector_type: 'sku', product_id: 'x' }] },
        ],
      },
    }
    const result = evaluatePromotion(promo, [
      { product_id: 'x', product_category: 'แก้ว', quantity: 1, unit_price: 100, is_free: false },
      { product_id: 'y', product_category: 'แก้ว', quantity: 1, unit_price: 90, is_free: false },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(90)
  })

  it('ตรวจของแถมจากแถว is_free เท่านั้น', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'buy_get',
      rule_config: {
        condition_groups: [{ id: 'ซื้อ', quantity: 1, options: [{ selector_type: 'sku', product_id: 'a' }] }],
        reward_groups: [{ id: 'แถม', quantity: 1, options: [{ selector_type: 'sku', product_id: 'gift' }] }],
      },
    }
    const failed = evaluatePromotion(promo, [...items, { product_id: 'gift', quantity: 1, unit_price: 50, is_free: false }], { channel_code: 'FBTR' })
    const passed = evaluatePromotion(promo, [...items, { product_id: 'gift', quantity: 1, unit_price: 0, is_free: true }], { channel_code: 'FBTR' })
    expect(failed.passed).toBe(false)
    expect(passed.passed).toBe(true)
  })

  it('บล็อกการซ้อนเมื่อมีโปรโมชั่นใดไม่อนุญาต', () => {
    const results = evaluatePromotions([base, { ...base, id: 'p2', allow_stack: false }], items, { channel_code: 'FBTR' })
    expect(results.every((result) => !result.passed)).toBe(true)
  })

  it('กรองโปรโมชั่นรายการเดิมตามช่องทางที่ตั้งค่าไว้', () => {
    const legacy: PromotionDefinition = { ...base, rule_type: 'legacy', channel_codes: ['FSPTR', 'LZTR'] }
    expect(promotionMatchesChannel(legacy, 'FSPTR')).toBe(true)
    expect(promotionMatchesChannel(legacy, 'FBTR')).toBe(false)
  })
})
