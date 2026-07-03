/**
 * Helpers สำหรับสร้างสตริงกรองแบบ `.or()` ของ PostgREST อย่างปลอดภัย
 *
 * ปัญหา: ถ้าเอาคำค้นหาจากผู้ใช้ยัดลงใน `.or('col.ilike.%<term>%,...')` ตรง ๆ
 * แล้วคำค้นมีอักขระสงวนของ PostgREST (เช่น , . ( ) ) จะทำให้ query
 * error ว่า "failed to parse logic tree"
 *
 * วิธีแก้: ครอบค่าด้วย double-quote (PostgREST อนุญาตให้ค่าใน double-quote
 * มีอักขระสงวนได้) พร้อม escape `"` และ `\` ที่อยู่ในคำค้น
 */

/** Escape คำค้นเพื่อใช้ภายในค่า ilike ที่ครอบด้วย double-quote */
export function escapeIlikeTerm(term: string): string {
  return term.replace(/[\\"]/g, '\\$&')
}

/**
 * สร้างสตริงกรอง `.or()` แบบ ilike ครอบหลายคอลัมน์อย่างปลอดภัย
 * @example query.or(buildIlikeOr(searchTerm, ['product_code', 'product_name']))
 */
export function buildIlikeOr(term: string, columns: string[]): string {
  const safe = escapeIlikeTerm(term)
  return columns.map((c) => `${c}.ilike."%${safe}%"`).join(',')
}
