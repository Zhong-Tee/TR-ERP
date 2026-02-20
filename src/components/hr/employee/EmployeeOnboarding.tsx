import { useState, useEffect, useCallback } from 'react'
import { FiBookOpen, FiFileText, FiCheckCircle, FiChevronDown, FiChevronUp } from 'react-icons/fi'
import {
  fetchEmployeeByUserId,
  fetchOnboardingPlans,
  getOnboardingDetail,
  markDocumentRead,
  submitExamResult,
  fetchExams,
  fetchDocumentById,
  getHRFileUrl,
} from '../../../lib/hrApi'
import { useAuthContext } from '../../../contexts/AuthContext'
import type { HROnboardingPlan, HROnboardingProgress, HRExam, HREmployee } from '../../../types'

const BUCKET_DOCS = 'hr-docs'

type TemplatePhase = {
  name: string
  day_start: number
  day_end: number
  tasks: {
    title: string
    description?: string
    type: 'learn' | 'read_doc' | 'exam' | 'evaluate'
    doc_id?: string
    exam_id?: string
    deadline_day: number
    passing_score?: number
  }[]
}

type Detail = {
  plan: HROnboardingPlan
  employee: HREmployee
  mentor: HREmployee | null
  supervisor: HREmployee | null
  manager: HREmployee | null
  template: { name?: string; phases?: TemplatePhase[] }
  progress: (HROnboardingProgress & { due_date?: string })[]
}

function taskTypeIcon(type: string) {
  switch (type) {
    case 'read_doc': return <FiFileText className="w-5 h-5 text-blue-500" />
    case 'exam': return <FiBookOpen className="w-5 h-5 text-amber-500" />
    case 'evaluate': return <FiCheckCircle className="w-5 h-5 text-gray-500" />
    default: return <FiBookOpen className="w-5 h-5 text-gray-500" />
  }
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-600',
    in_progress: 'bg-amber-100 text-amber-800',
    completed: 'bg-emerald-100 text-emerald-800',
    failed: 'bg-red-100 text-red-800',
  }
  const labels: Record<string, string> = {
    pending: 'รอดำเนินการ',
    in_progress: 'กำลังทำ',
    completed: 'เสร็จแล้ว',
    failed: 'ไม่ผ่าน',
  }
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${map[status] ?? 'bg-gray-100'}`}>
      {labels[status] ?? status}
    </span>
  )
}

export default function EmployeeOnboarding() {
  const { user } = useAuthContext()
  const [employee, setEmployee] = useState<HREmployee | null>(null)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [phaseOpen, setPhaseOpen] = useState<Record<number, boolean>>({})
  const [examOverlay, setExamOverlay] = useState<{ exam: HRExam; taskProgressId?: string } | null>(null)
  const [examAnswers, setExamAnswers] = useState<Record<number, number>>({})
  const [examSubmitting, setExamSubmitting] = useState(false)
  const [examResult, setExamResult] = useState<{ passed: boolean; score: number; max: number } | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const emp = await fetchEmployeeByUserId(user.id)
      setEmployee(emp)
      if (!emp) {
        setLoading(false)
        return
      }
      const plans = await fetchOnboardingPlans({ employee_id: emp.id, status: 'in_progress' })
      const activePlan = Array.isArray(plans) && plans.length ? plans[0] : null
      if (activePlan) {
        const d = await getOnboardingDetail(activePlan.id)
        setDetail(d)
        setPhaseOpen({ 0: true })
      } else {
        setDetail(null)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    load()
  }, [load])

  const getProgress = (phaseIndex: number, taskIndex: number) =>
    detail?.progress?.find((p) => p.phase_index === phaseIndex && p.task_index === taskIndex)

  const overallProgress = (() => {
    if (!detail?.template?.phases) return 0
    let total = 0
    let done = 0
    detail.template.phases.forEach((ph) => {
      ph.tasks.forEach((_, ti) => {
        total++
        const p = getProgress(detail.template.phases!.indexOf(ph), ti)
        if (p?.status === 'completed') done++
      })
    })
    return total ? Math.round((done / total) * 100) : 0
  })()

  const togglePhase = (idx: number) => {
    setPhaseOpen((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }

  const handleReadDoc = async (docId: string) => {
    if (!employee) return
    try {
      const doc = await fetchDocumentById(docId)
      if (doc.file_url) window.open(getHRFileUrl(BUCKET_DOCS, doc.file_url), '_blank')
      await markDocumentRead(docId, employee.id)
      await load()
    } catch (e) {
      console.error(e)
    }
  }

  const openExam = async (examId: string) => {
    try {
      const exams = await fetchExams()
      const exam = exams.find((e) => e.id === examId)
      if (exam) {
        setExamOverlay({ exam })
        setExamAnswers({})
        setExamResult(null)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const closeExam = () => {
    setExamOverlay(null)
    setExamResult(null)
    load()
  }

  const submitExam = async () => {
    if (!employee || !examOverlay) return
    const exam = examOverlay.exam
    const answers = exam.questions.map((q, idx) => ({
      question_idx: idx,
      answer: examAnswers[idx] ?? -1,
      is_correct: (examAnswers[idx] ?? -1) === q.correct_answer,
    }))
    const score = answers.reduce((s, a, i) => s + (a.is_correct ? (exam.questions[i].score ?? 1) : 0), 0)
    const maxScore = exam.questions.reduce((s, q) => s + (q.score ?? 1), 0)
    const percentage = maxScore ? Math.round((score / maxScore) * 100) : 0
    const passed = percentage >= (exam.passing_score ?? 60)
    setExamSubmitting(true)
    try {
      await submitExamResult({
        exam_id: exam.id,
        employee_id: employee.id,
        answers,
        score,
        max_score: maxScore,
        percentage,
        passed,
      })
      setExamResult({ passed, score, max: maxScore })
    } catch (e) {
      console.error(e)
    } finally {
      setExamSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-emerald-500 border-t-transparent" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm text-center text-gray-500">
        ไม่พบข้อมูลพนักงาน
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="rounded-2xl bg-white border border-gray-200 p-8 shadow-sm text-center">
        <FiBookOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
        <p className="font-medium text-gray-600">ไม่มีแผน Onboarding</p>
        <p className="text-sm text-gray-500 mt-1">คุณยังไม่มีแผน Onboarding ที่กำลังดำเนินการ</p>
      </div>
    )
  }

  const plan = detail.plan as HROnboardingPlan & { mentor?: HREmployee; supervisor?: HREmployee; manager?: HREmployee }
  const mentor = detail.mentor ?? plan.mentor
  const supervisor = detail.supervisor ?? plan.supervisor
  const manager = detail.manager ?? plan.manager
  const name = (e: HREmployee | null | undefined) => e ? [e.first_name, e.last_name].filter(Boolean).join(' ') : '-'

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
        <p className="text-xs text-gray-500 mb-1">Mentor / Supervisor / Manager</p>
        <p className="text-sm text-gray-800">Mentor: {name(mentor)} · Supervisor: {name(supervisor)} · Manager: {name(manager)}</p>
        <div className="mt-3">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-600">ความคืบหน้า</span>
            <span className="font-medium text-emerald-600">{overallProgress}%</span>
          </div>
          <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${overallProgress}%` }} />
          </div>
        </div>
      </section>

      {detail.template?.phases?.map((phase, pidx) => {
        const isOpen = phaseOpen[pidx] ?? false
        const phaseProgress = detail.progress?.filter((p) => p.phase_index === pidx) ?? []
        const completedInPhase = phaseProgress.filter((p) => p.status === 'completed').length
        const totalInPhase = phase.tasks.length
        return (
          <section key={pidx} className="rounded-2xl bg-white border border-gray-200 shadow-sm overflow-hidden">
            <button
              type="button"
              onClick={() => togglePhase(pidx)}
              className="w-full flex items-center justify-between p-4 text-left active:bg-gray-50"
            >
              <div>
                <h3 className="font-semibold text-gray-900">{phase.name}</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  วันที่ {phase.day_start}–{phase.day_end} · {completedInPhase}/{totalInPhase} งาน
                </p>
              </div>
              {isOpen ? <FiChevronUp className="w-5 h-5 text-gray-400" /> : <FiChevronDown className="w-5 h-5 text-gray-400" />}
            </button>
            {isOpen && (
              <div className="border-t border-gray-100 px-4 pb-4 space-y-3">
                {phase.tasks.map((task, tidx) => {
                  const prog = getProgress(pidx, tidx)
                  const isCompleted = prog?.status === 'completed'
                  return (
                    <div key={tidx} className="rounded-xl border border-gray-200 p-3">
                      <div className="flex items-start gap-2">
                        {taskTypeIcon(task.type)}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-gray-900">{task.title}</p>
                          {task.description && <p className="text-xs text-gray-500 mt-0.5">{task.description}</p>}
                          <div className="flex flex-wrap items-center gap-2 mt-2">
                            {prog?.due_date && <span className="text-xs text-gray-500">ครบกำหนด: {prog.due_date}</span>}
                            {statusBadge(prog?.status ?? 'pending')}
                            {isCompleted && prog?.score != null && (
                              <span className="text-xs text-emerald-600">คะแนน: {prog.score}</span>
                            )}
                          </div>
                          {task.type === 'read_doc' && task.doc_id && (
                            <button
                              type="button"
                              onClick={() => handleReadDoc(task.doc_id!)}
                              className="mt-2 rounded-lg bg-blue-100 text-blue-800 px-3 py-1.5 text-sm font-medium active:bg-blue-200"
                            >
                              อ่านเอกสาร
                            </button>
                          )}
                          {task.type === 'exam' && task.exam_id && (
                            <button
                              type="button"
                              onClick={() => openExam(task.exam_id!)}
                              disabled={isCompleted}
                              className="mt-2 rounded-lg bg-amber-100 text-amber-800 px-3 py-1.5 text-sm font-medium active:bg-amber-200 disabled:opacity-60"
                            >
                              ทำข้อสอบ
                            </button>
                          )}
                        </div>
                        {isCompleted && <FiCheckCircle className="w-6 h-6 text-emerald-500 shrink-0" />}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}

      {/* Exam overlay: full-screen on mobile */}
      {examOverlay && (
        <div className="fixed inset-0 z-50 bg-white overflow-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-emerald-600 text-white shadow">
            <h3 className="font-semibold">{examOverlay.exam.title}</h3>
            <button type="button" onClick={closeExam} className="p-2 rounded-lg hover:bg-white/20">
              ปิด
            </button>
          </div>
          <div className="p-4 pb-24">
            {examResult ? (
              <div className="rounded-2xl border-2 p-6 text-center max-w-sm mx-auto">
                <p className={`text-xl font-bold ${examResult.passed ? 'text-emerald-600' : 'text-red-600'}`}>
                  {examResult.passed ? 'ผ่าน' : 'ไม่ผ่าน'}
                </p>
                <p className="text-gray-600 mt-1">คะแนน {examResult.score} / {examResult.max}</p>
                <button
                  type="button"
                  onClick={closeExam}
                  className="mt-4 w-full py-3 rounded-xl bg-emerald-600 text-white font-medium"
                >
                  ปิด
                </button>
              </div>
            ) : (
              <>
                <div className="space-y-6">
                  {examOverlay.exam.questions.map((q, idx) => (
                    <div key={idx} className="rounded-2xl border border-gray-200 p-4">
                      <p className="font-medium text-gray-900 mb-3">{idx + 1}. {q.question}</p>
                      <div className="space-y-2">
                        {q.options.map((opt, oidx) => (
                          <label key={oidx} className="flex items-center gap-2 p-2 rounded-lg border border-gray-200 has-[:checked]:border-emerald-500 has-[:checked]:bg-emerald-50">
                            <input
                              type="radio"
                              name={`q-${idx}`}
                              checked={examAnswers[idx] === oidx}
                              onChange={() => setExamAnswers((a) => ({ ...a, [idx]: oidx }))}
                              className="text-emerald-600"
                            />
                            <span className="text-gray-800">{opt}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={submitExam}
                  disabled={examSubmitting || Object.keys(examAnswers).length < examOverlay.exam.questions.length}
                  className="mt-6 w-full py-4 rounded-2xl bg-emerald-600 text-white font-semibold disabled:opacity-60"
                >
                  {examSubmitting ? 'กำลังส่ง...' : 'ส่งคำตอบ'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
