import type { MpOrderItem } from '../types/marketplace'

type MarketplaceSummaryItem = Pick<
  MpOrderItem,
  | 'product_name_raw'
  | 'sku_ref'
  | 'qty'
  | 'ink_color'
  | 'cartoon_pattern'
  | 'line_pattern'
  | 'font'
  | 'line_1'
  | 'line_2'
  | 'line_3'
  | 'no_name_line'
> & {
  product_name?: string | null
}

function formatCopyTimestamp(copiedAt: Date): string {
  const parts = new Intl.DateTimeFormat('th-TH-u-nu-latn', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(copiedAt)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${value('day')}/${value('month')}/${value('year')} ${value('hour')}:${value('minute')} น.`
}

function addDetail(lines: string[], label: string, value: string | null | undefined) {
  const text = String(value || '').trim()
  if (text) lines.push(`${label}: ${text}`)
}

const CUSTOMER_CONFIRMATION_MESSAGE = `💖 โปรดอ่านและตรวจสอบรายละเอียดคำสั่งซื้ออีกครั้งนะคะ

• แอดมินได้สรุปรายละเอียดตามข้อมูลที่ลูกค้าแจ้งไว้ และทางร้านจะผลิต ตามรายละเอียดด้านบน ค่ะ ✨

• รบกวนตรวจสอบ ชื่อ / ข้อความ / ตัวสะกด / แบบ / ลาย / สี / จำนวน ให้ครบถ้วนก่อนยืนยันนะคะ

• เนื่องจากเป็นสินค้าสั่งผลิตเฉพาะบุคคล เมื่อเข้าสู่กระบวนการผลิตแล้ว จะไม่สามารถแก้ไขรายละเอียดได้ หากมีการเปลี่ยนแปลงภายหลัง อาจมีค่าใช้จ่ายเพิ่มเติมค่ะ

🛡️ การรับประกันสินค้า
• หากผลิต ไม่ตรงกับรายละเอียดด้านบน หรือเกิดความผิดพลาดจากทางร้าน เรายินดีตรวจสอบและดูแลให้ค่ะ 💕
• หากผลิตตรงตามรายละเอียด แต่ข้อมูลที่แจ้งไว้ไม่ถูกต้อง จะไม่อยู่ในเงื่อนไขการเคลมค่ะ

🌷 รายละเอียดด้านบนจะใช้เป็นข้อมูลอ้างอิงในการผลิตและการเคลมสินค้า

ขอบคุณที่ไว้วางใจ TR นะคะ 💗`

/** ข้อความสรุปสำหรับส่งให้ลูกค้า — ไม่รวมราคาและหมายเหตุภายในระบบ */
export function buildMarketplaceOrderSummary(
  orderNo: string,
  items: MarketplaceSummaryItem[],
  copiedAt: Date = new Date(),
): string {
  const itemBlocks = items.map((item, index) => {
    const productName = String(item.product_name || item.product_name_raw || item.sku_ref || '-').trim()
    const lines = [`${index + 1}. ${productName}`]
    const quantity = Number(item.qty)
    lines.push(`จำนวน ${Number.isFinite(quantity) && quantity > 0 ? quantity.toLocaleString('th-TH') : '-'} ชิ้น`)

    addDetail(lines, 'สีหมึก', item.ink_color)
    addDetail(lines, 'ลาย', item.cartoon_pattern?.trim() === '0' ? 'ไม่เอาลาย' : item.cartoon_pattern)
    addDetail(lines, 'ลายเส้น', item.line_pattern)
    addDetail(lines, 'ฟอนต์', item.font)
    if (item.no_name_line) lines.push('ไม่รับชื่อ')
    addDetail(lines, 'บรรทัด 1', item.line_1)
    addDetail(lines, 'บรรทัด 2', item.line_2)
    addDetail(lines, 'บรรทัด 3', item.line_3)

    return lines.join('\n')
  })

  return [
    `เลขคำสั่งซื้อ: ${orderNo.trim() || '-'}`,
    ...itemBlocks,
    `เวลาส่งผลิต: ${formatCopyTimestamp(copiedAt)}`,
    CUSTOMER_CONFIRMATION_MESSAGE,
  ].join('\n\n')
}
