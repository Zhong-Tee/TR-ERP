import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderPickingSlipPages } from './pickingSlipCanvas'
import type { PickingSlipData } from './pickingSlipData'

type Draw = { text: string; y: number }
let draws: Draw[][]
beforeEach(() => {
  draws = []
  vi.stubGlobal('document', {
    fonts: { load: async () => [], ready: Promise.resolve() },
    createElement: () => {
      const page: Draw[] = []; draws.push(page)
      const context = { scale() {}, fillRect() {}, strokeRect() {},
        measureText: (s: string) => ({ width: Array.from(s).length * 7 }),
        fillText: (text: string, _x: number, y: number) => page.push({ text, y }) }
      return { width: 0, height: 0, getContext: () => context }
    },
  })
})
afterEach(() => vi.unstubAllGlobals())
const fixture = (count: number): PickingSlipData => ({ workOrderName: 'TEST', departments: ['LASER'], spareDept: 'STAMP',
  mainItems: Array.from({ length: count }, (_, i) => ({ woName: 'TEST', location: 'A1', code: `C${i}`, name: `Item-${i}`, finalQty: 1, dept: 'LASER' })),
  spareItems: [{ label: 'RUBBER', qty: 2 }], subItems: [], nonPickItems: [] })
describe('picking slip paper layout', () => {
  it('moves the whole spare table to a new page when the remaining space is insufficient', async () => {
    const data = fixture(10)
    data.spareItems = Array.from({ length: 10 }, (_, i) => ({ label: `SPARE-${i}`, qty: 1 }))
    const pages = await renderPickingSlipPages(data, 'A5', 'ทั้งหมด')
    expect(pages).toHaveLength(2)
    expect(draws[0].some(d => d.text.startsWith('SPARE-') || d.text.startsWith('อะไหล่'))).toBe(false)
    expect(draws[1].filter(d => d.text.startsWith('SPARE-'))).toHaveLength(10)
  })
  it('keeps a spare table on the current page when it fits', async () => {
    expect(await renderPickingSlipPages(fixture(1), 'A5', 'ทั้งหมด')).toHaveLength(1)
    expect(draws[0].some(d => d.text === 'RUBBER')).toBe(true)
  })
  it('continues an oversized spare table with repeated headers and no missing rows', async () => {
    const data = fixture(1)
    data.spareItems = Array.from({ length: 80 }, (_, i) => ({ label: `SPARE-${i}`, qty: 1 }))
    await renderPickingSlipPages(data, 'A5', 'ทั้งหมด')
    expect(draws[0].some(d => d.text.startsWith('SPARE-'))).toBe(false)
    for (const page of draws.slice(2)) expect(page.some(d => d.text === 'อะไหล่ (หน้ายาง/โฟม) (ต่อ)')).toBe(true)
    const printed = draws.flat().map(d => d.text)
    for (let i = 0; i < 80; i++) expect(printed.filter(t => t === `SPARE-${i}`)).toHaveLength(1)
  })
  it.each(['A5', 'A4'] as const)('numbers every %s page, repeats headers, and preserves all items', async (paper) => {
    const pages = await renderPickingSlipPages(fixture(100), paper, 'ทั้งหมด')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].width).toBe(paper === 'A5' ? 1184 : 1680)
    expect(pages[0].height).toBe(paper === 'A5' ? 1680 : 2376)
    draws.forEach((page, index) => {
      expect(page.some((d) => d.text === `หน้า ${index + 1}/${pages.length}`)).toBe(true)
      expect(page.every((d) => d.y < pages[index].height / 2)).toBe(true)
      if (index > 0 && page.some((d) => d.text.startsWith('Item-'))) {
        expect(page.some((d) => d.text === 'สินค้าเบิก (ต่อ)')).toBe(true)
        expect(page.some((d) => d.text === 'รหัส')).toBe(true)
      }
    })
    const printed = draws.flat().map((d) => d.text)
    for (let i = 0; i < 100; i++) expect(printed.filter((t) => t === `Item-${i}`)).toHaveLength(1)
    expect(printed).not.toContain('ไม่มีรายการ')
    expect(printed).not.toContain('สินค้าคลังย่อย')
  })
  it('keeps text longer than one page without overflowing or looping', async () => {
    const data = fixture(1)
    data.mainItems[0].name = 'X'.repeat(6000)
    const pages = await renderPickingSlipPages(data, 'A5', 'ทั้งหมด')
    expect(pages.length).toBeGreaterThan(2)
    const description = draws.flat().filter((d) => /^X+$/.test(d.text)).map((d) => d.text).join('')
    expect(description).toHaveLength(6000)
    expect(draws.flat().every((d) => d.y < 840)).toBe(true)
  })
  it('omits empty table titles and headers on A5', async () => {
    const data = { ...fixture(0), spareItems: [] }
    expect(await renderPickingSlipPages(data, 'A5', 'ทั้งหมด')).toHaveLength(1)
    const printed = draws.flat().map((d) => d.text)
    for (const label of ['สินค้าเบิก', 'อะไหล่ (หน้ายาง/โฟม)', 'สินค้าคลังย่อย', 'ลำดับ', 'ไม่มีรายการ']) {
      expect(printed).not.toContain(label)
    }
  })
})
