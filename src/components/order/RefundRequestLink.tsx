import { refundRequestLink } from '../../lib/refundRequest'

export default function RefundRequestLink({ value, iconOnly = false }: { value?: string | null; iconOnly?: boolean }) {
  const href = refundRequestLink(value)
  if (!href) return null
  if (iconOnly) return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()} title={`เปิดหลักฐานประกอบ: ${value?.trim()}`} aria-label="เปิดลิงก์หลักฐานประกอบการโอนคืนในแท็บใหม่" className="mt-1 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </a>
  )
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()} className="mt-1 block break-all text-blue-600 underline">{value?.trim()}</a>
}
