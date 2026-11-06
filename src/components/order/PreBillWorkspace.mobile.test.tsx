// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
const api = vi.hoisted(() => ({ detail: vi.fn(), page: vi.fn() }))
vi.mock('../../contexts/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'sales', role: 'sales-pump' } }) }))
vi.mock('../../lib/supabase', () => ({ supabase: {
  channel: () => ({ on: () => ({ subscribe: () => ({}) }) }), removeChannel: vi.fn(),
} }))
vi.mock('../../lib/prebillWorkspace', () => ({
  PREBILL_PAGE_SIZE: 20, loadPreBillPage: api.page, loadPreBillDetail: api.detail,
  loadPreBillCounts: async () => ({ mine: 1 }),
} ))
vi.mock('./PreBillForm', () => ({ default: (props: { mobile: boolean; onOpenBill?: unknown }) =>
  createElement('div', null, `editor:${props.mobile ? 'mobile' : 'desktop'}:${props.onOpenBill ? 'convert' : 'no-convert'}`),
}))
import PreBillWorkspace from './PreBillWorkspace'
afterEach(cleanup)
const doc = { id: 'qt-1', document_type: 'quotation', document_no: 'QT-001', customer_name: 'Customer', status: 'active', valid_until: '2099-01-01', created_at: '2026-11-04', total_amount: 500 }
const props = { pendingCounts: { quotation: 0, production_confirmation: 0 }, onOpenBill: vi.fn(), onViewConvertedOrder: vi.fn(), onReviewDiscounts: vi.fn() }
describe('Sales QT/PC workspace isolation', () => {
  it('mobile opens read-only details before offering edit without bill conversion', async () => {
    api.page.mockResolvedValue({ documents: [doc], total: 1 })
    api.detail.mockResolvedValue(doc)
    render(createElement(PreBillWorkspace, { ...props, mobile: true }))
    expect(await screen.findByText('QT-001')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'เปิดบิล' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'แก้ไข' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ยกเลิก' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'ดูรายละเอียด QT-001' }))
    fireEvent.click(await screen.findByRole('button', { name: 'แก้ไข' }))
    expect(await screen.findByText('editor:mobile:no-convert')).toBeTruthy()
    expect(api.detail).toHaveBeenCalledWith('qt-1')
  })
  it('returns from details to the compact list and keeps cancelled documents read-only', async () => {
    api.page.mockResolvedValue({ documents: [{ ...doc, status: 'cancelled' }], total: 1 })
    api.detail.mockResolvedValue({ ...doc, status: 'cancelled' })
    render(createElement(PreBillWorkspace, { ...props, mobile: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'ดูรายละเอียด QT-001' }))
    const back = await screen.findByRole('button', { name: '‹ กลับไปรายการ' })
    expect(screen.queryByRole('button', { name: 'แก้ไข' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'ยกเลิก' })).toBeNull()
    fireEvent.click(back)
    expect(screen.getByRole('button', { name: 'ดูรายละเอียด QT-001' })).toBeTruthy()
  })
  it('desktop keeps its conversion action and existing editor', async () => {
    api.page.mockResolvedValue({ documents: [doc], total: 1 })
    api.detail.mockResolvedValue(doc)
    render(createElement(PreBillWorkspace, props))
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดบิล' }))
    expect(props.onOpenBill).toHaveBeenCalledWith(doc)
    fireEvent.click(screen.getByRole('button', { name: 'แก้ไข' }))
    expect(await screen.findByText('editor:desktop:convert')).toBeTruthy()
  })
})
