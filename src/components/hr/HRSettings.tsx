import { useState, useEffect, useCallback } from 'react'
import {
  fetchDepartments,
  upsertDepartment,
  deleteDepartment,
  fetchPositions,
  upsertPosition,
  deletePosition,
  fetchLeaveTypes,
  upsertLeaveType,
  fetchCareerTracks,
  upsertCareerTrack,
  fetchCareerLevels,
  upsertCareerLevel,
  deleteCareerLevel,
  fetchOnboardingTemplates,
  upsertOnboardingTemplate,
  fetchNotificationSettings,
  upsertNotificationSettings,
} from '../../lib/hrApi'
import type {
  HRDepartment,
  HRPosition,
  HRLeaveType,
  HRCareerTrack,
  HRCareerLevel,
  HROnboardingTemplate,
  HRNotificationSettings,
} from '../../types'

const TABS = ['แผนก', 'ตำแหน่ง', 'ประเภทการลา', 'เส้นทางเงินเดือน', 'Onboarding Templates', 'Telegram'] as const

type LevelForm = {
  id?: string
  title: string
  position_id: string
  level_order: string
  salary_min: string
  salary_max: string
  salary_step: string
  requirements: string
}

function getNextLevelOrder(levels: HRCareerLevel[]): number {
  return levels.reduce((max, level) => Math.max(max, level.level_order), 0) + 1
}

function buildLevelForm(levelOrder = 1): LevelForm {
  return {
    title: '',
    position_id: '',
    level_order: String(levelOrder),
    salary_min: '0',
    salary_max: '0',
    salary_step: '',
    requirements: '',
  }
}

function requirementsToText(reqs: { item: string; description: string }[] | undefined): string {
  if (!Array.isArray(reqs) || reqs.length === 0) return ''
  return reqs
    .map((r) => (r.description ? `${r.item}: ${r.description}` : r.item))
    .join('\n')
}

function parseRequirementsInput(raw: string): { item: string; description: string }[] {
  const text = raw.trim()
  if (!text) return []

  // Backward compatibility: still accept old JSON array input.
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('รูปแบบคุณสมบัติต้องเป็นรายการ')
    return parsed.map((x: unknown) => {
      const row = x as { item?: unknown; description?: unknown }
      return {
        item: String(row?.item ?? '').trim(),
        description: String(row?.description ?? '').trim(),
      }
    }).filter((r) => r.item)
  }

  // Friendly format: one requirement per line, optional "หัวข้อ: คำอธิบาย".
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':')
      if (i === -1) return { item: line, description: '' }
      return {
        item: line.slice(0, i).trim(),
        description: line.slice(i + 1).trim(),
      }
    })
    .filter((r) => r.item)
}

export default function HRSettings() {
  const [activeTab, setActiveTab] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [positions, setPositions] = useState<HRPosition[]>([])
  const [positionDeptFilter, setPositionDeptFilter] = useState<string>('')
  const [leaveTypes, setLeaveTypes] = useState<HRLeaveType[]>([])
  const [tracks, setTracks] = useState<HRCareerTrack[]>([])
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [levels, setLevels] = useState<HRCareerLevel[]>([])
  const [salaryDeptFilter, setSalaryDeptFilter] = useState<string>('')
  const [salaryPositionFilter, setSalaryPositionFilter] = useState<string>('')
  const [templates, setTemplates] = useState<HROnboardingTemplate[]>([])
  const [notifSettings, setNotifSettings] = useState<HRNotificationSettings | null>(null)

  const [deptForm, setDeptForm] = useState<{ id?: string; name: string; description: string; telegram_group_id: string }>({
    name: '',
    description: '',
    telegram_group_id: '',
  })
  const [posForm, setPosForm] = useState<{ id?: string; name: string; department_id: string; level: string }>({
    name: '',
    department_id: '',
    level: '1',
  })
  const [leaveForm, setLeaveForm] = useState<{ id?: string; name: string; max_days_per_year: string; requires_doc: boolean; is_paid: boolean }>({
    name: '',
    max_days_per_year: '',
    requires_doc: false,
    is_paid: true,
  })
  const [trackForm, setTrackForm] = useState<{ id?: string; name: string; department_id: string; description: string }>({
    name: '',
    department_id: '',
    description: '',
  })
  const [levelForm, setLevelForm] = useState<LevelForm>(buildLevelForm())
  const [templateForm, setTemplateForm] = useState<{
    id?: string
    name: string
    department_id: string
    position_id: string
    is_active: boolean
    phases: string
  }>({
    name: '',
    department_id: '',
    position_id: '',
    is_active: true,
    phases: '[]',
  })
  const [notifForm, setNotifForm] = useState<{
    id?: string
    bot_token: string
    hr_group_chat_id: string
    manager_group_chat_id: string
    leave_notify_before_days: string
    leave_notify_morning_time: string
  }>({
    bot_token: '',
    hr_group_chat_id: '',
    manager_group_chat_id: '',
    leave_notify_before_days: '1',
    leave_notify_morning_time: '07:00',
  })

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [depts, pos, lt, tr, tmpl, notif] = await Promise.all([
        fetchDepartments(),
        fetchPositions(),
        fetchLeaveTypes(),
        fetchCareerTracks(),
        fetchOnboardingTemplates(),
        fetchNotificationSettings().then((r) => r ?? null),
      ])
      setDepartments(depts)
      setPositions(pos)
      setLeaveTypes(lt)
      setTracks(tr)
      setTemplates(tmpl)
      setNotifSettings(notif)
      setNotifForm({
        id: notif?.id,
        bot_token: notif?.bot_token ?? '',
        hr_group_chat_id: notif?.hr_group_chat_id ?? '',
        manager_group_chat_id: notif?.manager_group_chat_id ?? '',
        leave_notify_before_days: String(notif?.leave_notify_before_days ?? 1),
        leave_notify_morning_time: notif?.leave_notify_morning_time ?? '07:00',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    let cancelled = false
    if (!selectedTrackId) {
      setLevels([])
      setLevelForm(buildLevelForm())
      return
    }
    fetchCareerLevels(selectedTrackId)
      .then((nextLevels) => {
        if (cancelled) return
        setLevels(nextLevels)
        setLevelForm((prev) => (prev.id ? prev : buildLevelForm(getNextLevelOrder(nextLevels))))
      })
      .catch(() => {
        if (cancelled) return
        setLevels([])
        setLevelForm(buildLevelForm())
      })
    return () => {
      cancelled = true
    }
  }, [selectedTrackId])

  const resetDeptForm = () => setDeptForm({ name: '', description: '', telegram_group_id: '' })
  const resetPosForm = () => setPosForm({ name: '', department_id: '', level: '1' })
  const resetLeaveForm = () => setLeaveForm({ name: '', max_days_per_year: '', requires_doc: false, is_paid: true })
  const resetTrackForm = () => setTrackForm({ name: '', department_id: '', description: '' })
  const resetLevelForm = () => setLevelForm(buildLevelForm(getNextLevelOrder(levels)))
  const resetTemplateForm = () =>
    setTemplateForm({
      name: '',
      department_id: '',
      position_id: '',
      is_active: true,
      phases: '[]',
    })

  const saveDepartment = async () => {
    if (!deptForm.name.trim()) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await upsertDepartment({
        id: deptForm.id,
        name: deptForm.name.trim(),
        description: deptForm.description.trim() || undefined,
        telegram_group_id: deptForm.telegram_group_id.trim() || undefined,
      })
      setMessage('บันทึกแผนกเรียบร้อย')
      resetDeptForm()
      setDepartments(await fetchDepartments())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกแผนกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const removeDepartment = async (id: string) => {
    if (!window.confirm('ยืนยันลบแผนกนี้?')) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await deleteDepartment(id)
      setMessage('ลบแผนกเรียบร้อย')
      resetDeptForm()
      setDepartments(await fetchDepartments())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบแผนกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const savePosition = async () => {
    if (!posForm.name.trim()) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await upsertPosition({
        id: posForm.id,
        name: posForm.name.trim(),
        department_id: posForm.department_id || undefined,
        level: Number(posForm.level) || 1,
      })
      setMessage('บันทึกตำแหน่งเรียบร้อย')
      resetPosForm()
      setPositions(await fetchPositions())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกตำแหน่งไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const removePosition = async (id: string) => {
    if (!window.confirm('ยืนยันลบตำแหน่งนี้?')) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await deletePosition(id)
      setMessage('ลบตำแหน่งเรียบร้อย')
      resetPosForm()
      setPositions(await fetchPositions())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบตำแหน่งไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveLeaveType = async () => {
    if (!leaveForm.name.trim()) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await upsertLeaveType({
        id: leaveForm.id,
        name: leaveForm.name.trim(),
        max_days_per_year: leaveForm.max_days_per_year.trim() === '' ? undefined : Number(leaveForm.max_days_per_year),
        requires_doc: leaveForm.requires_doc,
        is_paid: leaveForm.is_paid,
      })
      setMessage('บันทึกประเภทการลาเรียบร้อย')
      resetLeaveForm()
      setLeaveTypes(await fetchLeaveTypes())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกประเภทการลาไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveTrack = async () => {
    if (!trackForm.name.trim()) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const saved = await upsertCareerTrack({
        id: trackForm.id,
        name: trackForm.name.trim(),
        department_id: trackForm.department_id || undefined,
        description: trackForm.description.trim() || undefined,
      })
      setMessage('บันทึกสายงานเรียบร้อย')
      resetTrackForm()
      const tr = await fetchCareerTracks()
      setTracks(tr)
      if (!selectedTrackId) setSelectedTrackId(saved.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกสายงานไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveLevel = async () => {
    if (!selectedTrackId) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const selectedPosition = positions.find((p) => p.id === levelForm.position_id)
      const levelTitle = levelForm.title.trim() || selectedPosition?.name || ''
      if (!levelTitle) {
        throw new Error('กรุณาระบุชื่อตำแหน่ง/ระดับ หรือเลือกตำแหน่งงาน')
      }
      const levelOrder = Math.max(1, Math.trunc(Number(levelForm.level_order) || 1))
      const duplicateOrderLevel = levels.find((lv) => lv.level_order === levelOrder && lv.id !== levelForm.id)
      if (duplicateOrderLevel) {
        throw new Error(`ลำดับ ${levelOrder} ถูกใช้กับระดับ "${duplicateOrderLevel.title}" ในสายงานนี้แล้ว กรุณาเลือกลำดับอื่น`)
      }
      const parsedRequirements = parseRequirementsInput(levelForm.requirements)
      await upsertCareerLevel({
        id: levelForm.id,
        track_id: selectedTrackId,
        position_id: levelForm.position_id || undefined,
        level_order: levelOrder,
        title: levelTitle,
        salary_min: Number(levelForm.salary_min) || 0,
        salary_max: Number(levelForm.salary_max) || 0,
        salary_step: levelForm.salary_step.trim() === '' ? undefined : Number(levelForm.salary_step),
        requirements: parsedRequirements,
      })
      setMessage('บันทึกระดับสายงานเรียบร้อย')
      const nextLevels = await fetchCareerLevels(selectedTrackId)
      setLevels(nextLevels)
      setLevelForm(buildLevelForm(getNextLevelOrder(nextLevels)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกระดับสายงานไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const removeLevel = async (id: string) => {
    if (!window.confirm('ยืนยันลบระดับนี้?')) return
    if (!selectedTrackId) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      await deleteCareerLevel(id)
      setMessage('ลบระดับสายงานเรียบร้อย')
      const nextLevels = await fetchCareerLevels(selectedTrackId)
      setLevels(nextLevels)
      setLevelForm(buildLevelForm(getNextLevelOrder(nextLevels)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบระดับสายงานไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveTemplate = async () => {
    if (!templateForm.name.trim()) return
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      let parsedPhases: HROnboardingTemplate['phases'] = []
      try {
        parsedPhases = JSON.parse(templateForm.phases || '[]')
      } catch {
        throw new Error('รูปแบบ Phases ต้องเป็น JSON Array')
      }
      await upsertOnboardingTemplate({
        id: templateForm.id,
        name: templateForm.name.trim(),
        department_id: templateForm.department_id || undefined,
        position_id: templateForm.position_id || undefined,
        phases: parsedPhases,
        is_active: templateForm.is_active,
      })
      setMessage('บันทึก Onboarding Template เรียบร้อย')
      resetTemplateForm()
      setTemplates(await fetchOnboardingTemplates())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึก Onboarding Template ไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveNotificationSettings = async () => {
    if (!notifForm.bot_token.trim()) {
      setError('กรุณากรอก Bot Token')
      return
    }
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const saved = await upsertNotificationSettings({
        id: notifForm.id,
        bot_token: notifForm.bot_token.trim(),
        hr_group_chat_id: notifForm.hr_group_chat_id.trim() || undefined,
        manager_group_chat_id: notifForm.manager_group_chat_id.trim() || undefined,
        leave_notify_before_days: Number(notifForm.leave_notify_before_days) || 1,
        leave_notify_morning_time: notifForm.leave_notify_morning_time || '07:00',
      })
      setNotifSettings(saved)
      setNotifForm({
        id: saved.id,
        bot_token: saved.bot_token,
        hr_group_chat_id: saved.hr_group_chat_id ?? '',
        manager_group_chat_id: saved.manager_group_chat_id ?? '',
        leave_notify_before_days: String(saved.leave_notify_before_days),
        leave_notify_morning_time: saved.leave_notify_morning_time,
      })
      setMessage('บันทึกการตั้งค่า Telegram เรียบร้อย')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึก Telegram ไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const filteredPositions = positionDeptFilter
    ? positions.filter((p) => p.department_id === positionDeptFilter)
    : positions

  const salaryFilteredTracks = salaryDeptFilter
    ? tracks.filter((t) => t.department_id === salaryDeptFilter)
    : tracks

  const salaryFilteredPositions = salaryDeptFilter
    ? positions.filter((p) => p.department_id === salaryDeptFilter)
    : positions

  const visibleLevels = [...levels]
    .filter((lv) => !salaryPositionFilter || lv.position_id === salaryPositionFilter)
    .sort((a, b) => a.level_order - b.level_order)

  if (loading) {
    return (
      <div className="mt-4 flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-6">
      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>
      )}
      {message && (
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm">{message}</div>
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
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
            <table className="w-full text-sm">
              <thead className="bg-surface-100 border-b border-surface-200">
                <tr>
                  <th className="text-left py-2 px-3">ชื่อแผนก</th>
                  <th className="text-left py-2 px-3">คำอธิบาย</th>
                  <th className="text-left py-2 px-3">Telegram Group ID</th>
                  <th className="text-right py-2 px-3">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((d) => (
                  <tr key={d.id} className="border-b border-surface-100">
                    <td className="py-2 px-3 font-medium">{d.name}</td>
                    <td className="py-2 px-3">{d.description ?? '-'}</td>
                    <td className="py-2 px-3">{d.telegram_group_id ?? '-'}</td>
                    <td className="py-2 px-3 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() => setDeptForm({ id: d.id, name: d.name, description: d.description ?? '', telegram_group_id: d.telegram_group_id ?? '' })}
                        className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        onClick={() => removeDepartment(d.id)}
                        className="px-2 py-1 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs"
                        disabled={saving}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
                {departments.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลแผนก</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
            <h3 className="font-medium text-gray-900">{deptForm.id ? 'แก้ไขแผนก' : 'เพิ่มแผนก'}</h3>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อแผนก *</span>
              <input
                type="text"
                value={deptForm.name}
                onChange={(e) => setDeptForm((p) => ({ ...p, name: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">คำอธิบาย</span>
              <input
                type="text"
                value={deptForm.description}
                onChange={(e) => setDeptForm((p) => ({ ...p, description: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">Telegram Group ID</span>
              <input
                type="text"
                value={deptForm.telegram_group_id}
                onChange={(e) => setDeptForm((p) => ({ ...p, telegram_group_id: e.target.value }))}
                className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={resetDeptForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
              <button type="button" onClick={saveDepartment} disabled={saving || !deptForm.name.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ตำแหน่ง */}
      {activeTab === 1 && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
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
                  <th className="text-right py-2 px-3">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {filteredPositions.map((p) => (
                  <tr key={p.id} className="border-b border-surface-100">
                    <td className="py-2 px-3 font-medium">{p.name}</td>
                    <td className="py-2 px-3">{departments.find((d) => d.id === p.department_id)?.name ?? '-'}</td>
                    <td className="py-2 px-3">{p.level}</td>
                    <td className="py-2 px-3 text-right space-x-2">
                      <button
                        type="button"
                        onClick={() => setPosForm({ id: p.id, name: p.name, department_id: p.department_id ?? '', level: String(p.level ?? 1) })}
                        className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        onClick={() => removePosition(p.id)}
                        className="px-2 py-1 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs"
                        disabled={saving}
                      >
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
                {filteredPositions.length === 0 && (
                  <tr><td colSpan={4} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลตำแหน่ง</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
            <h3 className="font-medium text-gray-900">{posForm.id ? 'แก้ไขตำแหน่ง' : 'เพิ่มตำแหน่ง'}</h3>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อตำแหน่ง *</span>
              <input type="text" value={posForm.name} onChange={(e) => setPosForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">แผนก</span>
              <select value={posForm.department_id} onChange={(e) => setPosForm((p) => ({ ...p, department_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือก --</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ระดับ</span>
              <input type="number" min={1} value={posForm.level} onChange={(e) => setPosForm((p) => ({ ...p, level: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={resetPosForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
              <button type="button" onClick={savePosition} disabled={saving || !posForm.name.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ประเภทการลา */}
      {activeTab === 2 && (
        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
            <table className="w-full text-sm">
              <thead className="bg-surface-100 border-b border-surface-200">
                <tr>
                  <th className="text-left py-2 px-3">ประเภทการลา</th>
                  <th className="text-left py-2 px-3">จำนวนวัน/ปี</th>
                  <th className="text-left py-2 px-3">ต้องแนบเอกสาร</th>
                  <th className="text-left py-2 px-3">ได้รับเงิน</th>
                  <th className="text-right py-2 px-3">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {leaveTypes.map((lt) => (
                  <tr key={lt.id} className="border-b border-surface-100">
                    <td className="py-2 px-3 font-medium">{lt.name}</td>
                    <td className="py-2 px-3">{lt.max_days_per_year ?? '-'}</td>
                    <td className="py-2 px-3">{lt.requires_doc ? 'ใช่' : 'ไม่'}</td>
                    <td className="py-2 px-3">{lt.is_paid ? 'ใช่' : 'ไม่'}</td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          setLeaveForm({
                            id: lt.id,
                            name: lt.name,
                            max_days_per_year: lt.max_days_per_year == null ? '' : String(lt.max_days_per_year),
                            requires_doc: lt.requires_doc,
                            is_paid: lt.is_paid,
                          })
                        }
                        className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                      >
                        แก้ไข
                      </button>
                    </td>
                  </tr>
                ))}
                {leaveTypes.length === 0 && (
                  <tr><td colSpan={5} className="py-4 text-center text-gray-400">ยังไม่มีข้อมูลประเภทการลา</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
            <h3 className="font-medium text-gray-900">{leaveForm.id ? 'แก้ไขประเภทการลา' : 'เพิ่มประเภทการลา'}</h3>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อประเภทลา *</span>
              <input type="text" value={leaveForm.name} onChange={(e) => setLeaveForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">จำนวนวัน/ปี (เว้นว่างได้)</span>
              <input type="number" min={0} value={leaveForm.max_days_per_year} onChange={(e) => setLeaveForm((p) => ({ ...p, max_days_per_year: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={leaveForm.requires_doc} onChange={(e) => setLeaveForm((p) => ({ ...p, requires_doc: e.target.checked }))} />
              ต้องแนบเอกสาร
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={leaveForm.is_paid} onChange={(e) => setLeaveForm((p) => ({ ...p, is_paid: e.target.checked }))} />
              ได้รับค่าจ้าง
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={resetLeaveForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
              <button type="button" onClick={saveLeaveType} disabled={saving || !leaveForm.name.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            </div>
          </div>
        </div>
      )}

      {/* เส้นทางเงินเดือน */}
      {activeTab === 3 && (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            ขั้นตอน: 1) เลือกแผนก 2) เลือก/สร้างสายงาน 3) เลือกตำแหน่งงาน และกำหนดช่วงเงินเดือนของแต่ละระดับ
          </div>

          <div className="rounded-xl border border-surface-200 bg-white p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-sm">
                <span className="text-gray-600">แผนก</span>
                <select
                  value={salaryDeptFilter}
                  onChange={(e) => {
                    const deptId = e.target.value
                    setSalaryDeptFilter(deptId)
                    setSalaryPositionFilter('')
                    setSelectedTrackId(null)
                    setLevelForm((p) => ({ ...p, position_id: '' }))
                  }}
                  className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                >
                  <option value="">-- ทุกแผนก --</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">ตำแหน่งงาน (ใช้กรองระดับ)</span>
                <select
                  value={salaryPositionFilter}
                  onChange={(e) => setSalaryPositionFilter(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                >
                  <option value="">-- ทุกตำแหน่ง --</option>
                  {salaryFilteredPositions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
              <h3 className="font-medium text-gray-900">{trackForm.id ? 'แก้ไขสายงาน' : 'เพิ่มสายงาน'}</h3>
              <label className="block text-sm">
                <span className="text-gray-600">ชื่อสายงาน *</span>
                <input type="text" value={trackForm.name} onChange={(e) => setTrackForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">แผนก</span>
                <select value={trackForm.department_id} onChange={(e) => setTrackForm((p) => ({ ...p, department_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                  <option value="">-- เลือก --</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">คำอธิบาย</span>
                <textarea value={trackForm.description} onChange={(e) => setTrackForm((p) => ({ ...p, description: e.target.value }))} rows={2} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={resetTrackForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
                <button type="button" onClick={saveTrack} disabled={saving || !trackForm.name.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกสายงาน'}</button>
              </div>
            </div>
            <div className="rounded-xl border border-surface-200 bg-white p-4">
              <h3 className="font-medium text-gray-900 mb-2">รายการสายงาน</h3>
              <div className="space-y-2">
                {salaryFilteredTracks.map((t) => (
                  <div key={t.id} className={`rounded-xl border p-3 ${selectedTrackId === t.id ? 'border-emerald-300 bg-emerald-50' : 'border-surface-200'}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTrackId(t.id)
                        setLevelForm(buildLevelForm())
                      }}
                      className="w-full text-left"
                    >
                      <p className="font-medium">{t.name}</p>
                      <p className="text-xs text-gray-500">{t.description ?? '-'}</p>
                    </button>
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          setTrackForm({
                            id: t.id,
                            name: t.name,
                            department_id: t.department_id ?? '',
                            description: t.description ?? '',
                          })
                        }
                        className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                      >
                        แก้ไข
                      </button>
                    </div>
                  </div>
                ))}
                {salaryFilteredTracks.length === 0 && <p className="text-sm text-gray-400">ยังไม่มีสายงานในแผนกที่เลือก</p>}
              </div>
            </div>
          </div>

          {selectedTrackId && (
            <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
              <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
                <table className="w-full text-sm">
                  <thead className="bg-surface-100 border-b border-surface-200">
                    <tr>
                      <th className="text-left py-2 px-3">ลำดับ</th>
                      <th className="text-left py-2 px-3">ระดับ/ชื่อตำแหน่ง</th>
                      <th className="text-left py-2 px-3">ตำแหน่งอ้างอิง</th>
                      <th className="text-left py-2 px-3">ช่วงเงินเดือน</th>
                      <th className="text-right py-2 px-3">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLevels.map((lv) => (
                      <tr key={lv.id} className="border-b border-surface-100">
                        <td className="py-2 px-3">{lv.level_order}</td>
                        <td className="py-2 px-3 font-medium">{lv.title}</td>
                        <td className="py-2 px-3">{positions.find((p) => p.id === lv.position_id)?.name ?? '-'}</td>
                        <td className="py-2 px-3">
                          {(lv.salary_min ?? 0).toLocaleString()} - {(lv.salary_max ?? 0).toLocaleString()}
                          {lv.salary_step != null && <span className="text-gray-500"> (step {lv.salary_step})</span>}
                        </td>
                        <td className="py-2 px-3 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() =>
                              setLevelForm({
                                id: lv.id,
                                title: lv.title,
                                position_id: lv.position_id ?? '',
                                level_order: String(lv.level_order),
                                salary_min: String(lv.salary_min ?? 0),
                                salary_max: String(lv.salary_max ?? 0),
                                salary_step: lv.salary_step == null ? '' : String(lv.salary_step),
                                requirements: requirementsToText(lv.requirements),
                              })
                            }
                            className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                          >
                            แก้ไข
                          </button>
                          <button
                            type="button"
                            onClick={() => removeLevel(lv.id)}
                            className="px-2 py-1 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs"
                            disabled={saving}
                          >
                            ลบ
                          </button>
                        </td>
                      </tr>
                    ))}
                    {visibleLevels.length === 0 && (
                      <tr><td colSpan={5} className="py-4 text-center text-gray-400">ยังไม่มีระดับตามเงื่อนไขที่เลือก</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
                <h3 className="font-medium text-gray-900">{levelForm.id ? 'แก้ไขระดับ' : 'เพิ่มระดับ'}</h3>
                <label className="block text-sm">
                  <span className="text-gray-600">ตำแหน่งงาน</span>
                  <select
                    value={levelForm.position_id}
                    onChange={(e) => {
                      const nextPositionId = e.target.value
                      const matched = positions.find((p) => p.id === nextPositionId)
                      setLevelForm((p) => ({
                        ...p,
                        position_id: nextPositionId,
                        title: p.title.trim() ? p.title : (matched?.name ?? ''),
                      }))
                    }}
                    className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                  >
                    <option value="">-- เลือกตำแหน่ง --</option>
                    {salaryFilteredPositions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">ชื่อระดับ/ชื่อตำแหน่ง</span>
                  <input
                    type="text"
                    value={levelForm.title}
                    onChange={(e) => setLevelForm((p) => ({ ...p, title: e.target.value }))}
                    placeholder="เช่น เจ้าหน้าที่อาวุโส / หัวหน้าทีม"
                    className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block text-sm">
                    <span className="text-gray-600">ลำดับ</span>
                    <input type="number" min={1} value={levelForm.level_order} onChange={(e) => setLevelForm((p) => ({ ...p, level_order: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
                  </label>
                  <label className="block text-sm">
                    <span className="text-gray-600">เงินเดือนต่ำสุด</span>
                    <input type="number" min={0} value={levelForm.salary_min} onChange={(e) => setLevelForm((p) => ({ ...p, salary_min: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
                  </label>
                  <label className="block text-sm">
                    <span className="text-gray-600">เงินเดือนสูงสุด</span>
                    <input type="number" min={0} value={levelForm.salary_max} onChange={(e) => setLevelForm((p) => ({ ...p, salary_max: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
                  </label>
                </div>
                <label className="block text-sm">
                  <span className="text-gray-600">Salary Step</span>
                  <input type="number" min={0} value={levelForm.salary_step} onChange={(e) => setLevelForm((p) => ({ ...p, salary_step: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">คุณสมบัติ/เงื่อนไข (ไม่บังคับ)</span>
                  <textarea
                    value={levelForm.requirements}
                    onChange={(e) => setLevelForm((p) => ({ ...p, requirements: e.target.value }))}
                    rows={6}
                    placeholder={'พิมพ์บรรทัดละ 1 ข้อ เช่น\nผ่านทดลองงาน\nประเมินผลงานเฉลี่ย >= 80\nทักษะ Excel: ระดับดี'}
                    className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-gray-500">รองรับ JSON เดิมได้ แต่ไม่จำเป็นต้องกรอกแบบ JSON แล้ว</p>
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={resetLevelForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
                  <button
                    type="button"
                    onClick={saveLevel}
                    disabled={saving || (!levelForm.title.trim() && !levelForm.position_id)}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {saving ? 'กำลังบันทึก...' : 'บันทึกระดับ'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {!selectedTrackId && salaryFilteredTracks.length > 0 && (
            <div className="rounded-xl border border-surface-200 bg-white p-4 text-sm text-gray-600">
              เลือกสายงานจาก “รายการสายงาน” เพื่อกำหนดระดับเงินเดือน
            </div>
          )}
        </div>
      )}

      {/* Onboarding Templates */}
      {activeTab === 4 && (
        <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
          <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id} className="rounded-xl border border-surface-200 p-3 bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{t.name}</p>
                      <p className="text-xs text-gray-500">
                        {t.is_active ? 'Active' : 'Inactive'} · Phases: {Array.isArray(t.phases) ? t.phases.length : 0}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setTemplateForm({
                          id: t.id,
                          name: t.name,
                          department_id: t.department_id ?? '',
                          position_id: t.position_id ?? '',
                          is_active: t.is_active,
                          phases: JSON.stringify(t.phases ?? [], null, 2),
                        })
                      }
                      className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs"
                    >
                      แก้ไข
                    </button>
                  </div>
                </li>
              ))}
              {templates.length === 0 && (
                <li className="text-sm text-gray-400">ยังไม่มีข้อมูล Onboarding Templates</li>
              )}
            </ul>
          </div>
          <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
            <h3 className="font-medium text-gray-900">{templateForm.id ? 'แก้ไข Template' : 'เพิ่ม Template'}</h3>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อ Template *</span>
              <input type="text" value={templateForm.name} onChange={(e) => setTemplateForm((p) => ({ ...p, name: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">แผนก</span>
              <select value={templateForm.department_id} onChange={(e) => setTemplateForm((p) => ({ ...p, department_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือก --</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ตำแหน่ง</span>
              <select value={templateForm.position_id} onChange={(e) => setTemplateForm((p) => ({ ...p, position_id: e.target.value }))} className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2">
                <option value="">-- เลือก --</option>
                {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={templateForm.is_active} onChange={(e) => setTemplateForm((p) => ({ ...p, is_active: e.target.checked }))} />
              Active
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">Phases (JSON Array)</span>
              <textarea
                value={templateForm.phases}
                onChange={(e) => setTemplateForm((p) => ({ ...p, phases: e.target.value }))}
                rows={10}
                className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 font-mono text-xs"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={resetTemplateForm} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ล้างค่า</button>
              <button type="button" onClick={saveTemplate} disabled={saving || !templateForm.name.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Telegram */}
      {activeTab === 5 && (
        <div className="rounded-xl border border-surface-200 bg-white p-4 max-w-lg space-y-3">
          <p className="text-xs text-gray-500">
            {notifSettings ? 'แก้ไขการตั้งค่า Telegram' : 'ตั้งค่า Telegram ครั้งแรก'}
          </p>
          <label className="block text-sm">
            <span className="text-gray-600">Bot Token *</span>
            <input
              type="text"
              value={notifForm.bot_token}
              onChange={(e) => setNotifForm((p) => ({ ...p, bot_token: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">HR Group Chat ID</span>
            <input
              type="text"
              value={notifForm.hr_group_chat_id}
              onChange={(e) => setNotifForm((p) => ({ ...p, hr_group_chat_id: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">Manager Group Chat ID</span>
            <input
              type="text"
              value={notifForm.manager_group_chat_id}
              onChange={(e) => setNotifForm((p) => ({ ...p, manager_group_chat_id: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">แจ้งเตือนก่อนวันลา (วัน)</span>
            <input
              type="number"
              min={0}
              value={notifForm.leave_notify_before_days}
              onChange={(e) => setNotifForm((p) => ({ ...p, leave_notify_before_days: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">เวลาแจ้งเตือนเช้า</span>
            <input
              type="time"
              value={notifForm.leave_notify_morning_time}
              onChange={(e) => setNotifForm((p) => ({ ...p, leave_notify_morning_time: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-surface-200 px-3 py-2"
            />
          </label>
          <div className="flex justify-end">
            <button type="button" onClick={saveNotificationSettings} disabled={saving} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
