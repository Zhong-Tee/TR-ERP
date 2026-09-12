import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiArrowRight, FiPlusCircle, FiRefreshCw, FiSearch } from 'react-icons/fi'
import { fetchAssetLogs } from '../../lib/hrApi'
import type { HRAssetLog } from '../../types'

// ตัวเลือกกรองตามชนิดการเปลี่ยนแปลง — ค่าตรงกับ field ที่ trigger บันทึก
const FIELD_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'ทุกการเปลี่ยนแปลง' },
  { value: 'created', label: 'สร้างใหม่' },
  { value: 'status', label: 'เปลี่ยนสถานะ' },
  { value: 'assigned_employee_id', label: 'เปลี่ยนผู้รับผิดชอบ' },
  { value: 'department_id', label: 'เปลี่ยนแผนก' },
  { value: 'location', label: 'เปลี่ยนสถานที่ใช้งาน' },
  { value: 'name', label: 'เปลี่ยนชื่อ' },
]

// ป้ายสีของแต่ละชนิดการเปลี่ยนแปลง
const FIELD_CHIP: Record<string, string> = {
  created: 'bg-emerald-100 text-emerald-700',
  status: 'bg-amber-100 text-amber-700',
  assigned_employee_id: 'bg-blue-100 text-blue-700',
  department_id: 'bg-purple-100 text-purple-700',
  location: 'bg-teal-100 text-teal-700',
  name: 'bg-gray-100 text-gray-700',
}

function fieldChipClass(log: HRAssetLog): string {
  if (log.action === 'created') return FIELD_CHIP.created
  return FIELD_CHIP[log.field ?? ''] ?? 'bg-gray-100 text-gray-700'
}

export default function AssetHistory() {
  const [logs, setLogs] = useState<HRAssetLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [fieldFilter, setFieldFilter] = useState('')

  // หน่วงการค้นหาเล็กน้อยเพื่อไม่ยิง query ทุกตัวอักษร
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAssetLogs({ search: search || undefined, field: fieldFilter || undefined })
      setLogs(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดประวัติทรัพย์สินไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [search, fieldFilter])

  useEffect(() => {
    load()
  }, [load])

  // จัดกลุ่มตามวัน เพื่อให้ timeline อ่านง่าย
  const grouped = useMemo(() => {
    const map = new Map<string, HRAssetLog[]>()
    for (const log of logs) {
      const day = new Date(log.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })
      const arr = map.get(day) ?? []
      arr.push(log)
      map.set(day, arr)
    }
    return Array.from(map.entries())
  }, [logs])

  return (
    <div className="mt-4 space-y-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <div className="rounded-xl border border-surface-200 bg-white p-4 shadow-soft">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-[240px] flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="ค้นหารหัส / ชื่อทรัพย์สิน / ผู้แก้ไข / ค่าที่เปลี่ยน"
              className="w-full rounded-xl border border-surface-200 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value)}
            className="rounded-xl border border-surface-200 px-3 py-2 text-sm"
          >
            {FIELD_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-2 rounded-xl border border-surface-200 px-3 py-2 text-sm text-gray-600 hover:bg-surface-50"
            title="รีเฟรช"
          >
            <FiRefreshCw className={loading ? 'animate-spin' : ''} /> รีเฟรช
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-emerald-600" />
          </div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-gray-500">ยังไม่มีประวัติการเปลี่ยนแปลง</div>
        ) : (
          <div className="space-y-6">
            {grouped.map(([day, dayLogs]) => (
              <div key={day}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-700">{day}</span>
                  <span className="h-px flex-1 bg-surface-200" />
                  <span className="text-xs text-gray-400">{dayLogs.length} รายการ</span>
                </div>
                <div className="overflow-hidden rounded-xl border border-surface-200">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-surface-50 text-xs text-gray-500">
                      <tr>
                        <th className="px-3 py-2 font-semibold">เวลา</th>
                        <th className="px-3 py-2 font-semibold">ทรัพย์สิน</th>
                        <th className="px-3 py-2 font-semibold">การเปลี่ยนแปลง</th>
                        <th className="px-3 py-2 font-semibold">รายละเอียด</th>
                        <th className="px-3 py-2 font-semibold">โดย</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-100">
                      {dayLogs.map((log) => (
                        <tr key={log.id} className="align-top hover:bg-surface-50/60">
                          <td className="whitespace-nowrap px-3 py-2 text-gray-500">
                            {new Date(log.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs text-gray-500">{log.asset_code ?? '-'}</div>
                            <div className="font-medium text-gray-900">{log.asset_name ?? '-'}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${fieldChipClass(log)}`}>
                              {log.action === 'created' && <FiPlusCircle className="h-3 w-3" />}
                              {log.action === 'created' ? 'สร้างใหม่' : log.field_label ?? 'แก้ไข'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {log.action === 'created' ? (
                              <span className="text-gray-500">เพิ่มทรัพย์สินเข้าทะเบียน</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded bg-red-50 px-2 py-0.5 text-red-600 line-through decoration-red-300">
                                  {log.old_value || '—'}
                                </span>
                                <FiArrowRight className="h-3.5 w-3.5 text-gray-400" />
                                <span className="rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                                  {log.new_value || '—'}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-gray-600">{log.changed_by_name ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {logs.length >= 500 && (
              <p className="text-center text-xs text-gray-400">แสดงประวัติล่าสุด 500 รายการ — ใช้ตัวกรองเพื่อค้นหาที่เจาะจงขึ้น</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
