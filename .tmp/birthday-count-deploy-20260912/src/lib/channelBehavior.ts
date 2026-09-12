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

/** ช่องทางที่ลูกค้าเข้ารับสินค้าเอง จึงไม่ใช้เลขพัสดุในขั้นตอนแพ็ค */
export const SELF_PICKUP_CHANNELS = ['SHOPP']

export type SelfPickupChannelMetadata = Record<
  string,
  { is_self_pickup?: boolean | null } | undefined
>

export function isSelfPickupChannel(
  channelCode: string | null | undefined,
  channelMetadata?: SelfPickupChannelMetadata,
): boolean {
  const normalized = String(channelCode || '').trim().toUpperCase()
  if (!normalized) return false

  // Once channel metadata is available it is the source of truth, including
  // the ability for an admin to turn SHOPP back into a normal shipping channel.
  if (channelMetadata && Object.prototype.hasOwnProperty.call(channelMetadata, normalized)) {
    return channelMetadata[normalized]?.is_self_pickup === true
  }

  // Preserve the legacy SHOPP behavior while the new migration/metadata is not
  // available (for example during a staggered deployment).
  return SELF_PICKUP_CHANNELS.includes(normalized)
}

export function isSelfPickupBill(
  fulfillmentMethod: 'self_pickup' | 'shipping' | null | undefined,
  channelCode: string | null | undefined,
  channelMetadata?: SelfPickupChannelMetadata,
): boolean {
  if (fulfillmentMethod) return fulfillmentMethod === 'self_pickup'
  return isSelfPickupChannel(channelCode, channelMetadata)
}
