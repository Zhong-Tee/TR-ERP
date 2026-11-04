export type VatRecord = { tax_id: string; company_name: string; branch: string; tax_address: { house_number: string; building: string; floor: string; room: string; moo: string; village: string; soi: string; road: string; sub_district: string; district: string; province: string; postal_code: string } }
export function parseVatResponse(xml: string, taxId: string, branch: string): { status: 'found' | 'not_found'; records: VatRecord[] } {
  const match = xml.match(/<(?:\w+:)?ServiceResult(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?ServiceResult>/)
  if (!match) throw new Error('Invalid SOAP response')
  const json = match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const data = JSON.parse(json)
  if (!data || typeof data !== 'object' || !Array.isArray(data.NID)) throw new Error('Invalid VAT data')
  const field = (name: string, i: number) => { const v = String(data[name]?.[i] ?? '').trim(); return v === '-' ? '' : v }
  const messages = [data.msgerr, data.vmsgerr].flat().filter(Boolean).join(' ')
  if (!data.NID.length) {
    if (/ไม่พบข้อมูล|Data not found/i.test(messages)) return { status: 'not_found', records: [] }
    throw new Error('Unexpected empty VAT response')
  }
  const records: VatRecord[] = data.NID.map((_: unknown, i: number) => ({
    tax_id: field('NID', i), company_name: `${field('TitleName', i)} ${field('Name', i)}`.trim(), branch: field('BranchNumber', i).padStart(5, '0'),
    tax_address: { house_number: field('HouseNumber', i), building: field('BuildingName', i), floor: field('FloorNumber', i), room: field('RoomNumber', i), moo: field('MooNumber', i), village: field('VillageName', i), soi: [field('SoiName', i), field('Yaek', i)].filter(Boolean).join(' แยก '), road: field('StreetName', i), sub_district: field('Thambol', i), district: field('Amphur', i), province: field('Province', i), postal_code: field('PostCode', i) },
  }))
  if (records.some(r => r.tax_id !== taxId || r.branch !== branch || !r.company_name)) throw new Error('VAT identity mismatch')
  return { status: 'found', records }
}
