export interface TaxAddress {
  house_number: string
  building: string
  floor: string
  room: string
  moo: string
  village: string
  soi: string
  road: string
  sub_district: string
  district: string
  province: string
  postal_code: string
  /** Unparsed legacy address is retained until the user supplies structured data. */
  legacy_text?: string
}
export const emptyTaxAddress = (): TaxAddress => ({ house_number: '', building: '', floor: '', room: '', moo: '', village: '', soi: '', road: '', sub_district: '', district: '', province: '', postal_code: '' })
export const normalizeTaxId = (text: string) => text.replace(/[\s-]/g, '')
export function validTaxId(text: string) {
  const id = normalizeTaxId(text)
  if (!/^\d{13}$/.test(id) || /^0+$/.test(id)) return false
  const sum = [...id.slice(0, 12)].reduce((n, digit, i) => n + Number(digit) * (13 - i), 0)
  return (11 - sum % 11) % 10 === Number(id[12])
}
export function formatTaxAddress(a: TaxAddress): string {
  const values = [a.house_number, a.building && `อาคาร${a.building}`, a.floor && `ชั้น ${a.floor}`, a.room && `ห้อง ${a.room}`, a.moo && `หมู่ ${a.moo}`, a.village && `หมู่บ้าน${a.village}`, a.soi && `ซอย${a.soi}`, a.road && `ถนน${a.road}`, a.sub_district && `${a.province === 'กรุงเทพมหานคร' ? 'แขวง' : 'ตำบล'}${a.sub_district}`, a.district && `${a.province === 'กรุงเทพมหานคร' ? 'เขต' : 'อำเภอ'}${a.district}`, a.province, a.postal_code].filter(Boolean)
  return values.join(' ') || a.legacy_text || ''
}
/** Only a uniquely labelled number is safe to fill automatically. */
export function extractTaxIdentity(text: string) {
  const pattern = /(?<!\d)\d(?:[\s-]?\d){12}(?!\d)/g
  const candidates = [...new Set((text.match(pattern) || []).map(normalizeTaxId))]
  const labelled = [...text.matchAll(/(?:เลขประจำตัวผู้เสียภาษี(?:อากร)?|เลขภาษี|TAX\s*ID|TIN)\s*[:：]?\s*(\d(?:[\s-]?\d){12})(?!\d)/gi)].map(m => normalizeTaxId(m[1]))
  const taxId = candidates.length === 1 && labelled.includes(candidates[0]) ? candidates[0] : ''
  return { taxId, candidates, addressText: text.replace(/(?:เลขประจำตัวผู้เสียภาษี(?:อากร)?|เลขภาษี|TAX\s*ID|TIN)\s*[:：]?\s*\d(?:[\s-]?\d){12}/gi, '').replace(pattern, '').trim() }
}
export function calculateWithholding(gross: number, enabled: boolean, vatRate = 7) {
  if (!Number.isFinite(gross) || gross < 0 || !Number.isFinite(vatRate) || vatRate < 0) throw new Error('ยอดบิลหรืออัตราภาษีไม่ถูกต้อง')
  const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
  const total = round(gross)
  const base = round(total / (1 + vatRate / 100))
  // Round the VAT-exclusive base first; VAT is the residual, so totals reconcile.
  const withheld = enabled ? round(base * .03) : 0
  return { gross: total, base, vat: round(total - base), withheld, receivable: round(total - withheld) }
}
export function orderReceivable(order: { total_amount?: number | null; billing_details?: { withholding_requested?: boolean; vat_rate?: number } | null }) {
  return calculateWithholding(Number(order.total_amount || 0), order.billing_details?.withholding_requested === true, order.billing_details?.vat_rate ?? 7).receivable
}

export function taxInvoiceErrors(value: { company_name: string; address: string; tax_id: string; branch?: string; tax_address?: TaxAddress }) {
  const errors: string[] = []
  if (!value.company_name.trim()) errors.push('กรอกชื่อลูกค้า / บริษัท')
  if (!value.address.trim()) errors.push('กรอกที่อยู่ใบกำกับภาษี')
  if (!validTaxId(value.tax_id)) errors.push('เลขภาษีต้องมี 13 หลักและเลขตรวจสอบถูกต้อง')
  if (!/^\d{5}$/.test(value.branch ?? '00000')) errors.push('เลขสาขาต้องมี 5 หลัก')
  if (value.tax_address && (!/^\d{5}$/.test(value.tax_address.postal_code) || !value.tax_address.sub_district || !value.tax_address.district || !value.tax_address.province)) errors.push('เลือกตำบล อำเภอ จังหวัด และรหัสไปรษณีย์ให้ครบ')
  return errors
}

/** Split explicitly labelled address details; retain an unlabelled line intact. */
export function splitTaxAddressLine(line: string): Partial<TaxAddress> {
  const labels: [keyof TaxAddress,string][] = [['building','อาคาร'],['floor','ชั้น(?:ที่)?'],['room','ห้อง'],['moo','หมู่(?!บ้าน)(?:ที่)?'],['village','หมู่บ้าน'],['soi','ซอย|ซ\\.'],['road','ถนน|ถ\\.']]
  const markers=labels.flatMap(([field,label])=>{const match=new RegExp(`(?:${label})\\s*`,'u').exec(line);return match?[{field,start:match.index,end:match.index+match[0].length}]:[]}).sort((a,b)=>a.start-b.start)
  const parts: Partial<TaxAddress>={house_number:(markers.length?line.slice(0,markers[0].start):line).replace(/^เลขที่\s*/,'').trim()}
  markers.forEach((marker,i)=>{parts[marker.field]=line.slice(marker.end,markers[i+1]?.start ?? line.length).trim()})
  return parts
}

/** Resolve only an explicit, unique locality within the postcode's candidates. */
export function resolveTaxLocality<T extends { subDistrict: string; district: string; province?: string }>(text: string, options: T[]): T | undefined {
  const sub = /(?:แขวง|ตำบล|ต\.)\s*([^\s,]+?)(?=\s|เขต|อำเภอ|อ\.|จังหวัด|จ\.|$)/u.exec(text)?.[1]
  const district = /(?:เขต|อำเภอ|อ\.)\s*([^\s,]+?)(?=\s|จังหวัด|จ\.|$)/u.exec(text)?.[1]
  const province = /(?:จังหวัด|จ\.)\s*([^\s,]+)/u.exec(text)?.[1]
    || (/(?:กรุงเทพมหานคร|กรุงเทพฯ|กทม\.?)/u.test(text) ? 'กรุงเทพมหานคร' : undefined)
  const unique = options.filter((option, i) => option.district && options.findIndex(other => other.subDistrict === option.subDistrict && other.district === option.district && other.province === option.province) === i)
  const matches = unique.filter(option => (!sub || option.subDistrict === sub)
    && (!district || option.district.replace(/^(?:เขต|อำเภอ)\s*/, '') === district)
    && (!province || option.province === province))
  return matches.length === 1 ? matches[0] : undefined
}
