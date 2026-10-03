import { describe, expect, it } from 'vitest'
import { getPopoverPosition } from './popoverPosition'

describe('lot popover viewport placement', () => {
  it('opens below the price when there is room', () => {
    expect(getPopoverPosition({ top: 100, bottom: 124, right: 700 }, { width: 1000, height: 800 }, 300))
      .toMatchObject({ top: 128, left: 320, width: 380 })
  })
  it('opens above a price near the bottom instead of clipping the history', () => {
    expect(getPopoverPosition({ top: 700, bottom: 724, right: 700 }, { width: 1000, height: 800 }, 300).top).toBe(396)
  })
  it('fits narrow screens and keeps the left edge visible', () => {
    expect(getPopoverPosition({ top: 100, bottom: 124, right: 60 }, { width: 320, height: 640 }, 300))
      .toMatchObject({ left: 8, width: 304 })
  })
  it('caps tall content and preserves margins in a short viewport', () => {
    expect(getPopoverPosition({ top: 100, bottom: 124, right: 1000 }, { width: 800, height: 200 }, 400))
      .toMatchObject({ top: 8, left: 412, maxHeight: 184 })
  })
})
