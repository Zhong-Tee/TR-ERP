import { describe, expect, it } from 'vitest'
import { calculateWithholding, extractTaxIdentity, formatTaxAddress, emptyTaxAddress, validTaxId, splitTaxAddressLine, resolveTaxLocality, orderReceivable } from './taxInvoice'
import { parseVatResponse } from '../../supabase/functions/rd-vat-lookup/parser'
describe('VAT-inclusive withholding', () => {
  it('deducts 3% after discounts and shipping without reducing VAT', () => {
    expect(calculateWithholding(1070 - 107 + 107, true)).toEqual({ gross: 1070, base: 1000, vat: 70, withheld: 30, receivable: 1040 })
    expect(calculateWithholding(1070, false).receivable).toBe(1070)
    expect(calculateWithholding(100, true)).toEqual({ gross: 100, base: 93.46, vat: 6.54, withheld: 2.8, receivable: 97.2 })
    expect(calculateWithholding(100, true, 0).receivable).toBe(97)
    expect(calculateWithholding(0, true).receivable).toBe(0)
    expect(() => calculateWithholding(-1, true)).toThrow()
  })
  it('keeps old bills payable unchanged', () => expect(orderReceivable({ total_amount: 1070 })).toBe(1070))
})
describe('tax data compatibility and extraction', () => {
  it('accepts formatted tax IDs and checks checksum', () => {
    expect(validTaxId('0-1035-63005-34-5')).toBe(true)
    expect(validTaxId('0103563005344')).toBe(false)
    expect(validTaxId('0000000000000')).toBe(false)
  })
  it('fills only a uniquely labelled tax number', () => {
    expect(extractTaxIdentity('TAX ID: 0103563005345').taxId).toBe('0103563005345')
    expect(extractTaxIdentity('0103563005345').taxId).toBe('')
    expect(extractTaxIdentity('เลขภาษี 0103563005345 เลขอื่น 0107537002443').taxId).toBe('')
    expect(extractTaxIdentity('เลขภาษี 0103563005345').addressText).toBe('')
  })
  it('separates labelled building, floor and road without dropping the house number', () => {
    expect(splitTaxAddressLine('เลขที่ 99/9 อาคารเอ ชั้น 3 ห้อง 12 ซอยสุขุมวิท 1 ถนนสุขุมวิท')).toEqual({house_number:'99/9',building:'เอ',floor:'3',room:'12',soi:'สุขุมวิท 1',road:'สุขุมวิท'})
  })
  it('preserves legacy addresses', () => expect(formatTaxAddress({ ...emptyTaxAddress(), legacy_text: 'ที่อยู่เก่าไม่ทราบรูปแบบ' })).toBe('ที่อยู่เก่าไม่ทราบรูปแบบ'))
})
describe('RD SOAP adapter', () => {
  const wrap = (data: unknown) => `<soap:Envelope><ServiceResult>${JSON.stringify(data).replaceAll('&','&amp;').replaceAll('"','&quot;')}</ServiceResult></soap:Envelope>`
  it('distinguishes not found from transport or malformed results', () => {
    expect(parseVatResponse(wrap({ NID: [], msgerr: ['ไม่พบข้อมูลที่ต้องการค้นหา <br> Data not found'] }), '0103563005345','00000').status).toBe('not_found')
    expect(() => parseVatResponse('<html>Error</html>', '0103563005345','00000')).toThrow()
    expect(() => parseVatResponse(wrap({ NID: [] }), '0103563005345','00000')).toThrow()
  })
  it('normalizes missing fields, ignores v duplicates and verifies the requested branch', () => {
    const data = { NID: ['0103563005345'], vNID: ['0103563005345'], TitleName: ['ห้างหุ้นส่วนจำกัด'], Name: ['ทีอาร์ คิดส์ช็อป'], BranchNumber: ['1'], BuildingName: ['-'] }
    const result = parseVatResponse(wrap(data),'0103563005345','00001')
    expect(result.records).toHaveLength(1)
    expect(result.records[0].tax_address.building).toBe('')
    expect(() => parseVatResponse(wrap(data),'0103563005345','00000')).toThrow()
  })
})

describe('tax locality resolution', () => {
  const options = ['บางแค','บางแคเหนือ','บางไผ่','หลักสอง'].map(subDistrict=>({subDistrict,district:'บางแค',province:'กรุงเทพมหานคร'}))
  it('uses explicit subdistrict and district within a shared postcode', () => {
    expect(resolveTaxLocality('1641,1643 ชั้นที่3 ถ.เพชรเกษม แขวงหลักสอง เขตบางแค กทม. 10160',options)).toEqual(options[3])
  })
  it('does not select the first locality when only the postcode is known', () => {
    expect(resolveTaxLocality('1641 เพชรเกษม 10160',options)).toBeUndefined()
  })
  it('does not accept conflicting district or province', () => {
    expect(resolveTaxLocality('แขวงหลักสอง เขตปทุมวัน กทม. 10160',options)).toBeUndefined()
    expect(resolveTaxLocality('ตำบลหลักสอง อำเภอบางแค จังหวัดนนทบุรี 10160',options)).toBeUndefined()
  })
})
