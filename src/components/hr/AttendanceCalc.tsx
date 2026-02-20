import React, { useState, useEffect, useCallback } from 'react'
import { FiUpload, FiChevronDown, FiChevronRight, FiCalendar, FiSave, FiAlertCircle } from 'react-icons/fi'
import {
  parseNewBuildingExcel,
  parseOldBuildingExcel,
  batchUpsertAttendance,
  fetchAttendanceUploads,
  fetchAttendanceSummary,
  fetchAttendanceDaily,
  uploadHRFile,
} from '../../lib/hrApi'
import type { HRAttendanceUpload, HRAttendanceSummary, HRAttendanceDaily } from '../../types'
import type { ParsedAttendanceResult } from '../../lib/hrApi'
import { supabase } from '../../lib/supabase'

const BUCKET = 'hr-attendance'

const ACCEPT = '.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function SummaryTable({
  summaries,
  dailiesByFpId,
  expandable = true,
}: {
  summaries: (HRAttendanceSummary | Record<string, unknown>)[]
  dailiesByFpId?: Map<string, HRAttendanceDaily[] | Record<string, unknown>[]>
  expandable?: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-emerald-200 bg-white shadow-soft">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-emerald-200 bg-emerald-50/80">
            {expandable && <th className="w-10 p-2" />}
            <th className="p-2 font-semibold text-emerald-900">ชื่อ</th>
            <th className="p-2 font-semibold text-emerald-900">แผนก</th>
            <th className="p-2 font-semibold text-emerald-900">ชั่วโมงทำงาน</th>
            <th className="p-2 font-semibold text-emerald-900">มาสาย(ครั้ง)</th>
            <th className="p-2 font-semibold text-emerald-900">นาทีมาสาย</th>
            <th className="p-2 font-semibold text-emerald-900">ขาด(วัน)</th>
            <th className="p-2 font-semibold text-emerald-900">ลา(วัน)</th>
            <th className="p-2 font-semibold text-emerald-900">OT</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((row) => {
            const fpId = (row.fingerprint_id ?? row.employee_name ?? '') as string
            const key = fpId + '_' + (row.period_start ?? '')
            const isExpanded = expandable && expanded.has(key)
            const dailies = dailiesByFpId?.get(fpId) ?? []

            return (
              <React.Fragment key={key}>
                <tr
                  key={key}
                  className="border-b border-emerald-100 hover:bg-emerald-50/50"
                >
                  {expandable && (
                    <td className="p-2">
                      {dailies.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          className="text-emerald-600 hover:text-emerald-800"
                        >
                          {isExpanded ? <FiChevronDown /> : <FiChevronRight />}
                        </button>
                      ) : null}
                    </td>
                  )}
                  <td className="p-2">{(row as Record<string, unknown>).employee_name as string}</td>
                  <td className="p-2">{(row as Record<string, unknown>).department as string}</td>
                  <td className="p-2">
                    {(row as Record<string, unknown>).actual_hours != null
                      ? Number((row as Record<string, unknown>).actual_hours).toFixed(1)
                      : '-'}
                  </td>
                  <td className="p-2">{(row as Record<string, unknown>).late_count ?? 0}</td>
                  <td className="p-2">{(row as Record<string, unknown>).late_minutes ?? 0}</td>
                  <td className="p-2">{(row as Record<string, unknown>).absent_days ?? 0}</td>
                  <td className="p-2">{(row as Record<string, unknown>).leave_days ?? 0}</td>
                  <td className="p-2">
                    {(row as Record<string, unknown>).overtime_hours != null
                      ? Number((row as Record<string, unknown>).overtime_hours).toFixed(1)
                      : '-'}
                  </td>
                </tr>
                {isExpanded && dailies.length > 0 && (
                  <tr key={`${key}-detail`} className="bg-emerald-50/30">
                    <td colSpan={9} className="p-3">
                      <div className="rounded-lg border border-emerald-200 bg-white p-2 text-xs">
                        <div className="mb-1 font-semibold text-emerald-800">รายวัน</div>
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-emerald-200">
                              <th className="py-1 pr-2">วันที่</th>
                              <th className="py-1 pr-2">กะ</th>
                              <th className="py-1 pr-2">เข้า</th>
                              <th className="py-1 pr-2">ออก</th>
                              <th className="py-1 pr-2">มาสาย(นาที)</th>
                              <th className="py-1 pr-2">ออกก่อน(นาที)</th>
                              <th className="py-1 pr-2">หมายเหตุ</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dailies.map((d: Record<string, unknown>) => (
                              <tr key={String(d.work_date)} className="border-b border-emerald-100">
                                <td className="py-1 pr-2">{String(d.work_date ?? '')}</td>
                                <td className="py-1 pr-2">{String(d.shift_code ?? '-')}</td>
                                <td className="py-1 pr-2">{String(d.clock_in ?? '-')}</td>
                                <td className="py-1 pr-2">{String(d.clock_out ?? '-')}</td>
                                <td className="py-1 pr-2">{Number(d.late_minutes ?? 0)}</td>
                                <td className="py-1 pr-2">{Number(d.early_minutes ?? 0)}</td>
                                <td className="py-1 pr-2">
                                  {d.is_absent ? 'ขาด' : d.is_holiday ? 'หยุด' : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DropZone({
  label,
  accept,
  onFile,
  disabled,
}: {
  label: string
  accept: string
  onFile: (file: File) => void
  disabled?: boolean
}) {
  const [drag, setDrag] = useState(false)

  const handleFile = (file: File) => {
    const ext = file.name.toLowerCase().replace(/.*\./, '')
    if (ext !== 'xls' && ext !== 'xlsx') return
    onFile(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
        drag ? 'border-emerald-500 bg-emerald-50' : 'border-emerald-200 bg-emerald-50/50'
      } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <FiUpload className="mx-auto mb-2 text-2xl text-emerald-600" />
      <p className="font-medium text-emerald-900">{label}</p>
      <p className="text-xs text-emerald-700">.xls / .xlsx</p>
      <input
        type="file"
        accept={accept}
        className="mt-2 block w-full text-sm text-emerald-700 file:mr-2 file:rounded-lg file:border-0 file:bg-emerald-600 file:px-3 file:py-1.5 file:text-white file:hover:bg-emerald-700"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
          e.target.value = ''
        }}
        disabled={disabled}
      />
    </div>
  )
}

export default function AttendanceCalc() {
  const [uploads, setUploads] = useState<HRAttendanceUpload[]>([])
  const [loadingUploads, setLoadingUploads] = useState(true)
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null)
  const [historySummaries, setHistorySummaries] = useState<HRAttendanceSummary[]>([])
  const [historyDailies, setHistoryDailies] = useState<HRAttendanceDaily[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  const [parsed, setParsed] = useState<ParsedAttendanceResult | null>(null)
  const [parseFile, setParseFile] = useState<File | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadUploads = useCallback(async () => {
    setLoadingUploads(true)
    try {
      const list = await fetchAttendanceUploads()
      setUploads(list)
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingUploads(false)
    }
  }, [])

  useEffect(() => {
    loadUploads()
  }, [loadUploads])

  const loadHistory = useCallback(async (uploadId: string) => {
    setSelectedUploadId(uploadId)
    setLoadingHistory(true)
    setHistorySummaries([])
    setHistoryDailies([])
    try {
      const [summaries, dailies] = await Promise.all([
        fetchAttendanceSummary(uploadId),
        fetchAttendanceDaily(uploadId),
      ])
      setHistorySummaries(summaries)
      setHistoryDailies(dailies)
    } catch (e) {
      console.error(e)
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  const handleNewBuildingFile = async (file: File) => {
    setParseError(null)
    setParsed(null)
    setParseFile(file)
    try {
      const buf = await file.arrayBuffer()
      const result = parseNewBuildingExcel(buf)
      setParsed(result)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'อ่านไฟล์ตึกใหม่ไม่สำเร็จ')
    }
  }

  const handleOldBuildingFile = async (file: File) => {
    setParseError(null)
    setParsed(null)
    setParseFile(file)
    try {
      const buf = await file.arrayBuffer()
      const result = parseOldBuildingExcel(buf)
      setParsed(result)
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'อ่านไฟล์ตึกเก่าไม่สำเร็จ')
    }
  }

  const handleSave = async () => {
    if (!parsed || !parseFile) return
    setSaveError(null)
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const path = `attendance/${Date.now()}_${parseFile.name}`
      await uploadHRFile(BUCKET, path, parseFile)
      const fileUrl = path

      const uploadRecord: Record<string, unknown> = {
        source: parsed.source,
        period_start: parsed.periodStart,
        period_end: parsed.periodEnd,
        file_url: fileUrl,
        uploaded_by: user?.id ?? null,
        row_count: parsed.summaries.length,
      }
      await batchUpsertAttendance(uploadRecord, parsed.summaries, parsed.dailies)
      setParsed(null)
      setParseFile(null)
      setParseError(null)
      loadUploads()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const dailiesByFpId = parsed
    ? (() => {
        const map = new Map<string, Record<string, unknown>[]>()
        for (const d of parsed.dailies) {
          const fpId = (d.fingerprint_id ?? '') as string
          if (!map.has(fpId)) map.set(fpId, [])
          map.get(fpId)!.push(d)
        }
        return map
      })()
    : undefined

  const historyDailiesByFpId = (() => {
    const map = new Map<string, HRAttendanceDaily[]>()
    for (const d of historyDailies) {
      const fpId = d.fingerprint_id ?? ''
      if (!map.has(fpId)) map.set(fpId, [])
      map.get(fpId)!.push(d)
    }
    return map
  })()

  return (
    <div className="space-y-6 rounded-xl bg-white p-6 shadow-soft">
      <h2 className="text-lg font-semibold text-emerald-900">คำนวณเวลาทำงาน (จากไฟล์สแกนลายนิ้วมือ)</h2>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DropZone
          label="ตึกใหม่"
          accept={ACCEPT}
          onFile={handleNewBuildingFile}
          disabled={saving}
        />
        <DropZone
          label="ตึกเก่า"
          accept={ACCEPT}
          onFile={handleOldBuildingFile}
          disabled={saving}
        />
      </div>

      {parseError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-red-800">
          <FiAlertCircle />
          {parseError}
        </div>
      )}

      {parsed && (
        <>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-emerald-800">
              <FiCalendar />
              <span>
                {parsed.periodStart} ~ {parsed.periodEnd}
              </span>
              <span className="text-emerald-600">
                ({parsed.source === 'new_building' ? 'ตึกใหม่' : 'ตึกเก่า'})
              </span>
            </div>
          </div>
          <SummaryTable
            summaries={parsed.summaries}
            dailiesByFpId={dailiesByFpId}
            expandable
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 font-medium text-white shadow-soft hover:bg-emerald-700 disabled:opacity-50"
            >
              <FiSave />
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
            {saveError && (
              <span className="text-sm text-red-600">{saveError}</span>
            )}
          </div>
        </>
      )}

      <section className="border-t border-emerald-200 pt-6">
        <h3 className="mb-3 text-base font-semibold text-emerald-900">ประวัติการอัปโหลด</h3>
        {loadingUploads ? (
          <p className="text-sm text-emerald-700">กำลังโหลด...</p>
        ) : uploads.length === 0 ? (
          <p className="text-sm text-emerald-600">ยังไม่มีประวัติ</p>
        ) : (
          <ul className="space-y-2">
            {uploads.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => loadHistory(u.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                    selectedUploadId === u.id
                      ? 'border-emerald-500 bg-emerald-100 text-emerald-900'
                      : 'border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-800'
                  }`}
                >
                  <span className="font-medium">
                    {u.period_start} ~ {u.period_end}
                  </span>
                  <span className="ml-2 text-emerald-600">
                    ({u.source === 'new_building' ? 'ตึกใหม่' : 'ตึกเก่า'})
                  </span>
                  {u.row_count != null && (
                    <span className="ml-2 text-emerald-500">({u.row_count} คน)</span>
                  )}
                </button>
                {selectedUploadId === u.id && (
                  <div className="mt-2 pl-2">
                    {loadingHistory ? (
                      <p className="text-sm text-emerald-600">กำลังโหลด...</p>
                    ) : (
                      <SummaryTable
                        summaries={historySummaries}
                        dailiesByFpId={historyDailiesByFpId}
                        expandable
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
