import { useState, useEffect, useCallback } from 'react'
import { FiPlus, FiChevronDown, FiChevronRight, FiUser, FiBook, FiFileText, FiCheckCircle } from 'react-icons/fi'
import {
  fetchOnboardingPlans,
  upsertOnboardingPlan,
  getOnboardingDetail,
  upsertOnboardingProgress,
  fetchOnboardingTemplates,
  fetchEmployees,
} from '../../lib/hrApi'
import type { HROnboardingPlan, HROnboardingProgress, HROnboardingTemplate, HREmployee } from '../../types'
import Modal from '../ui/Modal'

type PlanWithEmployee = HROnboardingPlan & { employee?: HREmployee & { photo_url?: string } }
type DetailData = {
  plan: HROnboardingPlan
  employee: HREmployee
  mentor: HREmployee | null
  supervisor: HREmployee | null
  manager: HREmployee | null
  template: HROnboardingTemplate
  progress: HROnboardingProgress[]
}

const TASK_TYPE_ICON: Record<string, React.ReactNode> = {
  learn: <FiBook className="w-4 h-4" />,
  read_doc: <FiFileText className="w-4 h-4" />,
  exam: <FiFileText className="w-4 h-4" />,
  evaluate: <FiCheckCircle className="w-4 h-4" />,
}
const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-700',
  in_progress: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
}

export default function OnboardingPlan() {
  const [plans, setPlans] = useState<PlanWithEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailPlanId, setDetailPlanId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [templates, setTemplates] = useState<HROnboardingTemplate[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [createForm, setCreateForm] = useState<{ employee_id: string; template_id: string; mentor_id: string; supervisor_id: string; manager_id: string; start_date: string }>({ employee_id: '', template_id: '', mentor_id: '', supervisor_id: '', manager_id: '', start_date: '' })
  const [createSaving, setCreateSaving] = useState(false)
  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set([0]))
  const [progressSaving, setProgressSaving] = useState<string | null>(null)

  const loadPlans = useCallback(async () => {
    const data = await fetchOnboardingPlans()
    setPlans(data as PlanWithEmployee[])
  }, [])

  useEffect(() => {
    let c = false
    setLoading(true)
    setError(null)
    loadPlans().then(() => { if (!c) setLoading(false) }).catch((e) => { if (!c) { setError(e instanceof Error ? e.message : 'โหลดไม่สำเร็จ'); setLoading(false) } })
    return () => { c = true }
  }, [loadPlans])

  useEffect(() => {
    if (!detailPlanId) { setDetail(null); return }
    setDetailLoading(true)
    getOnboardingDetail(detailPlanId).then(setDetail).catch(() => setDetail(null)).finally(() => setDetailLoading(false))
  }, [detailPlanId])

  const loadCreateData = useCallback(async () => {
    const [t, e] = await Promise.all([fetchOnboardingTemplates(), fetchEmployees()])
    setTemplates(t)
    setEmployees(e)
  }, [])

  const openCreate = () => {
    loadCreateData()
    setCreateForm({ employee_id: '', template_id: '', mentor_id: '', supervisor_id: '', manager_id: '', start_date: new Date().toISOString().slice(0, 10) })
    setCreateOpen(true)
  }

  const expectedEndFromTemplate = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId)
    if (!t || !createForm.start_date) return undefined
    const phases = t.phases ?? []
    let maxDay = 0
    phases.forEach((ph) => { ph.tasks?.forEach((tk) => { if (tk.deadline_day > maxDay) maxDay = tk.deadline_day }) })
    const d = new Date(createForm.start_date)
    d.setDate(d.getDate() + maxDay)
    return d.toISOString().slice(0, 10)
  }

  const handleCreate = async () => {
    if (!createForm.employee_id || !createForm.template_id || !createForm.start_date) return
    setCreateSaving(true)
    setError(null)
    try {
      const expectedEnd = expectedEndFromTemplate(createForm.template_id)
      const plan = await upsertOnboardingPlan({
        employee_id: createForm.employee_id,
        template_id: createForm.template_id,
        mentor_id: createForm.mentor_id || undefined,
        supervisor_id: createForm.supervisor_id || undefined,
        manager_id: createForm.manager_id || undefined,
        start_date: createForm.start_date,
        expected_end_date: expectedEnd,
        status: 'in_progress',
      })
      const detailData = await getOnboardingDetail(plan.id)
      const template = detailData.template
      const progressRows: Partial<HROnboardingProgress>[] = []
      ;(template.phases ?? []).forEach((ph, pi) => {
        (ph.tasks ?? []).forEach((_, ti) => {
          progressRows.push({ plan_id: plan.id, phase_index: pi, task_index: ti, status: 'pending' as const })
        })
      })
      for (const row of progressRows) await upsertOnboardingProgress(row)
      setCreateOpen(false)
      await loadPlans()
      setDetailPlanId(plan.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'สร้างแผนไม่สำเร็จ') } finally { setCreateSaving(false) }
  }

  const updateProgress = async (progressId: string, status: HROnboardingProgress['status'], score?: number, note?: string) => {
    setProgressSaving(progressId)
    try {
      await upsertOnboardingProgress({ id: progressId, status, score, note, evaluated_at: new Date().toISOString(), completed_at: status === 'completed' || status === 'failed' ? new Date().toISOString() : undefined })
      if (detailPlanId) setDetail(await getOnboardingDetail(detailPlanId))
    } finally { setProgressSaving(null) }
  }

  const togglePhase = (idx: number) => {
    setExpandedPhases((s) => { const n = new Set(s); if (n.has(idx)) n.delete(idx); else n.add(idx); return n })
  }

  const empName = (e: HREmployee | null | undefined) => e ? [e.first_name, e.last_name].filter(Boolean).join(' ') : '-'
  const planProgress = (p: PlanWithEmployee) => {
    if (!detail || detail.plan.id !== p.id) return 0
    const total = detail.progress.length
    if (!total) return 0
    const done = detail.progress.filter((x) => x.status === 'completed').length
    return Math.round((done / total) * 100)
  }

  if (loading) return (<div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" /></div>)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">แผนปฐมนิเทศ</h1>
        <button type="button" onClick={openCreate} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 shadow-soft"><FiPlus /> สร้างแผนใหม่</button>
      </div>
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plans.filter((p) => p.status === 'in_progress' || p.status === 'extended').map((plan) => {
          const emp = plan.employee as (HREmployee & { photo_url?: string }) | undefined
          const name = emp ? [emp.first_name, emp.last_name].filter(Boolean).join(' ') : '-'
          const progress = detailPlanId === plan.id && detail ? planProgress(plan) : 0
          return (
            <div key={plan.id} className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4 hover:border-emerald-200 transition-colors">
              <button type="button" onClick={() => setDetailPlanId(plan.id)} className="w-full text-left">
                <div className="flex items-center gap-3 mb-2">
                  {emp?.photo_url ? <img src={emp.photo_url} alt="" className="w-12 h-12 rounded-full object-cover" /> : <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600"><FiUser className="w-6 h-6" /></div>}
                  <div>
                    <p className="font-medium text-gray-900">{name}</p>
                    <p className="text-xs text-gray-500">เริ่ม {plan.start_date} · สิ้นสุดประมาณ {plan.expected_end_date ?? '-'}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className={`px-2 py-0.5 rounded-lg ${plan.status === 'in_progress' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-700'}`}>{plan.status === 'in_progress' ? 'กำลังดำเนินการ' : plan.status}</span>
                  <span className="text-emerald-600 font-medium">{progress}%</span>
                </div>
              </button>
            </div>
          )
        })}
      </div>
      {plans.filter((p) => p.status === 'in_progress' || p.status === 'extended').length === 0 && <p className="text-gray-500 py-8">ไม่มีแผนปฐมนิเทศที่กำลังดำเนินการ</p>}

      <Modal open={!!detailPlanId && !!detail && !detailLoading} onClose={() => setDetailPlanId(null)} contentClassName="max-w-2xl">
        {detail && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">รายละเอียดแผนปฐมนิเทศ</h2>
            <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
              <p><span className="text-gray-500">พนักงาน:</span> {empName(detail.employee)}</p>
              <p><span className="text-gray-500">พี่เลี้ยง:</span> {empName(detail.mentor)}</p>
              <p><span className="text-gray-500">หัวหน้า:</span> {empName(detail.supervisor)}</p>
              <p><span className="text-gray-500">ผู้จัดการ:</span> {empName(detail.manager)}</p>
            </div>
            <div className="space-y-2">
              {(detail.template.phases ?? []).map((ph, pi) => (
                <div key={pi} className="rounded-xl border border-surface-200 bg-white overflow-hidden">
                  <button type="button" onClick={() => togglePhase(pi)} className="w-full flex items-center justify-between px-4 py-3 text-left font-medium text-gray-900">
                    <span>{ph.name}</span>
                    {expandedPhases.has(pi) ? <FiChevronDown className="w-5 h-5" /> : <FiChevronRight className="w-5 h-5" />}
                  </button>
                  {expandedPhases.has(pi) && (
                    <div className="border-t border-surface-100 px-4 pb-3 space-y-2">
                      {(ph.tasks ?? []).map((tk, ti) => {
                        const prog = detail.progress.find((r) => r.phase_index === pi && r.task_index === ti)
                        const status = prog?.status ?? 'pending'
                        const dueDate = prog?.due_date ?? (detail.plan.start_date && tk.deadline_day != null ? (() => { const d = new Date(detail.plan.start_date); d.setDate(d.getDate() + tk.deadline_day); return d.toISOString().slice(0, 10) })() : undefined)
                        return (
                          <div key={ti} className="flex items-center gap-3 rounded-lg bg-surface-50 p-3 text-sm">
                            <span className="text-gray-500">{TASK_TYPE_ICON[tk.type] ?? <FiBook />}</span>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-gray-800">{tk.title}</p>
                              {tk.description && <p className="text-xs text-gray-500">{tk.description}</p>}
                              <p className="text-xs text-gray-500 mt-1">ครบกำหนด: {dueDate ?? '-'} {prog?.score != null && ` · คะแนน ${prog.score}`}</p>
                            </div>
                            <span className={`shrink-0 px-2 py-0.5 rounded-lg text-xs ${STATUS_BADGE[status] ?? 'bg-gray-100'}`}>{status === 'pending' ? 'รอดำเนินการ' : status === 'in_progress' ? 'กำลังทำ' : status === 'completed' ? 'ผ่าน' : 'ไม่ผ่าน'}</span>
                            {(status === 'pending' || status === 'in_progress') && (
                              <div className="flex gap-1">
                                <button type="button" onClick={() => updateProgress(prog!.id, 'completed', tk.passing_score ?? 100)} disabled={progressSaving === prog!.id} className="px-2 py-1 rounded-lg bg-emerald-100 text-emerald-800 text-xs font-medium disabled:opacity-50">ผ่าน</button>
                                <button type="button" onClick={() => updateProgress(prog!.id, 'failed', 0)} disabled={progressSaving === prog!.id} className="px-2 py-1 rounded-lg bg-red-100 text-red-800 text-xs font-medium disabled:opacity-50">ไม่ผ่าน</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" onClick={() => setDetailPlanId(null)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ปิด</button></div>
          </div>
        )}
      </Modal>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} contentClassName="max-w-lg">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">สร้างแผนปฐมนิเทศ</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">พนักงาน *</label>
              <select value={createForm.employee_id} onChange={(e) => setCreateForm((f) => ({ ...f, employee_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{[emp.first_name, emp.last_name].filter(Boolean).join(' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">เทมเพลต *</label>
              <select value={createForm.template_id} onChange={(e) => setCreateForm((f) => ({ ...f, template_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">พี่เลี้ยง</label>
              <select value={createForm.mentor_id} onChange={(e) => setCreateForm((f) => ({ ...f, mentor_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{[emp.first_name, emp.last_name].filter(Boolean).join(' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หัวหน้า</label>
              <select value={createForm.supervisor_id} onChange={(e) => setCreateForm((f) => ({ ...f, supervisor_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{[emp.first_name, emp.last_name].filter(Boolean).join(' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ผู้จัดการ</label>
              <select value={createForm.manager_id} onChange={(e) => setCreateForm((f) => ({ ...f, manager_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.map((emp) => <option key={emp.id} value={emp.id}>{[emp.first_name, emp.last_name].filter(Boolean).join(' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันเริ่ม *</label>
              <input type="date" value={createForm.start_date} onChange={(e) => setCreateForm((f) => ({ ...f, start_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
              {createForm.template_id && expectedEndFromTemplate(createForm.template_id) && <p className="text-xs text-gray-500 mt-1">สิ้นสุดประมาณ: {expectedEndFromTemplate(createForm.template_id)}</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button type="button" onClick={() => setCreateOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ยกเลิก</button>
            <button type="button" onClick={handleCreate} disabled={createSaving || !createForm.employee_id || !createForm.template_id || !createForm.start_date} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{createSaving ? 'กำลังสร้าง...' : 'สร้างแผน'}</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
