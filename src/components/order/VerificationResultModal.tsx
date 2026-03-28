import { useState, useEffect } from 'react'
import Modal from '../ui/Modal'

export type VerificationResultType = 'success' | 'failed' | 'over_transfer' | 'save_success'
export type AmountStatus = 'match' | 'over' | 'under' | 'mismatch'

/** ข้อมูลบัญชีรับโอนคืน — ส่งไปเก็บใน ac_refunds และแสดงในเมนูบัญชี */
export type OverpayRefundBankDetails = {
  refund_recipient_account_name: string
  refund_recipient_bank: string
  refund_recipient_account_number: string
}

export interface VerificationResultModalProps {
  open: boolean
  onClose: () => void
  type: VerificationResultType
  /** เลขบัญชีตรงหรือไม่ (null = ไม่ได้ตรวจ) */
  accountMatch: boolean | null
  /** สาขาตรงหรือไม่ (null = ไม่ได้ตรวจ) */
  bankCodeMatch: boolean | null
  /** สถานะยอดเงิน */
  amountStatus: AmountStatus
  orderAmount: number
  totalAmount: number
  overpayAmount?: number
  errors?: string[]
  validationErrors?: string[]
  statusMessage: string
  /** หลังกรอกบัญชีรับคืนแล้ว — สร้าง/อัปเดต ac_refunds */
  onConfirmOverpay?: (details: OverpayRefundBankDetails) => void | Promise<void>
  /** กำลังดำเนินการ (เช่น กำลังสร้างรายการโอนคืน) */
  confirmingOverpay?: boolean
}

function StatusBadge({ match, isFailed }: { match: boolean | null; isFailed?: boolean }) {
  if (match === null && !isFailed) return <span className="text-gray-500">—</span>
  const showMatch = match === true
  return showMatch ? (
    <span className="inline-flex items-center gap-1 text-green-600 font-medium">
      <span className="w-2 h-2 rounded-full bg-green-500" /> ตรง
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-red-600 font-medium">
      <span className="w-2 h-2 rounded-full bg-red-500" /> ไม่ตรง
    </span>
  )
}

function formatSlipDetailMessage(msg: string): string {
  const m = msg.match(/สลิป\s*(\d+):\s*(?:ตรวจสอบสำเร็จ\s*แต่พบข้อผิดพลาด:\s*)?ยอดเงินไม่ตรง:\s*ตรวจ\s*พบ\s*([\d.]+)\s*แต่คาดหวัง\s*([\d.]+)/)
  if (m) {
    const [, slipNum, found, expected] = m
    return `สลิป ${slipNum}: ตรวจสอบสำเร็จ (แต่พบข้อผิดพลาด)\nยอดเงินไม่ตรง: ตรวจพบ ${found} \nแต่คาดหวัง ${expected}`
  }
  return msg
}

function AmountStatusBadge({ status }: { status: AmountStatus }) {
  const config = {
    match: { text: 'ตรง', className: 'text-green-600', dot: 'bg-green-500' },
    over: { text: 'เกิน', className: 'text-amber-600', dot: 'bg-amber-500' },
    under: { text: 'ไม่พอ', className: 'text-red-600', dot: 'bg-red-500' },
    mismatch: { text: 'ไม่ตรง', className: 'text-red-600', dot: 'bg-red-500' },
  }
  const c = config[status]
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${c.className}`}>
      <span className={`w-2 h-2 rounded-full ${c.dot}`} /> {c.text}
    </span>
  )
}

export default function VerificationResultModal({
  open,
  onClose,
  type,
  accountMatch,
  bankCodeMatch,
  amountStatus,
  orderAmount,
  totalAmount,
  overpayAmount = 0,
  errors = [],
  validationErrors = [],
  statusMessage,
  onConfirmOverpay,
  confirmingOverpay = false,
}: VerificationResultModalProps) {
  const [showOverpayBankForm, setShowOverpayBankForm] = useState(false)
  const [recipientName, setRecipientName] = useState('')
  const [recipientBank, setRecipientBank] = useState('')
  const [recipientAccountNo, setRecipientAccountNo] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (open) {
      setShowOverpayBankForm(false)
      setRecipientName('')
      setRecipientBank('')
      setRecipientAccountNo('')
      setFormError('')
    }
  }, [open])

  if (!open) return null

  const isOverTransfer = type === 'over_transfer'
  const isSuccess = type === 'success'
  const isSaveSuccess = type === 'save_success'
  const isFailed = type === 'failed'
  const showVerificationDetails = !isSaveSuccess && !(isOverTransfer && showOverpayBankForm)

  function handleSubmitOverpayBank() {
    const n = recipientName.trim()
    const b = recipientBank.trim()
    const a = recipientAccountNo.trim()
    if (!n || !b || !a) {
      setFormError('กรุณากรอกชื่อบัญชี ธนาคาร และเลขบัญชีให้ครบ')
      return
    }
    setFormError('')
    void onConfirmOverpay?.({
      refund_recipient_account_name: n,
      refund_recipient_bank: b,
      refund_recipient_account_number: a,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      contentClassName="max-w-md max-h-[90vh]"
      role="dialog"
      ariaModal
      ariaLabelledby="verification-result-title"
    >
      <div
        className={`shrink-0 px-6 py-4 ${
          isSuccess || isSaveSuccess ? 'bg-green-500' : isOverTransfer ? 'bg-amber-500' : 'bg-red-500'
        } text-white`}
      >
        <h2 id="verification-result-title" className="text-lg font-semibold">
          {isSaveSuccess && 'บันทึกสำเร็จ'}
          {isSuccess && !isSaveSuccess && 'ตรวจสอบสลิปสำเร็จ'}
          {isOverTransfer && !showOverpayBankForm && 'ยอดสลิปเกินยอดออเดอร์'}
          {isOverTransfer && showOverpayBankForm && 'บัญชีรับโอนคืน'}
          {isFailed && 'ตรวจสอบสลิปไม่สำเร็จ'}
        </h2>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {isOverTransfer && showOverpayBankForm && (
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900 space-y-1">
            <div>ยอดออเดอร์: ฿{orderAmount.toLocaleString()}</div>
            <div>ยอดสลิป: ฿{totalAmount.toLocaleString()}</div>
            {overpayAmount > 0 && <div className="font-semibold">ยอดเกิน: ฿{overpayAmount.toLocaleString()}</div>}
          </div>
        )}

        {isOverTransfer && showOverpayBankForm && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">กรอกบัญชีที่ลูกค้าใช้รับเงินคืน (ข้อมูลจะแสดงในเมนูบัญชี — รายการโอนคืน)</p>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">ชื่อบัญชี</span>
              <input
                type="text"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                disabled={confirmingOverpay}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 focus:border-amber-400 disabled:bg-gray-100"
                autoComplete="name"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">ธนาคาร</span>
              <input
                type="text"
                value={recipientBank}
                onChange={(e) => setRecipientBank(e.target.value)}
                disabled={confirmingOverpay}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-amber-400 focus:border-amber-400 disabled:bg-gray-100"
                placeholder="เช่น กสิกรไทย, SCB"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-gray-700">เลขบัญชี</span>
              <input
                type="text"
                value={recipientAccountNo}
                onChange={(e) => setRecipientAccountNo(e.target.value)}
                disabled={confirmingOverpay}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-amber-400 focus:border-amber-400 disabled:bg-gray-100"
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
            {formError ? <p className="text-sm text-red-600 font-medium">{formError}</p> : null}
          </div>
        )}

        {showVerificationDetails && (
          <div className="rounded-xl bg-gray-50 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-700">การตรวจข้อมูล</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <span className="text-gray-600">เลขบัญชี</span>
              <StatusBadge match={accountMatch} isFailed={isFailed} />
              <span className="text-gray-600">สาขา</span>
              <StatusBadge match={bankCodeMatch} isFailed={isFailed} />
              <span className="text-gray-600">ยอดเงิน</span>
              <AmountStatusBadge status={amountStatus} />
            </div>
            <div className="pt-2 border-t border-gray-200 text-sm text-gray-600">
              <div>ยอดออเดอร์: ฿{orderAmount.toLocaleString()}</div>
              <div>ยอดสลิป: ฿{totalAmount.toLocaleString()}</div>
              {overpayAmount > 0 && (
                <div className="text-amber-600 font-medium">ยอดเกิน: ฿{overpayAmount.toLocaleString()}</div>
              )}
            </div>
          </div>
        )}

        {!(isOverTransfer && showOverpayBankForm) && (
          <div className="text-sm text-gray-700 whitespace-pre-line">{statusMessage}</div>
        )}

        {(errors.length > 0 || validationErrors.length > 0) && !(isOverTransfer && showOverpayBankForm) && (
          <div className="rounded-xl bg-red-50 p-4 space-y-2">
            {(errors.length > 0 || validationErrors.length > 0) && (
              <h3 className="text-sm font-semibold text-red-800">รายละเอียด</h3>
            )}
            {errors.map((msg, i) => (
              <p key={`e-${i}`} className="text-sm text-red-700 whitespace-pre-line">
                {formatSlipDetailMessage(msg)}
              </p>
            ))}
            {validationErrors.map((msg, i) => (
              <p key={`v-${i}`} className="text-sm text-red-700 whitespace-pre-line">
                {formatSlipDetailMessage(msg)}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 py-4 bg-gray-50 border-t border-gray-200 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        {isOverTransfer && onConfirmOverpay ? (
          showOverpayBankForm ? (
            <>
              <button
                type="button"
                onClick={() => !confirmingOverpay && setShowOverpayBankForm(false)}
                disabled={confirmingOverpay}
                className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ย้อนกลับ
              </button>
              <button
                type="button"
                onClick={handleSubmitOverpayBank}
                disabled={confirmingOverpay}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
              >
                {confirmingOverpay ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ส่งรายการโอนคืน'
                )}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={confirmingOverpay}
                className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ไม่ยืนยัน
              </button>
              <button
                type="button"
                onClick={() => setShowOverpayBankForm(true)}
                disabled={confirmingOverpay}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 text-sm font-medium"
              >
                ยืนยัน โอนเงินเกิน
              </button>
            </>
          )
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 text-sm font-medium"
          >
            ตกลง
          </button>
        )}
      </div>
    </Modal>
  )
}
