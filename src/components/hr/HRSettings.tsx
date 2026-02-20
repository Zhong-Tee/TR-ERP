import { useState, useEffect, useCallback } from 'react'
import {
  fetchDepartments,
  fetchPositions,
  fetchLeaveTypes,
  fetchCareerTracks, fetchCareerLevels,
  fetchOnboardingTemplates,
  fetchNotificationSettings,
  fetchEmployees,
} from '../../lib/hrApi'
import type { HRDepartment, HRPosition, HRLeaveType, HRCareerTrack, HRCareerLevel, HROnboardingTemplate, HRNotificationSettings } from '../../types'

const TABS = ['แผนก', 'ตำแหน่ง', 'ประเภทการลา', 'เส้นทางเงินเดือน', 'Onboarding Templates', 'Telegram'] as const

export default function HRSettings() {
  const [activeTab, setActiveTab] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [positions, setPositions] = useState<HRPosition[]>([])
  const [positionDeptFilter, setPositionDeptFilter] = useState<string>('')
  const [leaveTypes, setLeaveTypes] = useState<HRLeaveType[]>([])
  const [tracks, setTracks] = useState<HRCareerTrack[]>([])
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [levels, setLevels] = useState<HRCareerLevel[]>([])
  const [templates, setTemplates] = useState<HROnboardingTemplate[]>([])
  const [notifSettings, setNotifSettings] = useState<HRNotificationSettings | null>(null)
  const [, setEmployees] = useState<Awaited<ReturnType<typeof fetchEmployees>>>([])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [depts, pos, lt, tr, tmpl, notif, emp] = await Promise.all([
        fetchDepartments(), fetchPositions(), fetchLeaveTypes(), fetchCareerTracks(),
        fetchOnboardingTemplates(), fetchNotificationSettings().then((r) => r ?? null), fetchEmployees(),
      ])
      setDepartments(depts)
      setPositions(pos)
      setLeaveTypes(lt)
      setTracks(tr)
      setTemplates(tmpl)
      setNotifSettings(notif)
      setEmployees(emp)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (!selectedTrackId) setLevels([])
    else fetchCareerLevels(selectedTrackId).then(setLevels).catch(() => setLevels([]))
  }, [selectedTrackId])

  const filteredPositions = positionDeptFilter
    ? positions.filter((p) => p.department_id === positionDeptFilter)
    : positions

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>
      )}
      <div className="flex gap-2 border-b border-surface-200 flex-wrap">
        {TABS.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActiveTab(i)}
            className={`px-4 py-2 rounded-t-xl font-medium text-sm ${
              activeTab === i
                ? 'bg-emerald-100 text-emerald-800 border border-b-0 border-emerald-200'
                : 'bg-surface-50 text-gray-600 hover:bg-surface-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* แผนก */}
      {activeTab === 0 && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <table className="w-full text-sm">
            <thead className="bg-surface-100 border-b border-surface-200">
              <tr>
                <th className="text-left py-2 px-3">ชื่อแผนก</th>
                <th className="text-left py-2 px-3">คำอธิบาย</th>
                <th className="text-left py-2 px-3">Telegram Group ID</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} className="border-b border-surface-100">
                  <td className="py-2 px-3 font-medium">{d.name}</td>
                  <td className="py-2 px-3">{d.description ?? '-'}</td>
                  <td className="py-2 px-3">{d.telegram_group_id ?? '-'}</td>
                </tr>
              ))}
              {departments.length === 0 && (
                <tr><td colSpan={3} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลแผนก</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ตำแหน่ง */}
      {activeTab === 1 && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">กรองตามแผนก</label>
            <select
              value={positionDeptFilter}
              onChange={(e) => setPositionDeptFilter(e.target.value)}
              className="rounded-xl border border-surface-200 px-3 py-2 text-sm"
            >
              <option value="">ทั้งหมด</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-100 border-b border-surface-200">
              <tr>
                <th className="text-left py-2 px-3">ชื่อตำแหน่ง</th>
                <th className="text-left py-2 px-3">แผนก</th>
                <th className="text-left py-2 px-3">ระดับ</th>
              </tr>
            </thead>
            <tbody>
              {filteredPositions.map((p) => (
                <tr key={p.id} className="border-b border-surface-100">
                  <td className="py-2 px-3 font-medium">{p.name}</td>
                  <td className="py-2 px-3">{departments.find((d) => d.id === p.department_id)?.name ?? '-'}</td>
                  <td className="py-2 px-3">{p.level}</td>
                </tr>
              ))}
              {filteredPositions.length === 0 && (
                <tr><td colSpan={3} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลตำแหน่ง</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ประเภทการลา */}
      {activeTab === 2 && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <table className="w-full text-sm">
            <thead className="bg-surface-100 border-b border-surface-200">
              <tr>
                <th className="text-left py-2 px-3">ประเภทการลา</th>
                <th className="text-left py-2 px-3">จำนวนวัน/ปี</th>
                <th className="text-left py-2 px-3">ต้องแนบเอกสาร</th>
                <th className="text-left py-2 px-3">ได้รับเงิน</th>
              </tr>
            </thead>
            <tbody>
              {leaveTypes.map((lt) => (
                <tr key={lt.id} className="border-b border-surface-100">
                  <td className="py-2 px-3 font-medium">{lt.name}</td>
                  <td className="py-2 px-3">{lt.max_days_per_year ?? '-'}</td>
                  <td className="py-2 px-3">{lt.requires_doc ? 'ใช่' : 'ไม่'}</td>
                  <td className="py-2 px-3">{lt.is_paid ? 'ใช่' : 'ไม่'}</td>
                </tr>
              ))}
              {leaveTypes.length === 0 && (
                <tr><td colSpan={4} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลประเภทการลา</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* เส้นทางเงินเดือน */}
      {activeTab === 3 && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">เลือกสายงาน</label>
            <select
              value={selectedTrackId ?? ''}
              onChange={(e) => setSelectedTrackId(e.target.value || null)}
              className="rounded-xl border border-surface-200 px-3 py-2 text-sm"
            >
              <option value="">เลือกสายงาน</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          {selectedTrackId && (
            <div className="space-y-2">
              {levels.sort((a, b) => a.level_order - b.level_order).map((lv) => (
                <div key={lv.id} className="rounded-xl border border-surface-200 p-3 bg-white">
                  <p className="font-medium">{lv.title}</p>
                  <p className="text-sm text-gray-600">
                    เงินเดือน: {lv.salary_min?.toLocaleString() ?? 0} - {lv.salary_max?.toLocaleString() ?? 0} บาท
                    {lv.salary_step != null && <span className="text-gray-500"> (ขั้นละ {lv.salary_step})</span>}
                  </p>
                  {lv.requirements?.length > 0 && (
                    <ul className="mt-1 text-xs text-gray-500 list-disc pl-4">
                      {(lv.requirements as { item: string; description: string }[]).map((r, i) => (
                        <li key={i}>{r.item}: {r.description}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              {levels.length === 0 && (
                <p className="text-sm text-gray-400">ยังไม่มีข้อมูลระดับในสายงานนี้</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Onboarding Templates */}
      {activeTab === 4 && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <ul className="space-y-2">
            {templates.map((t) => (
              <li key={t.id} className="rounded-xl border border-surface-200 p-3 bg-white font-medium">{t.name}</li>
            ))}
            {templates.length === 0 && (
              <li className="text-sm text-gray-400">ยังไม่มีข้อมูล Onboarding Templates</li>
            )}
          </ul>
        </div>
      )}

      {/* Telegram */}
      {activeTab === 5 && notifSettings && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4 max-w-lg space-y-2">
          <p className="text-sm">แจ้งเตือนก่อนวันลา: {notifSettings.leave_notify_before_days} วัน</p>
          <p className="text-sm">เวลาแจ้งเตือนเช้า: {notifSettings.leave_notify_morning_time}</p>
        </div>
      )}
      {activeTab === 5 && !notifSettings && (
        <div className="rounded-xl border border-surface-200 p-4 text-gray-500">ยังไม่มีการตั้งค่า Telegram</div>
      )}
    </div>
  )
}
