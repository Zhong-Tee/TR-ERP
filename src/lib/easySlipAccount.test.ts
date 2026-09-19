import { describe, expect, it } from 'vitest'
import { accountDisplay, easySlipAccountDetails } from './easySlipAccount'

describe('easySlipAccountDetails', () => {
  it('reads sender and receiver names and bank accounts', () => {
    expect(easySlipAccountDetails({
      data: {
        sender: { account: { name: { th: 'ลูกค้า ทดสอบ' }, bank: { account: 'XXX-X-1234-X' } } },
        receiver: { account: { name: 'บริษัท ทดสอบ', bank: { account: '111-2-33333-4' } } },
      },
    })).toEqual({
      senderName: 'ลูกค้า ทดสอบ',
      senderAccount: 'XXX-X-1234-X',
      receiverName: 'บริษัท ทดสอบ',
      receiverAccount: '111-2-33333-4',
    })
  })

  it('supports legacy from/to fields and receiver fallback', () => {
    expect(easySlipAccountDetails({
      data: { from: { name: 'ผู้โอน', account: { account: 'X9876' } } },
    }, 'XXX-9739')).toEqual({
      senderName: 'ผู้โอน',
      senderAccount: 'X9876',
      receiverName: null,
      receiverAccount: 'XXX-9739',
    })
  })

  it('formats missing account data clearly', () => {
    expect(accountDisplay('นาย ก', 'X1234')).toBe('นาย ก · X1234')
    expect(accountDisplay(null, null)).toBe('ไม่พบข้อมูลบัญชี')
  })
})
