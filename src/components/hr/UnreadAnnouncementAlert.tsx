import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { FiArrowDown, FiBell, FiCheck, FiStar, FiX } from 'react-icons/fi'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  ANNOUNCEMENT_BUCKET,
  acknowledgeAnnouncement,
  fetchAnnouncements,
  fetchEmployeeByUserId,
  fetchMyAnnouncementReads,
} from '../../lib/hrApi'
import { ANNOUNCEMENT_ALERT_SHOWN_KEY, pickUnacknowledged } from '../../lib/announcementAlert'
import { sessionDayKey } from '../../lib/dailySession'
import { AttachmentStrip } from './employee/AttachmentViewer'
import type { HRAnnouncement } from '../../types'

const thaiDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'

/**
 * Popup "ประกาศที่ยังไม่รับทราบ" — เด้งทันทีที่ login ทั้ง PC และมือถือ
 * เงื่อนไข: บัญชีผูกกับทะเบียนพนักงาน และมีประกาศที่เผยแพร่แล้วแต่ยังไม่กดรับทราบ
 * กดรับทราบทีละฉบับ (ต้องเลื่อนอ่านถึงล่างสุดก่อน เหมือนหน้าเอกสาร → ประกาศ)
 * ปิดไปก่อนได้ แล้วจะเด้งใหม่ใน login ครั้งถัดไปจนกว่าจะกดรับทราบครบ
 */
export default function UnreadAnnouncementAlert() {
  const { user } = useAuthContext()
  const location = useLocation()
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [queue, setQueue] = useState<HRAnnouncement[]>([])
  const [index, setIndex] = useState(0)
  const [acting, setActing] = useState(false)
  /** เลื่อนอ่านถึงล่างสุดแล้วหรือยัง — ต้องถึงล่างสุดจึงกดรับทราบได้ */
  const [scrolledToEnd, setScrolledToEnd] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const checkedRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

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
      if (sessionStorage.getItem(ANNOUNCEMENT_ALERT_SHOWN_KEY) === shownKey) {
        checkedRef.current = shownKey
        return
      }
    } catch {
      /* storage ไม่พร้อมใช้งาน — เตือนตามปกติ */
    }
    checkedRef.current = shownKey

    const markChecked = () => {
      try {
        sessionStorage.setItem(ANNOUNCEMENT_ALERT_SHOWN_KEY, shownKey)
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
      const [list, reads] = await Promise.all([
        fetchAnnouncements(),
        fetchMyAnnouncementReads(employee.id),
      ])
      if (!mountedRef.current) return
      markChecked()
      const pending = pickUnacknowledged(list, new Set(reads))
      if (pending.length === 0) return
      setEmployeeId(employee.id)
      setQueue(pending)
      setIndex(0)
    })().catch(() => {
      // โหลดข้อมูลไม่สำเร็จ (เช่นเน็ตหลุด) — ไม่รบกวนผู้ใช้ แต่เปิดให้ลองเช็คใหม่ตอนเปลี่ยนหน้า
      checkedRef.current = null
    })
    // ไม่ยกเลิกงานที่ค้างอยู่ตอน effect รันใหม่ — SmartRedirect เปลี่ยน path ทันทีหลัง login
    // ถ้ายกเลิกตามการเปลี่ยนหน้า การเช็คจะถูกตัดกลางคันแล้วไม่ได้เตือนเลย
  }, [location.pathname, user?.id])

  const current = queue[index] ?? null

  // เนื้อหาสั้นกว่าหน้าจอ = ถือว่าอ่านครบแล้ว (ไม่มีอะไรให้เลื่อน)
  useEffect(() => {
    if (!current) return
    setScrolledToEnd(false)
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = 0
    const t = setTimeout(() => {
      if (el.scrollHeight <= el.clientHeight + 8) setScrolledToEnd(true)
    }, 100)
    return () => clearTimeout(t)
  }, [current])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setScrolledToEnd(true)
  }

  const close = () => {
    setQueue([])
    setIndex(0)
  }

  const handleAcknowledge = async () => {
    if (!current || !employeeId) return
    setActing(true)
    try {
      await acknowledgeAnnouncement(current.id, employeeId)
      // อัปเดต badge ประกาศใน Employee Portal ทันที
      window.dispatchEvent(new Event('hr-announcements-changed'))
      if (index + 1 >= queue.length) close()
      else setIndex((i) => i + 1)
    } catch (e) {
      console.error(e)
    } finally {
      setActing(false)
    }
  }

  if (!current) return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[85vh] sm:max-w-lg sm:rounded-2xl overflow-hidden shadow-xl flex flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 bg-emerald-600 text-white shrink-0">
          <h3 className="font-semibold flex items-center gap-2 min-w-0">
            <FiBell className="w-5 h-5 shrink-0" />
            <span className="truncate">ประกาศที่ยังไม่รับทราบ</span>
            {queue.length > 1 && (
              <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium">
                {index + 1}/{queue.length}
              </span>
            )}
          </h3>
          <button type="button" onClick={close} aria-label="ปิด" className="shrink-0 rounded-lg p-1 hover:bg-white/20">
            <FiX className="w-5 h-5" />
          </button>
        </div>

        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          <div>
            <div className="flex items-center gap-1.5">
              {current.is_pinned && <FiStar className="w-4 h-4 text-amber-500 shrink-0" />}
              <h2 className="text-lg font-bold text-gray-900">{current.title}</h2>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {current.category?.name ?? 'ไม่ระบุประเภท'} · {thaiDate(current.published_at ?? current.created_at)}
            </p>
          </div>

          <div className="rounded-xl border border-gray-200 p-4 text-sm leading-relaxed whitespace-pre-wrap">
            {current.content}
          </div>

          {current.attachment_urls?.length > 0 && (
            <AttachmentStrip
              label="ไฟล์แนบ"
              items={current.attachment_urls.map((path) => ({ bucket: ANNOUNCEMENT_BUCKET, path }))}
            />
          )}

          <p className="pt-2 pb-4 text-center text-xs text-gray-400">— จบประกาศ —</p>
        </div>

        <div className="border-t border-gray-200 bg-white p-4 shrink-0">
          {!scrolledToEnd ? (
            <p className="flex items-center justify-center gap-2 py-3 text-sm text-gray-500">
              <FiArrowDown className="w-4 h-4 animate-bounce" />
              เลื่อนอ่านให้ถึงด้านล่างสุดก่อน
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={close}
                className="py-3 bg-gray-200 text-gray-700 rounded-xl font-semibold active:scale-95"
              >
                ไว้ทีหลัง
              </button>
              <button
                type="button"
                onClick={handleAcknowledge}
                disabled={acting}
                className="flex items-center justify-center gap-2 py-3 bg-emerald-600 text-white rounded-xl font-semibold active:scale-95 disabled:opacity-60"
              >
                <FiCheck className="w-5 h-5" />
                {acting ? 'กำลังบันทึก...' : 'รับทราบ'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
