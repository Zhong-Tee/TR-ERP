import { describe, it, expect } from 'vitest'
import { countThaiBillChars } from './thaiBillCharCount'

describe('countThaiBillChars', () => {
  it('counts plain Thai consonants', () => {
    expect(countThaiBillChars('ก')).toBe(1)
    expect(countThaiBillChars('กขค')).toBe(3)
  })

  it('does not count tone marks and floating vowels above/below', () => {
    expect(countThaiBillChars('ก่')).toBe(1)
    expect(countThaiBillChars('ก้')).toBe(1)
    expect(countThaiBillChars('ก๊')).toBe(1)
    expect(countThaiBillChars('ก๋')).toBe(1)
    expect(countThaiBillChars('กิ')).toBe(1)
    expect(countThaiBillChars('กี')).toBe(1)
    expect(countThaiBillChars('กึ')).toBe(1)
    expect(countThaiBillChars('กื')).toBe(1)
    expect(countThaiBillChars('กุ')).toBe(1)
    expect(countThaiBillChars('กู')).toBe(1)
    expect(countThaiBillChars('ก็')).toBe(1)
    expect(countThaiBillChars('ก์')).toBe(1)
  })

  it('counts spaces and Latin', () => {
    expect(countThaiBillChars('a b')).toBe(3)
    expect(countThaiBillChars('hello')).toBe(5)
  })

  it('counts sara am ำ as one unit and leading vowels', () => {
    expect(countThaiBillChars('กำ')).toBe(2)
    expect(countThaiBillChars('เก')).toBe(2)
    expect(countThaiBillChars('แก')).toBe(2)
  })

  it('mixed word with combining marks', () => {
    expect(countThaiBillChars('สวัสดี')).toBe(4)
    expect(countThaiBillChars('เกี๊ยว')).toBe(4)
  })

  it('empty string', () => {
    expect(countThaiBillChars('')).toBe(0)
  })
})
