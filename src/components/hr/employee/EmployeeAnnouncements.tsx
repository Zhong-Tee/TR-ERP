import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { FiBell, FiCheck, FiStar, FiChevronRight, FiArrowDown } from 'react-icons/fi'
import ModalCloseButton from '../../ui/ModalCloseButton'
import {
  fetchAnnouncements,
  fetchMyAnnouncementReads,
  acknowledgeAnnouncement,
  setAnnouncementApproval,
  fetchEmployeeByUserId,
  ANNOUNCEMENT_BUCKET,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import { AttachmentStrip } from './AttachmentViewer'
import type { HRAnnouncement } from '../../../types'

const thaiDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'

export default function EmployeeAnnouncements({ onUnreadChange }: { onUnreadChange?: () => void }) {
  const { user } = useAuthContext()
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [announcements, setAnnouncements] = useState<HRAnnouncement[]>([])
  const [readIds, setReadIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState<HRAnnouncement | null>(null)
  /** เลื่อนอ่านถึงล่างสุดแล้วหรือยัง — ต้องถึงล่างสุดจึงกดรับทราบได้ */
  const [scrolledToEnd, setScrolledToEnd] = useState(false)
  const [acting, setActing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    setError(null)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployeeId(emp?.id ?? null)
      const [list, reads] = await Promise.all([
        fetchAnnouncements(),
        emp?.id ? fetchMyAnnouncementReads(emp.id) : Promise.resolve([]),
      ])
      setAnnouncements(list)
      setReadIds(new Set(reads))
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'โหลดประกาศไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { load() }, [load])

  // เนื้อหาสั้นกว่าหน้าจอ = ถือว่าอ่านครบแล้ว (ไม่มีอะไรให้เลื่อน)
  useEffect(() => {
    if (!reading) return
    setScrolledToEnd(false)
    const el = scrollRef.current
    if (!el) return
    const t = setTimeout(() => {
      if (el.scrollHeight <= el.clientHeight + 8) setScrolledToEnd(true)
    }, 100)
    return () => clearTimeout(t)
  }, [reading])

  // เปิดหน้าอ่านอยู่ → ล็อกไม่ให้หน้าเบื้องหลังเลื่อนตาม
  useEffect(() => {
    if (!reading) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [reading])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setScrolledToEnd(true)
  }

  /** รายการอนุมัติของเราที่ยังไม่ได้กดในประกาศนี้ */
  const myPendingApproval = (a: HRAnnouncement) =>
    a.approvals?.find((ap) => ap.employee_id === employeeId && ap.status === 'pending') ?? null

  const handleAcknowledge = async () => {
    if (!reading || !employeeId) return
    setActing(true)
    try {
      await acknowledgeAnnouncement(reading.id, employeeId)
      setReadIds((prev) => new Set([...prev, reading.id]))
      setReading(null)
      onUnreadChange?.()
    } catch (e) {
      console.error(e)
    } finally {
      setActing(false)
    }
  }

  const handleApproval = async (status: 'approved' | 'rejected') => {
    if (!reading) return
    const approval = myPendingApproval(reading)
    if (!approval) return
    setActing(true)
    try {
      await setAnnouncementApproval(approval.id, status)
      setReading(null)
      await load()
    } catch (e) {
      console.error(e)
    } finally {
      setActing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  const waitingMyApproval = announcements.filter((a) => myPendingApproval(a))
  const published = announcements.filter((a) => a.status === 'published')

  const card = (a: HRAnnouncement, mode: 'approve' | 'read') => {
    const isRead = readIds.has(a.id)
    return (
      <button
        key={a.id}
        type="button"
        onClick={() => setReading(a)}
        className="w-full rounded-2xl bg-white border border-gray-200 shadow-sm p-4 text-left active:bg-gray-50"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {a.is_pinned && <FiStar className="w-4 h-4 text-amber-500 shrink-0" />}
              <p className="font-semibold text-gray-900 truncate">{a.title}</p>
            </div>
            <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">{a.content}</p>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {a.category?.name && (
                <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600">{a.category.name}</span>
              )}
              <span className="text-xs text-gray-400">{thaiDate(a.published_at ?? a.created_at)}</span>
              {mode === 'approve' ? (
                <span className="inline-flex rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">รอคุณอนุมัติ</span>
              ) : (
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${isRead ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                  {isRead ? 'รับทราบแล้ว' : 'ยังไม่รับทราบ'}
                </span>
              )}
            </div>
          </div>
          <FiChevronRight className="w-5 h-5 text-gray-400 shrink-0 mt-1" />
        </div>
      </button>
    )
  }

  const readingApproval = reading ? myPendingApproval(reading) : null
  const readingAcknowledged = reading ? readIds.has(reading.id) : false

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}

      {waitingMyApproval.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <FiBell className="w-5 h-5 text-blue-600" />
            รอคุณอนุมัติ ({waitingMyApproval.length})
          </h3>
          {waitingMyApproval.map((a) => card(a, 'approve'))}
        </section>
      )}

      <section className="space-y-3">
        <h3 className="font-semibold text-gray-900">ประกาศทั้งหมด</h3>
        {published.length === 0 ? (
          <div className="rounded-2xl bg-white border border-gray-200 p-8 text-center text-gray-500">ยังไม่มีประกาศ</div>
        ) : (
          published.map((a) => card(a, 'read'))
        )}
      </section>

      {/*
        หน้าอ่านประกาศเต็มจอ — ต้อง render ที่ body ผ่าน portal
        ถ้าปล่อยไว้ใน <main> ของ Employee Portal กล่องจะยึดกับ containing block ของ main
        ทำให้เหลือแถบ header โผล่ด้านบนแทนที่จะเต็มจอจริง
      */}
      {reading && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col bg-white h-[100dvh]" role="dialog" aria-modal="true" aria-label={reading.title}>
          <div
            className="relative flex items-center gap-2 px-4 py-3 pr-16 bg-emerald-600 text-white shadow shrink-0"
            style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
          >
            <h3 className="font-semibold truncate">{reading.title}</h3>
            <ModalCloseButton onClick={() => setReading(null)} className="absolute right-3 top-1/2 -translate-y-1/2" />
          </div>

          <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
            <div>
              <div className="flex items-center gap-1.5">
                {reading.is_pinned && <FiStar className="w-4 h-4 text-amber-500" />}
                <h2 className="text-lg font-bold text-gray-900">{reading.title}</h2>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {reading.category?.name ?? 'ไม่ระบุประเภท'} · {thaiDate(reading.published_at ?? reading.created_at)}
              </p>
            </div>

            <div className="rounded-xl border border-gray-200 p-4 text-sm leading-relaxed whitespace-pre-wrap">
              {reading.content}
            </div>

            {reading.attachment_urls?.length > 0 && (
              <AttachmentStrip
                label="ไฟล์แนบ"
                items={reading.attachment_urls.map((path) => ({ bucket: ANNOUNCEMENT_BUCKET, path }))}
              />
            )}

            <p className="pt-2 pb-8 text-center text-xs text-gray-400">— จบประกาศ —</p>
          </div>

          <div
            className="border-t border-gray-200 bg-white p-4 shrink-0 shadow-[0_-2px_10px_rgba(0,0,0,0.06)]"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            {!scrolledToEnd ? (
              <p className="flex items-center justify-center gap-2 py-3 text-sm text-gray-500">
                <FiArrowDown className="w-4 h-4 animate-bounce" />
                เลื่อนอ่านให้ถึงด้านล่างสุดก่อน
              </p>
            ) : readingApproval ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleApproval('rejected')}
                  disabled={acting}
                  className="flex-1 py-3 rounded-xl border border-red-300 text-red-600 font-medium disabled:opacity-60"
                >
                  ไม่อนุมัติ
                </button>
                <button
                  type="button"
                  onClick={() => handleApproval('approved')}
                  disabled={acting}
                  className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-60"
                >
                  <FiCheck className="w-5 h-5" />
                  {acting ? 'กำลังบันทึก...' : 'อนุมัติ'}
                </button>
              </div>
            ) : readingAcknowledged ? (
              <p className="flex items-center justify-center gap-2 py-3 text-sm font-medium text-emerald-700">
                <FiCheck className="w-5 h-5" />
                คุณรับทราบประกาศนี้แล้ว
              </p>
            ) : (
              <button
                type="button"
                onClick={handleAcknowledge}
                disabled={acting}
                className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-emerald-600 text-white font-medium disabled:opacity-60"
              >
                <FiCheck className="w-5 h-5" />
                {acting ? 'กำลังบันทึก...' : 'ยืนยัน / รับทราบ'}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
