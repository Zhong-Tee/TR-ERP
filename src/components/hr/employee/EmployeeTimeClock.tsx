import { useState, useEffect, useCallback, useRef } from 'react'
import { FiLogIn, FiLogOut, FiClock, FiMapPin, FiCamera, FiRefreshCw, FiX, FiPlus } from 'react-icons/fi'
import {
  fetchEmployeeByUserId,
  fetchClockLocations,
  fetchTimeEntries,
  createTimeEntry,
  uploadTimeClockPhoto,
  fetchOTRequests,
  createOTRequest,
  fetchWorkSchedules,
  haversineMeters,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import type { HREmployee, HRClockLocation, HRTimeEntry, HRTimeEntryType, HROTRequest, HRWorkSchedule } from '../../../types'

const ENTRY_LABELS: Record<HRTimeEntryType, string> = {
  clock_in: 'เข้างาน',
  clock_out: 'ออกงาน',
  ot_in: 'เข้า OT',
  ot_out: 'ออก OT',
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStr(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

/** นาที → hh:mm น. เช่น 44 → 00:44 น., 90 → 01:30 น. */
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} น.`
}

function otStatusBadge(status: string) {
  const map: Record<string, [string, string]> = {
    pending: ['bg-amber-100 text-amber-800', 'รออนุมัติ'],
    approved: ['bg-emerald-100 text-emerald-800', 'อนุมัติแล้ว'],
    rejected: ['bg-red-100 text-red-800', 'ไม่อนุมัติ'],
    cancelled: ['bg-gray-100 text-gray-600', 'ยกเลิก'],
  }
  const [cls, label] = map[status] ?? ['bg-gray-100 text-gray-600', status]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
}

type CaptureState = {
  type: HRTimeEntryType
  phase: 'gps' | 'gps-fail' | 'out-of-range' | 'camera' | 'preview' | 'submitting'
  position?: GeolocationPosition
  target?: HRClockLocation
  distance?: number
  error?: string
  photoBlob?: Blob
  photoUrl?: string
}

export default function EmployeeTimeClock() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [locations, setLocations] = useState<HRClockLocation[]>([])
  const [todayEntries, setTodayEntries] = useState<HRTimeEntry[]>([])
  const [otRequests, setOtRequests] = useState<HROTRequest[]>([])
  const [schedule, setSchedule] = useState<HRWorkSchedule | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [capture, setCapture] = useState<CaptureState | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [otFormOpen, setOtFormOpen] = useState(false)
  const [otForm, setOtForm] = useState({ request_date: todayStr(), ot_start: '17:00', ot_end: '20:00', reason: '' })
  const [otSubmitting, setOtSubmitting] = useState(false)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) return
      const today = todayStr()
      const [locs, entries, ots, scheds] = await Promise.all([
        fetchClockLocations(true),
        fetchTimeEntries({ employee_id: emp.id, date_from: today, date_to: today }),
        fetchOTRequests({ employee_id: emp.id }),
        fetchWorkSchedules(true).catch(() => [] as HRWorkSchedule[]),
      ])
      setLocations(locs)
      setTodayEntries(entries)
      setOtRequests(ots.slice(0, 10))
      // มาตรฐานเวลาของพนักงาน: ชุดประจำตัว ถ้าไม่ได้กำหนด → ชุดค่าเริ่มต้น
      const mySched =
        (emp.work_schedule_id ? scheds.find((s) => s.id === emp.work_schedule_id) : undefined) ??
        scheds.find((s) => s.is_default) ??
        scheds[0] ??
        null
      setSchedule(mySched)
    } catch (e: any) {
      setMessage({ type: 'error', text: 'โหลดข้อมูลไม่สำเร็จ: ' + e.message })
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(t)
  }, [message])

  // ปิดกล้องเมื่อ modal ปิดหรือ component ถูกถอด
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => () => stopCamera(), [stopCamera])

  const hasEntry = (type: HRTimeEntryType) => todayEntries.some((e) => e.entry_type === type)
  const approvedOtToday = otRequests.some((r) => r.status === 'approved' && r.request_date === todayStr())

  /** นาทีที่สายเกินผ่อนผัน (เฉพาะเข้างานปกติ) — 0 = ไม่สาย */
  const lateMinutes = (entry: HRTimeEntry): number => {
    if (entry.entry_type !== 'clock_in' || !schedule) return 0
    const [h, m] = schedule.work_start.slice(0, 5).split(':').map(Number)
    const startMin = h * 60 + (m || 0) + (schedule.late_grace_min ?? 0)
    const d = new Date(entry.entry_time)
    return Math.max(0, d.getHours() * 60 + d.getMinutes() - startMin)
  }

  // ─── ขั้นตอนบันทึกเวลา: GPS → ตรวจระยะ → กล้อง → ยืนยัน ─────────────────────

  function startCapture(type: HRTimeEntryType) {
    if (!employee) return
    if (locations.length === 0) {
      setMessage({ type: 'error', text: 'ยังไม่มีการตั้งค่าจุดพิกัดบริษัท กรุณาติดต่อผู้ดูแลระบบ' })
      return
    }
    setCapture({ type, phase: 'gps' })
    requestGps(type)
  }

  function requestGps(type: HRTimeEntryType) {
    if (!navigator.geolocation) {
      setCapture({ type, phase: 'gps-fail', error: 'เบราว์เซอร์นี้ไม่รองรับ GPS' })
      return
    }

    const handleSuccess = (pos: GeolocationPosition) => {
      // จุดที่ใช้ตรวจ: จุดประจำตัวพนักงาน ถ้าไม่ได้กำหนด → จุด active ที่ใกล้ที่สุด
      const assigned = employee?.clock_location_id
        ? locations.find((l) => l.id === employee.clock_location_id)
        : undefined
      let target = assigned
      let distance = Infinity
      if (target) {
        distance = haversineMeters(pos.coords.latitude, pos.coords.longitude, target.lat, target.lng)
      } else {
        for (const loc of locations) {
          const d = haversineMeters(pos.coords.latitude, pos.coords.longitude, loc.lat, loc.lng)
          if (d < distance) {
            distance = d
            target = loc
          }
        }
      }
      if (!target) {
        setCapture({ type, phase: 'gps-fail', error: 'ไม่พบจุดพิกัดที่ใช้งานได้' })
        return
      }
      if (distance > target.radius_m) {
        setCapture({ type, phase: 'out-of-range', position: pos, target, distance })
        return
      }
      setCapture({ type, phase: 'camera', position: pos, target, distance })
      startCamera()
    }

    const fail = (err: GeolocationPositionError) => {
      setCapture({
        type,
        phase: 'gps-fail',
        error:
          err.code === err.PERMISSION_DENIED
            ? 'ไม่ได้รับอนุญาตให้เข้าถึงตำแหน่ง กรุณาเปิดการอนุญาตตำแหน่ง (Location) ให้เบราว์เซอร์'
            : err.code === err.TIMEOUT
              ? 'อ่านพิกัด GPS ไม่ทัน ลองอีกครั้ง หรือออกไปที่โล่ง/ใกล้หน้าต่างเพื่อให้สัญญาณดีขึ้น'
              : 'อ่านพิกัด GPS ไม่สำเร็จ: ' + err.message,
      })
    }

    // ชั้นที่ 1: ความแม่นยำสูง (ดาวเทียม) ยอมใช้ค่าที่อ่านไว้ล่าสุดภายใน 1 นาที
    navigator.geolocation.getCurrentPosition(
      handleSuccess,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          fail(err)
          return
        }
        // ชั้นที่ 2 (fallback): ความแม่นยำต่ำจาก Wi-Fi/เสาสัญญาณ — เร็วกว่า ใช้ได้ในอาคาร
        navigator.geolocation.getCurrentPosition(
          handleSuccess,
          fail,
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
        )
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    )
  }

  async function startCamera() {
    try {
      // getUserMedia = ภาพสดจากกล้องเท่านั้น เลือกรูปจากแกลเลอรีไม่ได้
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }
    } catch (e: any) {
      setCapture((c) =>
        c
          ? {
              ...c,
              phase: 'gps-fail',
              error:
                e?.name === 'NotAllowedError'
                  ? 'ไม่ได้รับอนุญาตให้เข้าถึงกล้อง กรุณาเปิดการอนุญาตกล้องให้เบราว์เซอร์'
                  : 'เปิดกล้องไม่สำเร็จ: ' + (e?.message ?? e),
            }
          : c,
      )
    }
  }

  function takePhoto() {
    const video = videoRef.current
    if (!video || !capture) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        stopCamera()
        setCapture((c) => (c ? { ...c, phase: 'preview', photoBlob: blob, photoUrl: URL.createObjectURL(blob) } : c))
      },
      'image/jpeg',
      0.85,
    )
  }

  function retakePhoto() {
    setCapture((c) => {
      if (c?.photoUrl) URL.revokeObjectURL(c.photoUrl)
      return c ? { ...c, phase: 'camera', photoBlob: undefined, photoUrl: undefined } : c
    })
    startCamera()
  }

  function closeCapture() {
    stopCamera()
    if (capture?.photoUrl) URL.revokeObjectURL(capture.photoUrl)
    setCapture(null)
  }

  async function submitEntry() {
    if (!capture || !employee || !capture.photoBlob || !capture.position || !capture.target) return
    setCapture((c) => (c ? { ...c, phase: 'submitting' } : c))
    try {
      const photoPath = await uploadTimeClockPhoto(employee.id, capture.photoBlob)
      const created = await createTimeEntry({
        employee_id: employee.id,
        entry_type: capture.type,
        lat: capture.position.coords.latitude,
        lng: capture.position.coords.longitude,
        accuracy_m: Math.round(capture.position.coords.accuracy * 10) / 10,
        distance_m: Math.round((capture.distance ?? 0) * 10) / 10,
        location_id: capture.target.id,
        location_name: capture.target.name,
        photo_url: photoPath,
      })
      // แจ้งเตือน Telegram เข้ากลุ่ม Manager — ไม่ block การบันทึก ถ้าส่งไม่สำเร็จก็ไม่กระทบพนักงาน
      supabase.functions.invoke('hr-clock-notify', { body: { entry_id: created.id } }).catch(() => {})
      setMessage({ type: 'success', text: `บันทึก${ENTRY_LABELS[capture.type]}สำเร็จ (${capture.target.name})` })
      closeCapture()
      load()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
      setCapture((c) => (c ? { ...c, phase: 'preview' } : c))
    }
  }

  // ─── ขอ OT ───────────────────────────────────────────────────────────────

  function otHours(start: string, end: string): number {
    const [sh, sm] = start.split(':').map(Number)
    const [eh, em] = end.split(':').map(Number)
    let mins = eh * 60 + em - (sh * 60 + sm)
    if (mins < 0) mins += 24 * 60 // ข้ามเที่ยงคืน
    return Math.round((mins / 60) * 100) / 100
  }

  async function submitOtRequest() {
    if (!employee) return
    if (!otForm.request_date || !otForm.ot_start || !otForm.ot_end) {
      setMessage({ type: 'error', text: 'กรุณากรอกวันที่และช่วงเวลา OT' })
      return
    }
    setOtSubmitting(true)
    try {
      const createdOt = await createOTRequest({
        employee_id: employee.id,
        request_date: otForm.request_date,
        ot_start: otForm.ot_start,
        ot_end: otForm.ot_end,
        hours: otHours(otForm.ot_start, otForm.ot_end),
        reason: otForm.reason || undefined,
      })
      // แจ้งคำขอ OT ใหม่เข้ากลุ่ม Manager (fire-and-forget)
      supabase.functions.invoke('hr-ot-notify', { body: { ot_id: createdOt.id } }).catch(() => {})
      setMessage({ type: 'success', text: 'ส่งคำขอ OT แล้ว รอการอนุมัติ' })
      setOtFormOpen(false)
      setOtForm({ request_date: todayStr(), ot_start: '17:00', ot_end: '20:00', reason: '' })
      load()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'ส่งคำขอไม่สำเร็จ: ' + e.message })
    } finally {
      setOtSubmitting(false)
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 text-center text-amber-800">
        บัญชีของคุณยังไม่ถูกผูกกับทะเบียนพนักงาน กรุณาติดต่อ HR
      </div>
    )
  }

  const clockInDone = hasEntry('clock_in')
  const clockOutDone = hasEntry('clock_out')
  const otInDone = hasEntry('ot_in')
  const otOutDone = hasEntry('ot_out')

  return (
    <div className="space-y-5">
      {message && (
        <div className={`p-3 rounded-xl text-sm font-medium ${
          message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      {/* ปุ่มเข้า/ออกงาน */}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => startCapture('clock_in')}
          disabled={clockInDone}
          className={`flex flex-col items-center gap-2 py-6 rounded-2xl shadow-sm font-semibold transition ${
            clockInDone
              ? 'bg-gray-100 text-gray-400'
              : 'bg-emerald-600 text-white active:scale-95'
          }`}
        >
          <FiLogIn className="w-8 h-8" />
          {clockInDone ? 'เข้างานแล้ว' : 'เข้างาน'}
          {clockInDone && (
            <span className="text-xs font-normal">
              {timeStr(todayEntries.find((e) => e.entry_type === 'clock_in')!.entry_time)}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => startCapture('clock_out')}
          disabled={!clockInDone || clockOutDone}
          className={`flex flex-col items-center gap-2 py-6 rounded-2xl shadow-sm font-semibold transition ${
            !clockInDone || clockOutDone
              ? 'bg-gray-100 text-gray-400'
              : 'bg-rose-600 text-white active:scale-95'
          }`}
        >
          <FiLogOut className="w-8 h-8" />
          {clockOutDone ? 'ออกงานแล้ว' : 'ออกงาน'}
          {clockOutDone && (
            <span className="text-xs font-normal">
              {timeStr(todayEntries.find((e) => e.entry_type === 'clock_out')!.entry_time)}
            </span>
          )}
        </button>
      </div>

      {/* OT */}
      <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <FiClock className="text-emerald-600" /> โอที (OT)
          </h2>
          <button
            type="button"
            onClick={() => setOtFormOpen(true)}
            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-lg active:scale-95"
          >
            <FiPlus /> ขอ OT
          </button>
        </div>

        {approvedOtToday ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => startCapture('ot_in')}
              disabled={otInDone}
              className={`flex items-center justify-center gap-2 py-3 rounded-xl font-semibold ${
                otInDone ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 text-white active:scale-95'
              }`}
            >
              <FiLogIn /> {otInDone ? 'เข้า OT แล้ว' : 'เข้า OT'}
            </button>
            <button
              type="button"
              onClick={() => startCapture('ot_out')}
              disabled={!otInDone || otOutDone}
              className={`flex items-center justify-center gap-2 py-3 rounded-xl font-semibold ${
                !otInDone || otOutDone ? 'bg-gray-100 text-gray-400' : 'bg-indigo-600 text-white active:scale-95'
              }`}
            >
              <FiLogOut /> {otOutDone ? 'ออก OT แล้ว' : 'ออก OT'}
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            ปุ่มเข้า/ออก OT จะเปิดเมื่อคำขอ OT ของวันนี้ได้รับการอนุมัติ
          </p>
        )}

        {otRequests.length > 0 && (
          <div className="space-y-2 pt-1">
            {otRequests.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border-t border-gray-100 pt-2">
                <div>
                  <div className="font-medium text-gray-700">
                    {new Date(r.request_date + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}{' '}
                    {r.ot_start.slice(0, 5)}–{r.ot_end.slice(0, 5)} ({r.hours ?? '-'} ชม.)
                  </div>
                  {r.reject_reason && <div className="text-xs text-red-500">{r.reject_reason}</div>}
                </div>
                {otStatusBadge(r.status)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* บันทึกวันนี้ */}
      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h2 className="font-semibold text-gray-800 mb-3">บันทึกวันนี้</h2>
        {todayEntries.length === 0 ? (
          <p className="text-sm text-gray-400">ยังไม่มีการบันทึกเวลา</p>
        ) : (
          <>
            <div className="flex items-center text-[11px] text-gray-400 font-medium px-0.5 pb-1.5 border-b border-gray-100">
              <span className="w-20">ประเภท</span>
              <span className="flex-1">จุดบันทึก</span>
              <span className="w-[72px] text-center">สาย</span>
              <span className="w-12 text-right">เวลา</span>
            </div>
            <div className="space-y-2 mt-2">
              {[...todayEntries].reverse().map((e) => {
                const lm = lateMinutes(e)
                return (
                  <div key={e.id} className="flex items-center text-sm">
                    <span className="w-20 font-medium text-gray-700">{ENTRY_LABELS[e.entry_type]}</span>
                    <span className="flex-1 text-gray-500 flex items-center gap-1 min-w-0">
                      <FiMapPin className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{e.location_name ?? '-'}</span>
                    </span>
                    <span className="w-[72px] text-center">
                      {e.entry_type === 'clock_in'
                        ? lm > 0
                          ? <span className="text-red-600 font-semibold">{minutesToHHMM(lm)}</span>
                          : <span className="text-emerald-600 text-xs">ตรงเวลา</span>
                        : <span className="text-gray-300">-</span>}
                    </span>
                    <span className="w-12 text-right font-semibold text-gray-800">{timeStr(e.entry_time)}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Modal ขั้นตอนถ่ายรูป/GPS */}
      {capture && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-emerald-600 text-white">
              <h3 className="font-semibold">{ENTRY_LABELS[capture.type]}</h3>
              <button type="button" onClick={closeCapture} aria-label="ปิด">
                <FiX className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {capture.phase === 'gps' && (
                <div className="text-center py-8 space-y-3">
                  <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600 mx-auto" />
                  <p className="text-gray-600">กำลังตรวจตำแหน่ง GPS...</p>
                </div>
              )}

              {capture.phase === 'gps-fail' && (
                <div className="text-center py-6 space-y-4">
                  <p className="text-red-600">{capture.error}</p>
                  <button
                    type="button"
                    onClick={() => requestGps(capture.type)}
                    className="flex items-center gap-2 mx-auto px-4 py-2 bg-emerald-600 text-white rounded-xl font-medium"
                  >
                    <FiRefreshCw /> ลองใหม่
                  </button>
                </div>
              )}

              {capture.phase === 'out-of-range' && capture.target && (
                <div className="text-center py-6 space-y-4">
                  <FiMapPin className="w-10 h-10 text-red-500 mx-auto" />
                  <p className="text-red-600 font-semibold">อยู่นอกพื้นที่บริษัท</p>
                  <p className="text-gray-600 text-sm">
                    ห่างจาก "{capture.target.name}" ประมาณ{' '}
                    <span className="font-semibold">{Math.round(capture.distance ?? 0).toLocaleString()} เมตร</span>
                    <br />
                    (อนุญาตไม่เกิน {capture.target.radius_m} เมตร)
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setCapture((c) => (c ? { ...c, phase: 'gps' } : c))
                      requestGps(capture.type)
                    }}
                    className="flex items-center gap-2 mx-auto px-4 py-2 bg-emerald-600 text-white rounded-xl font-medium"
                  >
                    <FiRefreshCw /> ตรวจตำแหน่งอีกครั้ง
                  </button>
                </div>
              )}

              {(capture.phase === 'camera' || capture.phase === 'preview' || capture.phase === 'submitting') && capture.target && (
                <>
                  <div className="flex items-center justify-center gap-1.5 text-sm text-emerald-700 bg-emerald-50 rounded-lg py-2">
                    <FiMapPin />
                    {capture.target.name} — ห่าง {Math.round(capture.distance ?? 0)} ม.
                  </div>

                  {capture.phase === 'camera' && (
                    <>
                      <div className="rounded-xl overflow-hidden bg-black aspect-[3/4]">
                        {/* วิดีโอสดจากกล้องเท่านั้น — ไม่มีตัวเลือกรูปจากเครื่อง */}
                        <video ref={videoRef} playsInline muted autoPlay className="w-full h-full object-cover" />
                      </div>
                      <button
                        type="button"
                        onClick={takePhoto}
                        className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 text-white rounded-xl font-semibold active:scale-95"
                      >
                        <FiCamera className="w-5 h-5" /> ถ่ายรูป
                      </button>
                    </>
                  )}

                  {(capture.phase === 'preview' || capture.phase === 'submitting') && capture.photoUrl && (
                    <>
                      <div className="rounded-xl overflow-hidden bg-black aspect-[3/4]">
                        <img src={capture.photoUrl} alt="รูปถ่ายยืนยัน" className="w-full h-full object-cover" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={retakePhoto}
                          disabled={capture.phase === 'submitting'}
                          className="py-3 bg-gray-200 text-gray-700 rounded-xl font-semibold disabled:opacity-50"
                        >
                          ถ่ายใหม่
                        </button>
                        <button
                          type="button"
                          onClick={submitEntry}
                          disabled={capture.phase === 'submitting'}
                          className="py-3 bg-emerald-600 text-white rounded-xl font-semibold disabled:opacity-50"
                        >
                          {capture.phase === 'submitting' ? 'กำลังบันทึก...' : `ยืนยัน${ENTRY_LABELS[capture.type]}`}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal ขอ OT */}
      {otFormOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-emerald-600 text-white">
              <h3 className="font-semibold">ขอ OT</h3>
              <button type="button" onClick={() => setOtFormOpen(false)} aria-label="ปิด">
                <FiX className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <label className="block">
                <span className="block text-sm font-medium text-gray-600 mb-1">วันที่ทำ OT</span>
                <input
                  type="date"
                  value={otForm.request_date}
                  onChange={(e) => setOtForm({ ...otForm, request_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-sm font-medium text-gray-600 mb-1">เริ่ม</span>
                  <input
                    type="time"
                    value={otForm.ot_start}
                    onChange={(e) => setOtForm({ ...otForm, ot_start: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
                <label className="block">
                  <span className="block text-sm font-medium text-gray-600 mb-1">สิ้นสุด</span>
                  <input
                    type="time"
                    value={otForm.ot_end}
                    onChange={(e) => setOtForm({ ...otForm, ot_end: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  />
                </label>
              </div>
              <p className="text-sm text-gray-500">รวม {otHours(otForm.ot_start, otForm.ot_end)} ชั่วโมง</p>
              <label className="block">
                <span className="block text-sm font-medium text-gray-600 mb-1">เหตุผล</span>
                <textarea
                  value={otForm.reason}
                  onChange={(e) => setOtForm({ ...otForm, reason: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="เช่น เร่งงานผลิตให้ทันส่งมอบ"
                />
              </label>
              <button
                type="button"
                onClick={submitOtRequest}
                disabled={otSubmitting}
                className="w-full py-3 bg-emerald-600 text-white rounded-xl font-semibold disabled:opacity-50"
              >
                {otSubmitting ? 'กำลังส่ง...' : 'ส่งคำขอ OT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
