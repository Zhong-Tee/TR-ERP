import { describe, expect, it } from 'vitest'
import { pickUnacknowledged } from './announcementAlert'
import type { HRAnnouncement } from '../types'

function ann(over: Partial<HRAnnouncement> & { id: string }): HRAnnouncement {
  return {
    title: `ประกาศ ${over.id}`,
    content: '',
    status: 'published',
    is_pinned: false,
    published_at: '2026-08-01T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    attachment_urls: [],
    ...over,
  } as HRAnnouncement
}

describe('pickUnacknowledged', () => {
  it('เอาเฉพาะประกาศที่เผยแพร่แล้วและยังไม่กดรับทราบ', () => {
    const list = [
      ann({ id: 'read' }),
      ann({ id: 'pending', status: 'pending' }),
      ann({ id: 'rejected', status: 'rejected' }),
      ann({ id: 'new' }),
    ]
    expect(pickUnacknowledged(list, new Set(['read'])).map((a) => a.id)).toEqual(['new'])
  })

  it('ปักหมุดมาก่อน แล้วเรียงเก่าไปใหม่', () => {
    const list = [
      ann({ id: 'new', published_at: '2026-08-05T00:00:00Z' }),
      ann({ id: 'pinned', is_pinned: true, published_at: '2026-08-04T00:00:00Z' }),
      ann({ id: 'old', published_at: '2026-08-02T00:00:00Z' }),
    ]
    expect(pickUnacknowledged(list, new Set()).map((a) => a.id)).toEqual(['pinned', 'old', 'new'])
  })

  it('ไม่มีวันเผยแพร่ → ใช้วันที่สร้างแทน', () => {
    const list = [
      ann({ id: 'b', published_at: null, created_at: '2026-08-03T00:00:00Z' }),
      ann({ id: 'a', published_at: null, created_at: '2026-08-01T00:00:00Z' }),
    ]
    expect(pickUnacknowledged(list, new Set()).map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('รับทราบครบแล้ว → ไม่มีอะไรให้เตือน', () => {
    const list = [ann({ id: 'x' }), ann({ id: 'y' })]
    expect(pickUnacknowledged(list, new Set(['x', 'y']))).toEqual([])
  })
})
