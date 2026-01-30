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
  role = 'dialog',
  ariaModal = true,
  ariaLabelledby,
}: ModalProps) {
  if (!open) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex p-4 ${align === 'center' ? 'items-center justify-center' : 'items-center justify-start pl-[540px]'}`}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-hidden
        onClick={closeOnBackdropClick ? onClose : undefined}
      />
      <div
        role={role}
        aria-modal={ariaModal}
        aria-labelledby={ariaLabelledby}
        className={`relative flex flex-col w-full rounded-2xl bg-white shadow-xl overflow-hidden ${contentClassName}`}
        onClick={closeOnBackdropClick ? (e) => e.stopPropagation() : undefined}
      >
        {children}
      </div>
    </div>
  )
}
