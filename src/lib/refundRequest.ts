export function refundRequestLink(value: string | null | undefined): string | null {
  const link = value?.trim()
  if (!link) return null
  try {
    const url = new URL(link)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}
