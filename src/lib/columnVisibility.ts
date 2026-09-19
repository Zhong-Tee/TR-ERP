import { useEffect, useState } from 'react'

export type ColumnVisibilityOption = {
  id: string
  label: string
}

export function useColumnVisibility(storageKey: string) {
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]')
      return new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [])
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify([...hiddenColumns]))
  }, [hiddenColumns, storageKey])

  return {
    hiddenColumns,
    isColumnVisible: (id: string) => !hiddenColumns.has(id),
    toggleColumn: (id: string) => setHiddenColumns((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    }),
    resetColumns: () => setHiddenColumns(new Set()),
  }
}
