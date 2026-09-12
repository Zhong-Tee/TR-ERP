type ModalCloseButtonProps = {
  onClick: () => void
  className?: string
  disabled?: boolean
}

export default function ModalCloseButton({ onClick, className = '', disabled = false }: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="ปิดหน้าต่าง"
      title="ปิดหน้าต่าง"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-md transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
        <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  )
}
