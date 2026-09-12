import { supabase } from './supabase'

/**
 * สร้างเลขบิลอัตโนมัติ: {channelCode}{YY}{MM}{running 4 หลัก} เช่น SPTR26070001
 * (ย้ายมาจาก OrderForm.tsx เพื่อใช้ร่วมกับเมนู Marketplace)
 */
export async function generateBillNo(channelCode: string): Promise<string> {
  const today = new Date()
  const year = today.getFullYear().toString().slice(-2)
  const month = (today.getMonth() + 1).toString().padStart(2, '0')

  const { data } = await supabase
    .from('or_orders')
    .select('bill_no')
    .like('bill_no', `${channelCode}${year}${month}%`)
    .order('bill_no', { ascending: false })
    .limit(1)

  let sequence = 1
  if (data && data.length > 0) {
    const lastBillNo = data[0].bill_no
    const lastSeq = parseInt(lastBillNo.slice(-4)) || 0
    sequence = lastSeq + 1
  }

  return `${channelCode}${year}${month}${sequence.toString().padStart(4, '0')}`
}

/**
 * insert or_orders พร้อมเลขบิลใหม่ — ถ้าเลขชน (unique 23505 จากการเปิดบิลพร้อมกัน)
 * จะ generate เลขใหม่แล้วลองซ้ำ สูงสุด maxRetries ครั้ง
 */
export async function insertOrderWithBillNo(
  orderData: Record<string, unknown>,
  channelCode: string,
  maxRetries = 3,
): Promise<{ id: string; bill_no: string }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const billNo = await generateBillNo(channelCode)
    const { data, error } = await supabase
      .from('or_orders')
      .insert({ ...orderData, bill_no: billNo })
      .select('id, bill_no')
      .single()
    if (!error && data) return { id: data.id, bill_no: data.bill_no || billNo }
    lastError = error
    if (error?.code !== '23505') break
  }
  throw lastError instanceof Error ? lastError : new Error((lastError as { message?: string })?.message || 'สร้างบิลไม่สำเร็จ')
}
