import { describe, expect, it } from 'vitest'
import { createStoragePath } from './storagePath'

describe('createStoragePath', () => {
  it('does not include Thai characters or spaces from the original filename', () => {
    const path = createStoragePath('documents', 'ใบเสร็จรับเงิน.pdf')

    expect(path).toMatch(/^documents\/[a-z0-9_]+\.pdf$/)
    expect(path).not.toContain('ใบเสร็จรับเงิน')
  })

  it('normalizes an ASCII extension to lowercase', () => {
    expect(createStoragePath('assets', 'รูปทรัพย์สิน.JPEG')).toMatch(
      /^assets\/[a-z0-9_]+\.jpeg$/,
    )
  })

  it('drops unsafe or excessively long extensions', () => {
    expect(createStoragePath('documents', 'เอกสาร.นามสกุล')).toMatch(
      /^documents\/[a-z0-9_]+$/,
    )
  })
})
