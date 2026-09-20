import { describe, expect, it } from 'vitest'
import { buildMarketplaceOrderSummary } from './marketplaceOrderSummary'

describe('buildMarketplaceOrderSummary', () => {
  it('includes the order, product details, and quantity but omits price and notes', () => {
    const text = buildMarketplaceOrderSummary('260920H1GEBWRU', [
      {
        product_name: 'กบเหลาดินสอ 2 ช่อง SPA1 สีเขียว',
        product_name_raw: 'ชื่อจากไฟล์',
        sku_ref: 'SPA1',
        qty: 1,
        ink_color: null,
        cartoon_pattern: 'EG001',
        line_pattern: null,
        font: null,
        line_1: 'TEST',
        line_2: 'TEST',
        line_3: null,
        no_name_line: false,
      },
      {
        product_name: 'กบเหลา JUMBO',
        product_name_raw: null,
        sku_ref: null,
        qty: 2,
        ink_color: null,
        cartoon_pattern: null,
        line_pattern: null,
        font: null,
        line_1: null,
        line_2: null,
        line_3: null,
        no_name_line: false,
      },
    ], new Date('2026-09-20T09:45:00.000Z'))

    expect(text).toBe(
      'เลขคำสั่งซื้อ: 260920H1GEBWRU\n\n' +
      '1. กบเหลาดินสอ 2 ช่อง SPA1 สีเขียว\n' +
      'จำนวน 1 ชิ้น\n' +
      'ลาย: EG001\n' +
      'บรรทัด 1: TEST\n' +
      'บรรทัด 2: TEST\n\n' +
      '2. กบเหลา JUMBO\n' +
      'จำนวน 2 ชิ้น\n\n' +
      'เวลาส่งผลิต: 20/09/2569 16:45 น.\n\n' +
      '💖 โปรดอ่านและตรวจสอบรายละเอียดคำสั่งซื้ออีกครั้งนะคะ\n\n' +
      '• แอดมินได้สรุปรายละเอียดตามข้อมูลที่ลูกค้าแจ้งไว้ และทางร้านจะผลิต ตามรายละเอียดด้านบน ค่ะ ✨\n\n' +
      '• รบกวนตรวจสอบ ชื่อ / ข้อความ / ตัวสะกด / แบบ / ลาย / สี / จำนวน ให้ครบถ้วนก่อนยืนยันนะคะ\n\n' +
      '• เนื่องจากเป็นสินค้าสั่งผลิตเฉพาะบุคคล เมื่อเข้าสู่กระบวนการผลิตแล้ว จะไม่สามารถแก้ไขรายละเอียดได้ หากมีการเปลี่ยนแปลงภายหลัง อาจมีค่าใช้จ่ายเพิ่มเติมค่ะ\n\n' +
      '🛡️ การรับประกันสินค้า\n' +
      '• หากผลิต ไม่ตรงกับรายละเอียดด้านบน หรือเกิดความผิดพลาดจากทางร้าน เรายินดีตรวจสอบและดูแลให้ค่ะ 💕\n' +
      '• หากผลิตตรงตามรายละเอียด แต่ข้อมูลที่แจ้งไว้ไม่ถูกต้อง จะไม่อยู่ในเงื่อนไขการเคลมค่ะ\n\n' +
      '🌷 รายละเอียดด้านบนจะใช้เป็นข้อมูลอ้างอิงในการผลิตและการเคลมสินค้า\n\n' +
      'ขอบคุณที่ไว้วางใจ TR นะคะ 💗',
    )
    expect(text).not.toContain('ราคา')
    expect(text).not.toContain('หมายเหตุ')
  })

  it('includes every populated customization field and no-name selection, but not the file variation', () => {
    const text = buildMarketplaceOrderSummary('ORDER-2', [{
      product_name_raw: 'ตรายาง',
      sku_ref: null,
      qty: 1,
      ink_color: 'น้ำเงิน',
      cartoon_pattern: 'CT1001',
      line_pattern: 'กรอบมน',
      font: 'F01',
      line_1: null,
      line_2: null,
      line_3: null,
      no_name_line: true,
    }], new Date('2026-09-20T09:45:00.000Z'))

    expect(text).not.toContain('ตัวเลือก')
    expect(text).toContain('สีหมึก: น้ำเงิน')
    expect(text).not.toContain('ชั้น')
    expect(text).toContain('ลาย: CT1001')
    expect(text).toContain('ลายเส้น: กรอบมน')
    expect(text).toContain('ฟอนต์: F01')
    expect(text).toContain('ไม่รับชื่อ')
    expect(text).toContain('เวลาส่งผลิต: 20/09/2569 16:45 น.')
    expect(text).toContain('\n\n💖 โปรดอ่านและตรวจสอบรายละเอียดคำสั่งซื้ออีกครั้งนะคะ')
  })

  it('shows a zero pattern as no pattern', () => {
    const text = buildMarketplaceOrderSummary('ORDER-3', [{
      product_name_raw: 'กบเหลา',
      sku_ref: null,
      qty: 1,
      ink_color: null,
      cartoon_pattern: '0',
      line_pattern: null,
      font: null,
      line_1: null,
      line_2: null,
      line_3: null,
      no_name_line: false,
    }], new Date('2026-09-20T09:45:00.000Z'))

    expect(text).toContain('ลาย: ไม่เอาลาย')
    expect(text).not.toContain('ลาย: 0')
  })
})
