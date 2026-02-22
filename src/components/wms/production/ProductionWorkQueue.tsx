import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../../../lib/supabase'
import {
  PlanSettingsData,
  PlanJob,
  defaultSettings,
  nowISO,
  sameDay,
  fmtLocalHHMM,
  fmtCutTime,
  secToHHMM,
  getEffectiveQty,
  getJobStatusForDept,
  computePlanTimeline,
} from '../../../lib/planUtils'

type ModalState = {
  type: 'confirm' | 'alert'
  message: string
} | null

export default function ProductionWorkQueue() {
  const [settings, setSettings] = useState<PlanSettingsData>(defaultSettings)
  const [jobs, setJobs] = useState<PlanJob[]>([])
  const [loading, setLoading] = useState(true)
  const [depDate, setDepDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [depFilter, setDepFilter] = useState('ALL')
  const [hideCompleted, setHideCompleted] = useState(true)
  const [expandedJob, setExpandedJob] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null)

  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve
      setModal({ type: 'confirm', message })
    })
  }, [])

  const showAlert = useCallback((message: string) => {
    setModal({ type: 'alert', message })
  }, [])

  const handleModalAction = useCallback((result: boolean) => {
    confirmResolveRef.current?.(result)
    confirmResolveRef.current = null
    setModal(null)
  }, [])

  const selectableDepts = settings.departments.filter((d) => !['เบิก', 'QC', 'PACK'].includes(d))

  useEffect(() => {
    if (depFilter !== 'ALL' && depFilter && !selectableDepts.includes(depFilter)) {
      setDepFilter('ALL')
    }
  }, [depFilter, selectableDepts])

  const load = useCallback(async () => {
    try {
      const [settingsRes, jobsRes] = await Promise.all([
        supabase.from('plan_settings').select('data').eq('id', 1).single(),
        supabase.from('plan_jobs').select('*').order('order_index'),
      ])
      const loadedSettings = settingsRes.data?.data
        ? { ...defaultSettings, ...settingsRes.data.data }
        : defaultSettings
      setSettings(loadedSettings)
      setJobs((jobsRes.data || []) as PlanJob[])
    } catch (e) {
      console.error('ProductionWorkQueue load error:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const channel = supabase
      .channel('prod-queue-plan-jobs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plan_jobs' }, () => {
        supabase
          .from('plan_jobs')
          .select('*')
          .order('order_index')
          .then(({ data }) => data && setJobs(data as PlanJob[]))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const markStart = useCallback(
    async (jobId: string, dept: string, proc: string) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const t = job.tracks?.[dept]?.[proc]
      if (t?.start && !(await showConfirm('มีเวลาเริ่มอยู่แล้ว ต้องการแทนที่?'))) return
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: { [proc]: { start: nowISO() } },
      })
      if (error) {
        showAlert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
    },
    [jobs, showConfirm, showAlert]
  )

  const markEnd = useCallback(
    async (jobId: string, dept: string, proc: string) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const t = job.tracks?.[dept]?.[proc]
      if (!t?.start && !(await showConfirm('ยังไม่กดเริ่ม จะบันทึกเสร็จเลยหรือไม่?'))) return
      const now = nowISO()
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: { [proc]: { start_if_null: now, end: now } },
      })
      if (error) {
        showAlert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
    },
    [jobs, showConfirm, showAlert]
  )

  const backStep = useCallback(
    async (jobId: string, dept: string) => {
      const job = jobs.find((j) => j.id === jobId)
      if (!job) return
      const procs = (settings.processes[dept] || []).map((p) => p.name)
      const tracks = job.tracks?.[dept] || {}
      let currentIndex = procs.findIndex((p) => !tracks[p]?.end)
      let patch: Record<string, Record<string, string | null>> | null = null

      if (currentIndex === -1 && procs.length > 0) {
        const lastProc = procs[procs.length - 1]
        if (!(await showConfirm(`ยกเลิกการเสร็จสิ้นของขั้นตอน "${lastProc}"?`))) return
        patch = { [lastProc]: { end: null } }
      } else if (currentIndex >= 0) {
        const currentProc = procs[currentIndex]
        const t = tracks[currentProc] || { start: null, end: null }
        if (t.start) {
          if (!(await showConfirm(`ล้างเวลาเริ่มของขั้นตอน "${currentProc}"?`))) return
          patch = { [currentProc]: { start: null, end: null } }
        } else if (currentIndex > 0) {
          const prevProc = procs[currentIndex - 1]
          if (!(await showConfirm(`ยกเลิกการเสร็จสิ้นของขั้นตอน "${prevProc}"?`))) return
          patch = { [prevProc]: { end: null } }
        }
      }
      if (!patch) return
      const { data: newTracks, error } = await supabase.rpc('merge_plan_tracks', {
        p_job_id: jobId,
        p_dept: dept,
        p_patch: patch,
      })
      if (error) {
        showAlert('บันทึกข้อมูลไม่สำเร็จ! ' + error.message)
        return
      }
      const deptTracks = newTracks?.[dept] || {}
      const stillHasStart = Object.entries(deptTracks)
        .filter(([key]) => key !== 'เตรียมไฟล์')
        .some(([, t]: [string, any]) => t?.start)

      if (!stillHasStart && job.locked_plans?.[dept]) {
        const newLocked = { ...(job.locked_plans || {}) }
        delete newLocked[dept]
        await supabase.from('plan_jobs').update({ locked_plans: newLocked }).eq('id', jobId)
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks, locked_plans: newLocked } : j)))
      } else {
        setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, tracks: newTracks } : j)))
      }
    },
    [jobs, settings, showConfirm, showAlert]
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-400" />
      </div>
    )
  }

  const dept = depFilter
  const jobsOnDate = dept && dept !== 'ALL'
    ? jobs
        .filter((j) => sameDay(j.date, depDate) && getEffectiveQty(j, dept, settings) > 0)
        .sort((a, b) => a.order_index - b.order_index)
    : []
  const timeline = dept && dept !== 'ALL' ? computePlanTimeline(dept, depDate, settings, jobs) : []
  const linesCount = dept && dept !== 'ALL' ? Math.max(1, settings.linesPerDept?.[dept] ?? 1) : 1
  const processNames = dept && dept !== 'ALL' ? (settings.processes[dept] || []).map((p) => p.name) : []
  const workflowLabel = processNames.length ? processNames.join(' → ') : '-'

  const lineJobs: PlanJob[][] = Array.from({ length: linesCount }, () => [])
  jobsOnDate.forEach((j) => {
    if (hideCompleted && getJobStatusForDept(j, dept, settings).key === 'done') return
    const lineIdx = j.line_assignments?.[dept] ?? 0
    const idx = Math.min(lineIdx, lineJobs.length - 1)
    lineJobs[idx].push(j)
  })

  return (
    <div className="p-3 space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[130px]">
          <label className="block text-xs text-gray-400 mb-1">วันที่</label>
          <input
            type="date"
            value={depDate}
            onChange={(e) => setDepDate(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white"
          />
        </div>
        <div className="flex-1 min-w-[150px]">
          <label className="block text-xs text-gray-400 mb-1">แผนก</label>
          <select
            value={depFilter}
            onChange={(e) => setDepFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white"
          >
            <option value="ALL">-- เลือกแผนก --</option>
            {selectableDepts.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 cursor-pointer py-2">
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={(e) => setHideCompleted(e.target.checked)}
            className="rounded border-slate-500 bg-slate-700 text-blue-500"
          />
          <span className="text-xs text-gray-300">ซ่อนงานเสร็จ</span>
        </label>
      </div>

      {(!dept || dept === 'ALL') ? (
        <p className="text-center text-gray-500 py-12">กรุณาเลือกแผนกเพื่อเริ่มงาน</p>
      ) : (
        <>
          {/* Department info */}
          <div className="rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-sm text-white">แผนก: {dept}</span>
            <span className="text-xs text-gray-400 bg-slate-700 px-2 py-1 rounded-full">{workflowLabel}</span>
          </div>

          {/* Queue by line */}
          {Array.from({ length: linesCount }, (_, lineIdx) => (
            <div key={lineIdx} className="rounded-xl border border-slate-700 bg-slate-800/50 p-2">
              {linesCount > 1 && (
                <h3 className="mb-2 border-b border-slate-700 pb-1.5 font-semibold text-sm text-gray-300">
                  Line {lineIdx + 1}
                </h3>
              )}
              <div className="flex flex-col gap-2">
                {lineJobs[lineIdx].length === 0 && (
                  <p className="text-center text-gray-600 text-xs py-4">ไม่มีงาน</p>
                )}
                {lineJobs[lineIdx].map((j) => {
                  const jtl = timeline.find((x) => x.id === j.id)
                  const tracks = j.tracks?.[dept] || {}
                  const currentProc = processNames.find((p) => !tracks[p]?.end)
                  const isAllDone = processNames.length > 0 && !currentProc
                  const t = currentProc ? tracks[currentProc] : null
                  const startTime = t?.start ? fmtLocalHHMM(t.start) : '--:--'
                  const isStarted = !!t?.start
                  const expKey = `${dept}_${j.id}`
                  const isExpanded = expandedJob === expKey

                  return (
                    <div
                      key={j.id}
                      className={`rounded-xl border p-3 ${
                        isAllDone
                          ? 'bg-green-900/30 border-green-700'
                          : isStarted
                          ? 'bg-blue-900/30 border-blue-700'
                          : 'bg-slate-800 border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-base text-white">{j.name}</div>
                          <div className="text-xs text-gray-400 mt-0.5">
                            ตัด: {fmtCutTime(j.cut)} | Qty: <b className="text-gray-200">{getEffectiveQty(j, dept, settings)}</b>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setExpandedJob(isExpanded ? null : expKey)}
                          className="shrink-0 rounded-lg border border-slate-600 bg-slate-700 px-2.5 py-1 text-xs font-medium text-gray-300 hover:bg-slate-600"
                        >
                          {isExpanded ? 'ปิด' : 'ประวัติ'}
                        </button>
                      </div>

                      <div className="mt-1.5 text-xs text-gray-500">
                        แผน: {jtl ? secToHHMM(jtl.start) : '--:--'} - {jtl ? secToHHMM(jtl.end) : '--:--'}
                      </div>

                      {isAllDone ? (
                        <div className="mt-3 space-y-2">
                          <div className="rounded-xl border border-green-700 bg-green-800/50 py-2 text-center text-sm font-bold text-green-300">
                            ✓ เสร็จสมบูรณ์
                          </div>
                          <button
                            type="button"
                            onClick={() => backStep(j.id, dept)}
                            className="w-full rounded-lg border border-yellow-700 bg-yellow-900/40 py-2 text-sm font-medium text-yellow-300 hover:bg-yellow-800/60 active:bg-yellow-800"
                          >
                            ↺ แก้ไข/ย้อนขั้นตอน
                          </button>
                        </div>
                      ) : currentProc ? (
                        <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/50 p-2.5">
                          {!isStarted ? (
                            <button
                              type="button"
                              onClick={() => markStart(j.id, dept, currentProc)}
                              className="w-full rounded-lg bg-blue-600 py-3 text-base font-bold text-white hover:bg-blue-700 active:bg-blue-800"
                            >
                              เริ่ม: {currentProc}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => markEnd(j.id, dept, currentProc)}
                              className="w-full rounded-lg bg-green-600 py-3 text-base font-bold text-white hover:bg-green-700 active:bg-green-800"
                            >
                              เสร็จ: {currentProc}
                            </button>
                          )}
                          <div className="mt-2 flex justify-between border-t border-dashed border-slate-700 pt-2 text-[11px] text-gray-400">
                            <span>เวลาเริ่ม: <b className="text-blue-400">{startTime}</b></span>
                            <span>สถานะ: <b>{isStarted ? 'กำลังทำ...' : 'รอเริ่ม'}</b></span>
                          </div>
                        </div>
                      ) : null}

                      {/* History */}
                      {isExpanded && (
                        <div className="mt-3 space-y-1 border-t border-slate-700 pt-3">
                          {processNames.map((pName) => {
                            const tr = tracks[pName] || {}
                            const icon = tr.end ? '✅' : tr.start ? '⏳' : '⚪'
                            return (
                              <div
                                key={pName}
                                className="flex items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px]"
                              >
                                <span className="flex items-center gap-1 text-white">
                                  <b>{pName}</b> <span>{icon}</span>
                                </span>
                                <span className="text-gray-400 shrink-0">
                                  เริ่ม: {tr.start ? fmtLocalHHMM(tr.start) : '-'} | เสร็จ: {tr.end ? fmtLocalHHMM(tr.end) : '-'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </>
      )}
      {/* Confirm / Alert Modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-600 bg-slate-800 shadow-2xl">
            <div className="px-5 pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                  modal.type === 'alert'
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-yellow-500/20 text-yellow-400'
                }`}>
                  {modal.type === 'alert' ? (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-white">
                    {modal.type === 'alert' ? 'แจ้งเตือน' : 'ยืนยันการดำเนินการ'}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-gray-300">{modal.message}</p>
                </div>
              </div>
            </div>
            <div className={`flex gap-3 border-t border-slate-700 px-5 py-3.5 ${
              modal.type === 'alert' ? 'justify-end' : 'justify-end'
            }`}>
              {modal.type === 'confirm' ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleModalAction(false)}
                    className="rounded-lg border border-slate-600 bg-slate-700 px-5 py-2 text-sm font-medium text-gray-300 hover:bg-slate-600 active:bg-slate-500 transition-colors"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={() => handleModalAction(true)}
                    className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-bold text-white hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ตกลง
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleModalAction(false)}
                  className="rounded-lg bg-blue-600 px-6 py-2 text-sm font-bold text-white hover:bg-blue-700 active:bg-blue-800 transition-colors"
                >
                  ตกลง
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
