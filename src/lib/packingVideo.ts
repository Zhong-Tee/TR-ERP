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

/**
 * MediaRecorder บางรุ่นรับ option video/mp4 แต่คืน container จริงเป็น
 * video/x-matroska + H.264 ซึ่ง Google Drive ไม่สามารถ preview เป็น WebM ได้
 * จึงต้องตรวจ MIME ที่ recorder เลือกจริงก่อนเริ่มบันทึก
 */
export function isPackingRecorderMimeCompatible(requestedMimeType: string, actualMimeType: string): boolean {
  const requested = String(requestedMimeType || '').toLowerCase()
  const actual = String(actualMimeType || requestedMimeType || '').toLowerCase()

  if (requested.includes('video/mp4')) {
    if (!actual.includes('video/mp4')) return false
    const declaresCodec = /codecs?=/.test(actual)
    return !declaresCodec || /(avc1|avc3|h\.264|h264)/.test(actual)
  }

  if (requested.includes('video/webm')) {
    if (!actual.includes('video/webm')) return false
    // VP9/AV1/H.264 are intentionally not accepted for the compatibility profile.
    if (/(vp0?9|av01|avc1|avc3|h\.264|h264|hevc|hvc1|hev1)/.test(actual)) return false
    const declaresCodec = /codecs?=/.test(actual)
    return !requested.includes('vp8') || !declaresCodec || /vp0?8/.test(actual)
  }

  return false
}

export function isSafePackingRecorderMimeType(actualMimeType: string): boolean {
  return isPackingRecorderMimeCompatible(actualMimeType, actualMimeType)
}

export function videoFileExtension(mimeType: string | null | undefined): 'mp4' | 'webm' {
  return String(mimeType || '').toLowerCase().includes('mp4') ? 'mp4' : 'webm'
}

export function codecFromVideoMimeType(mimeType: string): string {
  const match = mimeType.match(/codecs?=([^;]+)/i)
  return match?.[1]?.replace(/["']/g, '').trim() || mimeType.split('/')[1]?.split(';')[0] || '-'
}
