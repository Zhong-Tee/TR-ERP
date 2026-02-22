import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  FiUpload,
  FiUsers,
  FiCalendar,
  FiEdit2,
  FiCheck,
  FiPlus,
  FiTrash2,
} from 'react-icons/fi'
import {
  fetchCandidates,
  upsertCandidate,
  fetchInterviews,
  upsertInterview,
  fetchInterviewScores,
  upsertInterviewScore,
  parseSiamIdData,
  getLatestSiamIdRecords,
  siamIdToCandidate,
  fetchEmployees,
  type SiamIdRecord,
} from '../../lib/hrApi'
import type { HRCandidate, HRInterview, HRInterviewScore, HREmployee } from '../../types'
import Modal from '../ui/Modal'

type CandidateStatus = HRCandidate['status']

const STATUS_OPTIONS: { value: CandidateStatus | ''; label: string }[] = [
  { value: '', label: 'ทุกสถานะ' },
  { value: 'new', label: 'ใหม่' },
  { value: 'scheduled', label: 'นัดสัมภาษณ์' },
  { value: 'interviewed', label: 'สัมภาษณ์แล้ว' },
  { value: 'passed', label: 'ผ่าน' },
  { value: 'failed', label: 'ไม่ผ่าน' },
  { value: 'hired', label: 'รับเข้าทำงานแล้ว' },
  { value: 'withdrawn', label: 'ถอนตัว' },
]

function candidateName(c: HRCandidate): string {
  return [c.prefix, c.first_name, c.last_name].filter(Boolean).join(' ')
}

function formatDate(d: string): string {
  if (!d) return '-'
  try {
    return new Date(d).toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return d
  }
}

function formatDateTime(d: string): string {
  if (!d) return '-'
  try {
    return new Date(d).toLocaleString('th-TH', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return d
  }
}

export default function InterviewSchedule() {
  const [candidates, setCandidates] = useState<HRCandidate[]>([])
  const [interviews, setInterviews] = useState<HRInterview[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [statusFilter, setStatusFilter] = useState<CandidateStatus | ''>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [, setImportFile] = useState<File | null>(null)
  const [parsedRecords, setParsedRecords] = useState<SiamIdRecord[]>([])
  const [selectedImportIds, setSelectedImportIds] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [scheduleCandidate, setScheduleCandidate] = useState<HRCandidate | null>(null)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [scheduleLocation, setScheduleLocation] = useState('')
  const [scheduleInterviewers, setScheduleInterviewers] = useState<string[]>([])
  const [scheduleSaving, setScheduleSaving] = useState(false)

  const [scoringInterview, setScoringInterview] = useState<HRInterview | null>(null)
  const [existingScores, setExistingScores] = useState<HRInterviewScore[]>([])
  const [criteriaRows, setCriteriaRows] = useState<{ name: string; max_score: number; score: number; note: string }[]>([])
  const [recommendation, setRecommendation] = useState<HRInterviewScore['recommendation']>('maybe')
  const [scoreComments, setScoreComments] = useState('')
  const [scoreSaving, setScoreSaving] = useState(false)
  const [hiringCandidateId, setHiringCandidateId] = useState<string | null>(null)

  /** Optional: current employee id for interviewer_id when saving score (e.g. from auth). */
  const currentEmployeeId: string | undefined = undefined

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cand, ints, emps] = await Promise.all([
        fetchCandidates(),
        fetchInterviews(),
        fetchEmployees({ status: 'active' }),
      ])
      setCandidates(cand)
      setInterviews(ints)
      setEmployees(emps)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const filteredCandidates = useMemo(() => {
    if (!statusFilter) return candidates
    return candidates.filter((c) => c.status === statusFilter)
  }, [candidates, statusFilter])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.txt')) {
      setError('กรุณาเลือกไฟล์ .txt (Data.txt จาก SIAM-ID)')
      return
    }
    setImportFile(file)
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const records = parseSiamIdData(text)
      const latest = getLatestSiamIdRecords(records)
      setParsedRecords(latest)
      setSelectedImportIds(new Set(latest.map((r) => r.citizen_id)))
    }
    reader.readAsText(file, 'UTF-8')
  }

  const handleImport = async () => {
    if (parsedRecords.length === 0) return
    setImporting(true)
    setError(null)
    try {
      const toImport = parsedRecords.filter((r) => selectedImportIds.has(r.citizen_id))
      for (const r of toImport) {
        await upsertCandidate(siamIdToCandidate(r))
      }
      setSuccessMessage(`นำเข้าสำเร็จ ${toImport.length} รายการ`)
      setImportOpen(false)
      setImportFile(null)
      setParsedRecords([])
      setSelectedImportIds(new Set())
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'นำเข้าข้อมูลไม่สำเร็จ')
    } finally {
      setImporting(false)
    }
  }

  const openScheduleModal = (candidate: HRCandidate) => {
    setScheduleCandidate(candidate)
    setScheduleDate('')
    setScheduleTime('09:00')
    setScheduleLocation('')
    setScheduleInterviewers([])
    setScheduleModalOpen(true)
  }

  const handleScheduleSubmit = async () => {
    if (!scheduleCandidate || !scheduleDate) return
    setScheduleSaving(true)
    setError(null)
    try {
      await upsertInterview({
        candidate_id: scheduleCandidate.id,
        interview_date: `${scheduleDate}T${scheduleTime}:00`,
        location: scheduleLocation || undefined,
        interviewer_ids: scheduleInterviewers,
        status: 'scheduled',
      })
      await upsertCandidate({ id: scheduleCandidate.id, status: 'scheduled' })
      setSuccessMessage('นัดสัมภาษณ์แล้ว')
      setScheduleModalOpen(false)
      setScheduleCandidate(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setScheduleSaving(false)
    }
  }

  const openScoring = async (interview: HRInterview) => {
    setScoringInterview(interview)
    setCriteriaRows([{ name: '', max_score: 10, score: 0, note: '' }])
    setRecommendation('maybe')
    setScoreComments('')
    setError(null)
    try {
      const scores = await fetchInterviewScores(interview.id)
      setExistingScores(scores)
      if (scores.length > 0) {
        const s = scores[0]
        setCriteriaRows(
          s.criteria.length > 0
            ? s.criteria.map((c) => ({
                name: c.name,
                max_score: c.max_score,
                score: c.score ?? 0,
                note: c.note ?? '',
              }))
            : [{ name: '', max_score: 10, score: 0, note: '' }]
        )
        setRecommendation(s.recommendation)
        setScoreComments(s.comments ?? '')
      }
    } catch {
      setExistingScores([])
    }
  }

  const addCriteriaRow = () => {
    setCriteriaRows((prev) => [...prev, { name: '', max_score: 10, score: 0, note: '' }])
  }

  const removeCriteriaRow = (index: number) => {
    setCriteriaRows((prev) => prev.filter((_, i) => i !== index))
  }

  const updateCriteriaRow = (
    index: number,
    field: 'name' | 'max_score' | 'score' | 'note',
    value: string | number
  ) => {
    setCriteriaRows((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const totalScore = useMemo(() => {
    return criteriaRows.reduce((sum, r) => sum + (Number(r.score) || 0), 0)
  }, [criteriaRows])

  const maxPossible = useMemo(() => {
    return criteriaRows.reduce((sum, r) => sum + (Number(r.max_score) || 0), 0)
  }, [criteriaRows])

  const handleSaveScore = async () => {
    if (!scoringInterview) return
    const interviewerId =
      currentEmployeeId ??
      (Array.isArray(scoringInterview.interviewer_ids) && scoringInterview.interviewer_ids.length > 0
        ? scoringInterview.interviewer_ids[0]
        : undefined)
    if (!interviewerId) {
      setError('ไม่พบผู้สัมภาษณ์ (interviewer_id) สำหรับบันทึกคะแนน')
      return
    }
    const criteria = criteriaRows
      .filter((r) => r.name.trim())
      .map((r) => ({
        name: r.name.trim(),
        max_score: Number(r.max_score) || 0,
        score: Number(r.score) || 0,
        note: r.note.trim() || undefined,
      }))
    if (criteria.length === 0) {
      setError('กรุณาเพิ่มเกณฑ์การให้คะแนนอย่างน้อย 1 รายการ')
      return
    }
    setScoreSaving(true)
    setError(null)
    try {
      const payload: Partial<HRInterviewScore> = {
        interview_id: scoringInterview.id,
        interviewer_id: interviewerId,
        criteria,
        total_score: totalScore,
        max_possible: maxPossible,
        recommendation,
        comments: scoreComments.trim() || undefined,
      }
      if (existingScores.length > 0) {
        payload.id = existingScores[0].id
      }
      await upsertInterviewScore(payload)
      await upsertInterview({ id: scoringInterview.id, status: 'completed' })
      const cand = scoringInterview.candidate
      if (cand) {
        await upsertCandidate({
          id: cand.id,
          status: recommendation === 'hire' ? 'passed' : recommendation === 'reject' ? 'failed' : 'interviewed',
        })
      }
      setSuccessMessage('บันทึกคะแนนแล้ว')
      setScoringInterview(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกคะแนนไม่สำเร็จ')
    } finally {
      setScoreSaving(false)
    }
  }

  const handleHire = async (candidateId: string) => {
    setHiringCandidateId(candidateId)
    setError(null)
    try {
      await upsertCandidate({ id: candidateId, status: 'hired' })
      setSuccessMessage('รับเข้าทำงานแล้ว')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ')
    } finally {
      setHiringCandidateId(null)
    }
  }

  useEffect(() => {
    if (!successMessage) return
    const t = setTimeout(() => setSuccessMessage(null), 3000)
    return () => clearTimeout(t)
  }, [successMessage])

  const statusLabel = (s: CandidateStatus): string => {
    const o = STATUS_OPTIONS.find((x) => x.value === s)
    return o?.label ?? s
  }

  return (
    <div className="mt-4 space-y-6">
      <div className="rounded-xl bg-white shadow-soft border border-surface-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-surface-800">สัมภาษณ์และคะแนน</h2>
          <button
            type="button"
            onClick={() => {
              setImportOpen(true)
              setImportFile(null)
              setParsedRecords([])
              setError(null)
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 shadow-soft"
          >
            <FiUpload className="w-4 h-4" />
            นำเข้าข้อมูลผู้สมัคร
          </button>
        </div>

        {error && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-red-50 text-red-800 text-sm border border-red-200">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mx-6 mt-4 px-4 py-3 rounded-lg bg-emerald-50 text-emerald-800 text-sm border border-emerald-200">
            {successMessage}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-2 border-surface-300 border-t-emerald-600" />
          </div>
        ) : (
          <>
            <div className="px-6 py-4 border-b border-surface-100">
              <div className="flex items-center gap-2">
                <FiUsers className="w-5 h-5 text-surface-500" />
                <span className="text-sm font-medium text-surface-700">ผู้สมัคร</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter((e.target.value || '') as CandidateStatus | '')}
                  className="ml-2 rounded-lg border border-surface-300 bg-white px-3 py-1.5 text-sm"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value || 'all'} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-surface-50 border-b border-surface-200">
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">ชื่อ-นามสกุล</th>
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">ตำแหน่งที่สมัคร</th>
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่สมัคร</th>
                    <th className="px-6 py-3 text-sm font-semibold text-surface-700">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCandidates.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-surface-500 text-sm">
                        ไม่มีรายการ
                      </td>
                    </tr>
                  ) : (
                    filteredCandidates.map((c) => (
                      <tr key={c.id} className="border-b border-surface-100 hover:bg-surface-50/50">
                        <td className="px-6 py-3 text-sm text-surface-800">{candidateName(c)}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">{c.applied_position ?? '-'}</td>
                        <td className="px-6 py-3">
                          <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-surface-100 text-surface-700 border border-surface-200">
                            {statusLabel(c.status)}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">{formatDate(c.created_at)}</td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            {c.status === 'new' && (
                              <button
                                type="button"
                                onClick={() => openScheduleModal(c)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 text-sm hover:bg-emerald-200"
                              >
                                <FiCalendar className="w-4 h-4" /> นัดสัมภาษณ์
                              </button>
                            )}
                            {c.status === 'passed' && (
                              <button
                                type="button"
                                onClick={() => handleHire(c.id)}
                                disabled={!!hiringCandidateId}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
                              >
                                <FiCheck className="w-4 h-4" /> รับเข้าทำงาน
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl bg-white shadow-soft border border-surface-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200">
          <h3 className="text-base font-semibold text-surface-800">รายการสัมภาษณ์</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-surface-50 border-b border-surface-200">
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">ผู้สมัคร</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่/เวลา</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานที่</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                <th className="px-6 py-3 text-sm font-semibold text-surface-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {interviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-surface-500 text-sm">
                    ไม่มีรายการ
                  </td>
                </tr>
              ) : (
                interviews.map((iv) => (
                  <tr
                    key={iv.id}
                    onClick={() => openScoring(iv)}
                    className="border-b border-surface-100 hover:bg-emerald-50/50 cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-3 text-sm text-surface-800">
                      {iv.candidate ? candidateName(iv.candidate) : '-'}
                    </td>
                    <td className="px-6 py-3 text-sm text-surface-700">{formatDateTime(iv.interview_date)}</td>
                    <td className="px-6 py-3 text-sm text-surface-700">{iv.location ?? '-'}</td>
                    <td className="px-6 py-3">
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${
                          iv.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-800'
                            : iv.status === 'scheduled'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-surface-100 text-surface-700'
                        }`}
                      >
                        {iv.status === 'scheduled' ? 'นัดแล้ว' : iv.status === 'completed' ? 'เสร็จสิ้น' : iv.status}
                      </span>
                    </td>
                    <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => openScoring(iv)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-100 text-surface-700 text-sm hover:bg-surface-200"
                      >
                        <FiEdit2 className="w-4 h-4" /> ให้คะแนน
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Import modal */}
      <Modal open={importOpen} onClose={() => setImportOpen(false)} contentClassName="max-w-4xl" closeOnBackdropClick>
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-2">นำเข้าข้อมูลผู้สมัคร (Data.txt จาก SIAM-ID)</h3>
          <div className="mb-4">
            <input
              type="file"
              accept=".txt"
              onChange={handleFileSelect}
              className="block w-full text-sm text-surface-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:font-medium"
            />
          </div>
          {parsedRecords.length > 0 && (
            <>
              <p className="text-sm text-surface-600 mb-2">
                พบ {parsedRecords.length} รายการ (ล่าสุดตามเลขบัตร) — เลือกรายการที่ต้องการนำเข้า
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border border-surface-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedImportIds.size === parsedRecords.length}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedImportIds(new Set(parsedRecords.map((r) => r.citizen_id)))
                            } else {
                              setSelectedImportIds(new Set())
                            }
                          }}
                        />
                      </th>
                      <th className="px-3 py-2 font-semibold text-surface-700">ชื่อ-นามสกุล</th>
                      <th className="px-3 py-2 font-semibold text-surface-700">เลขบัตร</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRecords.map((r) => (
                      <tr key={r.citizen_id} className="border-t border-surface-100">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedImportIds.has(r.citizen_id)}
                            onChange={(e) => {
                              setSelectedImportIds((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(r.citizen_id)
                                else next.delete(r.citizen_id)
                                return next
                              })
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">{[r.prefix, r.first_name, r.last_name].filter(Boolean).join(' ')}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.citizen_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setImportOpen(false)}
                  className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
                >
                  ยกเลิก
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importing || selectedImportIds.size === 0}
                  className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  {importing ? 'กำลังนำเข้า...' : `นำเข้า (${selectedImportIds.size} รายการ)`}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Schedule interview modal */}
      <Modal
        open={scheduleModalOpen}
        onClose={() => {
          setScheduleModalOpen(false)
          setScheduleCandidate(null)
        }}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-4">นัดสัมภาษณ์</h3>
          {scheduleCandidate && (
            <p className="text-sm text-surface-600 mb-4">ผู้สมัคร: {candidateName(scheduleCandidate)}</p>
          )}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">วันที่</label>
              <input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">เวลา</label>
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">สถานที่</label>
              <input
                type="text"
                value={scheduleLocation}
                onChange={(e) => setScheduleLocation(e.target.value)}
                placeholder="ห้องสัมภาษณ์..."
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">ผู้สัมภาษณ์</label>
              <select
                multiple
                value={scheduleInterviewers}
                onChange={(e) => {
                  const opts = Array.from(e.target.selectedOptions, (o) => o.value)
                  setScheduleInterviewers(opts)
                }}
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm min-h-[80px]"
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.employee_code} {emp.first_name} {emp.last_name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-surface-500 mt-1">กด Ctrl/Cmd เพื่อเลือกหลายคน</p>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setScheduleModalOpen(false)}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleScheduleSubmit}
              disabled={scheduleSaving || !scheduleDate}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {scheduleSaving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Scoring modal */}
      <Modal
        open={!!scoringInterview}
        onClose={() => setScoringInterview(null)}
        contentClassName="max-w-2xl"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-4">ให้คะแนนการสัมภาษณ์</h3>
          {scoringInterview?.candidate && (
            <p className="text-sm text-surface-600 mb-4">ผู้สมัคร: {candidateName(scoringInterview.candidate)}</p>
          )}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-surface-700">เกณฑ์การให้คะแนน</span>
              <button
                type="button"
                onClick={addCriteriaRow}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-100 text-emerald-700 text-sm"
              >
                <FiPlus className="w-4 h-4" /> เพิ่มเกณฑ์
              </button>
            </div>
            <div className="rounded-lg border border-surface-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-50">
                    <th className="px-3 py-2 text-left font-semibold text-surface-700">ชื่อเกณฑ์</th>
                    <th className="px-3 py-2 text-left font-semibold text-surface-700 w-24">คะแนนเต็ม</th>
                    <th className="px-3 py-2 text-left font-semibold text-surface-700 w-24">คะแนน</th>
                    <th className="px-3 py-2 text-left font-semibold text-surface-700">หมายเหตุ</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {criteriaRows.map((row, i) => (
                    <tr key={i} className="border-t border-surface-100">
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) => updateCriteriaRow(i, 'name', e.target.value)}
                          placeholder="ชื่อเกณฑ์"
                          className="w-full rounded border border-surface-300 px-2 py-1 text-surface-800"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          value={row.max_score}
                          onChange={(e) => updateCriteriaRow(i, 'max_score', e.target.value)}
                          className="w-full rounded border border-surface-300 px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={row.max_score}
                          value={row.score}
                          onChange={(e) => updateCriteriaRow(i, 'score', e.target.value)}
                          className="w-full rounded border border-surface-300 px-2 py-1"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={row.note}
                          onChange={(e) => updateCriteriaRow(i, 'note', e.target.value)}
                          placeholder="หมายเหตุ"
                          className="w-full rounded border border-surface-300 px-2 py-1 text-surface-800"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {criteriaRows.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeCriteriaRow(i)}
                            className="p-1 rounded text-red-600 hover:bg-red-50"
                          >
                            <FiTrash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm text-surface-600">
              รวมคะแนน: <strong>{totalScore}</strong> / {maxPossible}
            </p>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">ข้อเสนอแนะ</label>
              <select
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value as HRInterviewScore['recommendation'])}
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              >
                <option value="hire">รับเข้าทำงาน</option>
                <option value="maybe">พิจารณา</option>
                <option value="reject">ไม่รับ</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">ความเห็น</label>
              <textarea
                value={scoreComments}
                onChange={(e) => setScoreComments(e.target.value)}
                rows={3}
                placeholder="ความเห็นเพิ่มเติม..."
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setScoringInterview(null)}
              className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 text-sm font-medium"
            >
              ปิด
            </button>
            <button
              type="button"
              onClick={handleSaveScore}
              disabled={scoreSaving}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
            >
              {scoreSaving ? 'กำลังบันทึก...' : 'บันทึกคะแนน'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
