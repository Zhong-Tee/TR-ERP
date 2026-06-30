import { useEffect, useId, useState } from 'react'
import Modal from './Modal'

export type DangerTypedConfirmModalProps = {
  open: boolean
  title: string
  description?: string
  bullets?: string[]
  expectedText: string
  confirmLabel?: string
  cancelLabel?: string
  onCancel: () => void
  onConfirm: (typedText: string) => void
}

export default function DangerTypedConfirmModal({
  open,
  title,
  description,
  bullets = [],
  expectedText,
  confirmLabel = 'ยืนยัน',
  cancelLabel = 'ยกเลิก',
  onCancel,
  onConfirm,
}: DangerTypedConfirmModalProps) {
  const inputId = useId()
  const [typedText, setTypedText] = useState('')
  const isMatch = typedText === expectedText

  useEffect(() => {
    if (open) setTypedText('')
  }, [open, expectedText])

  if (!open) return null

  return (
    <Modal
      open
      onClose={onCancel}
      closeOnBackdropClick={false}
      contentClassName="max-w-lg w-full mx-4 my-8"
      stackClassName="z-[60]"
    >
      <div className="overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-red-100">
        <div className="bg-gradient-to-r from-red-600 to-red-700 px-6 py-5 text-white">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                />
              </svg>
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-lg font-bold leading-snug">{title}</h3>
              {description ? <p className="mt-1 text-sm text-red-100">{description}</p> : null}
            </div>
          </div>
        </div>

        <div className="space-y-5 px-6 py-5">
          {bullets.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">โปรดอ่านก่อนดำเนินการ</p>
              <ul className="mt-2 space-y-1.5 text-sm text-amber-950">
                {bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-2">
            <label htmlFor={inputId} className="block text-sm font-semibold text-gray-700">
              พิมพ์ข้อความด้านล่างเพื่อยืนยัน
            </label>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <code className="block break-all text-sm font-semibold tracking-wide text-red-700">{expectedText}</code>
            </div>
            <input
              id={inputId}
              type="text"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isMatch) onConfirm(typedText)
              }}
              placeholder="พิมพ์ข้อความยืนยันที่นี่"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className={`w-full rounded-xl border px-3 py-2.5 text-base outline-none transition ${
                typedText.length === 0
                  ? 'border-gray-300 focus:border-red-400 focus:ring-2 focus:ring-red-100'
                  : isMatch
                    ? 'border-emerald-400 bg-emerald-50/40 focus:ring-2 focus:ring-emerald-100'
                    : 'border-red-300 bg-red-50/40 focus:ring-2 focus:ring-red-100'
              }`}
            />
            {typedText.length > 0 && !isMatch ? (
              <p className="text-xs font-medium text-red-600">ข้อความยังไม่ตรงกับที่กำหนด</p>
            ) : null}
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(typedText)}
              disabled={!isMatch}
              className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
