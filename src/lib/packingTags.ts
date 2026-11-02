import { supabase } from './supabase'

/** Return the committed tags, including a tag another station saved first. */
export async function assignPackingTags(tags: Array<{ order_id: string; tag: number }>) {
  const saved: Record<string, number> = {}
  for (let start = 0; start < tags.length; start += 200) {
    const batch = tags.slice(start, start + 200)
    const { data, error } = await supabase.rpc('rpc_assign_packing_tags', { p_tags: batch })
    if (error) throw error
    for (const { order_id } of batch) {
      if (data?.[order_id] == null) throw new Error('บันทึก Tag แพ็คไม่ครบ กรุณาเปิดใบงานใหม่')
      saved[order_id] = data[order_id]
    }
  }
  return saved
}
