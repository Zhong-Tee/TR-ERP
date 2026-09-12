import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  FiUpload,
  FiEye,
  FiEdit2,
  FiCheck,
  FiPlus,
  FiTrash2,
  FiExternalLink,
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
  fetchPositions,
  fetchDepartments,
  fetchInterviewers,
  fetchInterviewCriteriaTemplates,
  fetchAllInterviewScores,
  deleteInterview,
  type SiamIdRecord,
} from '../../lib/hrApi'
import type {
  HRCandidate, HRInterview, HRInterviewer, HRInterviewScore,
  HRInterviewCriteriaTemplate, HREmployee, HRPosition, HRDepartment,
} from '../../types'
import Modal from '../ui/Modal'

type CandidateStatus = HRCandidate['status']
type InterviewStatus = HRInterview['status']

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

const INTERVIEW_STATUS_OPTIONS: { value: InterviewStatus; label: string }[] = [
  { value: 'waiting_contact', label: 'รอติดต่อกลับ' },
  { value: 'scheduled', label: 'นัดแล้ว' },
  { value: 'attended', label: 'มาตามนัด' },
  { value: 'rescheduled', label: 'เลื่อนนัด' },
  { value: 'no_show', label: 'ไม่มา' },
]

function interviewStatusLabel(status: InterviewStatus): string {
  return INTERVIEW_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status
}

/** ประเภทค่าจ้างของผู้สมัคร เก็บใน custom_field_2 (custom_field_1 = จำนวนเงิน) */
type SalaryType = 'monthly' | 'daily'

const SALARY_TYPE_OPTIONS: { value: SalaryType; label: string; unit: string }[] = [
  { value: 'monthly', label: 'เงินเดือน', unit: 'บาท/เดือน' },
  { value: 'daily', label: 'รายวัน', unit: 'บาท/วัน' },
]

function salaryTypeOf(c: HRCandidate | null | undefined): SalaryType {
  return c?.custom_field_2 === 'daily' ? 'daily' : 'monthly'
}

function salaryUnit(type: SalaryType): string {
  return SALARY_TYPE_OPTIONS.find((o) => o.value === type)?.unit ?? 'บาท'
}

/**
 * รวมวันที่+เวลาที่ผู้ใช้กรอก (เวลาท้องถิ่น) เป็น ISO ที่มี timezone
 * ถ้าส่ง "2026-08-20T09:00:00" เปล่าๆ เข้า TIMESTAMPTZ Postgres จะตีความเป็น UTC
 * แล้วแสดงกลับเป็นเวลาไทย +7 ชม. (นัด 09:00 กลายเป็น 16:00)
 */
function toLocalIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString()
}

/** แยก ISO ที่เก็บใน DB กลับเป็น {date, time} ของ input ตามเวลาท้องถิ่น (ตรงข้ามกับ toLocalIso) */
function splitLocalIso(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '09:00' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function candidateName(c: HRCandidate): string {
  return [c.prefix, c.first_name, c.last_name].filter(Boolean).join(' ')
}

/** ที่อยู่จากบัตรประชาชนเก็บเป็น JSON แยกช่อง — ต่อกลับเป็นบรรทัดเดียว */
function formatAddress(address?: Record<string, string>): string {
  if (!address) return '-'
  const parts = [
    address.house_no && `บ้านเลขที่ ${address.house_no}`,
    address.moo && `หมู่ ${address.moo}`,
    address.trok && `ตรอก ${address.trok}`,
    address.soi && `ซอย ${address.soi}`,
    address.road && `ถนน ${address.road}`,
    address.tambon,
    address.amphoe,
    address.province,
  ].filter((p): p is string => Boolean(p && p.trim()))
  return parts.length > 0 ? parts.join(' ') : '-'
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
  const [subTab, setSubTab] = useState<'appointments' | 'scoring' | 'candidates'>('appointments')
  const [candidates, setCandidates] = useState<HRCandidate[]>([])
  const [interviews, setInterviews] = useState<HRInterview[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [positions, setPositions] = useState<HRPosition[]>([])
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [interviewers, setInterviewers] = useState<HRInterviewer[]>([])
  const [appointmentSearch, setAppointmentSearch] = useState('')
  const [scoringSearch, setScoringSearch] = useState('')
  const [appointmentDateFrom, setAppointmentDateFrom] = useState('')
  const [appointmentDateTo, setAppointmentDateTo] = useState('')
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
  const [scheduleCandidateId, setScheduleCandidateId] = useState('')
  const [scheduleFirstName, setScheduleFirstName] = useState('')
  const [scheduleLastName, setScheduleLastName] = useState('')
  const [scheduleNickname, setScheduleNickname] = useState('')
  const [schedulePhone, setSchedulePhone] = useState('')
  const [scheduleSalary, setScheduleSalary] = useState('')
  const [scheduleSalaryType, setScheduleSalaryType] = useState<SalaryType>('monthly')
  const [scheduleDepartmentId, setScheduleDepartmentId] = useState('')
  const [scheduleAppliedPosition, setScheduleAppliedPosition] = useState('')
  const [schedulePortfolio, setSchedulePortfolio] = useState('')
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [scheduleLocation, setScheduleLocation] = useState('')
  const [scheduleInterviewers, setScheduleInterviewers] = useState<string[]>([])
  const [scheduleStatus, setScheduleStatus] = useState<InterviewStatus>('scheduled')
  const [scheduleSaving, setScheduleSaving] = useState(false)

  const [scoringInterview, setScoringInterview] = useState<HRInterview | null>(null)
  const [existingScores, setExistingScores] = useState<HRInterviewScore[]>([])
  const [criteriaRows, setCriteriaRows] = useState<{ name: string; max_score: number; score: number; note: string }[]>([])
  const [recommendation, setRecommendation] = useState<HRInterviewScore['recommendation']>('maybe')
  const [scoreComments, setScoreComments] = useState('')
  const [scoreSaving, setScoreSaving] = useState(false)
  const [hiringCandidateId, setHiringCandidateId] = useState<string | null>(null)
  const [deletingInterviewId, setDeletingInterviewId] = useState<string | null>(null)
  /** นัดหมายที่กำลังรอยืนยันการลบ (null = ไม่มีหน้าต่างยืนยันเปิดอยู่) */
  const [confirmDeleteInterview, setConfirmDeleteInterview] = useState<HRInterview | null>(null)
  /** ตั้งค่า = หน้าต่างนัดหมายกำลัง "แก้ไข" นัดเดิม (null = สร้างใหม่) */
  const [editingInterviewId, setEditingInterviewId] = useState<string | null>(null)
  /** ตั้งค่า = นำเข้าบัตรประชาชนเข้าไปในผู้สมัครคนนี้โดยเฉพาะ */
  const [importTargetCandidate, setImportTargetCandidate] = useState<HRCandidate | null>(null)
  const [detailCandidate, setDetailCandidate] = useState<HRCandidate | null>(null)
  const [criteriaTemplates, setCriteriaTemplates] = useState<HRInterviewCriteriaTemplate[]>([])
  const [scoresByInterview, setScoresByInterview] = useState<Map<string, HRInterviewScore>>(new Map())

  /** Optional: current employee id for interviewer_id when saving score (e.g. from auth). */
  const currentEmployeeId: string | undefined = undefined

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cand, ints, emps, pos, depts, itvs, crit, allScores] = await Promise.all([
        fetchCandidates(),
        fetchInterviews(),
        fetchEmployees({ status: 'active' }),
        fetchPositions(),
        fetchDepartments(),
        fetchInterviewers(),
        fetchInterviewCriteriaTemplates(),
        fetchAllInterviewScores(),
      ])
      setCandidates(cand)
      setInterviews(ints)
      setEmployees(emps)
      setPositions(pos)
      setDepartments(depts)
      setInterviewers(itvs)
      setCriteriaTemplates(crit)
      setScoresByInterview(new Map(allScores.map((s) => [s.interview_id, s])))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const scheduleCandidateOptions = candidates

  const candidateMap = useMemo(() => {
    const map = new Map<string, HRCandidate>()
    for (const c of candidates) map.set(c.id, c)
    return map
  }, [candidates])

  const candidateInterviewHistory = useMemo(() => {
    const map = new Map<string, { totalAppointments: number; interviewedCount: number }>()
    for (const iv of interviews) {
      const cur = map.get(iv.candidate_id) ?? { totalAppointments: 0, interviewedCount: 0 }
      cur.totalAppointments += 1
      if (iv.status === 'attended' || iv.status === 'completed') {
        cur.interviewedCount += 1
      }
      map.set(iv.candidate_id, cur)
    }
    return map
  }, [interviews])

  const filteredAppointments = useMemo(() => {
    const q = appointmentSearch.trim().toLowerCase()
    return interviews.filter((iv) => {
      const candidate = iv.candidate ?? candidateMap.get(iv.candidate_id)
      const dateOnly = iv.interview_date?.slice(0, 10) ?? ''

      if (appointmentDateFrom && dateOnly < appointmentDateFrom) return false
      if (appointmentDateTo && dateOnly > appointmentDateTo) return false

      if (!q) return true
      const haystack = [
        candidate ? candidateName(candidate) : '',
        candidate?.nickname ?? '',
        candidate?.phone ?? '',
        candidate?.applied_position ?? '',
        interviewStatusLabel(iv.status),
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(q)
    })
  }, [interviews, candidateMap, appointmentSearch, appointmentDateFrom, appointmentDateTo])

  const filteredScoringInterviews = useMemo(() => {
    const q = scoringSearch.trim().toLowerCase()
    if (!q) return interviews
    return interviews.filter((iv) => {
      const candidate = iv.candidate ?? candidateMap.get(iv.candidate_id)
      const score = scoresByInterview.get(iv.id)
      const haystack = [
        candidate ? candidateName(candidate) : '',
        candidate?.nickname ?? '',
        candidate?.phone ?? '',
        candidate?.applied_position ?? '',
        interviewStatusLabel(iv.status),
        score ? `${score.total_score ?? 0}/${score.max_possible ?? 0}` : 'ยังไม่ให้คะแนน',
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [interviews, candidateMap, scoresByInterview, scoringSearch])

  /** ตำแหน่งให้เลือกในหน้าต่างนัดหมาย — กรองตามแผนกที่เลือก (ถ้ายังไม่เลือกแผนก = ทุกตำแหน่ง) */
  const schedulePositionOptions = useMemo(() => {
    const names = new Set<string>()
    for (const p of positions) {
      if (scheduleDepartmentId && p.department_id !== scheduleDepartmentId) continue
      const n = p.name?.trim()
      if (n) names.add(n)
    }
    // ค่าเดิมของผู้สมัครอาจไม่อยู่ในทะเบียนตำแหน่ง — คงไว้ไม่ให้หายตอนบันทึก
    const current = scheduleAppliedPosition.trim()
    if (current) names.add(current)
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'th'))
  }, [positions, scheduleDepartmentId, scheduleAppliedPosition])

  /** ผู้สัมภาษณ์ที่เลือกได้ = รายชื่อที่ตั้งค่าไว้และเปิดใช้งาน (+ คนที่ถูกเลือกไว้แล้วแต่ถูกถอดออกภายหลัง) */
  const interviewerOptions = useMemo(() => {
    const rows = interviewers
      .filter((i) => i.is_active && i.employee)
      .map((i) => ({
        id: i.employee_id,
        label: [i.employee?.employee_code, i.employee?.first_name, i.employee?.last_name]
          .filter(Boolean).join(' '),
      }))
    const known = new Set(rows.map((r) => r.id))
    for (const id of scheduleInterviewers) {
      if (known.has(id)) continue
      const emp = employees.find((e) => e.id === id)
      rows.push({
        id,
        label: emp
          ? `${emp.employee_code} ${emp.first_name} ${emp.last_name}`
          : 'พนักงานที่ถูกลบออกจากรายชื่อ',
      })
    }
    return rows
  }, [interviewers, scheduleInterviewers, employees])

  const toggleScheduleInterviewer = (id: string) => {
    setScheduleInterviewers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

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
      // โหมดยิงเข้าผู้สมัครคนเดียว ให้ผู้ใช้เลือกเองว่าแถวไหน (ไม่ติ๊กให้อัตโนมัติ)
      setSelectedImportIds(importTargetCandidate ? new Set() : new Set(latest.map((r) => r.citizen_id)))
    }
    reader.readAsText(file, 'UTF-8')
  }

  /**
   * ข้อมูลจากบัตรประชาชนที่ปลอดภัยจะเขียนทับผู้สมัครที่มีอยู่แล้ว
   * custom_field_1/2 ถูกแอปใช้เก็บ "เงินเดือน/ประเภทค่าจ้าง" จึงต้องไม่ให้ค่าจากบัตรมาทับ
   */
  const siamIdPatchForExisting = (r: SiamIdRecord, existing: HRCandidate) => {
    const mapped = siamIdToCandidate(r)
    delete mapped.custom_field_1
    delete mapped.custom_field_2
    return { ...mapped, id: existing.id, status: existing.status }
  }

  const handleImport = async () => {
    if (parsedRecords.length === 0) return
    const toImport = parsedRecords.filter((r) => selectedImportIds.has(r.citizen_id))
    if (toImport.length === 0) return
    setImporting(true)
    setError(null)
    try {
      // เปิดจากปุ่มในแถว = ยัดข้อมูลบัตรเข้าไปในผู้สมัครคนนั้นโดยตรง (ไม่สนเลขบัตรตรงกันไหม)
      if (importTargetCandidate) {
        await upsertCandidate(siamIdPatchForExisting(toImport[0], importTargetCandidate))
        setSuccessMessage(`นำข้อมูลบัตรประชาชนเข้า ${candidateName(importTargetCandidate)} แล้ว`)
      } else {
        let mappedHistoryCount = 0
        for (const r of toImport) {
          const existing = candidates.find((c) => (c.citizen_id ?? '') === r.citizen_id)
          if (existing) {
            const history = candidateInterviewHistory.get(existing.id)
            if ((history?.totalAppointments ?? 0) > 0 || (history?.interviewedCount ?? 0) > 0) {
              mappedHistoryCount += 1
            }
            await upsertCandidate(siamIdPatchForExisting(r, existing))
          } else {
            await upsertCandidate(siamIdToCandidate(r))
          }
        }
        setSuccessMessage(`นำเข้าสำเร็จ ${toImport.length} รายการ (แมปประวัตินัด/สัมภาษณ์ได้ ${mappedHistoryCount} รายการ)`)
      }
      setImportOpen(false)
      setImportTargetCandidate(null)
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

  const openImportForCandidate = (candidate: HRCandidate) => {
    setImportTargetCandidate(candidate)
    setImportOpen(true)
    setImportFile(null)
    setParsedRecords([])
    setSelectedImportIds(new Set())
    setError(null)
  }

  /** เปิดหน้าต่างเดิมในโหมด "แก้ไขนัดหมาย" — บันทึกแล้วอัปเดตนัดเดิม ไม่สร้างนัดใหม่ */
  const openEditScheduleModal = (iv: HRInterview) => {
    const candidate = iv.candidate ?? candidateMap.get(iv.candidate_id) ?? null
    setScheduleCandidate(candidate)
    setScheduleCandidateId(candidate?.id ?? '')
    setScheduleFirstName(candidate?.first_name ?? '')
    setScheduleLastName(candidate?.last_name ?? '')
    setScheduleNickname(candidate?.nickname ?? '')
    setSchedulePhone(candidate?.phone ?? '')
    setScheduleSalary(candidate?.custom_field_1 ?? '')
    setScheduleSalaryType(salaryTypeOf(candidate))
    setScheduleDepartmentId(candidate?.applied_department_id ?? '')
    setScheduleAppliedPosition(candidate?.applied_position ?? '')
    setSchedulePortfolio(candidate?.portfolio_url ?? '')
    const { date, time } = splitLocalIso(iv.interview_date)
    setScheduleDate(date)
    setScheduleTime(time)
    setScheduleLocation(iv.location ?? '')
    setScheduleInterviewers(Array.isArray(iv.interviewer_ids) ? iv.interviewer_ids : [])
    setScheduleStatus(iv.status as InterviewStatus)
    setEditingInterviewId(iv.id)
    setScheduleModalOpen(true)
  }

  const openCreateScheduleModal = () => {
    setEditingInterviewId(null)
    // เริ่มที่ "ไม่เลือกผู้สมัครเดิม" เสมอ — ถ้า preset เป็นผู้สมัครคนแรก
    // การพิมพ์ชื่อใหม่ทับจะกลายเป็นการ "แก้ชื่อผู้สมัครเดิม" โดยไม่ตั้งใจ
    setScheduleCandidate(null)
    setScheduleCandidateId('')
    setScheduleFirstName('')
    setScheduleLastName('')
    setScheduleNickname('')
    setSchedulePhone('')
    setScheduleSalary('')
    setScheduleSalaryType('monthly')
    setScheduleDepartmentId('')
    setScheduleAppliedPosition('')
    setSchedulePortfolio('')
    setScheduleDate('')
    setScheduleTime('09:00')
    setScheduleLocation('')
    setScheduleInterviewers([])
    setScheduleStatus('scheduled')
    setScheduleModalOpen(true)
  }

  const handleScheduleSubmit = async () => {
    const selectedCandidateId = scheduleCandidate?.id || scheduleCandidateId
    const canUseManual = scheduleFirstName.trim() && scheduleLastName.trim()
    if (!scheduleDate || (!selectedCandidateId && !canUseManual)) return
    setScheduleSaving(true)
    setError(null)
    try {
      let candidateId = selectedCandidateId
      if (!candidateId) {
        const createdCandidate = await upsertCandidate({
          first_name: scheduleFirstName.trim(),
          last_name: scheduleLastName.trim(),
          phone: schedulePhone.trim() || undefined,
          custom_field_1: scheduleSalary.trim() || undefined,
          custom_field_2: scheduleSalaryType,
          applied_department_id: scheduleDepartmentId || undefined,
          applied_position: scheduleAppliedPosition.trim() || undefined,
          portfolio_url: schedulePortfolio.trim() || undefined,
          nickname: scheduleNickname.trim() || undefined,
          status: 'scheduled',
          source: 'manual-appointment',
        })
        candidateId = createdCandidate.id
      } else {
        await upsertCandidate({
          id: candidateId,
          first_name: scheduleFirstName.trim() || undefined,
          last_name: scheduleLastName.trim() || undefined,
          nickname: scheduleNickname.trim() || undefined,
          phone: schedulePhone.trim() || undefined,
          custom_field_1: scheduleSalary.trim() || undefined,
          custom_field_2: scheduleSalaryType,
          applied_department_id: scheduleDepartmentId || undefined,
          applied_position: scheduleAppliedPosition.trim() || undefined,
          portfolio_url: schedulePortfolio.trim() || undefined,
        })
      }
      await upsertInterview({
        ...(editingInterviewId ? { id: editingInterviewId } : {}),
        candidate_id: candidateId,
        interview_date: toLocalIso(scheduleDate, scheduleTime),
        location: scheduleLocation || undefined,
        interviewer_ids: scheduleInterviewers,
        status: scheduleStatus,
      })
      // นัดใหม่เท่านั้นที่ดันสถานะผู้สมัครเป็น "นัดสัมภาษณ์"
      // (แก้ไขนัดเดิมไม่ควรย้อนสถานะที่เดินไปแล้ว เช่น สัมภาษณ์แล้ว/ผ่าน)
      if (!editingInterviewId) {
        await upsertCandidate({ id: candidateId, status: 'scheduled' })
      }
      setSuccessMessage(editingInterviewId ? 'แก้ไขนัดสัมภาษณ์แล้ว' : 'นัดสัมภาษณ์แล้ว')
      setScheduleModalOpen(false)
      setScheduleCandidate(null)
      setScheduleCandidateId('')
      setEditingInterviewId(null)
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setScheduleSaving(false)
    }
  }

  /** หัวข้อเกณฑ์เริ่มต้นของตำแหน่งที่ผู้สมัครสมัคร (ว่าง = ยังไม่ได้ตั้งค่าไว้) */
  const defaultCriteriaFor = useCallback(
    (candidate: HRCandidate | undefined) => {
      const posName = candidate?.applied_position?.trim()
      if (!posName) return []
      const posIds = positions.filter((p) => p.name?.trim() === posName).map((p) => p.id)
      if (posIds.length === 0) return []
      return criteriaTemplates
        .filter((t) => t.is_active && posIds.includes(t.position_id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((t) => ({ name: t.name, max_score: t.max_score, score: 0, note: '' }))
    },
    [positions, criteriaTemplates]
  )

  const openScoring = async (interview: HRInterview) => {
    setScoringInterview(interview)
    const candidate = interview.candidate ?? candidateMap.get(interview.candidate_id)
    const preset = defaultCriteriaFor(candidate)
    setCriteriaRows(preset.length > 0 ? preset : [{ name: '', max_score: 10, score: 0, note: '' }])
    setRecommendation('maybe')
    setScoreComments('')
    setError(null)
    try {
      const scores = await fetchInterviewScores(interview.id)
      setExistingScores(scores)
      if (scores.length > 0) {
        const s = scores[0]
        // มีคะแนนเดิมอยู่แล้ว = ใช้ของเดิม ไม่ทับด้วยเกณฑ์เริ่มต้น
        setCriteriaRows(
          s.criteria.length > 0
            ? s.criteria.map((c) => ({
                name: c.name,
                max_score: c.max_score,
                score: c.score ?? 0,
                note: c.note ?? '',
              }))
            : preset.length > 0
              ? preset
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
      await upsertInterview({ id: scoringInterview.id, status: 'attended' })
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

  const handleDeleteInterview = async () => {
    const iv = confirmDeleteInterview
    if (!iv) return
    setDeletingInterviewId(iv.id)
    setError(null)
    try {
      await deleteInterview(iv.id)
      setConfirmDeleteInterview(null)
      setSuccessMessage('ลบนัดสัมภาษณ์แล้ว')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบนัดสัมภาษณ์ไม่สำเร็จ')
    } finally {
      setDeletingInterviewId(null)
    }
  }

  const handleInterviewStatusChange = async (interviewId: string, status: InterviewStatus) => {
    setError(null)
    try {
      await upsertInterview({ id: interviewId, status })
      setInterviews((prev) => prev.map((iv) => (iv.id === interviewId ? { ...iv, status } : iv)))
      setSuccessMessage(`อัปเดตสถานะเป็น "${interviewStatusLabel(status)}" แล้ว`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อัปเดตสถานะไม่สำเร็จ')
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
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSubTab('appointments')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            subTab === 'appointments'
              ? 'bg-emerald-600 text-white'
              : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
          }`}
        >
          รายการนัดสัมภาษณ์
        </button>
        <button
          type="button"
          onClick={() => setSubTab('scoring')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            subTab === 'scoring'
              ? 'bg-emerald-600 text-white'
              : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
          }`}
        >
          สัมภาษณ์และคะแนน
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-soft border border-surface-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-surface-200 flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-surface-800">
            {subTab === 'appointments' ? 'รายการนัดสัมภาษณ์' : 'สัมภาษณ์และคะแนน'}
          </h2>
          {subTab === 'appointments' && (
            <button
              type="button"
              onClick={openCreateScheduleModal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 shadow-soft"
            >
              <FiPlus className="w-4 h-4" />
              สร้างนัดหมาย
            </button>
          )}
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
        ) : subTab === 'appointments' ? (
          <div>
            <div className="px-6 py-4 border-b border-surface-100 flex flex-wrap items-end gap-3">
              <div className="min-w-[220px]">
                <label className="block text-xs text-surface-600 mb-1">ค้นหา</label>
                <input
                  type="text"
                  value={appointmentSearch}
                  onChange={(e) => setAppointmentSearch(e.target.value)}
                  placeholder="ค้นหาผู้สมัคร, ชื่อเล่น, ตำแหน่ง, เบอร์โทร..."
                  className="w-full rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-surface-600 mb-1">วันที่นัด (จาก)</label>
                <input
                  type="date"
                  value={appointmentDateFrom}
                  onChange={(e) => setAppointmentDateFrom(e.target.value)}
                  className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-surface-600 mb-1">ถึงวันที่</label>
                <input
                  type="date"
                  value={appointmentDateTo}
                  onChange={(e) => setAppointmentDateTo(e.target.value)}
                  className="rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setAppointmentSearch('')
                  setAppointmentDateFrom('')
                  setAppointmentDateTo('')
                }}
                className="px-3 py-2 rounded-lg bg-surface-100 text-surface-700 text-sm hover:bg-surface-200"
              >
                ล้างตัวกรอง
              </button>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ลำดับ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ผู้สมัคร</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ชื่อเล่น</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่/เวลานัด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ตำแหน่ง</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เงินเดือน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">Portfolio</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">เบอร์โทร</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {filteredAppointments.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-surface-500 text-sm">
                      ไม่มีรายการ
                    </td>
                  </tr>
                ) : (
                  filteredAppointments.map((iv, idx) => {
                    const candidate = iv.candidate ?? candidateMap.get(iv.candidate_id)
                    return (
                      <tr key={iv.id} className="border-b border-surface-100 hover:bg-surface-50/50 transition-colors">
                        <td className="px-6 py-3 text-sm text-surface-700">{idx + 1}</td>
                        <td className="px-6 py-3 text-sm text-surface-800">
                          {candidate ? candidateName(candidate) : '-'}
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">
                          {candidate?.nickname ?? '-'}
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">{formatDateTime(iv.interview_date)}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">{candidate?.applied_position ?? '-'}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">
                          {candidate?.custom_field_1
                            ? `${Number(candidate.custom_field_1).toLocaleString('th-TH')} ${salaryUnit(salaryTypeOf(candidate))}`
                            : '-'}
                        </td>
                        <td className="px-6 py-3 text-sm">
                          {candidate?.portfolio_url ? (
                            <a
                              href={candidate.portfolio_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-emerald-700 hover:underline"
                            >
                              <FiExternalLink className="w-4 h-4" /> เปิด
                            </a>
                          ) : (
                            <span className="text-surface-500">-</span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">{candidate?.phone ?? '-'}</td>
                        <td className="px-6 py-3">
                          <select
                            value={iv.status}
                            onChange={(e) => void handleInterviewStatusChange(iv.id, e.target.value as InterviewStatus)}
                            className="rounded-lg border border-surface-300 bg-white px-2 py-1.5 text-xs text-surface-700 min-w-[120px]"
                          >
                            {INTERVIEW_STATUS_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openEditScheduleModal(iv)}
                              title="แก้ไขนัดหมาย"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-100 text-surface-700 text-sm hover:bg-surface-200"
                            >
                              <FiEdit2 className="w-4 h-4" /> แก้ไข
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteInterview(iv)}
                              disabled={deletingInterviewId === iv.id}
                              title="ลบนัดหมาย"
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-100 text-red-700 text-sm hover:bg-red-200 disabled:opacity-50"
                            >
                              <FiTrash2 className="w-4 h-4" />
                              {deletingInterviewId === iv.id ? 'กำลังลบ...' : 'ลบ'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
            </div>
          </div>
        ) : subTab === 'scoring' ? (
          <div>
            <div className="px-6 py-4 border-b border-surface-100 flex flex-wrap items-end gap-3">
              <div className="min-w-[260px]">
                <label className="block text-xs text-surface-600 mb-1">ค้นหา</label>
                <input
                  type="text"
                  value={scoringSearch}
                  onChange={(e) => setScoringSearch(e.target.value)}
                  placeholder="ค้นหาผู้สมัคร, ชื่อเล่น, ตำแหน่ง, เบอร์โทร, สถานะ..."
                  className="w-full rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                />
              </div>
              <button
                type="button"
                onClick={() => setScoringSearch('')}
                className="px-3 py-2 rounded-lg bg-surface-100 text-surface-700 text-sm hover:bg-surface-200"
              >
                ล้างตัวกรอง
              </button>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-50 border-b border-surface-200">
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ลำดับ</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ผู้สมัคร</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ชื่อเล่น</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">วันที่/เวลานัด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">ตำแหน่ง</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">Portfolio</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">สถานะนัด</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">คะแนน</th>
                  <th className="px-6 py-3 text-sm font-semibold text-surface-700">จัดการ</th>
                </tr>
              </thead>
              <tbody>
                {filteredScoringInterviews.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center text-surface-500 text-sm">
                      {interviews.length === 0
                        ? 'ยังไม่มีนัดสัมภาษณ์ — สร้างได้ที่แถบ "รายการนัดสัมภาษณ์"'
                        : 'ไม่พบรายการที่ตรงกับคำค้นหา'}
                    </td>
                  </tr>
                ) : (
                  filteredScoringInterviews.map((iv, idx) => {
                    const candidate = iv.candidate ?? candidateMap.get(iv.candidate_id)
                    const score = scoresByInterview.get(iv.id)
                    return (
                      <tr
                        key={iv.id}
                        onClick={() => openScoring(iv)}
                        className="border-b border-surface-100 hover:bg-emerald-50/50 cursor-pointer transition-colors"
                      >
                        <td className="px-6 py-3 text-sm text-surface-700">{idx + 1}</td>
                        <td className="px-6 py-3 text-sm text-surface-800">
                          {candidate ? candidateName(candidate) : '-'}
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">{candidate?.nickname ?? '-'}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">{formatDateTime(iv.interview_date)}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">{candidate?.applied_position ?? '-'}</td>
                        <td className="px-6 py-3 text-sm" onClick={(e) => e.stopPropagation()}>
                          {candidate?.portfolio_url ? (
                            <a
                              href={candidate.portfolio_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-emerald-700 hover:underline"
                            >
                              <FiExternalLink className="w-4 h-4" /> เปิด
                            </a>
                          ) : (
                            <span className="text-surface-500">-</span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-sm text-surface-700">{interviewStatusLabel(iv.status)}</td>
                        <td className="px-6 py-3 text-sm text-surface-700">
                          {score
                            ? `${score.total_score ?? 0}/${score.max_possible ?? 0}`
                            : <span className="text-surface-500">ยังไม่ให้คะแนน</span>}
                        </td>
                        <td className="px-6 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => openScoring(iv)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-100 text-surface-700 text-sm hover:bg-surface-200"
                            >
                              <FiEdit2 className="w-4 h-4" /> {score ? 'แก้ไขคะแนน' : 'ให้คะแนน'}
                            </button>
                            <button
                              type="button"
                              onClick={() => candidate && setDetailCandidate(candidate)}
                              disabled={!candidate}
                              title="ดูข้อมูลผู้สมัคร"
                              aria-label="ดูข้อมูลผู้สมัคร"
                              className="p-1.5 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 disabled:opacity-40"
                            >
                              <FiEye className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => candidate && openImportForCandidate(candidate)}
                              disabled={!candidate}
                              title="นำเข้าข้อมูลบัตรประชาชน"
                              aria-label="นำเข้าข้อมูลบัตรประชาชน"
                              className="p-1.5 rounded-lg bg-surface-100 text-surface-700 hover:bg-surface-200 disabled:opacity-40"
                            >
                              <FiUpload className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
            </div>
          </div>
        ) : null}
      </div>

      {/* ยืนยันลบนัดสัมภาษณ์ */}
      <Modal
        open={!!confirmDeleteInterview}
        onClose={() => setConfirmDeleteInterview(null)}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        {confirmDeleteInterview && (
          <div className="p-6">
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-10 h-10 rounded-full bg-red-100 text-red-600 flex items-center justify-center">
                <FiTrash2 className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-surface-800">ลบนัดสัมภาษณ์</h3>
                <p className="mt-1 text-sm text-surface-700">
                  {(() => {
                    const c =
                      confirmDeleteInterview.candidate ??
                      candidateMap.get(confirmDeleteInterview.candidate_id)
                    return c ? candidateName(c) : 'รายการนี้'
                  })()}{' '}
                  · {formatDateTime(confirmDeleteInterview.interview_date)}
                </p>
                <p className="mt-2 text-sm text-red-700">
                  คะแนนสัมภาษณ์ของนัดนี้จะถูกลบไปด้วย และกู้คืนไม่ได้
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleDeleteInterview}
                disabled={!!deletingInterviewId}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {deletingInterviewId ? 'กำลังลบ...' : 'ลบนัดหมาย'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ดูข้อมูลผู้สมัคร */}
      <Modal open={!!detailCandidate} onClose={() => setDetailCandidate(null)} contentClassName="max-w-2xl" closeOnBackdropClick>
        {detailCandidate && (
          <div className="p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-surface-800">{candidateName(detailCandidate)}</h3>
                <p className="text-sm text-surface-500">
                  {detailCandidate.nickname ? `ชื่อเล่น ${detailCandidate.nickname} · ` : ''}
                  สมัครเมื่อ {formatDate(detailCandidate.created_at)}
                </p>
              </div>
              <span className="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-surface-100 text-surface-700 border border-surface-200">
                {statusLabel(detailCandidate.status)}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-surface-500">แผนก</dt>
                <dd className="text-surface-800">
                  {departments.find((d) => d.id === detailCandidate.applied_department_id)?.name ?? '-'}
                </dd>
              </div>
              <div>
                <dt className="text-surface-500">ตำแหน่งที่สมัคร</dt>
                <dd className="text-surface-800">{detailCandidate.applied_position || '-'}</dd>
              </div>
              <div>
                <dt className="text-surface-500">ค่าจ้าง</dt>
                <dd className="text-surface-800">
                  {detailCandidate.custom_field_1
                    ? `${Number(detailCandidate.custom_field_1).toLocaleString('th-TH')} ${salaryUnit(salaryTypeOf(detailCandidate))}`
                    : '-'}
                </dd>
              </div>
              <div>
                <dt className="text-surface-500">เบอร์โทร</dt>
                <dd className="text-surface-800">{detailCandidate.phone || '-'}</dd>
              </div>
              <div>
                <dt className="text-surface-500">เลขบัตรประชาชน</dt>
                <dd className="text-surface-800">{detailCandidate.citizen_id || '-'}</dd>
              </div>
              <div>
                <dt className="text-surface-500">วันเกิด</dt>
                <dd className="text-surface-800">
                  {detailCandidate.birth_date ? formatDate(detailCandidate.birth_date) : '-'}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-surface-500">ที่อยู่</dt>
                <dd className="text-surface-800">{formatAddress(detailCandidate.address)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-surface-500">Portfolio</dt>
                <dd>
                  {detailCandidate.portfolio_url ? (
                    <a
                      href={detailCandidate.portfolio_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-emerald-700 hover:underline break-all"
                    >
                      <FiExternalLink className="w-4 h-4 shrink-0" /> {detailCandidate.portfolio_url}
                    </a>
                  ) : (
                    <span className="text-surface-500">-</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-surface-500">ประวัตินัดสัมภาษณ์</dt>
                <dd className="text-surface-800">
                  {candidateInterviewHistory.get(detailCandidate.id)?.totalAppointments ?? 0} ครั้ง
                </dd>
              </div>
              <div>
                <dt className="text-surface-500">ประวัติสัมภาษณ์</dt>
                <dd className="text-surface-800">
                  {candidateInterviewHistory.get(detailCandidate.id)?.interviewedCount ?? 0} ครั้ง
                </dd>
              </div>
            </dl>

            <div className="flex justify-end gap-2 pt-2 border-t border-surface-100">
              {detailCandidate.status === 'passed' && (
                <button
                  type="button"
                  onClick={() => {
                    void handleHire(detailCandidate.id)
                    setDetailCandidate(null)
                  }}
                  disabled={!!hiringCandidateId}
                  className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
                >
                  <FiCheck className="w-4 h-4" /> รับเข้าทำงาน
                </button>
              )}
              <button
                type="button"
                onClick={() => setDetailCandidate(null)}
                className="px-4 py-2 rounded-lg bg-surface-100 text-surface-700 text-sm font-medium hover:bg-surface-200"
              >
                ปิด
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Import modal */}
      <Modal
        open={importOpen}
        onClose={() => {
          setImportOpen(false)
          setImportTargetCandidate(null)
        }}
        contentClassName="max-w-4xl"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-2">
            {importTargetCandidate
              ? `นำเข้าข้อมูลบัตรประชาชน → ${candidateName(importTargetCandidate)}`
              : 'นำเข้าข้อมูลผู้สมัคร (Data.txt จาก SIAM-ID)'}
          </h3>
          {importTargetCandidate && (
            <p className="text-sm text-surface-600 mb-3">
              เลือกรายการจากไฟล์ Data.txt 1 รายการ เพื่อเติมเลขบัตร/ที่อยู่/วันเกิด ลงในผู้สมัครคนนี้
              (ตำแหน่ง เงินเดือน ชื่อเล่น และ Portfolio จะไม่ถูกทับ)
            </p>
          )}
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
                พบ {parsedRecords.length} รายการ (ล่าสุดตามเลขบัตร) —{' '}
                {importTargetCandidate ? 'เลือก 1 รายการที่ตรงกับผู้สมัครคนนี้' : 'เลือกรายการที่ต้องการนำเข้า'}
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border border-surface-200">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2">
                        {!importTargetCandidate && (
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
                        )}
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
                            type={importTargetCandidate ? 'radio' : 'checkbox'}
                            name={importTargetCandidate ? 'siam-import-target' : undefined}
                            checked={selectedImportIds.has(r.citizen_id)}
                            onChange={(e) => {
                              // โหมดยิงเข้าผู้สมัครคนเดียว = เลือกได้ทีละรายการ
                              if (importTargetCandidate) {
                                setSelectedImportIds(new Set([r.citizen_id]))
                                return
                              }
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
          setScheduleCandidateId('')
        }}
        contentClassName="max-w-3xl overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        closeOnBackdropClick
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-surface-800 mb-4">
            {editingInterviewId ? 'แก้ไขนัดหมาย' : 'สร้างนัดหมาย'}
          </h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">อ้างอิงผู้สมัครเดิม (ถ้ามี)</label>
              <select
                value={scheduleCandidate ? scheduleCandidate.id : scheduleCandidateId}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) {
                    setScheduleCandidate(null)
                    setScheduleCandidateId('')
                    return
                  }
                  const found = candidateMap.get(id) ?? null
                  setScheduleCandidate(found)
                  setScheduleCandidateId(id)
                  if (found) {
                    setScheduleFirstName(found.first_name ?? '')
                    setScheduleLastName(found.last_name ?? '')
                    setScheduleNickname(found.nickname ?? '')
                    setSchedulePhone(found.phone ?? '')
                    setScheduleSalary(found.custom_field_1 ?? '')
                    setScheduleSalaryType(salaryTypeOf(found))
                    setScheduleDepartmentId(found.applied_department_id ?? '')
                    setScheduleAppliedPosition(found.applied_position ?? '')
                    setSchedulePortfolio(found.portfolio_url ?? '')
                  }
                }}
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              >
                <option value="">-- ไม่เลือก (สร้างผู้สมัครใหม่จากข้อมูลด้านล่าง) --</option>
                {scheduleCandidateOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {candidateName(c)}
                  </option>
                ))}
              </select>
            </div>

            {scheduleCandidate && (
              <div className="rounded-lg border border-surface-200 bg-surface-50 px-3 py-2 text-sm text-surface-700">
                ผู้สมัคร: {candidateName(scheduleCandidate)}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">ชื่อผู้สมัคร *</label>
                <input
                  type="text"
                  value={scheduleFirstName}
                  onChange={(e) => setScheduleFirstName(e.target.value)}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">นามสกุลผู้สมัคร *</label>
                <input
                  type="text"
                  value={scheduleLastName}
                  onChange={(e) => setScheduleLastName(e.target.value)}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">ชื่อเล่น</label>
                <input
                  type="text"
                  value={scheduleNickname}
                  onChange={(e) => setScheduleNickname(e.target.value)}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">เบอร์โทร</label>
                <input
                  type="text"
                  value={schedulePhone}
                  onChange={(e) => setSchedulePhone(e.target.value)}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">แผนก</label>
                <select
                  value={scheduleDepartmentId}
                  onChange={(e) => {
                    const deptId = e.target.value
                    setScheduleDepartmentId(deptId)
                    // ตำแหน่งเดิมอาจไม่อยู่ในแผนกใหม่ — ล้างทิ้งไม่ให้ค้างข้ามแผนก
                    const stillValid = !deptId || positions.some(
                      (p) => p.department_id === deptId && p.name?.trim() === scheduleAppliedPosition.trim()
                    )
                    if (!stillValid) setScheduleAppliedPosition('')
                  }}
                  className="w-full rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">-- เลือกแผนก --</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">ตำแหน่ง</label>
                <select
                  value={scheduleAppliedPosition}
                  onChange={(e) => setScheduleAppliedPosition(e.target.value)}
                  className="w-full rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">-- เลือกตำแหน่ง --</option>
                  {schedulePositionOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">ประเภท</label>
                <select
                  value={scheduleSalaryType}
                  onChange={(e) => setScheduleSalaryType(e.target.value as SalaryType)}
                  className="w-full rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
                >
                  {SALARY_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-surface-700 mb-1">จำนวนเงิน</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={scheduleSalary}
                  onChange={(e) => setScheduleSalary(e.target.value)}
                  placeholder={scheduleSalaryType === 'daily' ? 'เช่น 500' : 'เช่น 18000'}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">ลิงก์ Portfolio</label>
              <input
                type="url"
                value={schedulePortfolio}
                onChange={(e) => setSchedulePortfolio(e.target.value)}
                placeholder="https://..."
                className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div className="mt-3">
                <label className="block text-sm font-medium text-surface-700 mb-1">สถานะ</label>
                <select
                  value={scheduleStatus}
                  onChange={(e) => setScheduleStatus(e.target.value as InterviewStatus)}
                  className="w-full rounded-lg border border-surface-300 px-3 py-2 text-sm"
                >
                  {INTERVIEW_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">ผู้สัมภาษณ์</label>
              <div className="w-full rounded-lg border border-surface-300 bg-white px-1 py-1 text-sm max-h-[120px] overflow-y-auto">
                {interviewerOptions.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={scheduleInterviewers.includes(opt.id)}
                      onChange={() => toggleScheduleInterviewer(opt.id)}
                      className="rounded border-surface-300"
                    />
                    <span className="text-surface-700">{opt.label}</span>
                  </label>
                ))}
                {interviewerOptions.length === 0 && (
                  <p className="px-2 py-2 text-xs text-surface-500">
                    ยังไม่ได้ตั้งค่าผู้สัมภาษณ์ — เพิ่มได้ที่ ตั้งค่า HR → ผู้สัมภาษณ์
                  </p>
                )}
              </div>
            </div>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleScheduleSubmit}
              disabled={
                scheduleSaving ||
                !scheduleDate ||
                (!scheduleCandidate &&
                  !scheduleCandidateId &&
                  (!scheduleFirstName.trim() || !scheduleLastName.trim()))
              }
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
