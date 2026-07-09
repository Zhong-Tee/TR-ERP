import { useState, useEffect, useCallback } from 'react'
import { FiAlertTriangle, FiAward, FiCalendar } from 'react-icons/fi'
import { fetchEmployeeByUserId, fetchWarnings, fetchCertificates } from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HRWarning, HRCertificate } from '../../../types'

const WARNING_LEVEL: Record<string, string> = {
  verbal: 'ตักเตือนด้วยวาจา',
  written_1: 'หนังสือเตือนครั้งที่ 1',
  written_2: 'หนังสือเตือนครั้งที่ 2',
  final: 'หนังสือเตือนครั้งสุดท้าย',
}

const WARNING_STATUS: Record<string, [string, string]> = {
  draft: ['bg-gray-100 text-gray-600', 'ร่าง'],
  issued: ['bg-red-100 text-red-800', 'ออกแล้ว'],
  acknowledged: ['bg-amber-100 text-amber-800', 'รับทราบแล้ว'],
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
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
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
      setWarnings(w)
      setCerts(c)
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
              <div key={w.id} className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <FiAlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                      {w.subject}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {w.warning_number} • {WARNING_LEVEL[w.warning_level] ?? w.warning_level}
                    </p>
                  </div>
                  {badge(WARNING_STATUS, w.status)}
                </div>
                <div className="mt-2 text-sm text-gray-600 space-y-1">
                  <p className="flex items-center gap-1.5">
                    <FiCalendar className="w-3.5 h-3.5 text-gray-400" /> เหตุเกิด {thaiDate(w.incident_date)} • ออกเมื่อ {thaiDate(w.issued_date)}
                  </p>
                  {w.description && <p className="text-xs text-gray-500">{w.description}</p>}
                </div>
              </div>
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
            <div key={c.id} className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
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
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
