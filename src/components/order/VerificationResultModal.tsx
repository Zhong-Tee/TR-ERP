import Modal from '../ui/Modal'

export type VerificationResultType = 'success' | 'failed' | 'over_transfer' | 'save_success'
export type AmountStatus = 'match' | 'over' | 'under' | 'mismatch'

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
  /** เมื่อกดปุ่ม "ยืนยัน โอนเงินเกิน" (ใช้เมื่อ type === 'over_transfer') */
  onConfirmOverpay?: () => void | Promise<void>
  /** กำลังดำเนินการ (เช่น กำลังสร้างรายการโอนคืน) */
  confirmingOverpay?: boolean
}

function StatusBadge({ match, isFailed }: { match: boolean | null; isFailed?: boolean }) {
  // กรณีตรวจไม่ผ่าน และไม่มีข้อมูล (null) ให้แสดง "ไม่ตรง" สีแดง
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

/** จัดรูปแบบข้อความรายละเอียดสลิป (ยอดเงินไม่ตรง) ให้แสดงเป็นบรรทัดและวงเล็บตามที่กำหนด */
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
  if (!open) return null

  const isOverTransfer = type === 'over_transfer'
  const isSuccess = type === 'success'
  const isSaveSuccess = type === 'save_success'
  const isFailed = type === 'failed'
  const showVerificationDetails = !isSaveSuccess

  return (
    <Modal
      open={open}
      onClose={onClose}
      contentClassName="max-w-md max-h-[90vh]"
      role="dialog"
      ariaModal
      ariaLabelledby="verification-result-title"
    >
        {/* Header */}
        <div
          className={`shrink-0 px-6 py-4 ${
            isSuccess || isSaveSuccess ? 'bg-green-500' : isOverTransfer ? 'bg-amber-500' : 'bg-red-500'
          } text-white`}
        >
          <h2 id="verification-result-title" className="text-lg font-semibold">
            {isSaveSuccess && 'บันทึกสำเร็จ'}
            {isSuccess && !isSaveSuccess && 'ตรวจสอบสลิปสำเร็จ'}
            {isOverTransfer && 'ยอดสลิปเกินยอดออเดอร์'}
            {isFailed && 'ตรวจสอบสลิปไม่สำเร็จ'}
          </h2>
        </div>

        {/* ผลการตรวจสอบ — scroll ได้ ปุ่มจะอยู่ใต้ส่วนนี้เสมอ */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {/* การตรวจข้อมูล — ไม่แสดงเมื่อเป็น save_success */}
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

          {/* ข้อความสรุป */}
          <div className="text-sm text-gray-700 whitespace-pre-line">{statusMessage}</div>

          {/* รายการข้อผิดพลาด */}
          {(errors.length > 0 || validationErrors.length > 0) && (
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

        {/* ปุ่มตกลง / ไม่ยืนยัน / ยืนยันโอนเกิน — แสดงใต้ผลการตรวจสอบ อ่านก่อนค่อยกด */}
        <div className="shrink-0 px-6 py-4 bg-gray-50 border-t border-gray-200 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          {isOverTransfer && onConfirmOverpay ? (
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
                onClick={onConfirmOverpay}
                disabled={confirmingOverpay}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
              >
                {confirmingOverpay ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ยืนยัน โอนเงินเกิน'
                )}
              </button>
            </>
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
