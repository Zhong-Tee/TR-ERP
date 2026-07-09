import { useState, useEffect } from 'react'
import { FiMapPin, FiPlus, FiTrash2, FiEdit2, FiCrosshair, FiClock, FiStar } from 'react-icons/fi'
import {
  fetchClockLocations, upsertClockLocation, deleteClockLocation,
  fetchWorkSchedules, upsertWorkSchedule, deleteWorkSchedule,
} from '../../lib/hrApi'
import type { HRClockLocation, HRWorkSchedule } from '../../types'

interface Props {
  /** เฉพาะ superadmin แก้ไขได้ (RLS ก็บังคับอีกชั้น) */
  canEdit: boolean
}

const EMPTY_LOC_FORM = { name: '', lat: '', lng: '', radius_m: '100' }
const EMPTY_SCHED_FORM = {
  name: '',
  work_start: '08:00',
  work_end: '17:00',
  late_grace_min: '0',
  work_days: [1, 2, 3, 4, 5, 6] as number[],
  is_default: false,
}

const DAY_OPTIONS = [
  [1, 'จ.'], [2, 'อ.'], [3, 'พ.'], [4, 'พฤ.'], [5, 'ศ.'], [6, 'ส.'], [7, 'อา.'],
] as const

function parseWorkDays(s: string): number[] {
  return (s || '1,2,3,4,5,6')
    .split(',')
    .map((d) => parseInt(d, 10))
    .filter((d) => d >= 1 && d <= 7)
}

function workDaysLabel(s: string): string {
  const days = parseWorkDays(s)
  return DAY_OPTIONS.filter(([d]) => days.includes(d)).map(([, l]) => l).join(' ')
}

export default function ClockLocationsPanel({ canEdit }: Props) {
  const [locations, setLocations] = useState<HRClockLocation[]>([])
  const [schedules, setSchedules] = useState<HRWorkSchedule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_LOC_FORM)
  const [gettingGps, setGettingGps] = useState(false)

  const [showSchedForm, setShowSchedForm] = useState(false)
  const [editingSchedId, setEditingSchedId] = useState<string | null>(null)
  const [schedForm, setSchedForm] = useState(EMPTY_SCHED_FORM)

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(t)
  }, [message])

  async function loadData() {
    setLoading(true)
    try {
      const [locs, scheds] = await Promise.all([fetchClockLocations(), fetchWorkSchedules()])
      setLocations(locs)
      setSchedules(scheds)
    } catch (e: any) {
      setMessage({ type: 'error', text: 'โหลดข้อมูลไม่สำเร็จ: ' + e.message })
    } finally {
      setLoading(false)
    }
  }

  // ─── จุดพิกัดออฟฟิศ ─────────────────────────────────────────────────────────

  function openCreate() {
    setEditingId(null)
    setForm(EMPTY_LOC_FORM)
    setShowForm(true)
  }

  function openEdit(loc: HRClockLocation) {
    setEditingId(loc.id)
    setForm({ name: loc.name, lat: String(loc.lat), lng: String(loc.lng), radius_m: String(loc.radius_m) })
    setShowForm(true)
  }

  function useCurrentPosition() {
    if (!navigator.geolocation) {
      setMessage({ type: 'error', text: 'เบราว์เซอร์นี้ไม่รองรับ GPS' })
      return
    }
    setGettingGps(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: pos.coords.latitude.toFixed(7), lng: pos.coords.longitude.toFixed(7) }))
        setGettingGps(false)
      },
      (err) => {
        setMessage({ type: 'error', text: 'อ่านพิกัดไม่สำเร็จ: ' + err.message + ' (ต้องเปิดผ่าน HTTPS และอนุญาตตำแหน่ง)' })
        setGettingGps(false)
      },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  async function handleSaveLocation() {
    const lat = parseFloat(form.lat)
    const lng = parseFloat(form.lng)
    const radius = parseInt(form.radius_m, 10)
    if (!form.name.trim()) return setMessage({ type: 'error', text: 'กรุณาตั้งชื่อออฟฟิศ' })
    if (isNaN(lat) || lat < -90 || lat > 90) return setMessage({ type: 'error', text: 'Latitude ไม่ถูกต้อง' })
    if (isNaN(lng) || lng < -180 || lng > 180) return setMessage({ type: 'error', text: 'Longitude ไม่ถูกต้อง' })
    if (isNaN(radius) || radius < 10) return setMessage({ type: 'error', text: 'รัศมีต้องอย่างน้อย 10 เมตร' })

    setSaving(true)
    try {
      await upsertClockLocation({
        ...(editingId ? { id: editingId } : {}),
        name: form.name.trim(),
        lat, lng, radius_m: radius,
      })
      setMessage({ type: 'success', text: editingId ? 'แก้ไขจุดพิกัดสำเร็จ' : 'เพิ่มจุดพิกัดสำเร็จ' })
      setShowForm(false)
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleActive(loc: HRClockLocation) {
    try {
      await upsertClockLocation({ id: loc.id, is_active: !loc.is_active })
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    }
  }

  async function handleDelete(loc: HRClockLocation) {
    if (!window.confirm(`ลบจุดพิกัด "${loc.name}" หรือไม่?\nพนักงานที่ผูกกับจุดนี้จะกลับไปใช้จุดที่ใกล้ที่สุดแทน`)) return
    try {
      await deleteClockLocation(loc.id)
      setMessage({ type: 'success', text: 'ลบจุดพิกัดสำเร็จ' })
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'ลบไม่สำเร็จ: ' + e.message })
    }
  }

  // ─── มาตรฐานเวลาทำงาน ───────────────────────────────────────────────────────

  function openCreateSched() {
    setEditingSchedId(null)
    setSchedForm({ ...EMPTY_SCHED_FORM, is_default: schedules.length === 0 })
    setShowSchedForm(true)
  }

  function openEditSched(s: HRWorkSchedule) {
    setEditingSchedId(s.id)
    setSchedForm({
      name: s.name,
      work_start: s.work_start.slice(0, 5),
      work_end: s.work_end.slice(0, 5),
      late_grace_min: String(s.late_grace_min),
      work_days: parseWorkDays(s.work_days),
      is_default: s.is_default,
    })
    setShowSchedForm(true)
  }

  async function handleSaveSchedule() {
    const grace = parseInt(schedForm.late_grace_min, 10)
    if (!schedForm.name.trim()) return setMessage({ type: 'error', text: 'กรุณาตั้งชื่อมาตรฐานเวลา' })
    if (schedForm.work_days.length === 0) return setMessage({ type: 'error', text: 'เลือกวันทำงานอย่างน้อย 1 วัน' })
    if (isNaN(grace) || grace < 0) return setMessage({ type: 'error', text: 'นาทีผ่อนผันไม่ถูกต้อง' })

    setSaving(true)
    try {
      await upsertWorkSchedule({
        ...(editingSchedId ? { id: editingSchedId } : {}),
        name: schedForm.name.trim(),
        work_start: schedForm.work_start,
        work_end: schedForm.work_end,
        late_grace_min: grace,
        work_days: [...schedForm.work_days].sort((a, b) => a - b).join(','),
        is_default: schedForm.is_default,
      })
      setMessage({ type: 'success', text: editingSchedId ? 'แก้ไขมาตรฐานเวลาสำเร็จ' : 'เพิ่มมาตรฐานเวลาสำเร็จ' })
      setShowSchedForm(false)
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleSchedActive(s: HRWorkSchedule) {
    try {
      await upsertWorkSchedule({ id: s.id, is_active: !s.is_active })
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    }
  }

  async function handleSetDefaultSched(s: HRWorkSchedule) {
    try {
      await upsertWorkSchedule({ id: s.id, is_default: true })
      setMessage({ type: 'success', text: `ตั้ง "${s.name}" เป็นค่าเริ่มต้นแล้ว` })
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    }
  }

  async function handleDeleteSched(s: HRWorkSchedule) {
    if (s.is_default) {
      setMessage({ type: 'error', text: 'ลบชุดค่าเริ่มต้นไม่ได้ — ตั้งชุดอื่นเป็นค่าเริ่มต้นก่อน' })
      return
    }
    if (!window.confirm(`ลบมาตรฐานเวลา "${s.name}" หรือไม่?\nพนักงานที่ผูกกับชุดนี้จะกลับไปใช้ชุดค่าเริ่มต้นแทน`)) return
    try {
      await deleteWorkSchedule(s.id)
      setMessage({ type: 'success', text: 'ลบมาตรฐานเวลาสำเร็จ' })
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'ลบไม่สำเร็จ: ' + e.message })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    )
  }

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

  return (
    <div className="space-y-6">
      {message && (
        <div className={`p-3 rounded-lg text-sm font-medium ${
          message.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      {/* จุดพิกัดออฟฟิศ */}
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <FiMapPin className="text-blue-600" /> จุดพิกัดออฟฟิศ
          </h2>
          {canEdit && (
            <button
              type="button"
              onClick={openCreate}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition"
            >
              <FiPlus /> เพิ่มจุดพิกัด
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500 mb-4">
          พนักงานต้องอยู่ในรัศมีของจุดพิกัดจึงจะบันทึกเวลาเข้า-ออกงานได้ — กำหนดจุดประจำตัวพนักงานได้ที่ทะเบียนพนักงาน (แท็บข้อมูลการทำงาน)
        </p>

        {locations.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            ยังไม่มีจุดพิกัด — เพิ่มจุดแรกเพื่อเปิดใช้การบันทึกเวลาด้วย GPS
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">ชื่อออฟฟิศ</th>
                  <th className="p-3 text-left font-semibold">พิกัด (Lat, Lng)</th>
                  <th className="p-3 text-center font-semibold">รัศมี (ม.)</th>
                  <th className="p-3 text-center font-semibold">ใช้งาน</th>
                  <th className="p-3 text-center font-semibold rounded-tr-xl">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((loc, idx) => (
                  <tr key={loc.id} className={`border-t border-surface-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} ${!loc.is_active ? 'opacity-50' : ''}`}>
                    <td className="p-3 font-medium">{loc.name}</td>
                    <td className="p-3 text-sm text-gray-600">
                      <a
                        href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                        title="เปิดใน Google Maps"
                      >
                        {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)}
                      </a>
                    </td>
                    <td className="p-3 text-center">{loc.radius_m}</td>
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => canEdit && handleToggleActive(loc)}
                        disabled={!canEdit}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed ${
                          loc.is_active ? 'bg-green-500' : 'bg-gray-300'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${loc.is_active ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </td>
                    <td className="p-3 text-center">
                      {canEdit && (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(loc)}
                            className="p-1.5 rounded-lg text-blue-500 hover:bg-blue-50"
                            title="แก้ไข"
                          >
                            <FiEdit2 />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(loc)}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"
                            title="ลบ"
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ฟอร์มเพิ่ม/แก้ไขจุดพิกัด */}
        {showForm && canEdit && (
          <div className="mt-4 p-4 border border-blue-200 bg-blue-50/50 rounded-xl space-y-3">
            <h3 className="font-semibold text-gray-700">{editingId ? 'แก้ไขจุดพิกัด' : 'เพิ่มจุดพิกัดใหม่'}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-600 mb-1">ชื่อออฟฟิศ</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="เช่น สำนักงานใหญ่, โกดัง 2"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Latitude</label>
                <input
                  type="number"
                  step="any"
                  value={form.lat}
                  onChange={(e) => setForm({ ...form, lat: e.target.value })}
                  placeholder="13.7563309"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Longitude</label>
                <input
                  type="number"
                  step="any"
                  value={form.lng}
                  onChange={(e) => setForm({ ...form, lng: e.target.value })}
                  placeholder="100.5017651"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">รัศมีที่อนุญาต (เมตร)</label>
                <input
                  type="number"
                  min={10}
                  value={form.radius_m}
                  onChange={(e) => setForm({ ...form, radius_m: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={useCurrentPosition}
                  disabled={gettingGps}
                  className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                >
                  <FiCrosshair /> {gettingGps ? 'กำลังอ่านพิกัด...' : 'ใช้พิกัดปัจจุบัน'}
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleSaveLocation}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* มาตรฐานเวลาทำงาน (หลายชุด) */}
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <FiClock className="text-blue-600" /> เวลาทำงานมาตรฐาน
          </h2>
          {canEdit && (
            <button
              type="button"
              onClick={openCreateSched}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition"
            >
              <FiPlus /> เพิ่มมาตรฐานเวลา
            </button>
          )}
        </div>
        <p className="text-sm text-gray-500 mb-4">
          สร้างได้หลายชุดสำหรับตำแหน่ง/กะที่เข้า-ออกงานไม่เหมือนกัน — กำหนดชุดประจำตัวพนักงานได้ที่ทะเบียนพนักงาน (แท็บข้อมูลการทำงาน)
          พนักงานที่ยังไม่ได้กำหนดจะใช้ชุด <span className="font-medium">ค่าเริ่มต้น</span>
        </p>

        {schedules.length === 0 ? (
          <div className="text-center py-10 text-gray-400">ยังไม่มีมาตรฐานเวลา — เพิ่มชุดแรกเพื่อใช้คำนวณสาย/ขาดงาน</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">ชื่อชุด</th>
                  <th className="p-3 text-center font-semibold">วันทำงาน</th>
                  <th className="p-3 text-center font-semibold">เวลาเข้า–เลิก</th>
                  <th className="p-3 text-center font-semibold">ผ่อนผันสาย (นาที)</th>
                  <th className="p-3 text-center font-semibold">ค่าเริ่มต้น</th>
                  <th className="p-3 text-center font-semibold">ใช้งาน</th>
                  <th className="p-3 text-center font-semibold rounded-tr-xl">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s, idx) => (
                  <tr key={s.id} className={`border-t border-surface-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} ${!s.is_active ? 'opacity-50' : ''}`}>
                    <td className="p-3 font-medium">{s.name}</td>
                    <td className="p-3 text-center text-sm text-gray-600">{workDaysLabel(s.work_days)}</td>
                    <td className="p-3 text-center">
                      {s.work_start.slice(0, 5)}–{s.work_end.slice(0, 5)} น.
                    </td>
                    <td className="p-3 text-center">{s.late_grace_min}</td>
                    <td className="p-3 text-center">
                      {s.is_default ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
                          <FiStar className="w-3 h-3" /> ค่าเริ่มต้น
                        </span>
                      ) : canEdit ? (
                        <button
                          type="button"
                          onClick={() => handleSetDefaultSched(s)}
                          className="text-xs text-gray-400 hover:text-amber-600 underline"
                          title="ตั้งชุดนี้เป็นค่าเริ่มต้น"
                        >
                          ตั้งเป็นค่าเริ่มต้น
                        </button>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => canEdit && handleToggleSchedActive(s)}
                        disabled={!canEdit}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed ${
                          s.is_active ? 'bg-green-500' : 'bg-gray-300'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${s.is_active ? 'translate-x-5' : 'translate-x-0'}`} />
                      </button>
                    </td>
                    <td className="p-3 text-center">
                      {canEdit && (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditSched(s)}
                            className="p-1.5 rounded-lg text-blue-500 hover:bg-blue-50"
                            title="แก้ไข"
                          >
                            <FiEdit2 />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSched(s)}
                            disabled={s.is_default}
                            className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={s.is_default ? 'ลบชุดค่าเริ่มต้นไม่ได้' : 'ลบ'}
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ฟอร์มเพิ่ม/แก้ไขมาตรฐานเวลา */}
        {showSchedForm && canEdit && (
          <div className="mt-4 p-4 border border-blue-200 bg-blue-50/50 rounded-xl space-y-3">
            <h3 className="font-semibold text-gray-700">{editingSchedId ? 'แก้ไขมาตรฐานเวลา' : 'เพิ่มมาตรฐานเวลาใหม่'}</h3>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-1">ชื่อชุด</label>
              <input
                type="text"
                value={schedForm.name}
                onChange={(e) => setSchedForm({ ...schedForm, name: e.target.value })}
                placeholder="เช่น ออฟฟิศ จ.-ศ., ฝ่ายผลิตกะเช้า"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-600 mb-2">วันทำงานต่อสัปดาห์</label>
              <div className="flex flex-wrap gap-2">
                {DAY_OPTIONS.map(([d, label]) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() =>
                      setSchedForm((f) => ({
                        ...f,
                        work_days: f.work_days.includes(d)
                          ? f.work_days.filter((x) => x !== d)
                          : [...f.work_days, d],
                      }))
                    }
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                      schedForm.work_days.includes(d)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">เวลาเข้างาน</label>
                <input
                  type="time"
                  value={schedForm.work_start}
                  onChange={(e) => setSchedForm({ ...schedForm, work_start: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">เวลาเลิกงาน</label>
                <input
                  type="time"
                  value={schedForm.work_end}
                  onChange={(e) => setSchedForm({ ...schedForm, work_end: e.target.value })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">ผ่อนผันสาย (นาที)</label>
                <input
                  type="number"
                  min={0}
                  value={schedForm.late_grace_min}
                  onChange={(e) => setSchedForm({ ...schedForm, late_grace_min: e.target.value })}
                  className={inputClass}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={schedForm.is_default}
                onChange={(e) => setSchedForm({ ...schedForm, is_default: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300"
              />
              ตั้งเป็นค่าเริ่มต้น (ใช้กับพนักงานที่ยังไม่ได้กำหนดมาตรฐานเวลา)
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowSchedForm(false)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleSaveSchedule}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
