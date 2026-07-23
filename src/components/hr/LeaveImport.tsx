import { useState, useEffect, useCallback } from 'react'
import { FiX, FiDownload, FiUploadCloud, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import Modal from '../ui/Modal'
import { fetchEmployees, fetchLeaveTypes, fetchLeaveRequests, bulkInsertLeaveRequests } from '../../lib/hrApi'
import type { HREmployee, HRLeaveType } from '../../types'

const HEADERS = ['รหัสพนักงาน', 'ชื่อ-สกุล', 'ประเภทลา', 'วันเริ่ม', 'วันสิ้นสุด', 'จำนวนวัน', 'เหตุผล'] as const

const pad = (n: number) => String(n).padStart(2, '0')

/** แปลงค่าจากเซลล์ (Date / เลข serial ของ Excel / ข้อความ) → 'YYYY-MM-DD' หรือ null */
function normalizeDate(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v)
    if (!d || !d.y) return null
    return `${d.y}-${pad(d.m)}-${pad(d.d)}`
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (m) {
    let y = +m[3]
    if (y > 2500) y -= 543
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`
  }
  return null
}

/** จำนวนวันแบบนับรวมหัวท้าย (fallback เมื่อไม่กรอกจำนวนวัน) */
function inclusiveDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00`).getTime()
  const b = new Date(`${end}T00:00:00`).getTime()
  return Math.floor((b - a) / 86400000) + 1
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '')
const empName = (e: HREmployee) => `${e.first_name} ${e.last_name}${e.nickname ? ` (${e.nickname})` : ''}`

type BuiltLeave = {
  employee_id: string
  code: string
  name: string
  leave_type_id: string
  type_name: string
  start_date: string
  end_date: string
  total_days: number
  daysAuto: boolean
  reason: string
  duplicate: boolean
}
type Parsed = {
  rows: BuiltLeave[]
  issues: { row: number; reason: string }[]
}

export default function LeaveImport({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [leaveTypes, setLeaveTypes] = useState<HRLeaveType[]>([])
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doneCount, setDoneCount] = useState<number | null>(null)

  useEffect(() => {
    if (open) {
      fetchEmployees().then(setEmployees).catch(() => {})
      fetchLeaveTypes().then(setLeaveTypes).catch(() => {})
    }
  }, [open])

  const reset = () => { setFileName(''); setParsed(null); setError(''); setDoneCount(null); setBusy(false) }
  const handleClose = () => { reset(); onClose() }

  const downloadTemplate = () => {
    const active = employees.filter((e) => ['active', 'probation'].includes(e.employment_status))
    const firstType = leaveTypes[0]?.name ?? 'ลาป่วย'
    const wb = XLSX.utils.book_new()

    const ws = XLSX.utils.aoa_to_sheet([
      [...HEADERS],
      ['(ตัวอย่าง) EMP00001', 'จักรกฤษ (ตี้)', firstType, '2026-02-10', '2026-02-11', '2', 'ลบแถวตัวอย่างนี้ก่อนนำเข้า'],
      ['(ตัวอย่าง) EMP00002', 'จุฑารัตน์ (แนน)', leaveTypes[1]?.name ?? 'ลากิจ', '2026-03-05', '2026-03-05', '1', ''],
    ])
    ws['!cols'] = [{ wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(wb, ws, 'ข้อมูล')

    const wsEmp = XLSX.utils.aoa_to_sheet([
      ['รหัสพนักงาน', 'ชื่อ-สกุล', 'แผนก'],
      ...active.map((e) => [
        e.employee_code ?? '', empName(e),
        (e as HREmployee & { department?: { name?: string } }).department?.name ?? '',
      ]),
    ])
    wsEmp['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, wsEmp, 'รายชื่อพนักงาน (อ้างอิง)')

    const wsType = XLSX.utils.aoa_to_sheet([['ประเภทลาที่ใช้ได้'], ...leaveTypes.map((t) => [t.name])])
    wsType['!cols'] = [{ wch: 24 }]
    XLSX.utils.book_append_sheet(wb, wsType, 'ประเภทลา (อ้างอิง)')

    XLSX.writeFile(wb, 'Template_นำเข้าใบลาย้อนหลัง.xlsx')
  }

  const handleFile = useCallback(async (file: File) => {
    setError(''); setDoneCount(null); setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: false })
      if (aoa.length === 0) throw new Error('ไฟล์ว่างเปล่า')

      const headerIdx = aoa.findIndex((r) =>
        r.some((c) => String(c ?? '').includes('รหัส')) && r.some((c) => String(c ?? '').includes('ประเภท')),
      )
      if (headerIdx < 0) throw new Error('ไม่พบหัวตาราง — ต้องมีคอลัมน์ "รหัสพนักงาน" และ "ประเภทลา" (ใช้ Template ที่ดาวน์โหลด)')
      const header = aoa[headerIdx].map((c) => String(c ?? '').trim())
      const findCol = (pred: (h: string) => boolean) => header.findIndex(pred)
      const col = {
        code: findCol((h) => h.includes('รหัส')),
        type: findCol((h) => h.includes('ประเภท')),
        start: findCol((h) => h.includes('เริ่ม')),
        end: findCol((h) => h.includes('สิ้นสุด')),
        days: findCol((h) => h.includes('จำนวน')),
        reason: findCol((h) => h.includes('เหตุผล')),
      }
      if (col.start < 0 || col.end < 0) throw new Error('ไม่พบคอลัมน์ "วันเริ่ม" หรือ "วันสิ้นสุด"')

      const byCode = new Map<string, HREmployee>()
      for (const e of employees) if (e.employee_code) byCode.set(e.employee_code.trim().toUpperCase(), e)
      // map ประเภทลา: ตรงเป๊ะก่อน แล้วค่อย contains
      const typeByNorm = new Map<string, HRLeaveType>()
      for (const t of leaveTypes) typeByNorm.set(norm(t.name), t)
      const matchType = (raw: string): HRLeaveType | undefined => {
        const n = norm(raw)
        if (typeByNorm.has(n)) return typeByNorm.get(n)
        return leaveTypes.find((t) => norm(t.name).includes(n) || n.includes(norm(t.name)))
      }

      const rows: BuiltLeave[] = []
      const issues: { row: number; reason: string }[] = []

      for (let i = headerIdx + 1; i < aoa.length; i++) {
        const r = aoa[i]
        const rawCode = String(r[col.code] ?? '').trim()
        if (!rawCode || rawCode.includes('ตัวอย่าง')) continue
        const rowNum = i + 1

        const emp = byCode.get(rawCode.toUpperCase())
        if (!emp) { issues.push({ row: rowNum, reason: `${rawCode}: ไม่พบรหัสพนักงาน` }); continue }

        const rawType = String(r[col.type] ?? '').trim()
        const lt = matchType(rawType)
        if (!lt) { issues.push({ row: rowNum, reason: `${rawCode}: ไม่พบประเภทลา "${rawType}"` }); continue }

        const start = normalizeDate(r[col.start])
        const end = normalizeDate(r[col.end])
        if (!start || !end) { issues.push({ row: rowNum, reason: `${rawCode}: วันที่ไม่ถูกต้อง` }); continue }
        if (end < start) { issues.push({ row: rowNum, reason: `${rawCode}: วันสิ้นสุดก่อนวันเริ่ม` }); continue }

        const rawDays = col.days >= 0 ? r[col.days] : ''
        let total_days = typeof rawDays === 'number' ? rawDays : parseFloat(String(rawDays ?? '').trim())
        let daysAuto = false
        if (!Number.isFinite(total_days) || total_days <= 0) {
          total_days = inclusiveDays(start, end)
          daysAuto = true
        }

        rows.push({
          employee_id: emp.id,
          code: emp.employee_code ?? rawCode,
          name: empName(emp),
          leave_type_id: lt.id,
          type_name: lt.name,
          start_date: start,
          end_date: end,
          total_days,
          daysAuto,
          reason: col.reason >= 0 ? String(r[col.reason] ?? '').trim() : '',
          duplicate: false,
        })
      }

      if (rows.length === 0 && issues.length === 0) {
        throw new Error('ไม่พบข้อมูลที่นำเข้าได้ — ตรวจว่ากรอกรหัส/ประเภทลา/วันที่ถูกต้อง')
      }

      // ตรวจซ้ำกับใบลาที่มีอยู่ (คน + วันเริ่ม + วันสิ้นสุด + ประเภท)
      if (rows.length > 0) {
        const existing = await fetchLeaveRequests()
        const seen = new Set(
          existing.map((e) => `${e.employee_id}|${e.start_date}|${e.end_date}|${e.leave_type_id}`),
        )
        const inFile = new Set<string>()
        for (const r of rows) {
          const k = `${r.employee_id}|${r.start_date}|${r.end_date}|${r.leave_type_id}`
          if (seen.has(k) || inFile.has(k)) r.duplicate = true
          inFile.add(k)
        }
      }

      setFileName(file.name)
      setParsed({ rows, issues })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อ่านไฟล์ไม่สำเร็จ')
      setParsed(null)
    } finally {
      setBusy(false)
    }
  }, [employees, leaveTypes])

  const toImport = parsed ? parsed.rows.filter((r) => !skipDuplicates || !r.duplicate) : []
  const dupCount = parsed ? parsed.rows.filter((r) => r.duplicate).length : 0

  const doImport = async () => {
    if (toImport.length === 0) return
    setBusy(true); setError('')
    try {
      const payload = toImport.map((r) => ({
        employee_id: r.employee_id,
        leave_type_id: r.leave_type_id,
        start_date: r.start_date,
        end_date: r.end_date,
        total_days: r.total_days,
        reason: r.reason ? `[นำเข้า] ${r.reason}` : '[นำเข้า]',
        status: 'approved' as const,
        leave_mode: 'full_day' as const,
        notified_before: true,
        notified_morning: true,
      }))
      const n = await bulkInsertLeaveRequests(payload)
      setDoneCount(n)
      onImported()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'นำเข้าไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} closeOnBackdropClick contentClassName="max-w-3xl">
      <div className="flex items-center justify-between px-5 py-3.5 bg-emerald-600 text-white flex-shrink-0">
        <span className="font-semibold">นำเข้าใบลาย้อนหลัง (อนุมัติแล้ว)</span>
        <button type="button" onClick={handleClose} aria-label="ปิด"><FiX className="w-5 h-5" /></button>
      </div>

      <div className="p-5 space-y-4">
        {doneCount !== null ? (
          <div className="text-center py-8">
            <FiCheckCircle className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
            <p className="text-lg font-semibold text-gray-800">นำเข้าใบลาสำเร็จ {doneCount} รายการ</p>
            <p className="text-sm text-gray-500 mt-1">ระบบตัดยอดวันลาคงเหลือและปรับ "วันขาดงาน" ให้อัตโนมัติแล้ว</p>
            <button type="button" onClick={handleClose} className="mt-5 px-6 py-2.5 rounded-xl bg-emerald-600 text-white font-medium hover:bg-emerald-700">
              เสร็จสิ้น
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={downloadTemplate} className="flex items-center gap-1.5 px-3.5 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50">
                <FiDownload /> ดาวน์โหลด Template
              </button>
              <label className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 cursor-pointer">
                <FiUploadCloud /> เลือกไฟล์ Excel
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => {
                  const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''
                }} />
              </label>
              {fileName && <span className="text-sm text-gray-500 truncate">📄 {fileName}</span>}
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 space-y-1">
              <p className="font-semibold">วิธีกรอก Template (1 แถว = 1 ใบลา)</p>
              <p>• <b>ประเภทลา</b> ต้องตรงกับชื่อในระบบ — ดูได้ในชีต "ประเภทลา (อ้างอิง)"</p>
              <p>• <b>วันที่</b> รูปแบบ <code>YYYY-MM-DD</code> · <b>จำนวนวัน</b> เว้นว่างได้ (ระบบจะนับรวมหัวท้ายให้ แต่ควรกรอกเองถ้ามีวันหยุด/ครึ่งวัน)</p>
              <p>• ใบลาที่นำเข้าจะบันทึกเป็น <b>อนุมัติแล้ว</b> และ <b>ตัดยอดวันลาคงเหลือ</b> ทันที</p>
            </div>

            {busy && !parsed && <div className="text-center py-6 text-gray-500">กำลังประมวลผล…</div>}

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex items-start gap-2">
                <FiAlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
              </div>
            )}

            {parsed && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-center">
                    <div className="text-2xl font-bold text-emerald-700">{toImport.length}</div>
                    <div className="text-xs text-emerald-600">จะนำเข้า</div>
                  </div>
                  <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 text-center">
                    <div className="text-2xl font-bold text-gray-500">{dupCount}</div>
                    <div className="text-xs text-gray-500">ซ้ำกับที่มีอยู่</div>
                  </div>
                  <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-center">
                    <div className="text-2xl font-bold text-rose-600">{parsed.issues.length}</div>
                    <div className="text-xs text-rose-600">มีปัญหา (ข้าม)</div>
                  </div>
                </div>

                {parsed.issues.length > 0 && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700 space-y-1 max-h-28 overflow-y-auto">
                    {parsed.issues.map((iv) => <p key={iv.row}>แถว {iv.row}: {iv.reason}</p>)}
                  </div>
                )}

                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                  ข้ามใบลาที่ซ้ำกับข้อมูลที่มีอยู่แล้ว (แนะนำ)
                </label>

                {parsed.rows.length > 0 && (
                  <div className="overflow-auto max-h-64 rounded-lg border border-gray-200">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-100">
                        <tr>
                          <th className="p-2 text-left font-semibold">รหัส</th>
                          <th className="p-2 text-left font-semibold">พนักงาน</th>
                          <th className="p-2 text-left font-semibold">ประเภท</th>
                          <th className="p-2 text-center font-semibold">เริ่ม</th>
                          <th className="p-2 text-center font-semibold">สิ้นสุด</th>
                          <th className="p-2 text-center font-semibold">วัน</th>
                          <th className="p-2 text-center font-semibold">สถานะ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.rows.slice(0, 300).map((r, i) => (
                          <tr key={i} className={`border-t border-gray-100 ${r.duplicate ? 'bg-gray-50 text-gray-400' : ''}`}>
                            <td className="p-2">{r.code}</td>
                            <td className="p-2">{r.name}</td>
                            <td className="p-2">{r.type_name}</td>
                            <td className="p-2 text-center">{r.start_date}</td>
                            <td className="p-2 text-center">{r.end_date}</td>
                            <td className="p-2 text-center tabular-nums">
                              {r.total_days}{r.daysAuto && <span className="text-amber-500" title="ระบบนับให้">*</span>}
                            </td>
                            <td className="p-2 text-center">
                              {r.duplicate ? <span className="text-gray-400">ซ้ำ</span> : <span className="text-emerald-600">ใหม่</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.rows.length > 300 && (
                      <div className="p-2 text-center text-gray-400 text-xs">แสดง 300 แถวแรกจาก {parsed.rows.length} รายการ</div>
                    )}
                  </div>
                )}
                {parsed.rows.some((r) => r.daysAuto) && (
                  <p className="text-xs text-amber-600">* จำนวนวันที่มีเครื่องหมายดอกจัน = ระบบนับรวมหัวท้ายให้ (ไม่หักวันหยุด) โปรดตรวจสอบ</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={handleClose} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">
                    ยกเลิก
                  </button>
                  <button type="button" onClick={doImport} disabled={busy || toImport.length === 0}
                    className="px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed">
                    {busy ? 'กำลังนำเข้า…' : `นำเข้า ${toImport.length} ใบลา`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
