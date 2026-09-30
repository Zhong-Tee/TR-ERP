export type PickingSlipStatus = 'new' | 'printed' | 'empty'

export function resolvePickingSlipStatus(hasPickingItems: boolean, hasPrintRecord: boolean): PickingSlipStatus {
  if (!hasPickingItems) return 'empty'
  return hasPrintRecord ? 'printed' : 'new'
}
