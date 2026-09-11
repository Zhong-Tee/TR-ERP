export type WaybillBillingDetails = {
  address_line?: string | null
  sub_district?: string | null
  district?: string | null
  province?: string | null
  postal_code?: string | null
  mobile_phone?: string | null
}

type WaybillCustomerInput = {
  customerAddress?: string | null
  recipientName?: string | null
  customerName?: string | null
  billingDetails?: WaybillBillingDetails | null
  parsedAddress: string
  parsedPostalCode: string
  parsedPhones: string[]
}

/**
 * Select current reviewed shipping fields for a waybill. customerAddress is
 * presentation-only raw text; structured fields always win for shipment data.
 */
export function resolveWaybillCustomer(input: WaybillCustomerInput) {
  const billing = input.billingDetails
  const structuredAddress = [billing?.address_line, billing?.sub_district, billing?.district, billing?.province]
    .filter(Boolean).join(' ').trim()
  const billingPhone = String(billing?.mobile_phone || '').trim()
  const phones: string[] = []
  for (const phone of [billingPhone, ...input.parsedPhones]) {
    if (phone && !phones.includes(phone)) phones.push(phone)
  }

  return {
    addressRaw: String(input.customerAddress || '').trim(),
    consigneeName: String(input.recipientName || '').trim() || String(input.customerName || '').trim(),
    address: structuredAddress || input.parsedAddress,
    postalCode: String(billing?.postal_code || '').trim() || input.parsedPostalCode,
    phone1: phones[0] || '',
    phone2: phones[1] || '',
  }
}
