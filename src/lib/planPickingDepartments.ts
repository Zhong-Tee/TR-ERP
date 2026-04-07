import { supabase } from './supabase'

/** ค่าเริ่มต้นแผนกจาก Plan — ใช้เมื่อยังไม่บันทึก plan_settings */
export const PLAN_DEPARTMENTS_FALLBACK = ['เบิก', 'STAMP', 'STK', 'CTT', 'LASER', 'TUBE', 'QC', 'PACK'] as const

/** แผนกสำหรับรายการที่ไม่ตรงหมวดในตั้งค่า */
export const PICKING_GENERAL_DEPT = 'ทั่วไป'

/** แผนกคิว/คลัง — ให้จับคู่หมวดสินค้าหลังแผนกผลิต */
const PICKING_DEPT_LOW_PRIORITY = new Set(['เบิก', 'QC', 'PACK'])

export type PlanDeptSettings = {
  departments: string[]
  departmentProductCategories: Record<string, string[]>
}

export async function fetchPlanDeptSettings(): Promise<PlanDeptSettings> {
  const { data, error } = await supabase.from('plan_settings').select('data').eq('id', 1).maybeSingle()
  if (error && error.code !== 'PGRST116') console.warn('planPickingDepartments: โหลด plan_settings', error)
  const raw = data?.data as Partial<PlanDeptSettings> | undefined
  const departments =
    Array.isArray(raw?.departments) && raw.departments.length > 0
      ? raw.departments.map((d) => String(d))
      : [...PLAN_DEPARTMENTS_FALLBACK]
  const departmentProductCategories =
    raw?.departmentProductCategories && typeof raw.departmentProductCategories === 'object'
      ? (raw.departmentProductCategories as Record<string, string[]>)
      : {}
  return { departments, departmentProductCategories }
}

function pickingDepartmentSearchOrder(settings: PlanDeptSettings): string[] {
  const hi: string[] = []
  const lo: string[] = []
  for (const d of settings.departments) {
    if (isPickingLowPriorityDept(d)) lo.push(d)
    else hi.push(d)
  }
  return [...hi, ...lo]
}

function isPickingLowPriorityDept(name: string): boolean {
  return PICKING_DEPT_LOW_PRIORITY.has(name)
}

function inferDeptFromProductText(text: string, settings: PlanDeptSettings): string | null {
  const s = String(text || '').trim()
  if (!s) return null
  const depts = settings.departments
  if (/STAMP|ตรายาง|CONDO\s*STAMP|RUBBER|แสตมป์/i.test(s)) {
    const hit = depts.find((d) => isStampDepartmentName(d))
    return hit ?? null
  }
  if (/LASER|เลเซอร์/i.test(s)) {
    return depts.find((d) => d.toUpperCase().includes('LASER')) ?? null
  }
  if (/\bCTT\b/i.test(s) || /ซีทีที/i.test(s)) {
    return depts.find((d) => d.trim().toUpperCase() === 'CTT') ?? null
  }
  if (/\bSTK\b/i.test(s)) {
    return depts.find((d) => d.trim().toUpperCase() === 'STK') ?? null
  }
  if (/\bTUBE\b/i.test(s)) {
    return depts.find((d) => d.trim().toUpperCase() === 'TUBE') ?? null
  }
  return null
}

function inferDeptFromCategoryHeuristic(
  cat: string,
  settings: PlanDeptSettings,
  productName?: string
): string | null {
  return (
    inferDeptFromProductText(cat, settings) ??
    (productName ? inferDeptFromProductText(productName, settings) : null)
  )
}

export function resolvePickingDepartment(
  productCategory: string,
  settings: PlanDeptSettings,
  productName?: string
): string {
  const cat = String(productCategory || '').trim().replace(/\s+/g, ' ')
  const hasAnyAssignment = Object.values(settings.departmentProductCategories || {}).some(
    (list) => Array.isArray(list) && list.length > 0
  )
  if (!hasAnyAssignment) {
    return inferDeptFromCategoryHeuristic(cat, settings, productName) ?? PICKING_GENERAL_DEPT
  }
  const lower = cat.toLowerCase()
  for (const dept of pickingDepartmentSearchOrder(settings)) {
    const list = settings.departmentProductCategories[dept] || []
    for (const configured of list) {
      const c = String(configured || '').trim().replace(/\s+/g, ' ')
      if (c && (c === cat || c.toLowerCase() === lower)) {
        if (isPickingLowPriorityDept(dept)) {
          const bump = inferDeptFromCategoryHeuristic(cat, settings, productName)
          if (bump) return bump
        }
        return dept
      }
    }
  }
  return inferDeptFromCategoryHeuristic(cat, settings, productName) ?? PICKING_GENERAL_DEPT
}

export function deptExportOrder(settings: PlanDeptSettings, deptKeys: string[]): string[] {
  const withItems = new Set(deptKeys)
  const out: string[] = []
  for (const d of settings.departments) {
    if (withItems.has(d)) out.push(d)
  }
  if (withItems.has(PICKING_GENERAL_DEPT) && !out.includes(PICKING_GENERAL_DEPT)) out.push(PICKING_GENERAL_DEPT)
  for (const d of deptKeys) {
    if (!out.includes(d) && withItems.has(d)) out.push(d)
  }
  return out
}

export function isStampDepartmentName(dept: string): boolean {
  return dept.trim().toUpperCase() === 'STAMP'
}

/** เรียงชื่อแผนกที่ปรากฏในใบงานให้สอดคล้องลำดับใน Plan ก่อน แล้วตามด้วยที่เหลือ */
export function sortPickingDepartmentsForJob(settings: PlanDeptSettings, departmentsPresent: Iterable<string>): string[] {
  const present = new Set([...departmentsPresent].filter(Boolean))
  const ordered = settings.departments.filter((d) => present.has(d))
  const rest = [...present].filter((d) => !settings.departments.includes(d)).sort((a, b) => a.localeCompare(b, 'th'))
  return [...ordered, ...rest]
}
