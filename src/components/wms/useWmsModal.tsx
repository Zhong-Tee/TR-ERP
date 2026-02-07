import { useCallback, useRef, useState } from 'react'
import Modal from '../ui/Modal'

type MessageOptions = {
  title?: string
  message: string
  confirmText?: string
}

type ConfirmOptions = {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
}

type InternalMessageState = {
  open: boolean
  title: string
  message: string
  confirmText: string
}

type InternalConfirmState = {
  open: boolean
  title: string
  message: string
  confirmText: string
  cancelText: string
}

const defaultMessageState: InternalMessageState = {
  open: false,
  title: 'แจ้งเตือน',
  message: '',
  confirmText: 'ตกลง',
}

const defaultConfirmState: InternalConfirmState = {
  open: false,
  title: 'ยืนยัน',
  message: '',
  confirmText: 'ยืนยัน',
  cancelText: 'ยกเลิก',
}

export function useWmsModal() {
  const [messageState, setMessageState] = useState<InternalMessageState>(defaultMessageState)
  const [confirmState, setConfirmState] = useState<InternalConfirmState>(defaultConfirmState)
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null)

  const showMessage = useCallback((options: MessageOptions) => {
    setMessageState({
      open: true,
      title: options.title || defaultMessageState.title,
      message: options.message,
      confirmText: options.confirmText || defaultMessageState.confirmText,
    })
  }, [])

  const showConfirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve
      setConfirmState({
        open: true,
        title: options.title || defaultConfirmState.title,
        message: options.message,
        confirmText: options.confirmText || defaultConfirmState.confirmText,
        cancelText: options.cancelText || defaultConfirmState.cancelText,
      })
    })
  }, [])

  const closeMessage = useCallback(() => {
    setMessageState(defaultMessageState)
  }, [])

  const handleConfirm = useCallback((value: boolean) => {
    const resolver = confirmResolverRef.current
    confirmResolverRef.current = null
    resolver?.(value)
    setConfirmState(defaultConfirmState)
  }, [])

  const MessageModal = messageState.open ? (
    <Modal open={messageState.open} onClose={closeMessage} closeOnBackdropClick={false} contentClassName="max-w-md">
      <div className="p-6">
        <h3 className="text-lg font-bold text-slate-800 mb-3">{messageState.title}</h3>
        <p className="text-sm text-slate-600 whitespace-pre-line">{messageState.message}</p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={closeMessage}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700"
          >
            {messageState.confirmText}
          </button>
        </div>
      </div>
    </Modal>
  ) : null

  const ConfirmModal = confirmState.open ? (
    <Modal open={confirmState.open} onClose={() => handleConfirm(false)} closeOnBackdropClick={false} contentClassName="max-w-md">
      <div className="p-6">
        <h3 className="text-lg font-bold text-slate-800 mb-3">{confirmState.title}</h3>
        <p className="text-sm text-slate-600 whitespace-pre-line">{confirmState.message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => handleConfirm(false)}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            {confirmState.cancelText}
          </button>
          <button
            type="button"
            onClick={() => handleConfirm(true)}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700"
          >
            {confirmState.confirmText}
          </button>
        </div>
      </div>
    </Modal>
  ) : null

  return { showMessage, showConfirm, MessageModal, ConfirmModal }
}
