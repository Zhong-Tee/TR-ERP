import { describe, expect, it } from 'vitest'
import { selectReviewScopes } from './wmsReviewQueue'

const groups = [
  { id: 'new', pending: 0, uncheckedInspect: 1, date: '2026-10-06', label: 'ใหม่' },
  { id: 'old', pending: 0, uncheckedInspect: 2, date: '2026-09-11', label: 'เก่า' },
  { id: 'req:REQ-1', pending: 1, uncheckedInspect: 1, date: '2026-09-12', label: 'ใบเบิก' },
  { id: 'done', pending: 0, uncheckedInspect: 0, date: '2026-10-06', label: 'ตรวจครบ' },
]
const rows = { new: [{ created_at: '2026-10-06T03:00:00Z' }], old: [{ created_at: '2026-09-11T03:00:00Z' }, { created_at: '2026-10-05T18:00:00Z' }], done: [{ created_at: '2026-10-06T03:00:00Z' }] }

describe('review backlog across dates', () => {
  it('shows old work and requisitions first, while blocking scopes still being picked', () => {
    const queue = selectReviewScopes(groups, rows, '')
    expect(queue.backlog.map(g => g.id)).toEqual(['old', 'req:REQ-1', 'new'])
    expect(queue.ready.map(g => g.id)).toEqual(['new', 'old'])
  })
  it('keeps the complete backlog while selecting completed history and cross-day work in Bangkok time', () => {
    const queue = selectReviewScopes(groups, rows, '2026-10-06')
    expect(queue.backlog.map(g => g.id)).toEqual(['old', 'req:REQ-1', 'new'])
    expect(queue.ready.map(g => g.id)).toEqual(['new', 'old', 'done'])
    expect(queue.ready.find(g => g.id === 'old')?.uncheckedInspect).toBe(2)
  })
  it('removes fully checked work from the queue', () => {
    expect(selectReviewScopes(groups.map(g => ({ ...g, uncheckedInspect: 0 })), rows, '').backlog).toEqual([])
  })
})
