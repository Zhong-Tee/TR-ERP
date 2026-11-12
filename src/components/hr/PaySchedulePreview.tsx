import { schedulePeriods, shiftDate, type PaySchedule } from '../../lib/payrollSchedule'

const dateLabel = (date: string) => new Intl.DateTimeFormat('th-TH', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${date}T00:00:00Z`))

interface Props {
  schedule: Partial<PaySchedule>
  month: string
  effectiveDate?: string
  hireDate?: string
  endDate?: string
  employee?: boolean
}

/** Display only: reuse the existing period boundaries without calculating or saving pay. */
export default function PaySchedulePreview({ schedule, month, effectiveDate, hireDate, endDate, employee = false }: Props) {
  if (!/^\d{4}-\d{2}$/.test(month)) return <p className="text-sm text-gray-500">เลือกเดือนเพื่อดูตัวอย่างช่วงวันที่</p>
  if (employee && !effectiveDate) return <p className="text-sm text-gray-500">ระบุวันที่เริ่มใช้รอบจ่ายเพื่อดูตัวอย่าง</p>
  let periods
  try {
    if (schedule.frequency === 'semimonthly' && (!Number.isInteger(schedule.first_day) || Number(schedule.first_day) < 1 || Number(schedule.first_day) > 27)) {
      throw new Error('ระบุวันสิ้นสุดงวดแรกระหว่างวันที่ 1–27')
    }
    // Company holidays are not loaded here; show wage windows, not adjusted payment dates.
    periods = schedulePeriods({ ...schedule, holiday_rule: 'none' } as PaySchedule, month)
  } catch (error) {
    return <p role="status" className="text-sm text-amber-800">{error instanceof Error ? error.message : 'ตรวจสอบวันสิ้นสุดงวดเพื่อดูตัวอย่าง'}</p>
  }
  if (schedule.frequency === 'custom') return <p className="text-sm text-gray-600">รอบกำหนดช่วงเอง: ช่วงค่าจ้างขึ้นกับวันที่ที่เลือกเมื่อจัดทำงวด</p>
  const previousStart = [hireDate || `${month}-01`, `${month}-01`].sort().at(-1)!
  const previousEnd = effectiveDate ? [shiftDate(effectiveDate, -1), endDate || shiftDate(effectiveDate, -1)].sort()[0] : ''
  const shown = periods.slice(0, 3)
  return <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950" aria-live="polite">
    <p className="font-medium">ตัวอย่างช่วงค่าจ้างก่อนบันทึก</p>
    {employee && effectiveDate && <>
      <p>เริ่มใช้รอบที่เลือกตั้งแต่ {dateLabel(effectiveDate)}{hireDate ? ` · เริ่มงาน ${dateLabel(hireDate)}` : ''}</p>
      {previousStart <= previousEnd && <p className="rounded bg-amber-50 p-2 text-amber-900">{dateLabel(previousStart)} – {dateLabel(previousEnd)} ยังใช้รอบเดิมตามประวัติ ไม่รวมในรอบที่เลือกนี้</p>}
    </>}
    <ul className="list-disc space-y-1 pl-5">{shown.map((period, index) => {
      const start = [period.start, ...(employee ? [effectiveDate || '', hireDate || ''] : [])].sort().at(-1)!
      const end = employee && endDate && endDate < period.end ? endDate : period.end
      return <li key={period.start}>งวดที่ {index + 1}: {dateLabel(period.start)} – {dateLabel(period.end)}
        {employee && <span className="block">{start <= end ? `ช่วงที่อาจมีสิทธิ์ในรอบนี้: ${dateLabel(start)} – ${dateLabel(end)}` : 'ไม่มีช่วงวันที่เข้าเงื่อนไขในงวดนี้'}</span>}
      </li>
    })}</ul>
    {periods.length > shown.length && <p>และอีก {periods.length - shown.length} งวดในเดือนนี้</p>}
    <p className="text-xs text-emerald-800">{employee ? 'ตัวอย่างพิจารณาวันเริ่มงาน วันสิ้นสุดงาน และวันที่เริ่มใช้รอบจ่าย สิทธิ์จริงยังขึ้นกับประวัติค่าจ้าง/รอบจ่าย และวันที่ยืนยันหรือจ่ายแล้ว' : 'พนักงานเริ่มงานกลางงวดจะคิดสิทธิ์ตั้งแต่วันเริ่มงาน กำหนดวันที่เริ่มใช้รอบนี้แยกในทะเบียนพนักงาน'} · ช่วงค่าจ้างไม่เปลี่ยนตามการเลื่อนวันจ่าย</p>
  </div>
}
