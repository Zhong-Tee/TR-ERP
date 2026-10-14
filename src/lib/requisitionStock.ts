import { fetchReservationStock } from './stockReservations'

type Product = { id: string; product_code: string }
type Item = { product_code: string; qty: number; unit_name?: string | null }

export async function withRequisitionStock<T extends Product>(products: T[]) {
  const { data, error } = await fetchReservationStock('order', null)
  if (error) throw error
  const balances = new Map((data || []).map(row => [row.product_id, row]))
  return products.map(product => {
    const balance = balances.get(product.id)
    return { ...product, available_qty: Math.max(0, Number(balance?.on_hand || 0) - Number(balance?.reserved || 0)) }
  })
}

export function requisitionStockError(items: Item[], products: { product_code: string; available_qty: number }[]) {
  const stock = new Map(products.map(product => [product.product_code, product.available_qty]))
  const totals = new Map<string, number>()
  for (const item of items) {
    if (!Number.isFinite(item.qty) || item.qty <= 0) return `จำนวนเบิกสินค้า ${item.product_code} ต้องมากกว่า 0`
    const total = (totals.get(item.product_code) || 0) + item.qty
    totals.set(item.product_code, total)
    const available = stock.get(item.product_code) || 0
    if (total > available) return `สินค้า ${item.product_code} เบิกได้ไม่เกิน ${available.toLocaleString('th-TH')} ${item.unit_name || 'ชิ้น'} (ยอดพร้อมเบิกหลังหักจอง)`
  }
  return null
}
