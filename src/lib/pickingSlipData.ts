export interface PickingMainRow { woName: string; code: string; name: string; location: string; finalQty: number; dept: string }
export interface PickingSubRow extends PickingMainRow { warehouse: string }
export interface PickingSpareRow { label: string; qty: number }
export interface PickingSlipData {
  workOrderName: string
  mainItems: PickingMainRow[]
  spareItems: PickingSpareRow[]
  subItems: PickingSubRow[]
  nonPickItems: PickingMainRow[]
  spareDept: string
  departments: string[]
}
export type PaperSize = 'A5' | 'A4'
export const PAPER_MM = { A5: [148, 210], A4: [210, 297] } as const

export function pickingDestination(category: string, warehouses: string[], excluded: Set<string>) {
  if (warehouses.length) return 'sub'
  const normalized = category.trim().toUpperCase()
  return normalized && !excluded.has(normalized) ? 'main' : 'skip'
}

export function filterPickingDepartment(data: PickingSlipData, department: string | null): PickingSlipData {
  if (department == null) return data
  return { ...data, mainItems: data.mainItems.filter((r) => r.dept === department),
    nonPickItems: data.nonPickItems.filter((r) => r.dept === department),
    subItems: data.subItems.filter((r) => r.dept === department),
    spareItems: department === data.spareDept ? data.spareItems : [] }
}

