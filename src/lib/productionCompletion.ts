export interface MaterialActual {
  product_id: string
  product_code: string
  product_name: string
  planned_qty: number
  used_qty: number
  returned_qty: number
  waste_qty: number
  shortage_qty: number
  reason: string
}

export interface ByproductActual {
  product_id: string
  product_code: string
  product_name: string
  planned_qty: number
  qty: number
}

export interface ProductionActual {
  item_id: string
  product_code: string
  product_name: string
  planned_qty: number
  actual_qty: number
  reason_code: string
  reason: string
  materials: MaterialActual[]
  byproducts: ByproductActual[]
}

export interface ProductionCompletionReport extends ProductionActual {
  material_cost: number
  shortage_cost: number
  byproduct_cost: number
  production_loss_cost: number
  unit_cost: number
  total_cost: number
}

export const shortageReasons = ['วัตถุดิบในห่อไม่ครบ', 'วัตถุดิบไม่เพียงพอ', 'ชำรุดระหว่างผลิต', 'สูญเสียระหว่างผลิต', 'อื่น ๆ']

export function validateProductionActuals(items: ProductionActual[]): string | null {
  if (!items.length) return 'ไม่พบรายการผลิต'
  const valid = (n: number) => Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001
  for (const item of items) {
    if (!valid(item.actual_qty) || item.actual_qty > item.planned_qty) return `${item.product_code}: จำนวนผลิตจริงต้องอยู่ระหว่าง 0 ถึง ${item.planned_qty} และมีทศนิยมไม่เกิน 2 ตำแหน่ง`
    if (item.actual_qty < item.planned_qty && (!shortageReasons.includes(item.reason_code) || !item.reason.trim())) return `${item.product_code}: กรุณาเลือกเหตุผลและระบุรายละเอียดที่ผลิตขาด`
    for (const m of item.materials) {
      if (![m.used_qty, m.returned_qty, m.waste_qty, m.shortage_qty].every(valid)) return `${m.product_code}: จำนวนวัตถุดิบต้องไม่ติดลบ และมีทศนิยมไม่เกิน 2 ตำแหน่ง`
      if (Math.abs(m.used_qty + m.returned_qty + m.waste_qty + m.shortage_qty - m.planned_qty) > 0.000001) return `${m.product_code}: ยอดใช้ + เหลือคืน + สูญเสีย + ขาดจากห่อ ต้องเท่ากับยอดตามเอกสาร ${m.planned_qty}`
      if ((m.waste_qty > 0 || m.shortage_qty > 0 || Math.abs(m.used_qty - m.planned_qty) > 0.000001) && !m.reason.trim()) return `${m.product_code}: กรุณาระบุเหตุผลส่วนต่างวัตถุดิบ`
    }
    if (item.byproducts.some(b => !valid(b.qty))) return `${item.product_code}: จำนวนสินค้าที่แยกคืนไม่ถูกต้อง`
  }
  return null
}
