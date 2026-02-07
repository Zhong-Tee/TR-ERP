import { getPublicUrl } from '../../lib/qcApi'

export const WMS_STATUS_LABELS: Record<string, string> = {
  pending: 'กำลังจัด',
  picked: 'หยิบแล้ว',
  out_of_stock: 'สินค้าหมด',
  correct: 'หยิบถูก',
  wrong: 'หยิบผิด',
  not_find: 'ไม่เจอสินค้า',
}

const PRODUCT_IMAGE_BUCKET = 'product-images'

export function getProductImageUrl(productCode: string | null | undefined, ext: string = '.jpg'): string {
  if (!productCode) return ''
  return getPublicUrl(PRODUCT_IMAGE_BUCKET, productCode, ext)
}

export function formatDuration(ms: number): string {
  if (ms < 0 || Number.isNaN(ms)) return '00:00:00'
  let s = Math.floor(ms / 1000)
  let h = Math.floor(s / 3600)
  s %= 3600
  let m = Math.floor(s / 60)
  s %= 60
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function calculateDuration(startTime: string, endTime: string | null): string {
  const s = new Date(startTime)
  const e = endTime ? new Date(endTime) : new Date()
  return formatDuration(e.getTime() - s.getTime())
}

export function sortOrderItems<T extends { location?: string | null }>(items: T[] | null | undefined): T[] {
  if (!items) return []
  return [...items].sort((a, b) => {
    const locA = a.location || ''
    const locB = b.location || ''
    if (locA === 'อะไหล่' && locB !== 'อะไหล่') return 1
    if (locA !== 'อะไหล่' && locB === 'อะไหล่') return -1
    return locA.localeCompare(locB, 'th')
  })
}
