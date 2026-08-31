export function normalizeProductUnitName(unitName: string | null | undefined): string {
  return unitName?.trim() || 'ชิ้น'
}

/** Inventory quantities are stored in unit_name; unit_multiplier must not be applied here. */
export function stockQuantityFromDocument(quantity: number | string | null | undefined): number {
  const value = Number(quantity || 0)
  return Number.isFinite(value) ? value : 0
}

export function formatProductQuantity(
  quantity: number | string | null | undefined,
  unitName: string | null | undefined,
): string {
  return `${stockQuantityFromDocument(quantity).toLocaleString('th-TH')} ${normalizeProductUnitName(unitName)}`
}
