import { useState, useEffect, useCallback } from 'react'
import { FiAlertTriangle, FiAward, FiCalendar, FiCheck } from 'react-icons/fi'
import { acknowledgeMyCertificate, fetchEmployeeByUserId, fetchWarnings, fetchCertificates, HR_WARNING_CERT_BUCKET, respondToWarning } from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRWarning, HRCertificate } from '../../../types'
import { AttachmentStrip } from './AttachmentViewer'
import HRDocumentAttachments from '../HRDocumentAttachments'
import ModalCloseButton from '../../ui/ModalCloseButton'

const WARNING_LEVEL: Record<string, string> = {
  verbal: 'ตักเตือนด้วยวาจา ครั้งที่ 1',
  verbal_2: 'ตักเตือนด้วยวาจา ครั้งที่ 2',
  written_1: 'เตือนเป็นลายลักษณ์อักษร ครั้งที่ 1',
  written_2: 'เตือนเป็นลายลักษณ์อักษร ครั้งที่ 2',
  final: 'เตือนครั้งสุดท้าย',
  termination_review: 'พิจารณาเลิกจ้าง',
}

const WARNING_STATUS: Record<string, [string, string]> = {
  draft: ['bg-gray-100 text-gray-600', 'ร่าง'],
  issued: ['bg-red-100 text-red-800', 'อนุมัติ'],
  pending_acknowledgement: ['bg-orange-100 text-orange-800', 'รอรับทราบ'],
  acknowledged: ['bg-amber-100 text-amber-800', 'รับทราบแล้ว'],
  acknowledgement_refused: ['bg-red-100 text-red-800', 'ปฏิเสธรับทราบ'],
  termination_review: ['bg-slate-900 text-white', 'พิจารณาเลิกจ้าง'],
  closed: ['bg-gray-200 text-gray-700', 'ปิดเคส'],
  cancelled: ['bg-gray-100 text-gray-500', 'ยกเลิก'],
  appealed: ['bg-indigo-100 text-indigo-800', 'อุทธรณ์'],
  resolved: ['bg-emerald-100 text-emerald-800', 'ยุติแล้ว'],
}

const PASS_STATUS: Record<string, [string, string]> = {
  passed: ['bg-emerald-100 text-emerald-800', 'ผ่าน'],
  failed: ['bg-red-100 text-red-800', 'ไม่ผ่าน'],
  pending: ['bg-amber-100 text-amber-800', 'รอผล'],
}

function badge(map: Record<string, [string, string]>, key: string) {
  const [cls, label] = map[key] ?? ['bg-gray-100 text-gray-600', key]
  return <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
}

function thaiDate(d?: string): string {
  if (!d) return '-'
  return new Date(d + 'T00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EmployeeWarningsCerts() {
  const { user } = useAuthContext()
  const [tab, setTab] = useState<'warnings' | 'certs'>('warnings')
  const [warnings, setWarnings] = useState<HRWarning[]>([])
  const [certs, setCerts] = useState<HRCertificate[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<{ kind: 'warning'; item: HRWarning } | { kind: 'certificate'; item: HRCertificate } | null>(null)
  const [acknowledging, setAcknowledging] = useState(false)
  const [ackError, setAckError] = useState('')
  const [employeeResponse, setEmployeeResponse] = useState('')
  const [responseAttachments, setResponseAttachments] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      if (!emp) {
        setLoading(false)
        return
      }
      const [w, c] = await Promise.all([
        fetchWarnings({ employeeId: emp.id }),
        fetchCertificates({ employeeId: emp.id }),
      ])
      // เอกสารสถานะร่างเป็นงานภายในของ HR ยังไม่ควรแสดงให้พนักงานเห็น
      setWarnings(w.filter((item) => item.status !== 'draft'))
      setCerts(c.filter((item) => item.status !== 'draft'))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  const acknowledgeSelected = async (outcome: 'acknowledged' | 'refused' = 'acknowledged') => {
    if (!selected) return
    setAckError('')
    setAcknowledging(true)
    try {
      if (selected.kind === 'warning') await respondToWarning(selected.item.id, outcome, employeeResponse.trim() || undefined, 'employee_portal', responseAttachments)
      else await acknowledgeMyCertificate(selected.item.id)
      setSelected(null)
      setEmployeeResponse('')
      setResponseAttachments([])
      await load()
      window.dispatchEvent(new Event('hr-documents-changed'))
    } catch (error) {
      console.error(error)
      setAckError(error instanceof Error ? error.message : 'บันทึกการรับทราบไม่สำเร็จ กรุณาลองใหม่')
    } finally {
      setAcknowledging(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* แถบเมนูย่อย */}
      <div className="flex gap-2">
        {([
          ['warnings', 'ใบเตือน', warnings.length],
          ['certs', 'ใบรับรอง', certs.length],
        ] as [typeof tab, string, number][]).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              tab === key ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 border border-gray-200'
            }`}
          >
            {label} {count > 0 && `(${count})`}
          </button>
        ))}
      </div>

      {tab === 'warnings' ? (
        warnings.length === 0 ? (
          <div className="rounded-2xl bg-white border border-gray-200 p-6 text-center text-gray-500 text-sm">
            ไม่มีใบเตือน
          </div>
        ) : (
          <div className="space-y-3">
            {warnings.map((w) => (
              <button type="button" onClick={() => setSelected({ kind: 'warning', item: w })} key={w.id} className="w-full text-left rounded-2xl bg-white border border-gray-200 p-4 shadow-sm active:bg-gray-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-start gap-1.5 break-words font-semibold text-gray-900">
                      <FiAlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                      <span className="min-w-0">{w.subject}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400">{w.warning_number}</p>
                    <p className="mt-0.5 text-xs text-gray-400">{WARNING_LEVEL[w.warning_level] ?? w.warning_level}</p>
                  </div>
                  {badge(WARNING_STATUS, w.status)}
                </div>
                <div className="mt-2 text-sm text-gray-600 space-y-1">
                  <p className="flex items-center gap-1.5">
                    <FiCalendar className="w-3.5 h-3.5 text-gray-400" /> เหตุเกิด {thaiDate(w.incident_date)} • ออกเมื่อ {thaiDate(w.issued_date)}
                  </p>
                  {w.description && <p className="text-xs text-gray-500">{w.description}</p>}
                </div>
                <span className="block mt-3 text-xs font-semibold text-emerald-600">ดูรายละเอียด</span>
              </button>
            ))}
          </div>
        )
      ) : certs.length === 0 ? (
        <div className="rounded-2xl bg-white border border-gray-200 p-6 text-center text-gray-500 text-sm">
          ไม่มีใบรับรอง
        </div>
      ) : (
        <div className="space-y-3">
          {certs.map((c) => (
            <button type="button" onClick={() => setSelected({ kind: 'certificate', item: c })} key={c.id} className="w-full text-left rounded-2xl bg-white border border-gray-200 p-4 shadow-sm active:bg-gray-50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 flex items-center gap-1.5">
                    <FiAward className="w-4 h-4 text-emerald-500 shrink-0" />
                    {c.training_name}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {c.certificate_number} • {c.training_type === 'internal' ? 'อบรมภายใน' : 'อบรมภายนอก'}
                  </p>
                </div>
                {badge(PASS_STATUS, c.pass_status)}
              </div>
              <div className="mt-2 text-sm text-gray-600 space-y-1">
                <p className="flex items-center gap-1.5">
                  <FiCalendar className="w-3.5 h-3.5 text-gray-400" /> อบรม {thaiDate(c.training_start_date)}
                  {c.expiry_date ? ` • หมดอายุ ${thaiDate(c.expiry_date)}` : ''}
                </p>
                {c.score != null && <p className="text-xs text-gray-500">คะแนน {c.score}</p>}
              </div>
              <span className="block mt-3 text-xs font-semibold text-emerald-600">ดูรายละเอียด</span>
            </button>
          ))}
        </div>
      )}
      {selected && (() => {
        const isWarning = selected.kind === 'warning'
        const pending = (selected.item.status === 'issued' || (isWarning && selected.item.status === 'pending_acknowledgement')) && !selected.item.acknowledged_at
        return (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-4 sm:pt-8 px-0 sm:px-4" role="dialog" aria-modal="true" onClick={() => !acknowledging && setSelected(null)}>
            <div className="relative bg-white w-full max-h-[calc(100vh-2rem)] sm:max-w-lg sm:max-h-[calc(100vh-4rem)] rounded-b-2xl sm:rounded-2xl overflow-hidden flex flex-col shadow-xl" onClick={(event) => event.stopPropagation()}>
              <ModalCloseButton onClick={() => setSelected(null)}/>
              <div className={`px-4 py-3 pr-16 text-white ${isWarning ? 'bg-red-600' : 'bg-emerald-600'}`}>
                <h3 className="font-bold">รายละเอียด{isWarning ? 'ใบเตือน' : 'ใบรับรอง'}</h3>
              </div>
              <div className="p-4 overflow-y-auto space-y-3 text-sm text-gray-700">
                <h2 className="text-lg font-bold text-gray-900">{isWarning ? selected.item.subject : selected.item.training_name}</h2>
                <p className="text-gray-500">{isWarning ? selected.item.warning_number : selected.item.certificate_number}</p>
                {isWarning ? (
                  <>
                    <p>ระดับ: {WARNING_LEVEL[selected.item.warning_level] || selected.item.warning_level}</p>
                    {selected.item.offense_type?.name && <p>ประเภทความผิด: {selected.item.offense_type.name}</p>}
                    <p>เหตุเกิด {thaiDate(selected.item.incident_date)} · ออกเมื่อ {thaiDate(selected.item.issued_date)}</p>
                    <p className="whitespace-pre-wrap">{selected.item.description || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
                    {selected.item.corrective_action && <div className="rounded-xl bg-amber-50 p-3"><div className="font-semibold text-amber-900">สิ่งที่ต้องปรับปรุง / คำสั่งให้แก้ไข</div><p className="mt-1 whitespace-pre-wrap">{selected.item.corrective_action}</p></div>}
                    {selected.item.employee_response && <p>คำชี้แจง: {selected.item.employee_response}</p>}
                  </>
                ) : (
                  <>
                    <p>ประเภท: {selected.item.training_type === 'internal' ? 'อบรมภายใน' : 'อบรมภายนอก'}</p>
                    <p>อบรม {thaiDate(selected.item.training_start_date)}{selected.item.training_end_date ? ` - ${thaiDate(selected.item.training_end_date)}` : ''}</p>
                    <p>ผู้ฝึกอบรม: {selected.item.trainer || '-'}</p>
                    <p>ผลการอบรม: {PASS_STATUS[selected.item.pass_status]?.[1] || selected.item.pass_status}</p>
                    {selected.item.score != null && <p>คะแนน: {selected.item.score}</p>}
                    <p className="whitespace-pre-wrap">{selected.item.description || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
                  </>
                )}
                {selected.item.attachment_urls?.length > 0 && (
                  <AttachmentStrip label="รูปภาพ / ไฟล์แนบ" items={selected.item.attachment_urls.map((path) => ({ bucket: HR_WARNING_CERT_BUCKET, path }))} />
                )}
              </div>
              {pending && (
                <div className="border-t bg-white p-4 shrink-0">
                  {ackError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{ackError}</p>}
                  {isWarning && <><textarea rows={3} value={employeeResponse} onChange={e=>setEmployeeResponse(e.target.value)} placeholder="คำชี้แจงของพนักงาน (ถ้ามี)" className="mb-3 w-full rounded-xl border p-3 text-sm"/><div className="mb-3"><HRDocumentAttachments employeeId={selected.item.employee_id} category="warnings" paths={responseAttachments} onChange={setResponseAttachments} onError={setAckError}/></div></>}
                  <button type="button" onClick={()=>acknowledgeSelected('acknowledged')} disabled={acknowledging} className={`flex w-full items-center justify-center gap-2 rounded-xl py-3 font-semibold text-white disabled:opacity-60 ${isWarning ? 'bg-red-600' : 'bg-emerald-600'}`}><FiCheck className="w-5 h-5" />{acknowledging ? 'กำลังบันทึก...' : 'รับทราบ'}</button>
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
