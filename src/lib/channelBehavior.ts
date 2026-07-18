/**
 * พฤติกรรมช่องทางขายที่ใช้ร่วมกันระหว่าง OrderForm และเมนู Marketplace
 * (ค่าชุดเดียวกับค่าคงที่ใน OrderForm.tsx — แหล่งอ้างอิงหลักคือไฟล์นี้)
 */

/** ช่องทางที่เมื่อบันทึก "ข้อมูลครบ" ให้เคลื่อนสถานะไปที่ "ตรวจสอบแล้ว" โดยตรง (ไม่ต้องรอตรวจสลิป) */
export const CHANNELS_COMPLETE_TO_VERIFIED = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'SHOPP', 'OFFICE']

/** ช่องทางที่ให้กรอกราคาเอง (marketplace ใช้ราคาจากไฟล์/ข้อมูลชำระเงิน) */
export const CHANNELS_MANUAL_PRICE = ['SPTR', 'FSPTR', 'TTTR', 'LZTR']

/** ช่องทางที่ปิดการกรอกที่อยู่ (marketplace ใบปะหน้ามาจากแพลตฟอร์ม) */
export const CHANNELS_BLOCK_ADDRESS = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'SHOPP']

/** ช่องทางที่แสดงฟิลด์ "เลขคำสั่งซื้อ" (เลขออเดอร์ของแพลตฟอร์ม) */
export const CHANNELS_SHOW_ORDER_NO = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'PGTR', 'WY']
