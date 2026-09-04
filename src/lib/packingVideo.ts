export const PACKING_VIDEO_MIME_PRIORITY = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp8',
  'video/webm',
] as const

export function getSupportedPackingVideoMimeTypes(
  isTypeSupported: (mimeType: string) => boolean,
): string[] {
  return PACKING_VIDEO_MIME_PRIORITY.filter((mimeType) => {
    try {
      return isTypeSupported(mimeType)
    } catch {
      return false
    }
  })
}

export function videoFileExtension(mimeType: string | null | undefined): 'mp4' | 'webm' {
  return String(mimeType || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm'
}

export function codecFromVideoMimeType(mimeType: string): string {
  const match = mimeType.match(/codecs?=([^;]+)/i)
  return match?.[1]?.replace(/["']/g, '').trim() || mimeType.split('/')[1]?.split(';')[0] || '-'
}
