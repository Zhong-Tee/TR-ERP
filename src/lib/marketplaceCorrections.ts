const ITEM_FIELDS: Record<string, string> = {
  ink_color: 'ink_color', product_type: 'layer', cartoon_pattern: 'cartoon_pattern',
  line_pattern: 'line_art', font: 'font', line_1: 'line_1', line_2: 'line_2', line_3: 'line_3',
  notes: 'notes', file_attachment: 'attachment', attachment_name: 'attachment',
}

export function canCorrectMarketplaceItem(field: string, itemErrors?: Record<string, boolean> | null, orderErrors?: Record<string, boolean> | null): boolean {
  const key = ITEM_FIELDS[field]
  return !!key && (itemErrors?.[key] ?? orderErrors?.[key]) === true
}

export function preserveUnflaggedMarketplaceFields<T extends object>(original: T, proposed: T, itemErrors?: Record<string, boolean> | null, orderErrors?: Record<string, boolean> | null): T {
  const next = { ...original }
  for (const key of Object.keys(ITEM_FIELDS)) {
    if (canCorrectMarketplaceItem(key, itemErrors, orderErrors) && key in proposed) {
      (next as Record<string, unknown>)[key] = (proposed as Record<string, unknown>)[key]
    }
  }
  return next
}
