import { expect, it } from 'vitest'
import { resolvePickingSlipStatus } from './pickingSlipStatus'

it('marks eligible unprinted work orders as new', () => {
  expect(resolvePickingSlipStatus(true, false)).toBe('new')
})
it('marks eligible work orders with print history as printed', () => {
  expect(resolvePickingSlipStatus(true, true)).toBe('printed')
})
it('prioritizes no picking items even if a previous print exists', () => {
  expect(resolvePickingSlipStatus(false, false)).toBe('empty')
  expect(resolvePickingSlipStatus(false, true)).toBe('empty')
})
