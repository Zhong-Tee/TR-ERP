import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { sha256BytesHex } from './fileHash'
import { deliveryFileHash, parseDeliveryFile } from './deliveryCheck'
import { sha256Hex } from './bankStatement'

afterEach(() => vi.unstubAllGlobals())

describe('import fingerprints without Web Crypto', () => {
  it('keeps the standard SHA-256 fingerprints used for duplicate detection', () => {
    expect(sha256BytesHex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256BytesHex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it.each([undefined, {}])('hashes Statement and carrier files when crypto is %s', async cryptoValue => {
    vi.stubGlobal('crypto', cryptoValue)
    const statement = 'วันที่,รายละเอียด,เงินเข้า\n01/10/2569,รับโอนเงิน,280.00'
    expect(await sha256Hex(statement)).toBe(createHash('sha256').update(statement).digest('hex'))
    const bytes = Uint8Array.from({ length: 4097 }, (_, i) => i % 256)
    expect(await deliveryFileHash(new File([bytes], 'carrier.xlsx'))).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('previews and fingerprints an Excel file together with crypto.subtle unavailable', async () => {
    vi.stubGlobal('crypto', {})
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['เวลาสร้าง','เลขออเดอร์','เลขพัสดุ','ชื่อผู้ส่ง','ชื่อผู้รับ','เบอร์ผู้รับ','ที่อยู่ที่รับ','สถานะงานรับ'],
      ['2026-10-06 12:00:00','PUMP26100001','TH123','ผู้ส่ง','ผู้รับ','0812345678','กรุงเทพ','รับพัสดุแล้ว'],
    ]), 'Pickup')
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = new File([bytes], 'pickup.xlsx')
    const [preview, hash] = await Promise.all([parseDeliveryFile(file), deliveryFileHash(file)])
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].pickup_status).toBe('รับพัสดุแล้ว')
    expect(hash).toBe(createHash('sha256').update(new Uint8Array(bytes)).digest('hex'))
  })
})
