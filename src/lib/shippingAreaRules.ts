export type ShippingAreaType = 'remote' | 'special_tourism'

export type ShippingAreaRule = {
  id: string
  carrier: string
  area_type: ShippingAreaType
  channel_codes?: string[] | null
  postal_code?: string | null
  province: string
  district: string
  sub_district?: string | null
  surcharge: number
  is_forever: boolean
  start_date?: string | null
  end_date?: string | null
  is_active: boolean
  created_at?: string
  updated_at?: string
  updated_by?: string | null
}

export type ShippingAddress = {
  carrier?: string | null
  channel_code?: string | null
  postal_code?: string | null
  province?: string | null
  district?: string | null
  sub_district?: string | null
  order_date?: string
}

export const SHIPPING_AREA_TYPE_LABELS: Record<ShippingAreaType, string> = {
  remote: 'พื้นที่ห่างไกล',
  special_tourism: 'พื้นที่ท่องเที่ยวพิเศษ',
}

export function normalizeCarrierName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/(EXPRESS|ขนส่ง)/gu, '')
    .replace(/[^A-Z0-9ก-๙]/gu, '')
}

function stripPrefix(value: string, kind: 'province' | 'district' | 'sub_district') {
  if (kind === 'province') return value.replace(/^(จังหวัด|จ\.)/u, '')
  if (kind === 'district') return value.replace(/^(เขต|อำเภอ|อ\.)/u, '')
  return value.replace(/^(แขวง|ตำบล|ต\.)/u, '')
}

export function normalizeShippingAddressPart(
  value: unknown,
  kind: 'province' | 'district' | 'sub_district' | 'postal_code' | 'channel_code',
): string {
  const raw = String(value ?? '').trim()
  if (kind === 'postal_code') return raw.replace(/\D/g, '').slice(0, 5)
  if (kind === 'channel_code') return raw.toUpperCase().replace(/\s+/g, '')
  let normalized = stripPrefix(raw, kind)
    .replace(/[\s._\-/]/g, '')
    .toLowerCase()
  if (kind === 'province' && ['กรุงเทพฯ', 'กรุงเทพ', 'กทม'].includes(normalized)) normalized = 'กรุงเทพมหานคร'
  return normalized
}

function matchesOptional(ruleValue: string | null | undefined, addressValue: string | null | undefined, kind: 'postal_code' | 'sub_district') {
  if (!ruleValue) return true
  return normalizeShippingAddressPart(ruleValue, kind) === normalizeShippingAddressPart(addressValue, kind)
}

export function shippingAreaRuleMatches(rule: ShippingAreaRule, address: ShippingAddress): boolean {
  if (!rule.is_active) return false
  const orderDate = address.order_date || new Date().toISOString().slice(0, 10)
  if (!rule.is_forever) {
    if (!rule.start_date || !rule.end_date || orderDate < rule.start_date || orderDate > rule.end_date) return false
  }
  const channels = rule.channel_codes || []
  if (address.carrier != null && normalizeCarrierName(rule.carrier) !== normalizeCarrierName(address.carrier)) return false
  const channelCode = normalizeShippingAddressPart(address.channel_code, 'channel_code')
  if (channels.length && !channels.some((code) => normalizeShippingAddressPart(code, 'channel_code') === channelCode)) return false
  if (!matchesOptional(rule.postal_code, address.postal_code, 'postal_code')) return false
  if (normalizeShippingAddressPart(rule.province, 'province') !== normalizeShippingAddressPart(address.province, 'province')) return false
  if (normalizeShippingAddressPart(rule.district, 'district') !== normalizeShippingAddressPart(address.district, 'district')) return false
  return matchesOptional(rule.sub_district, address.sub_district, 'sub_district')
}

function specificity(rule: ShippingAreaRule): number {
  return (rule.channel_codes?.length ? 100 : 0)
    + (rule.sub_district ? 40 : 0)
    + (rule.district ? 20 : 0)
    + (rule.postal_code ? 10 : 0)
    + (rule.province ? 5 : 0)
}

export function findShippingAreaRule(rules: ShippingAreaRule[], address: ShippingAddress): ShippingAreaRule | null {
  return rules
    .filter((rule) => shippingAreaRuleMatches(rule, address))
    .sort((a, b) => specificity(b) - specificity(a) || Number(b.surcharge) - Number(a.surcharge))[0] || null
}

export function calculateShippingCharge(standardFee: number, surcharge: number, baseShippingWaived: boolean) {
  const standard_shipping_fee = Math.max(0, Number(standardFee) || 0)
  const special_area_surcharge = Math.max(0, Number(surcharge) || 0)
  const charged_standard_fee = baseShippingWaived ? 0 : standard_shipping_fee
  return {
    standard_shipping_fee,
    charged_standard_fee,
    special_area_surcharge,
    total_shipping_fee: charged_standard_fee + special_area_surcharge,
  }
}
