import { useState, useEffect, useCallback } from 'react'
import { FiTrendingUp, FiCheck } from 'react-icons/fi'
import { fetchEmployeeByUserId, getCareerPath } from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRCareerLevel } from '../../../types'

type CareerTrack = {
  track_id: string
  track_name: string
  description?: string
  current_level_id: string
  current_salary?: number
  effective_date: string
  levels: (HRCareerLevel & { requirements?: { item: string; description: string }[] })[]
}

type CareerHistoryItem = {
  from_title: string
  to_title: string
  from_salary?: number
  to_salary?: number
  effective_date: string
  reason?: string
}

export default function EmployeeSalaryPath() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<{ id: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<{
    career: CareerTrack[]
    history: CareerHistoryItem[]
  } | null>(null)
  const [expandedLevelId, setExpandedLevelId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) {
        setLoading(false)
        return
      }
      const path = await getCareerPath(emp.id)
      setData(path)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm text-center text-gray-500">
        ไม่พบข้อมูลพนักงาน
      </div>
    )
  }

  const hasCareer = data?.career?.length && data.career[0].levels?.length

  if (!hasCareer) {
    return (
      <div className="rounded-2xl bg-white border border-gray-200 p-8 shadow-sm text-center">
        <FiTrendingUp className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <p className="text-gray-600 font-medium">ยังไม่มีข้อมูลเส้นทางเงินเดือน</p>
        <p className="text-gray-500 text-sm mt-1">ติดต่อ HR เพื่อกำหนดสายงานและระดับ</p>
      </div>
    )
  }

  const track = data!.career[0]
  const levels = [...(track.levels ?? [])].sort((a, b) => (a.level_order ?? 0) - (b.level_order ?? 0))

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">{track.track_name}</h2>
        {track.description && <p className="text-sm text-gray-600">{track.description}</p>}
        <p className="text-sm text-emerald-600 font-medium mt-2">
          ระดับปัจจุบัน: เงินเดือน {track.current_salary != null ? track.current_salary.toLocaleString('th-TH') : '-'} บาท
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-gray-900 mb-3">เส้นทางสายงาน (จากล่างขึ้นบน)</h3>
        <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
          <div className="flex flex-col">
            {levels.map((level, idx) => {
              const isCurrent = level.id === track.current_level_id
              const isExpanded = expandedLevelId === level.id
              return (
                <div key={level.id}>
                  <div className="flex items-stretch">
                    <div className="w-8 shrink-0 flex flex-col items-center">
                      {idx > 0 && <div className="w-0.5 flex-1 bg-gray-200" />}
                      <div
                        className={`w-3 h-3 rounded-full shrink-0 ${isCurrent ? 'bg-emerald-500 ring-4 ring-emerald-100' : 'bg-gray-300'}`}
                      />
                      {idx < levels.length - 1 && <div className="w-0.5 flex-1 bg-gray-200" />}
                    </div>
                    <div className="flex-1 pb-4 pl-3 min-w-0">
                      <button
                        type="button"
                        onClick={() => setExpandedLevelId(isExpanded ? null : level.id)}
                        className={`w-full text-left rounded-xl border-2 p-4 transition-colors ${isCurrent ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-white'} active:bg-gray-50`}
                      >
                        <p className="font-semibold text-gray-900">{level.title}</p>
                        <p className="text-sm text-gray-600 mt-0.5">
                          {level.salary_min?.toLocaleString('th-TH')} – {level.salary_max?.toLocaleString('th-TH')} บาท
                        </p>
                      </button>
                      {isExpanded && level.requirements?.length ? (
                        <div className="mt-2 pl-4 border-l-2 border-emerald-200 space-y-2">
                          {level.requirements.map((req, i) => (
                            <div key={i} className="flex gap-2 text-sm">
                              <FiCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                              <div>
                                <p className="font-medium text-gray-800">{req.item}</p>
                                {req.description && <p className="text-gray-600 text-xs">{req.description}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : isExpanded && (!level.requirements || level.requirements.length === 0) && (
                        <p className="mt-2 pl-4 text-sm text-gray-500">ไม่มีรายการคุณสมบัติ</p>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {data?.history?.length ? (
        <section>
          <h3 className="font-semibold text-gray-900 mb-3">ประวัติการเลื่อนระดับ</h3>
          <div className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
            <ul className="divide-y divide-gray-100">
              {data.history.map((h, i) => (
                <li key={i} className="p-4">
                  <p className="font-medium text-gray-900">{h.from_title} → {h.to_title}</p>
                  {(h.from_salary != null || h.to_salary != null) && (
                    <p className="text-sm text-gray-600">
                      {h.from_salary != null ? h.from_salary.toLocaleString('th-TH') : '-'} → {h.to_salary != null ? h.to_salary.toLocaleString('th-TH') : '-'} บาท
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">{h.effective_date}</p>
                  {h.reason && <p className="text-xs text-gray-600 mt-0.5">{h.reason}</p>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  )
}
