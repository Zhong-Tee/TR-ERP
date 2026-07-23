import { useState, useEffect, useCallback } from 'react'
import { FiX, FiDownload, FiUploadCloud, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import Modal from '../ui/Modal'
import { fetchEmployees, fetchTimeEntries, bulkInsertTimeEntries } from '../../lib/hrApi'
import type { HREmployee, HRTimeEntryType } from '../../types'

/** หัวตารางของ Template — ใช้ทั้งตอนสร้างไฟล์และตอนหาคอลัมน์ตอนนำเข้า */
const HEADERS = ['รหัสพนักงาน', 'ชื่อ-สกุล', 'วันที่', 'เข้างาน', 'ออกงาน', 'เข้า OT', 'ออก OT', 'หมายเหตุ'] as const

const TIME_COLS: { key: HRTimeEntryType; label: string }[] = [
  { key: 'clock_in', label: 'เข้างาน' },
  { key: 'clock_out', label: 'ออกงาน' },
  { key: 'ot_in', label: 'เข้า OT' },
  { key: 'ot_out', label: 'ออก OT' },
]
const TYPE_LABEL: Record<HRTimeEntryType, string> = {
  clock_in: 'เข้างาน', clock_out: 'ออกงาน', ot_in: 'เข้า OT', ot_out: 'ออก OT',
}

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
  // YYYY-MM-DD หรือ YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  // D/M/YYYY หรือ D-M-YYYY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
  if (m) {
    let y = +m[3]
    if (y > 2500) y -= 543 // เผื่อกรอกเป็น พ.ศ.
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`
  }
  return null
}

/** แปลงค่าจากเซลล์เวลา (Date / เศษส่วนของวัน / 'HH:MM') → 'HH:MM' หรือ null */
function normalizeTime(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return `${pad(v.getHours())}:${pad(v.getMinutes())}`
  if (typeof v === 'number') {
    const frac = v - Math.floor(v)
    let mins = Math.round(frac * 1440)
    if (mins >= 1440) mins = 1439
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/)
  if (!m) return null
  const h = +m[1], mm = +m[2]
  if (h > 23 || mm > 59) return null
  return `${pad(h)}:${pad(mm)}`
}

const empName = (e: HREmployee) => `${e.first_name} ${e.last_name}${e.nickname ? ` (${e.nickname})` : ''}`

type BuiltEntry = {
  employee_id: string
  code: string
  name: string
  work_date: string
  entry_type: HRTimeEntryType
  time: string
  entry_time: string
  duplicate: boolean
}
type Parsed = {
  entries: BuiltEntry[]
  unknownCodes: string[]
  invalidRows: { row: number; reason: string }[]
}

export default function TimeEntryImport({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [skipDuplicates, setSkipDuplicates] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [doneCount, setDoneCount] = useState<number | null>(null)

  useEffect(() => {
    if (open) fetchEmployees().then(setEmployees).catch(() => {})
  }, [open])

  const reset = () => {
    setFileName(''); setParsed(null); setError(''); setDoneCount(null); setBusy(false)
  }
  const handleClose = () => { reset(); onClose() }

  const downloadTemplate = () => {
    const active = employees.filter((e) => ['active', 'probation'].includes(e.employment_status))
    const wb = XLSX.utils.book_new()

    const ws = XLSX.utils.aoa_to_sheet([
      [...HEADERS],
      ['(ตัวอย่าง) EMP00001', 'จักรกฤษ (ตี้)', '2026-01-05', '08:25', '17:32', '', '', 'ลบแถวตัวอย่างนี้ก่อนนำเข้า'],
      ['(ตัวอย่าง) EMP00002', 'จุฑารัตน์ (แนน)', '2026-01-05', '09:15', '18:05', '18:30', '20:30', ''],
    ])
    ws['!cols'] = [{ wch: 16 }, { wch: 24 }, { wch: 13 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(wb, ws, 'ข้อมูล')

    const refRows = [
      ['รหัสพนักงาน', 'ชื่อ-สกุล', 'แผนก'],
      ...active.map((e) => [
        e.employee_code ?? '',
        empName(e),
        (e as HREmployee & { department?: { name?: string } }).department?.name ?? '',
      ]),
    ]
    const wsRef = XLSX.utils.aoa_to_sheet(refRows)
    wsRef['!cols'] = [{ wch: 16 }, { wch: 26 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, wsRef, 'รายชื่อพนักงาน (อ้างอิง)')

    XLSX.writeFile(wb, 'Template_นำเข้าเวลาทำงาน.xlsx')
  }

  const handleFile = useCallback(async (file: File) => {
    setError(''); setDoneCount(null); setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, blankrows: false })
      if (aoa.length === 0) throw new Error('ไฟล์ว่างเปล่า')

      // หาแถวหัวตาราง (มีคำว่า "รหัส" และ "วันที่")
      const headerIdx = aoa.findIndex((r) =>
        r.some((c) => String(c ?? '').includes('รหัส')) && r.some((c) => String(c ?? '').includes('วันที่')),
      )
      if (headerIdx < 0) throw new Error('ไม่พบหัวตาราง — ต้องมีคอลัมน์ "รหัสพนักงาน" และ "วันที่" (ใช้ Template ที่ดาวน์โหลด)')
      const header = aoa[headerIdx].map((c) => String(c ?? '').trim())

      const findCol = (pred: (h: string) => boolean) => header.findIndex(pred)
      const col = {
        code: findCol((h) => h.includes('รหัส')),
        date: findCol((h) => h.includes('วันที่')),
        note: findCol((h) => h.includes('หมายเหตุ')),
      }
      const timeColIdx: Record<HRTimeEntryType, number> = {
        ot_in: findCol((h) => h.includes('OT') && h.includes('เข้า')),
        ot_out: findCol((h) => h.includes('OT') && h.includes('ออก')),
        clock_in: findCol((h) => h.includes('เข้างาน')),
        clock_out: findCol((h) => h.includes('ออกงาน')),
      }

      const byCode = new Map<string, HREmployee>()
      for (const e of employees) if (e.employee_code) byCode.set(e.employee_code.trim().toUpperCase(), e)

      const entries: BuiltEntry[] = []
      const unknown = new Set<string>()
      const invalid: { row: number; reason: string }[] = []

      for (let i = headerIdx + 1; i < aoa.length; i++) {
        const r = aoa[i]
        const rawCode = String(r[col.code] ?? '').trim()
        if (!rawCode || rawCode.includes('ตัวอย่าง')) continue // ข้ามแถวว่าง/แถวตัวอย่าง
        const rowNum = i + 1

        const emp = byCode.get(rawCode.toUpperCase())
        if (!emp) { unknown.add(rawCode); continue }

        const date = normalizeDate(r[col.date])
        if (!date) { invalid.push({ row: rowNum, reason: `${rawCode}: วันที่ไม่ถูกต้อง` }); continue }

        const noteBase = col.note >= 0 ? String(r[col.note] ?? '').trim() : ''
        let hasAnyTime = false
        for (const { key } of TIME_COLS) {
          const idx = timeColIdx[key]
          if (idx < 0) continue
          const time = normalizeTime(r[idx])
          if (!time) continue
          hasAnyTime = true
          entries.push({
            employee_id: emp.id,
            code: emp.employee_code ?? rawCode,
            name: empName(emp),
            work_date: date,
            entry_type: key,
            time,
            entry_time: `${date}T${time}:00+07:00`,
            duplicate: false,
            _note: noteBase, // ชั่วคราว, ใช้ตอน insert
          } as BuiltEntry & { _note: string })
        }
        if (!hasAnyTime) invalid.push({ row: rowNum, reason: `${rawCode} (${date}): ไม่มีเวลาเข้า/ออก` })
      }

      if (entries.length === 0 && unknown.size === 0) {
        throw new Error('ไม่พบข้อมูลที่นำเข้าได้ — ตรวจว่ากรอกรหัสพนักงานและเวลาถูกต้อง')
      }

      // ตรวจซ้ำกับข้อมูลเดิมในระบบ (คน + วัน + ประเภท)
      if (entries.length > 0) {
        const dates = entries.map((e) => e.work_date).sort()
        const existing = await fetchTimeEntries({
          date_from: dates[0], date_to: dates[dates.length - 1], limit: 20000,
        })
        const seen = new Set(existing.map((e) => `${e.employee_id}|${e.work_date}|${e.entry_type}`))
        // กันซ้ำภายในไฟล์เองด้วย
        const inFile = new Set<string>()
        for (const e of entries) {
          const k = `${e.employee_id}|${e.work_date}|${e.entry_type}`
          if (seen.has(k) || inFile.has(k)) e.duplicate = true
          inFile.add(k)
        }
      }

      setFileName(file.name)
      setParsed({ entries, unknownCodes: [...unknown], invalidRows: invalid })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อ่านไฟล์ไม่สำเร็จ')
      setParsed(null)
    } finally {
      setBusy(false)
    }
  }, [employees])

  const toImport = parsed ? parsed.entries.filter((e) => !skipDuplicates || !e.duplicate) : []
  const dupCount = parsed ? parsed.entries.filter((e) => e.duplicate).length : 0

  const doImport = async () => {
    if (toImport.length === 0) return
    setBusy(true); setError('')
    try {
      const payload = toImport.map((e) => {
        const note = (e as BuiltEntry & { _note?: string })._note
        return {
          employee_id: e.employee_id,
          entry_type: e.entry_type,
          work_date: e.work_date,
          entry_time: e.entry_time,
          location_name: 'เครื่องสแกนนิ้ว',
          source: 'device' as const,
          note: note ? `[นำเข้า] ${note}` : '[นำเข้า]',
        }
      })
      const n = await bulkInsertTimeEntries(payload)
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
        <span className="font-semibold">นำเข้าข้อมูลเวลาทำงาน (เครื่องสแกนนิ้ว)</span>
        <button type="button" onClick={handleClose} aria-label="ปิด"><FiX className="w-5 h-5" /></button>
      </div>

      <div className="p-5 space-y-4">
        {doneCount !== null ? (
          <div className="text-center py-8">
            <FiCheckCircle className="w-14 h-14 text-emerald-500 mx-auto mb-3" />
            <p className="text-lg font-semibold text-gray-800">นำเข้าสำเร็จ {doneCount} รายการ</p>
            <p className="text-sm text-gray-500 mt-1">ระบบคำนวณสาย / OT / ขาดงาน ให้อัตโนมัติแล้ว</p>
            <button
              type="button"
              onClick={handleClose}
              className="mt-5 px-6 py-2.5 rounded-xl bg-emerald-600 text-white font-medium hover:bg-emerald-700"
            >
              เสร็จสิ้น
            </button>
          </div>
        ) : (
          <>
            {/* ขั้นตอน */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={downloadTemplate}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-emerald-600 text-emerald-700 text-sm font-medium rounded-lg hover:bg-emerald-50"
              >
                <FiDownload /> ดาวน์โหลด Template
              </button>
              <label className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 cursor-pointer">
                <FiUploadCloud /> เลือกไฟล์ Excel
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFile(f)
                    e.target.value = ''
                  }}
                />
              </label>
              {fileName && <span className="text-sm text-gray-500 truncate">📄 {fileName}</span>}
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 space-y-1">
              <p className="font-semibold">วิธีกรอก Template (1 แถว = 1 คน 1 วัน)</p>
              <p>• <b>รหัสพนักงาน</b> (เช่น EMP00001) เป็นตัวหลัก — ดูรายชื่อได้ในชีต "รายชื่อพนักงาน (อ้างอิง)"</p>
              <p>• <b>วันที่</b> รูปแบบ <code>YYYY-MM-DD</code> · <b>เวลา</b> รูปแบบ <code>HH:MM</code> (24 ชม.) · ช่องที่ไม่มีการแตะให้เว้นว่าง</p>
              <p>• ลบแถว "(ตัวอย่าง)" ออกก่อนนำเข้า</p>
            </div>

            {busy && !parsed && <div className="text-center py-6 text-gray-500">กำลังประมวลผล…</div>}

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex items-start gap-2">
                <FiAlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
              </div>
            )}

            {parsed && (
              <>
                {/* สรุปผลตรวจ */}
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
                    <div className="text-2xl font-bold text-rose-600">{parsed.unknownCodes.length + parsed.invalidRows.length}</div>
                    <div className="text-xs text-rose-600">มีปัญหา (ข้าม)</div>
                  </div>
                </div>

                {(parsed.unknownCodes.length > 0 || parsed.invalidRows.length > 0) && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700 space-y-1 max-h-28 overflow-y-auto">
                    {parsed.unknownCodes.length > 0 && (
                      <p>ไม่พบรหัสพนักงาน: {parsed.unknownCodes.join(', ')}</p>
                    )}
                    {parsed.invalidRows.map((iv) => (
                      <p key={iv.row}>แถว {iv.row}: {iv.reason}</p>
                    ))}
                  </div>
                )}

                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
                  ข้ามรายการที่ซ้ำกับข้อมูลที่มีอยู่แล้ว (แนะนำ)
                </label>

                {/* พรีวิว */}
                {parsed.entries.length > 0 && (
                  <div className="overflow-auto max-h-64 rounded-lg border border-gray-200">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-gray-100">
                        <tr>
                          <th className="p-2 text-left font-semibold">รหัส</th>
                          <th className="p-2 text-left font-semibold">พนักงาน</th>
                          <th className="p-2 text-center font-semibold">วันที่</th>
                          <th className="p-2 text-center font-semibold">ประเภท</th>
                          <th className="p-2 text-center font-semibold">เวลา</th>
                          <th className="p-2 text-center font-semibold">สถานะ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.entries.slice(0, 300).map((e, i) => (
                          <tr key={i} className={`border-t border-gray-100 ${e.duplicate ? 'bg-gray-50 text-gray-400' : ''}`}>
                            <td className="p-2">{e.code}</td>
                            <td className="p-2">{e.name}</td>
                            <td className="p-2 text-center">{e.work_date}</td>
                            <td className="p-2 text-center">{TYPE_LABEL[e.entry_type]}</td>
                            <td className="p-2 text-center tabular-nums">{e.time}</td>
                            <td className="p-2 text-center">
                              {e.duplicate
                                ? <span className="text-gray-400">ซ้ำ</span>
                                : <span className="text-emerald-600">ใหม่</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.entries.length > 300 && (
                      <div className="p-2 text-center text-gray-400 text-xs">แสดง 300 แถวแรกจาก {parsed.entries.length} รายการ</div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={handleClose} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={doImport}
                    disabled={busy || toImport.length === 0}
                    className="px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? 'กำลังนำเข้า…' : `นำเข้า ${toImport.length} รายการ`}
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
