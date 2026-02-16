import { supabase } from './supabase'

interface StockAdjustmentInput {
  productId: string
  qtyDelta: number
  movementType: string
  refType?: string
  refId?: string
  note?: string
}

export async function adjustStockBalance({
  productId,
  qtyDelta,
  movementType,
  refType,
  refId,
  note,
}: StockAdjustmentInput): Promise<void> {
  const { data: existing, error: fetchError } = await supabase
    .from('inv_stock_balances')
    .select('id, on_hand')
    .eq('product_id', productId)
    .maybeSingle()

  if (fetchError) throw fetchError

  if (!existing) {
    const { error: insertError } = await supabase.from('inv_stock_balances').insert({
      product_id: productId,
      on_hand: qtyDelta,
      reserved: 0,
      safety_stock: 0,
    })
    if (insertError) throw insertError
  } else {
    const nextOnHand = Number(existing.on_hand || 0) + qtyDelta
    const { error: updateError } = await supabase
      .from('inv_stock_balances')
      .update({ on_hand: nextOnHand })
      .eq('id', existing.id)
    if (updateError) throw updateError
  }

  const { error: movementError } = await supabase.from('inv_stock_movements').insert({
    product_id: productId,
    movement_type: movementType,
    qty: qtyDelta,
    ref_type: refType || null,
    ref_id: refId || null,
    note: note || null,
  })
  if (movementError) throw movementError
}

/**
 * Batch process stock adjustments in chunks to avoid exhausting DB connection slots.
 * Processes CHUNK_SIZE items in parallel at a time.
 */
export async function adjustStockBalancesBulk(inputs: StockAdjustmentInput[]): Promise<void> {
  const CHUNK_SIZE = 5
  for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
    const chunk = inputs.slice(i, i + CHUNK_SIZE)
    await Promise.all(chunk.map((item) => adjustStockBalance(item)))
  }
}

// ── RPC-based bulk functions (1 API call แทนหลักร้อย) ──

/**
 * ปรับสต๊อค + บันทึก movement ทั้ง batch ผ่าน RPC ครั้งเดียว
 * ลดจาก N×3 queries เหลือ 1 query
 */
export async function adjustStockBalancesBulkRPC(inputs: StockAdjustmentInput[]): Promise<void> {
  if (!inputs.length) return
  const items = inputs.map((i) => ({
    product_id: i.productId,
    qty_delta: i.qtyDelta,
    movement_type: i.movementType,
    ref_type: i.refType || null,
    ref_id: i.refId || null,
    note: i.note || null,
  }))
  const { error } = await supabase.rpc('bulk_adjust_stock', { items })
  if (error) throw error
}

/**
 * อัปเดต safety_stock ทั้ง batch ผ่าน RPC ครั้งเดียว
 */
export async function bulkUpdateSafetyStock(
  items: { productId: string; safetyStock: number }[]
): Promise<void> {
  if (!items.length) return
  const payload = items.map((i) => ({
    product_id: i.productId,
    safety_stock: i.safetyStock,
  }))
  const { error } = await supabase.rpc('bulk_update_safety_stock', { items: payload })
  if (error) throw error
}

/**
 * อัปเดต order_point ใน pr_products ทั้ง batch ผ่าน RPC ครั้งเดียว
 */
export async function bulkUpdateOrderPoint(
  items: { productId: string; orderPoint: string }[]
): Promise<void> {
  if (!items.length) return
  const payload = items.map((i) => ({
    product_id: i.productId,
    order_point: i.orderPoint,
  }))
  const { error } = await supabase.rpc('bulk_update_order_point', { items: payload })
  if (error) throw error
}
