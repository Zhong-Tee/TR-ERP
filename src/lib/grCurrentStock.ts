import { supabase } from './supabase'

export type GRCurrentStock = { status: 'loaded'; qty: number } | { status: 'error' }

/** Read main normal stock before receipt; safety, reservations and sub warehouses are separate. */
export async function loadGRCurrentStock(productIds: string[]): Promise<Record<string, GRCurrentStock>> {
  const ids = [...new Set(productIds.filter(Boolean))]
  const result: Record<string, GRCurrentStock> = {}
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100)
    try {
      const { data, error } = await supabase.from('inv_stock_balances')
        .select('product_id, on_hand').in('product_id', batch)
      if (error) throw error
      const balances = new Map((data || []).map(row => [String(row.product_id), row.on_hand]))
      for (const id of batch) {
        // A missing balance row means no main stock yet; query failure does not mean zero.
        const value = balances.has(id) ? balances.get(id) : 0
        const qty = Number(value)
        result[id] = value != null && Number.isFinite(qty) ? { status: 'loaded', qty } : { status: 'error' }
      }
    } catch {
      for (const id of batch) result[id] = { status: 'error' }
    }
  }
  return result
}

export function grOrderStockNote(note: string) {
  return note.replace(/(^|\n)(\s*)คงเหลือ(?=\s*[:：]?\s*-?\d[\d,.]*\s*\/\s*จุดสั่งซื้อ)/g, '$1$2คงเหลือตอนสั่งซื้อ')
}
