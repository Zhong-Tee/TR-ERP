import { bangkokToday } from '../../lib/reconciliationDate'

export default function ReconciliationDateFilter({ from, to, onChange }: {
  from: string; to: string; onChange: (from: string, to: string) => void
}) {
  function preset(value: string) {
    const today = bangkokToday()
    const date = new Date(`${today}T12:00:00Z`)
    if (value === 'all') return onChange('', '')
    if (value === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    if (value === 'month') date.setUTCDate(1)
    onChange(date.toISOString().slice(0, 10), today)
  }
  return <div className="flex flex-wrap items-end gap-2">
    <label className="text-xs text-gray-600">ตั้งแต่<input aria-label="ตั้งแต่วันที่" type="date" value={from} onChange={e => onChange(e.target.value, to)} className="mt-1 block rounded-lg border px-3 py-2 text-sm" /></label>
    <label className="text-xs text-gray-600">ถึง<input aria-label="ถึงวันที่" type="date" value={to} min={from || undefined} onChange={e => onChange(from, e.target.value)} className="mt-1 block rounded-lg border px-3 py-2 text-sm" /></label>
    {([['today', 'วันนี้'], ['week', 'สัปดาห์นี้'], ['month', 'เดือนนี้'], ['all', 'ทุกวัน']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => preset(value)} className="rounded-lg border px-3 py-2 text-sm hover:bg-blue-50">{label}</button>)}
  </div>
}
