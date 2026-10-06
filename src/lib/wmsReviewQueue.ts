type ReviewScope = { id: string; pending: number; uncheckedInspect: number; date: string; label: string }

/** Date limits history choices; the outstanding queue always spans every date. */
export function selectReviewScopes<T extends ReviewScope>(groups: T[], rows: Record<string, Array<{ created_at?: string | null }>>, date: string) {
  return {
    ready: groups.filter(group => group.pending === 0 && (date
      ? (rows[group.id] || []).some(row => row.created_at && new Date(row.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }) === date)
      : group.uncheckedInspect > 0)),
    backlog: groups.filter(group => group.uncheckedInspect > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label, 'th')),
  }
}
