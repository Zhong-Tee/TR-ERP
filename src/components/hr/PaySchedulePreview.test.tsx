import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import PaySchedulePreview from './PaySchedulePreview'
import type { PaySchedule } from '../../lib/payrollSchedule'

const schedule: Partial<PaySchedule> = { frequency: 'semimonthly', first_day: 15, second_day: null }
const render = (effectiveDate: string) => renderToStaticMarkup(<PaySchedulePreview schedule={schedule} month="2026-11" hireDate="2026-11-02" effectiveDate={effectiveDate} employee />)

describe('pay schedule preview', () => {
  it('keeps days before the effective date in the old schedule', () => {
    const html = render('2026-11-15')
    expect(html).toContain('2 พ.ย. 2569 – 14 พ.ย. 2569 ยังใช้รอบเดิม')
    expect(html).toContain('ช่วงที่อาจมีสิทธิ์ในรอบนี้: 15 พ.ย. 2569 – 15 พ.ย. 2569')
  })
  it('starts at hire date when the schedule takes effect from hire', () => {
    const html = render('2026-11-02')
    expect(html).not.toContain('ยังใช้รอบเดิม')
    expect(html).toContain('ช่วงที่อาจมีสิทธิ์ในรอบนี้: 2 พ.ย. 2569 – 15 พ.ย. 2569')
  })
  it('uses actual schedule boundaries when the second cutoff is not month end', () => {
    const html = renderToStaticMarkup(<PaySchedulePreview schedule={{...schedule, second_day:30}} month="2026-12" />)
    expect(html).toContain('1 ธ.ค. 2569 – 15 ธ.ค. 2569')
    expect(html).toContain('16 ธ.ค. 2569 – 30 ธ.ค. 2569')
    const next = renderToStaticMarkup(<PaySchedulePreview schedule={{...schedule, second_day:30}} month="2027-01" />)
    expect(next).toContain('31 ธ.ค. 2569 – 15 ม.ค. 2570')
  })
  it('shows invalid cutoff feedback without crashing the form', () => {
    const html = renderToStaticMarkup(<PaySchedulePreview schedule={{...schedule,first_day:20,second_day:16}} month="2026-11" />)
    expect(html).toContain('วันจ่ายงวดที่สองต้องอยู่หลังงวดแรก')
  })
})
