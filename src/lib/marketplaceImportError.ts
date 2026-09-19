type ImportErrorLike = {
  code?: string
  message?: string
}

/** แปลงข้อผิดพลาดทางเทคนิคจากฐานข้อมูลเป็นข้อความที่ผู้ใช้งานเข้าใจได้ */
export function getMarketplaceImportErrorMessage(error: unknown): string {
  const value = (error && typeof error === 'object' ? error : {}) as ImportErrorLike
  const code = String(value.code || '')
  const message = String(value.message || error || '').trim()
  const normalized = message.toLowerCase()

  // แสดงตรง ๆ เฉพาะข้อความที่ RPC ตั้งใจให้ผู้ใช้เห็น ไม่ส่งรายละเอียด DB อื่นออกหน้า UI
  const safeRpcMessages = [
    'คุณไม่มีสิทธิ์นำเข้างาน Marketplace',
    'ไม่พบช่องทางนำเข้าที่เปิดใช้งาน กรุณาเลือกช่องทางใหม่',
    'ไม่พบชื่อไฟล์ที่ต้องการนำเข้า',
    'ไฟล์ต้องมีออเดอร์สำหรับนำเข้า 1 ถึง 10,000 รายการ',
    'พบออเดอร์ที่ไม่มีช่องทางขายหรือเลขคำสั่งซื้อ',
    'ไม่พบแผ่นงานในไฟล์',
    'จับคู่คอลัมน์ "เลขคำสั่งซื้อ" ไม่ได้ — ตรวจสอบการตั้งค่าจับคู่คอลัมน์กับหัวตารางของไฟล์',
  ]
  if (safeRpcMessages.includes(message)) return message

  if (code === '42501' || normalized.includes('permission denied') || normalized.includes('row-level security')) {
    return 'คุณไม่มีสิทธิ์นำเข้าออเดอร์ Marketplace กรุณาติดต่อผู้ดูแลระบบ'
  }
  if (code === '23503' || normalized.includes('foreign key')) {
    return 'ข้อมูลช่องทางหรือสินค้าบางรายการไม่อยู่ในระบบแล้ว กรุณาโหลดหน้าใหม่และลองอีกครั้ง'
  }
  if (code === '23505' || normalized.includes('duplicate key') || normalized.includes('unique constraint')) {
    return 'พบออเดอร์ที่เคยนำเข้าแล้ว ระบบจึงไม่ได้นำเข้ารายการซ้ำ กรุณาโหลดรายการใหม่อีกครั้ง'
  }
  if (code === 'PGRST202' || code === '42883' || normalized.includes('could not find the function')) {
    return 'ระบบนำเข้ายังอัปเดตไม่ครบ กรุณาติดต่อผู้ดูแลระบบ'
  }
  if (code.startsWith('22') || normalized.includes('invalid input syntax')) {
    return 'ข้อมูลวันที่ จำนวนเงิน หรือรายละเอียดออเดอร์ในไฟล์ไม่ถูกต้อง กรุณาตรวจสอบไฟล์แล้วลองอีกครั้ง'
  }
  if (normalized.includes('failed to fetch') || normalized.includes('network')) {
    return 'ไม่สามารถเชื่อมต่อระบบได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'
  }

  return 'ไม่สามารถนำเข้าออเดอร์ได้ กรุณาลองอีกครั้ง หรือติดต่อผู้ดูแลระบบหากยังพบปัญหา'
}
