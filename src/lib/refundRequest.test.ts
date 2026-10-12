import { describe, expect, it } from 'vitest'
import { refundRequestLink } from './refundRequest'

describe('refund request links', () => {
  it('allows omitted links', () => {
    expect(refundRequestLink('  ')).toBeNull()
    expect(refundRequestLink(null)).toBeNull()
  })
  it('accepts web links and trims whitespace', () => {
    expect(refundRequestLink(' https://example.com/chat?id=1 ')).toBe('https://example.com/chat?id=1')
    expect(refundRequestLink('http://example.com/')).toBe('http://example.com/')
  })
  it('rejects invalid or executable links', () => {
    for (const value of ['example.com', 'javascript:alert(1)', 'data:text/html,test', 'file:///tmp/test']) {
      expect(refundRequestLink(value)).toBeNull()
    }
  })
})
