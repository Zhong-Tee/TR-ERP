export type WaybillBillingDetails = {
  address_line?: string | null
  sub_district?: string | null
  district?: string | null
  province?: string | null
  postal_code?: string | null
  mobile_phone?: string | null
  /** Legacy claim/order snapshots used camelCase before shipping was normalized. */
  mobilePhone?: string | null
}

/** PostgreSQL JSON null || object produces an array; later confirmations append objects. */
export function normalizeWaybillBillingDetails(value: unknown): WaybillBillingDetails {
  const parts = Array.isArray(value) ? value : [value]
  return Object.assign({}, ...parts.filter(
    (part) => part !== null && typeof part === 'object' && !Array.isArray(part),
  )) as WaybillBillingDetails
}

export function waybillMobilePhone(value: unknown): string {
  const billing = normalizeWaybillBillingDetails(value)
  return String(billing.mobile_phone || '').trim() || String(billing.mobilePhone || '').trim()
}

type WaybillCustomerInput = {
  customerAddress?: string | null
  recipientName?: string | null
  customerName?: string | null
  billingDetails?: WaybillBillingDetails | Array<WaybillBillingDetails | null> | null
  parsedAddress: string
  parsedPostalCode: string
  parsedPhones: string[]
  /** Claim shipments must use the newly confirmed address, not inherited structured fields. */
  preferParsedAddress?: boolean
}

/**
 * Select current reviewed shipping fields for a waybill. customerAddress is
 * presentation-only raw text; structured fields always win for shipment data.
 */
export function resolveWaybillCustomer(input: WaybillCustomerInput) {
  const billing = normalizeWaybillBillingDetails(input.billingDetails)
  const structuredAddress = [billing?.address_line, billing?.sub_district, billing?.district, billing?.province]
    .filter(Boolean).join(' ').trim()
  const billingPhone = waybillMobilePhone(billing)
  const phones: string[] = []
  for (const phone of [billingPhone, ...input.parsedPhones]) {
    if (phone && !phones.includes(phone)) phones.push(phone)
  }

  return {
    addressRaw: String(input.customerAddress || '').trim(),
    consigneeName: String(input.recipientName || '').trim() || String(input.customerName || '').trim(),
    address: input.preferParsedAddress
      ? input.parsedAddress || structuredAddress
      : structuredAddress || input.parsedAddress,
    postalCode: input.preferParsedAddress
      ? input.parsedPostalCode || String(billing?.postal_code || '').trim()
      : String(billing?.postal_code || '').trim() || input.parsedPostalCode,
    phone1: phones[0] || '',
    phone2: phones[1] || '',
  }
}
