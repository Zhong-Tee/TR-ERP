import type { InventoryAuditItem } from '../../types'

type SnapshotEntry = NonNullable<InventoryAuditItem['location_snapshot']>[number]

export default function AuditLocationDisplay({
  entries,
  onlyType,
  fallback = '-',
}: {
  entries: InventoryAuditItem['location_snapshot']
  onlyType?: SnapshotEntry['label_type']
  fallback?: string
}) {
  const rows = (Array.isArray(entries) ? entries : []).filter((entry) => !onlyType || entry.label_type === onlyType)
  if (rows.length === 0) return <span>{fallback}</span>

  return (
    <div className="space-y-1">
      {rows.map((entry) => (
        <div key={entry.key} className="min-w-[10rem]">
          <span className="font-semibold text-surface-700">{entry.code}</span>
          <span className="ml-1 text-surface-500">· {entry.name}</span>
          <span className="ml-1 whitespace-nowrap text-surface-400">({Number(entry.qty || 0).toLocaleString()})</span>
        </div>
      ))}
    </div>
  )
}
