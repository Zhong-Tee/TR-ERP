import { supabase } from './supabase'
import {
  fetchPlanDeptSettings,
  resolvePickingDepartment,
  type PlanDeptSettings,
  sortPickingDepartmentsForJob,
} from './planPickingDepartments'

export type WmsRowForDept = {
  product_code?: string | null
  product_name?: string | null
}

export type WithPickingDepartment<T> = T & { picking_department: string }

/** โหลด plan_settings + แนบ picking_department ให้แถว wms (in-memory เท่านั้น) */
export async function enrichWmsRowsWithPickingDepartment<T extends WmsRowForDept>(
  rows: T[],
  settings?: PlanDeptSettings
): Promise<WithPickingDepartment<T>[]> {
  const plan = settings ?? (await fetchPlanDeptSettings())
  const codes = [...new Set(rows.map((r) => String(r.product_code || '').trim()).filter(Boolean))]
  const codeToMeta: Record<string, { category: string; name: string }> = {}
  if (codes.length > 0) {
    const { data, error } = await supabase
      .from('pr_products')
      .select('product_code, product_category, product_name')
      .in('product_code', codes)
    if (error) console.warn('enrichWmsRowsWithPickingDepartment: pr_products', error)
    for (const p of data || []) {
      const code = String((p as { product_code?: string }).product_code || '').trim()
      if (!code) continue
      codeToMeta[code] = {
        category: String((p as { product_category?: string }).product_category || ''),
        name: String((p as { product_name?: string }).product_name || ''),
      }
    }
  }

  return rows.map((r) => {
    const code = String(r.product_code || '').trim()
    const meta = codeToMeta[code]
    const category = meta?.category ?? ''
    const nameFromProduct = meta?.name
    const wmsName = String(r.product_name || '')
    const picking_department = resolvePickingDepartment(category, plan, nameFromProduct || wmsName)
    return { ...r, picking_department }
  })
}

/** ช่วยสร้างรายการ option แผนกสำหรับ UI (ลำดับตาม Plan) */
export function getDepartmentOptionsForWmsRows(
  settings: PlanDeptSettings,
  rows: Array<{ picking_department?: string }>
): string[] {
  const present = new Set(rows.map((r) => String(r.picking_department || '').trim()).filter(Boolean))
  return sortPickingDepartmentsForJob(settings, present)
}
