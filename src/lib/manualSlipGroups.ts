type SlipRow = {
  order_id: string
  status: string
  submitted_at: string
  approval_revoked_at: string | null
}

/** Pending decisions contain only the current queue; completed submissions keep their own history. */
export function groupManualSlipRows<T extends SlipRow>(rows: T[]): (T & { entries: T[] })[] {
  const groups = new Map<string, T & { entries: T[] }>()
  for (const row of rows) {
    const key = JSON.stringify(row.status === 'pending'
      ? [row.order_id, 'pending']
      : [row.order_id, row.status, row.submitted_at, row.approval_revoked_at])
    const group = groups.get(key)
    if (group) group.entries.push(row)
    else groups.set(key, { ...row, entries: [row] })
  }
  return [...groups.values()]
}
