import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FiAlertTriangle, FiClock } from 'react-icons/fi'
import ModalCloseButton from '../ui/ModalCloseButton'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchCompanyHolidays,
  fetchEmployeeByUserId,
  fetchLeaveRequests,
  fetchTimeEntries,
  fetchWorkCalendar,
  fetchWorkSchedules,
  resolveEmployeeDayType,
} from '../../lib/hrApi'
import { localISODate } from '../../lib/localDate'
import {
  MISSED_CLOCK_IN_SHOWN_KEY,
  coversDate,
  formatLateDuration,
  minutesPastWorkStart,
  shouldWarnMissedClockIn,
} from '../../lib/missedClockIn'
import { sessionDayKey } from '../../lib/dailySession'

/**
 * Popup "ลืมบันทึกเวลาเข้างาน" — เด้งครั้งเดียวทันทีที่ login
 * เงื่อนไข: วันนี้เป็นวันทำงานของพนักงานคนนั้น, เลยเวลาเข้างานมาแล้ว และยังไม่มีบันทึกเข้างาน
 */
export default function MissedClockInAlert() {
  const { user } = useAuthContext()
  const location = useLocation()
  const navigate = useNavigate()
  const [state, setState] = useState<{ workStart: string; lateMinutes: number } | null>(null)
  const checkedRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  const canOpenTimeClock = user?.role === 'employee' || user?.employee_access === true

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!user?.id) return
    // หน้า reset password ไม่ควรมี popup อื่นบัง
    if (location.pathname === '/reset-password') return

    const shownKey = `${user.id}:${sessionDayKey()}`
    // เช็คครั้งเดียวต่อการ login — ไม่ยิงซ้ำตอนเปลี่ยนหน้า/รีเฟรช
    if (checkedRef.current === shownKey) return
    try {
      if (sessionStorage.getItem(MISSED_CLOCK_IN_SHOWN_KEY) === shownKey) {
        checkedRef.current = shownKey
        return
      }
    } catch {
      /* storage ไม่พร้อมใช้งาน — เตือนตามปกติ */
    }
    checkedRef.current = shownKey

    const today = localISODate()

    const markChecked = () => {
      try {
        sessionStorage.setItem(MISSED_CLOCK_IN_SHOWN_KEY, shownKey)
      } catch {
        /* storage ไม่พร้อมใช้งาน — ข้าม */
      }
    }

    ;(async () => {
      const employee = await fetchEmployeeByUserId(user.id)
      // บัญชีที่ไม่ได้ผูกกับทะเบียนพนักงาน หรือพ้นสภาพแล้ว ไม่ต้องเตือน
      if (!employee || employee.employment_status === 'resigned' || employee.employment_status === 'terminated') {
        markChecked()
        return
      }

      // พนักงานรูปแบบ no_clock ไม่ต้องถูกตรวจหรือแจ้งเตือนเรื่องการลงเวลา
      if (employee.work_mode === 'no_clock') {
        markChecked()
        return
      }

      const [schedules, overrides, holidays, clockIns, leaves] = await Promise.all([
        fetchWorkSchedules(true),
        fetchWorkCalendar(today, today, [employee.id]),
        fetchCompanyHolidays(today, today),
        fetchTimeEntries({ employee_id: employee.id, date_from: today, date_to: today, entry_type: 'clock_in' }),
        fetchLeaveRequests({ employee_id: employee.id, status: 'approved' }).catch(() => []),
      ])
      if (!mountedRef.current) return

      const override = overrides[0]
      // มาตรฐานเวลาที่ใช้: ชุดที่ override ระบุไว้ → ชุดประจำตัว → ชุดค่าเริ่มต้น
      const schedule =
        (override?.work_schedule_id ? schedules.find((s) => s.id === override.work_schedule_id) : undefined) ??
        (employee.work_schedule_id ? schedules.find((s) => s.id === employee.work_schedule_id) : undefined) ??
        schedules.find((s) => s.is_default) ??
        schedules[0]
      if (!schedule) {
        markChecked()
        return
      }

      const workStart = override?.work_start ?? schedule.work_start
      const now = new Date()
      const warn = shouldWarnMissedClockIn({
        now,
        dayType: resolveEmployeeDayType(today, schedule, override, holidays[0]),
        workStart,
        hasClockIn: clockIns.length > 0,
        onApprovedLeave: coversDate(leaves, today),
        requiresClockIn: true,
      })
      markChecked()
      if (!warn) return

      setState({ workStart: workStart.slice(0, 5), lateMinutes: minutesPastWorkStart(now, workStart) })
    })().catch(() => {
      // โหลดข้อมูลไม่สำเร็จ (เช่นเน็ตหลุด) — ไม่รบกวนผู้ใช้ แต่เปิดให้ลองเช็คใหม่ตอนเปลี่ยนหน้า
      checkedRef.current = null
    })
    // ไม่ยกเลิกงานที่ค้างอยู่ตอน effect รันใหม่ — SmartRedirect เปลี่ยน path ทันทีหลัง login
    // ถ้ายกเลิกตามการเปลี่ยนหน้า การเช็คจะถูกตัดกลางคันแล้วไม่ได้เตือนเลย
  }, [location.pathname, user?.id, user?.role])

  if (!state) return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="relative bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-xl">
        <ModalCloseButton onClick={() => setState(null)} className="absolute right-3 top-3 z-10" />
        <div className="flex items-center px-4 py-3 pr-16 bg-amber-500 text-white">
          <h3 className="font-semibold flex items-center gap-2">
            <FiAlertTriangle className="w-5 h-5" /> ลืมบันทึกเวลาเข้างาน
          </h3>
        </div>

        <div className="p-5 space-y-4 text-center">
          <div className="mx-auto w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center">
            <FiClock className="w-8 h-8 text-amber-600" />
          </div>
          <p className="text-gray-700 leading-relaxed">
            วันนี้ยังไม่มีการบันทึกเวลาเข้างาน
            <br />
            เลยเวลาเข้างาน <span className="font-semibold">{state.workStart} น.</span> มาแล้ว{' '}
            <span className="font-semibold text-amber-600">{formatLateDuration(state.lateMinutes)}</span>
          </p>
          <p className="text-sm text-gray-500">กรุณาบันทึกเวลาเข้างานที่เมนู "ลงเวลา"</p>

          <div className="grid gap-3 grid-cols-1">
            {canOpenTimeClock && (
              <button
                type="button"
                onClick={() => {
                  setState(null)
                  navigate('/employee?tab=timeclock')
                }}
                className="py-3 bg-amber-500 text-white rounded-xl font-semibold active:scale-95"
              >
                ไปลงเวลา
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
