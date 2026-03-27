import React from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** คลิกที่พื้นหลังแล้วปิด (default: false) */
  closeOnBackdropClick?: boolean
  /** จัดตำแหน่ง: center หรือ start (ชิดซ้าย สำหรับ reject modal) */
  align?: 'center' | 'start'
  /** class ของกล่องเนื้อหา (เช่น max-w-md, max-w-4xl, rounded-2xl) */
  contentClassName?: string
  /** class ของ wrapper fixed (เช่น z-[60] เมื่อต้องซ้อนเหนือ modal อื่นที่ใช้ z-50) */
  /** แทนที่ z-index ของ overlay (default z-50) */
  stackClassName?: string
  role?: string
  ariaModal?: boolean
  ariaLabelledby?: string
}

/**
 * Modal/Popup ร่วม — แสดง overlay + backdrop + กล่องเนื้อหา
 * ใช้แทน <div className="fixed inset-0 ..."> ในทุกหน้า
 */
export default function Modal({
  open,
  onClose,
  children,
  closeOnBackdropClick = false,
  align = 'center',
  contentClassName = '',
  stackClassName,
  role = 'dialog',
  ariaModal = true,
  ariaLabelledby,
}: ModalProps) {
  if (!open) return null

  const stackZ = stackClassName?.trim() ? stackClassName.trim() : 'z-50'

  return (
    <div
      className={`fixed inset-0 ${stackZ} flex pr-4 pb-4 ${align === 'center' ? 'items-center justify-center pl-[calc(var(--content-offset-left,0rem)+1rem)]' : 'items-center justify-start pl-[calc(var(--content-offset-left,0rem)+1rem)]'}`}
      style={{ paddingTop: 'calc(5rem + var(--subnav-height, 0rem))' }}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-surface-900/30 backdrop-blur-sm"
        aria-hidden
        onClick={closeOnBackdropClick ? onClose : undefined}
      />
      <div
        role={role}
        aria-modal={ariaModal}
        aria-labelledby={ariaLabelledby}
        className={`relative flex flex-col w-full rounded-2xl bg-surface-50 shadow-soft border border-surface-200 overflow-y-auto ${contentClassName}`}
        style={{ maxHeight: 'calc(100vh - 6rem - var(--subnav-height, 0rem))' }}
        onClick={closeOnBackdropClick ? (e) => e.stopPropagation() : undefined}
      >
        {children}
      </div>
    </div>
  )
}
