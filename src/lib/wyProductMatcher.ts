export type WyProductLookup = {
  id: string
  product_code?: string | null
  product_name?: string | null
}

function normalizeLookupText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^'+/, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

/**
 * WY exports use aliases such as WY-WYS1G while the product master stores
 * WYS01G. Only normalize that documented format; do not use partial matching.
 */
export function normalizeWyProductCode(value: unknown): string {
  const withoutChannelPrefix = normalizeLookupText(value).replace(/^WY-/, '')
  return withoutChannelPrefix.replace(/^WYS(\d)([A-Z]*)$/, 'WYS0$1$2')
}

function getUniqueMatch<T>(matches: T[]): T | null {
  return matches.length === 1 ? matches[0] : null
}

export function findWyProduct<T extends WyProductLookup>(
  products: T[],
  rawCode: unknown,
  rawProductName: unknown,
): T | null {
  const code = normalizeWyProductCode(rawCode)
  if (code) {
    const codeMatches = products.filter((product) =>
      [product.product_code, product.product_name].some(
        (value) => normalizeWyProductCode(value) === code,
      ),
    )
    if (codeMatches.length > 0) return getUniqueMatch(codeMatches)
  }

  const productName = normalizeLookupText(rawProductName)
  if (!productName) return null

  return getUniqueMatch(
    products.filter((product) => normalizeLookupText(product.product_name) === productName),
  )
}
