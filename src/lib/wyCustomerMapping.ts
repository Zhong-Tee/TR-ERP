export type WyCustomerSourceRow = Record<string, unknown>

function clean(value: unknown): string {
  return String(value ?? '').trim().replace(/^'+/, '').trim()
}

/**
 * WY uses two different customer concepts in the export:
 * - `ชื่อลูกค้า` is the marketplace/channel customer name shown as "ชื่อช่องทาง" in Plan.
 * - `ชื่อ` + `นามสกุล` is the parcel recipient shown as "ชื่อลูกค้า" in Plan.
 */
export function mapWyCustomerFields(row: WyCustomerSourceRow): {
  customerName: string
  recipientName: string
} {
  const customerName = clean(row['ชื่อลูกค้า'])
  const recipientNameFromColumns = [clean(row['ชื่อ']), clean(row['นามสกุล'])]
    .filter(Boolean)
    .join(' ')
    .trim()
  const combinedRecipient = clean(row['ชื่อที่อยู่-เบอร์โทรผู้รับ'])
  const recipientNameFromAddress = combinedRecipient.includes(',')
    ? clean(combinedRecipient.split(',', 1)[0])
    : ''

  return {
    customerName,
    recipientName: recipientNameFromColumns || recipientNameFromAddress,
  }
}
