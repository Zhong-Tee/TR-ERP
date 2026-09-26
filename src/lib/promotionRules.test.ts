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
  const quantityPercent: PromotionDefinition = {
    ...base,
    rule_type: 'quantity_percent',
    rule_config: {
      discount_value: 10,
      max_applications: 2,
      condition_groups: [{ id: 'ซื้อ', quantity: 2, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
    },
  }

  it('ลดเปอร์เซ็นต์เฉพาะสินค้าที่จัดเข้าชุด ไม่รวมชิ้นเกิน สินค้าอื่น และของแถม', () => {
    const result = evaluatePromotion(quantityPercent, [
      { ...items[0], quantity: 3 },
      { product_id: 'other', product_category: 'อื่น', quantity: 1, unit_price: 1000 },
      { ...items[0], quantity: 1, unit_price: 2000, is_free: true },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(60)
    expect(result.application_count).toBe(1)
  })

  it('คำนวณเปอร์เซ็นต์จากชุดที่ใช้จริงโดยไม่คูณจำนวนครั้งซ้ำ', () => {
    const result = evaluatePromotion(quantityPercent, [{ ...items[0], quantity: 4 }], {
      channel_code: 'FBTR', application_counts: { p1: 2 },
    })
    expect(result.passed).toBe(true)
    expect(result.expected_discount).toBe(120)
    expect(result.application_count).toBe(2)
  })

  it('ไม่ให้ส่วนลดเมื่อสินค้าซื้อไม่ครบ แม้รวมของแถมแล้วครบ', () => {
    const result = evaluatePromotion(quantityPercent, [
      { ...items[0], quantity: 1 }, { ...items[0], quantity: 1, is_free: true },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(false)
    expect(result.expected_discount).toBe(0)
  })

  it('ไม่ใช้สินค้าชิ้นเดียวซ้ำระหว่างกลุ่มของโปรเปอร์เซ็นต์', () => {
    const result = evaluatePromotion({ ...quantityPercent, rule_config: {
      discount_value: 10,
      condition_groups: [
        { id: 'A', quantity: 2, options: [{ selector_type: 'category', category: 'แก้ว' }] },
        { id: 'B', quantity: 1, options: [{ selector_type: 'sku', product_id: 'a' }] },
      ],
    } }, items, { channel_code: 'FBTR' })
    expect(result.passed).toBe(false)
    expect(result.expected_discount).toBe(0)
  })

  it.each([
    [0, false, false, 0], [0, true, true, 0], [100, false, true, 600], [101, false, false, 0],
  ])('ตรวจส่วนลด %s และฟรีค่าส่ง %s', (discount, shipping, passed, expected) => {
    const result = evaluatePromotion({ ...quantityPercent, free_shipping: shipping as boolean,
      rule_config: { ...quantityPercent.rule_config, discount_value: discount as number },
    }, items, { channel_code: 'FBTR' })
    expect(result.passed).toBe(passed)
    expect(result.expected_discount).toBe(expected)
  })

  it('ไม่ให้ส่วนลดเปอร์เซ็นต์หากไม่กำหนดกลุ่มซื้อ', () => {
    const result = evaluatePromotion({ ...quantityPercent, rule_config: { discount_value: 10 } }, items, { channel_code: 'FBTR' })
    expect(result.passed).toBe(false)
    expect(result.expected_discount).toBe(0)
  })

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

  it('ตรวจโปรโมชั่นหลายครั้งตามจำนวนที่ระบุในบิล', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'quantity_fixed',
      rule_config: {
        max_applications: 3,
        discount_value: 120,
        condition_groups: [{ id: 'แก้ว 2 ใบ', quantity: 2, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
      },
    }
    const failed = evaluatePromotion(promo, [{ ...items[0], quantity: 3 }], {
      channel_code: 'FBTR',
      application_counts: { [promo.id]: 2 },
    })
    const passed = evaluatePromotion(promo, [{ ...items[0], quantity: 4 }], {
      channel_code: 'FBTR',
      application_counts: { [promo.id]: 2 },
    })
    expect(failed.passed).toBe(false)
    expect(passed.passed).toBe(true)
    expect(passed.application_count).toBe(2)
    expect(passed.expected_discount).toBe(240)
  })

  it('ไม่ยอมให้จำนวนที่ตรวจเกินจำนวนโปรโมชั่นต่อบิล', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_config: { ...base.rule_config, max_applications: 2 },
    }
    const result = evaluatePromotion(promo, [{ ...items[0], quantity: 10 }], {
      channel_code: 'FBTR',
      application_counts: { [promo.id]: 3 },
    })
    expect(result.passed).toBe(false)
    expect(result.messages.join(' ')).toContain('สูงสุด 2 ครั้งต่อบิล')
  })

  it('ซื้อครบ X บาท ส่วนลด 0 ผ่านได้เมื่อสิทธิ์คือฟรีค่าส่ง', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'spend_fixed',
      free_shipping: true,
      rule_config: { threshold_amount: 200, discount_value: 0 },
    }
    const result = evaluatePromotion(promo, [
      { product_id: 'a', product_category: 'แก้ว', quantity: 1, unit_price: 200, is_free: false },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.application_count).toBe(1)
    expect(result.expected_discount).toBe(0)
  })

  it('ซื้อ X สินค้า ส่วนลด 0 ผ่านได้เมื่อสิทธิ์คือฟรีค่าส่ง', () => {
    const promo: PromotionDefinition = {
      ...base,
      rule_type: 'quantity_fixed',
      free_shipping: true,
      rule_config: {
        discount_value: 0,
        condition_groups: [{ id: 'แก้ว 1 ใบ', quantity: 1, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
      },
    }
    const result = evaluatePromotion(promo, [
      { product_id: 'a', product_category: 'แก้ว', quantity: 1, unit_price: 100, is_free: false },
    ], { channel_code: 'FBTR' })
    expect(result.passed).toBe(true)
    expect(result.application_count).toBe(1)
    expect(result.expected_discount).toBe(0)
  })

  it('ส่วนลด 0 ไม่ผ่านเมื่อไม่มีสิทธิ์ฟรีค่าส่ง', () => {
    const spendPromo: PromotionDefinition = {
      ...base,
      rule_type: 'spend_fixed',
      free_shipping: false,
      rule_config: { threshold_amount: 200, discount_value: 0 },
    }
    const quantityPromo: PromotionDefinition = {
      ...base,
      rule_type: 'quantity_fixed',
      free_shipping: false,
      rule_config: {
        discount_value: 0,
        condition_groups: [{ id: 'แก้ว 1 ใบ', quantity: 1, options: [{ selector_type: 'category', category: 'แก้ว' }] }],
      },
    }
    const items = [{ product_id: 'a', product_category: 'แก้ว', quantity: 1, unit_price: 200, is_free: false }]
    expect(evaluatePromotion(spendPromo, items, { channel_code: 'FBTR' }).passed).toBe(false)
    expect(evaluatePromotion(quantityPromo, items, { channel_code: 'FBTR' }).passed).toBe(false)
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
