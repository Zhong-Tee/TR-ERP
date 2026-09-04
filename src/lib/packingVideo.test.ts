import { describe, expect, it } from 'vitest'
import {
  codecFromVideoMimeType,
  getSupportedPackingVideoMimeTypes,
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
})
