import { describe, expect, it } from 'vitest'
import { splitAddressParts } from './thaiAddress'

describe('splitAddressParts', () => {
  it('keeps an organization prefix when a separate recipient name is available', () => {
    const result = splitAddressParts(
      'กองบังคับการตำรวจนครบาล 3 เลขที่ 190 ถนนสีหบุรานุกิจ มีนบุรี กรุงเทพมหานคร 10510',
      'สร้อยทิพย์ อวดผล',
    )

    expect(result.recipientName).toBe('สร้อยทิพย์ อวดผล')
    expect(result.address).toBe('กองบังคับการตำรวจนครบาล 3 เลขที่ 190 ถนนสีหบุรานุกิจ มีนบุรี กรุงเทพมหานคร 10510')
  })

  it('removes the known recipient from the raw address when it is actually present', () => {
    const result = splitAddressParts(
      'สร้อยทิพย์ อวดผล 3 เลขที่ 190 ถนนสีหบุรานุกิจ มีนบุรี กรุงเทพมหานคร 10510',
      'สร้อยทิพย์ อวดผล',
    )

    expect(result.recipientName).toBe('สร้อยทิพย์ อวดผล')
    expect(result.address).toBe('3 เลขที่ 190 ถนนสีหบุรานุกิจ มีนบุรี กรุงเทพมหานคร 10510')
  })

  it('still infers a recipient when no separate recipient field exists', () => {
    const result = splitAddressParts('สมชาย ใจดี 99/9 ถนนสุขุมวิท กรุงเทพฯ 10110')

    expect(result.recipientName).toBe('สมชาย ใจดี')
    expect(result.address).toBe('99/9 ถนนสุขุมวิท กรุงเทพฯ 10110')
  })
})
