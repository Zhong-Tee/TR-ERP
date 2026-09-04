import { describe, expect, it } from 'vitest'
import {
  codecFromVideoMimeType,
  getSupportedPackingVideoMimeTypes,
  isPackingRecorderMimeCompatible,
  isSafePackingRecorderMimeType,
  videoFileExtension,
} from './packingVideo'

describe('packing video format negotiation', () => {
  it('prefers H.264 MP4 over generic MP4 and WebM VP8', () => {
    const supported = new Set([
      'video/webm;codecs=vp8',
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E',
    ])

    expect(getSupportedPackingVideoMimeTypes((type) => supported.has(type))).toEqual([
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp8',
    ])
  })

  it('falls back to VP8 and never proposes VP9', () => {
    expect(getSupportedPackingVideoMimeTypes((type) => type.includes('webm'))).toEqual([
      'video/webm;codecs=vp8',
      'video/webm',
    ])
  })

  it('uses an extension matching the selected container', () => {
    expect(videoFileExtension('video/mp4;codecs=avc1.42E01E')).toBe('mp4')
    expect(videoFileExtension('video/webm;codecs=vp8')).toBe('webm')
    expect(codecFromVideoMimeType('video/mp4;codecs=avc1.42E01E')).toBe('avc1.42E01E')
  })

  it('rejects H.264 Matroska returned for an MP4 request', () => {
    expect(isPackingRecorderMimeCompatible(
      'video/mp4;codecs=avc1.42E01E',
      'video/x-matroska;codecs=avc1.42E01E',
    )).toBe(false)
    expect(isSafePackingRecorderMimeType('video/x-matroska;codecs=avc1.42E01E')).toBe(false)
  })

  it('accepts H.264 MP4 and the VP8 WebM fallback but rejects VP9', () => {
    expect(isPackingRecorderMimeCompatible(
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1.42E01E',
    )).toBe(true)
    expect(isPackingRecorderMimeCompatible(
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp8',
    )).toBe(true)
    expect(isSafePackingRecorderMimeType('video/webm;codecs=vp9')).toBe(false)
  })
})
