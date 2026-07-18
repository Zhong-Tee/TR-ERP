import { supabase } from './supabase'

/**
 * กติกาแสดงฟิลด์ระดับสินค้า (Override) — logic เดียวกับ isFieldEnabled ใน OrderForm.tsx
 * ลำดับการตัดสิน: product override (ไม่ null) → category setting → default true
 */

export type FieldRuleKey =
  | 'product_name'
  | 'ink_color'
  | 'layer'
  | 'cartoon_pattern'
  | 'line_pattern'
  | 'font'
  | 'line_1'
  | 'line_2'
  | 'line_3'
  | 'quantity'
  | 'unit_price'
  | 'notes'
  | 'attachment'

export interface FieldRuleMaps {
  /** จาก pr_category_field_settings (key = category) */
  categorySettings: Record<string, Record<string, boolean | string | null>>
  /** จาก pr_product_field_overrides (key = product_id, ค่า null = inherit จากหมวด) */
  productOverrides: Record<string, Record<string, boolean | null>>
}

const OVERRIDE_FIELDS: FieldRuleKey[] = [
  'product_name', 'ink_color', 'layer', 'cartoon_pattern', 'line_pattern', 'font',
  'line_1', 'line_2', 'line_3', 'quantity', 'unit_price', 'notes', 'attachment',
]

export async function loadFieldRuleMaps(): Promise<FieldRuleMaps> {
  const [categoryRes, overrideRes] = await Promise.all([
    supabase.from('pr_category_field_settings').select('*'),
    supabase.from('pr_product_field_overrides').select('*'),
  ])

  const categorySettings: FieldRuleMaps['categorySettings'] = {}
  ;(categoryRes.data || []).forEach((row: Record<string, unknown>) => {
    const cat = String(row.category ?? '').trim()
    if (!cat) return
    categorySettings[cat] = row as Record<string, boolean | string | null>
  })

  const productOverrides: FieldRuleMaps['productOverrides'] = {}
  ;(overrideRes.data || []).forEach((row: Record<string, unknown>) => {
    const pid = String(row.product_id ?? '')
    if (!pid) return
    const map: Record<string, boolean | null> = {}
    OVERRIDE_FIELDS.forEach((f) => {
      const v = row[f]
      map[f] = v === undefined ? null : (v as boolean | null)
    })
    productOverrides[pid] = map
  })

  return { categorySettings, productOverrides }
}

/** ฟิลด์นี้ควรเปิดให้กรอกไหม สำหรับสินค้าที่เลือก (ไม่มีสินค้า/ไม่มีการตั้งค่า = เปิด) */
export function resolveFieldEnabled(
  product: { id: string; product_category?: string | null } | null | undefined,
  fieldKey: FieldRuleKey | string,
  maps: FieldRuleMaps,
): boolean {
  if (!product) return true

  const overrides = maps.productOverrides[String(product.id)]
  if (overrides) {
    const overrideVal = overrides[fieldKey]
    if (overrideVal !== undefined && overrideVal !== null) {
      return overrideVal === true
    }
  }

  const catRaw = product.product_category
  if (catRaw === undefined || catRaw === null || String(catRaw).trim() === '') return true

  const categorySettings = maps.categorySettings[String(catRaw).trim()]
  if (!categorySettings) return true

  const v = categorySettings[fieldKey]
  if (v === undefined || v === null) return true
  return v === true || v === 'true'
}
