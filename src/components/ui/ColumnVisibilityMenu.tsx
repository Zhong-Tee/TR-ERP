import { useEffect, useRef, useState } from 'react'
import type { ColumnVisibilityOption } from '../../lib/columnVisibility'

export default function ColumnVisibilityMenu({
  columns,
  hiddenColumns,
  onToggle,
  onReset,
  className = '',
}: {
  columns: ColumnVisibilityOption[]
  hiddenColumns: Set<string>
  onToggle: (id: string) => void
  onReset: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const visibleCount = columns.filter((column) => !hiddenColumns.has(column.id)).length

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [open])

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4" />
        </svg>
        เลือกคอลัมน์
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{visibleCount}/{columns.length}</span>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-2 pb-2">
            <span className="text-sm font-bold text-slate-800">แสดงคอลัมน์</span>
            <button type="button" onClick={onReset} className="text-xs font-semibold text-blue-600 hover:underline">
              คืนค่าเริ่มต้น
            </button>
          </div>
          <div className="mt-1 max-h-80 overflow-y-auto">
            {columns.map((column) => {
              const checked = !hiddenColumns.has(column.id)
              return (
                <label key={column.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-700 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && visibleCount === 1}
                    onChange={() => onToggle(column.id)}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>{column.label}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
