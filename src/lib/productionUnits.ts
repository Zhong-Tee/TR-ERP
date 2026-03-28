/** จำนวนชิ้นต่อแถวในออเดอร์ — ใช้แตกหลายแถวใน export ผลิต / QC / barcode */
export function normalizedLineQuantity(raw: unknown): number {
  const q = Math.floor(Number(raw))
  if (!Number.isFinite(q) || q < 1) return 1
  return Math.min(q, 9999)
}

/** Item UID ในไฟล์ผลิตและ QC: เลขบิล-ลำดับชิ้นในบิล (1,2,3,…) ไม่ต่อท้าย item_uid แถวออเดอร์ */
export function flatBillUnitUid(billNo: string, unitIndex1Based: number): string {
  const bill = String(billNo ?? '').trim() || '—'
  return `${bill}-${unitIndex1Based}`
}
