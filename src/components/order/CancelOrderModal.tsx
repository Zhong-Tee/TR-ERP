import { useEffect, useState } from 'react'
import type { Order } from '../../types'
import Modal from '../ui/Modal'

type ConfirmationStep = 'first' | 'final' | 'success' | 'error'

interface CancelOrderModalProps {
  open: boolean
  order: Order | null
  onClose: () => void
  onConfirm: (order: Order) => Promise<void>
  onDone?: () => void
}

const FIRST_CONFIRMATION = 'ยกเลิกบิล'
const FINAL_CONFIRMATION = 'ยืนยันยกเลิก'

export default function CancelOrderModal({
  open,
  order,
  onClose,
  onConfirm,
  onDone,
}: CancelOrderModalProps) {
  const [step, setStep] = useState<ConfirmationStep>('first')
  const [confirmationText, setConfirmationText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setStep('first')
    setConfirmationText('')
    setSubmitting(false)
    setErrorMessage('')
  }, [open, order?.id])

  if (!open || !order) return null

  const requiredText = step === 'final' ? FINAL_CONFIRMATION : FIRST_CONFIRMATION
  const canConfirm = confirmationText.trim() === requiredText

  const close = () => {
    if (!submitting) onClose()
  }

  const finish = () => {
    onClose()
    onDone?.()
  }

  return (
    <Modal
      open
      onClose={close}
      contentClassName="max-w-md"
      role="dialog"
      ariaModal
      ariaLabelledby="cancel-order-modal-title"
    >
      <div
        className={`px-6 py-4 text-white ${
          step === 'success' ? 'bg-green-600' : step === 'error' ? 'bg-red-600' : 'bg-red-600'
        }`}
      >
        <h2 id="cancel-order-modal-title" className="text-lg font-semibold">
          {step === 'success'
            ? 'ยกเลิกบิลสำเร็จ'
            : step === 'error'
              ? 'เกิดข้อผิดพลาด'
              : step === 'final'
                ? 'ยืนยันยกเลิกบิลอีกครั้ง'
                : 'ยืนยันยกเลิกบิล'}
        </h2>
      </div>

      <div className="px-6 py-5 text-gray-700">
        {step === 'success' ? (
          <p className="text-sm">บิล <strong>{order.bill_no}</strong> ถูกยกเลิกแล้ว</p>
        ) : step === 'error' ? (
          <p className="text-sm text-red-700">{errorMessage}</p>
        ) : (
          <>
            <p className="text-sm">
              {step === 'final'
                ? <>โปรดยืนยันครั้งสุดท้ายว่าต้องการยกเลิกบิล <strong>{order.bill_no}</strong></>
                : <>ต้องการยกเลิกบิล <strong>{order.bill_no}</strong> หรือไม่?</>}
            </p>
            <label className="mt-4 block text-sm font-semibold text-gray-800" htmlFor="cancel-order-confirmation">
              พิมพ์ “{requiredText}” เพื่อดำเนินการต่อ
            </label>
            <input
              key={step}
              id="cancel-order-confirmation"
              type="text"
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              disabled={submitting}
              autoFocus
              autoComplete="off"
              className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
              placeholder={requiredText}
            />
          </>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4">
        {step === 'success' ? (
          <button type="button" onClick={finish} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            ตกลง
          </button>
        ) : step === 'error' ? (
          <button type="button" onClick={close} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            ตกลง
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                if (step === 'final') {
                  setStep('first')
                  setConfirmationText('')
                } else {
                  close()
                }
              }}
              disabled={submitting}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {step === 'final' ? 'ย้อนกลับ' : 'ไม่ยืนยัน'}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!canConfirm) return
                if (step === 'first') {
                  setStep('final')
                  setConfirmationText('')
                  return
                }

                setSubmitting(true)
                try {
                  await onConfirm(order)
                  setStep('success')
                } catch (error) {
                  setErrorMessage(error instanceof Error ? error.message : 'เกิดข้อผิดพลาดในการยกเลิกบิล')
                  setStep('error')
                } finally {
                  setSubmitting(false)
                }
              }}
              disabled={!canConfirm || submitting}
              className="flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  กำลังยกเลิก...
                </>
              ) : step === 'final' ? 'ยืนยันยกเลิก' : 'ยืนยัน'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}

export { FIRST_CONFIRMATION, FINAL_CONFIRMATION }
