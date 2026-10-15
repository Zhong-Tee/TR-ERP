import type { MpOrderItem } from '../types/marketplace'

export function isMarketplaceImportedFieldLocked(order: {
  source_marketplace_order_id?: string | null
  status?: string | null
} | null | undefined, field: string): boolean {
  return !!order?.source_marketplace_order_id && order.status === 'ลงข้อมูลผิด' &&
    (field === 'channel_order_no' || field === 'quantity')
}

export function isMarketplaceReviewLocked(order?: {
  source_marketplace_order_id?: string | null
  status?: string | null
} | null): boolean {
  return !!order?.source_marketplace_order_id && order.status === 'รอตรวจคำสั่งซื้อ'
}

export function shouldReviewMarketplaceField(
  item: PersonalizationItem,
  key: string,
  required = false,
): boolean {
  if (key === 'line_art') return required || !!item.line_pattern?.trim()
  if (key === 'line_1' || key === 'line_2' || key === 'line_3') {
    if (item.no_name_line) return false
    return required || !!item[key]?.trim() ||
      (key === 'line_1' && ![item.line_1, item.line_2, item.line_3].some((v) => v?.trim()))
  }
  return true
}

type PersonalizationItem = {
  ink_color?: string | null; product_type?: string | null
  cartoon_pattern?: string | null; line_pattern?: string | null; font?: string | null
  line_1?: string | null; line_2?: string | null; line_3?: string | null
  no_name_line?: boolean
}

/** Only call for Marketplace items; ordinary bills and QT/PC retain their existing behavior. */
export function normalizeMarketplaceItem<T extends PersonalizationItem>(
  item: T,
  enabled: (key: string) => boolean,
): T {
  const next = { ...item }
  const fields = ['ink_color', 'product_type', 'cartoon_pattern', 'line_pattern', 'font', 'line_1', 'line_2', 'line_3'] as const
  for (const field of fields) {
    if (!enabled(field === 'product_type' ? 'layer' : field)) next[field] = null
  }
  if (!['line_1', 'line_2', 'line_3'].some(enabled)) next.no_name_line = false
  if (next.no_name_line) next.line_1 = next.line_2 = next.line_3 = null
  return fields.some((field) => next[field] !== item[field]) || next.no_name_line !== item.no_name_line ? next : item
}

export type BilledMarketplaceItem = PersonalizationItem & {
  id: string; product_id: string | null; product_name?: string | null
  source_mp_order_item_id?: string | null; item_uid?: string | null
  quantity?: number | null; unit_price?: number | null; created_at?: string
  is_free?: boolean; notes?: string | null; sort_order?: number | null
}

/** Never attach file metadata merely because two rows happen to have the same array index. */
export function mergeBilledMarketplaceItems(rows: BilledMarketplaceItem[], drafts: MpOrderItem[]): MpOrderItem[] {
  const byId = new Map(drafts.map((item) => [item.id, item]))
  return rows.map((row, index) => {
    let draft = row.source_mp_order_item_id ? byId.get(row.source_mp_order_item_id) : undefined
    if (!draft && !row.source_mp_order_item_id) {
      const sequence = Number(row.item_uid?.match(/-(\d+)$/)?.[1])
      const original = drafts.find((item) => item.line_index === sequence - 1)
      if (original && original.product_id === row.product_id) draft = original
      else {
        const matches = drafts.filter((item) => !!row.product_id && item.product_id === row.product_id)
        if (matches.length === 1) draft = matches[0]
      }
    }
    const qty = Number(row.quantity ?? 0)
    const price = row.unit_price == null ? null : Number(row.unit_price)
    return {
      ...row,
      id: row.id, mp_order_id: draft?.mp_order_id ?? '', line_index: index,
      product_name_raw: row.product_name ?? draft?.product_name_raw ?? null,
      sku_ref: draft?.sku_ref ?? null, variation: draft?.variation ?? null,
      raw_snapshot: draft?.raw_snapshot ?? null,
      qty, unit_price: price, line_total: price == null ? null : Math.round(qty * price * 100) / 100,
      product_type: row.product_type ?? null, ink_color: row.ink_color ?? null,
      cartoon_pattern: row.cartoon_pattern ?? null, line_pattern: row.line_pattern ?? null,
      font: row.font ?? null, line_1: row.line_1 ?? null, line_2: row.line_2 ?? null, line_3: row.line_3 ?? null,
      no_name_line: !!row.no_name_line, is_free: !!row.is_free, notes: row.notes ?? null,
      created_at: row.created_at ?? draft?.created_at ?? '',
    }
  })
}
