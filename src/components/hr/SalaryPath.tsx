import { useState, useEffect, useCallback } from 'react'
import { FiSearch } from 'react-icons/fi'
import { fetchCareerTracks, fetchCareerLevels, getCareerPath, fetchEmployees } from '../../lib/hrApi'
import type { HRCareerTrack, HRCareerLevel, HREmployee } from '../../types'

type CareerPathData = Awaited<ReturnType<typeof getCareerPath>>

export default function SalaryPath() {
  const [tracks, setTracks] = useState<HRCareerTrack[]>([])
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [levels, setLevels] = useState<HRCareerLevel[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null)
  const [pathData, setPathData] = useState<CareerPathData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [levelRequirementsId, setLevelRequirementsId] = useState<string | null>(null)

  const loadTracks = useCallback(async () => { setTracks(await fetchCareerTracks()) }, [])
  const loadLevels = useCallback(async () => {
    if (!selectedTrackId) { setLevels([]); return }
    setLevels(await fetchCareerLevels(selectedTrackId))
  }, [selectedTrackId])
  const loadEmployees = useCallback(async () => { setEmployees(await fetchEmployees()) }, [])

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    Promise.all([loadTracks(), loadEmployees()])
      .then(() => { if (!c) setLoading(false) })
      .catch((e) => { if (!c) { setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'); setLoading(false) } })
    return () => { c = true }
  }, [loadTracks, loadEmployees])

  useEffect(() => { loadLevels() }, [loadLevels])
  useEffect(() => {
    if (!selectedTrackId) setLevels([])
    else fetchCareerLevels(selectedTrackId).then(setLevels)
  }, [selectedTrackId])

  useEffect(() => {
    if (!selectedEmployeeId) { setPathData(null); return }
    getCareerPath(selectedEmployeeId).then(setPathData).catch(() => setPathData(null))
  }, [selectedEmployeeId])

  const filteredEmployees = employeeSearch.trim()
    ? employees.filter((e) => {
        const name = [e.first_name, e.last_name, e.employee_code].filter(Boolean).join(' ').toLowerCase()
        return name.includes(employeeSearch.trim().toLowerCase())
      })
    : employees.slice(0, 20)

  const selectEmployee = (id: string) => {
    setSelectedEmployeeId(id)
  }

  const sortedLevels = [...levels].sort((a, b) => a.level_order - b.level_order)
  const currentLevelId = pathData?.career?.[0]?.current_level_id

  if (loading) return (<div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" /></div>)

  return (
    <div className="space-y-6">
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}
      <div className="flex gap-6 rounded-xl shadow-soft border border-surface-200 bg-surface-50 overflow-hidden">
        <aside className="w-56 shrink-0 border-r border-surface-200 bg-white p-3">
          <div className="text-xs font-semibold text-gray-500 uppercase mb-2">สายงาน</div>
          {tracks.map((t) => (
            <button key={t.id} type="button" onClick={() => { setSelectedTrackId(t.id); setLevelRequirementsId(null) }} className={`w-full text-left px-3 py-2 rounded-lg text-sm ${selectedTrackId === t.id ? 'bg-emerald-100 text-emerald-800' : 'hover:bg-surface-100'}`}>{t.name}</button>
          ))}
        </aside>
        <div className="flex-1 min-w-0 p-4">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">ค้นหาพนักงาน</label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" value={employeeSearch} onChange={(e) => setEmployeeSearch(e.target.value)} placeholder="ชื่อ หรือรหัส" className="w-full pl-9 pr-3 py-2 rounded-xl border border-surface-200 text-sm" />
            </div>
            {employeeSearch && (
              <ul className="mt-2 rounded-xl border border-surface-200 bg-white max-h-48 overflow-y-auto">
                {filteredEmployees.map((e) => (
                  <li key={e.id}><button type="button" onClick={() => selectEmployee(e.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50">{[e.first_name, e.last_name].filter(Boolean).join(' ')} ({e.employee_code})</button></li>
                ))}
              </ul>
            )}
          </div>
          {selectedEmployeeId && pathData && (
            <div className="rounded-xl border border-surface-200 bg-white p-4 mb-4">
              <h3 className="font-medium text-gray-900 mb-2">ตำแหน่งปัจจุบัน</h3>
              {pathData.career?.map((c) => (
                <div key={c.track_id}>
                  <p className="text-sm text-gray-600">สายงาน: {c.track_name}</p>
                  <p className="text-sm text-gray-600">เงินเดือนปัจจุบัน: {c.current_salary?.toLocaleString() ?? '-'}</p>
                  <p className="text-xs text-gray-500">มีผลตั้งแต่: {c.effective_date}</p>
                </div>
              ))}
              {pathData.history?.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">ประวัติการเลื่อนระดับ</h4>
                  <ul className="space-y-1 text-sm">
                    {pathData.history.map((h, i) => (
                      <li key={i} className="text-gray-600">{h.from_title} → {h.to_title} ({h.effective_date})</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {selectedTrackId && (
            <div className="rounded-xl border border-surface-200 bg-white overflow-hidden">
              <h3 className="px-4 py-3 font-medium text-gray-900 border-b border-surface-200">ระดับในสายงาน</h3>
              <div className="p-4 flex flex-col gap-3">
                {sortedLevels.map((lv) => (
                  <div key={lv.id} className={`rounded-xl border-2 p-4 transition-colors ${currentLevelId === lv.id ? 'border-emerald-500 bg-emerald-50' : 'border-surface-200 bg-white'}`}>
                    <div className="flex items-center justify-between">
                      <button type="button" onClick={() => setLevelRequirementsId(levelRequirementsId === lv.id ? null : lv.id)} className="font-medium text-gray-900 text-left flex-1">{lv.title}</button>
                      <span className="text-emerald-600 font-medium">{currentLevelId === lv.id ? 'ตำแหน่งปัจจุบัน' : ''}</span>
                    </div>
                    <p className="text-sm text-gray-600 mt-1">เงินเดือน: {lv.salary_min?.toLocaleString() ?? 0} - {lv.salary_max?.toLocaleString() ?? 0} บาท {lv.salary_step != null && <span className="text-gray-500">(ขั้นละ {lv.salary_step})</span>}</p>
                    {levelRequirementsId === lv.id && lv.requirements?.length > 0 && (
                      <ul className="mt-3 pl-4 list-disc text-sm text-gray-600 space-y-1">
                        {(lv.requirements as { item: string; description: string }[]).map((r, i) => <li key={i}><strong>{r.item}</strong>: {r.description}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
