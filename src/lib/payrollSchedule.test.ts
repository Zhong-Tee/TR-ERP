import { describe, expect, it } from 'vitest'
import { daysBetween, distributeCents, monthlyDailyAmounts, periodClosed, scheduleOnDate, schedulePeriods, DEFAULT_PAY_SCHEDULE_ID, type PaySchedule } from './payrollSchedule'
const schedule:PaySchedule={id:'test',company_id:null,name:'Test',frequency:'monthly',weekday:1,first_day:15,second_day:null,payment_day:null,holiday_rule:'none',deduction_policy:'last',cutoff_time:'18:00:00',is_active:true}
describe('calendar earning periods',()=>{
  it.each([['2026-02','2026-02-28'],['2028-02','2028-02-29'],['2026-10','2026-10-31']])('covers actual month end %s',(month,end)=>{
    expect(schedulePeriods(schedule,month)).toEqual([{start:`${month}-01`,end,paymentDate:end}])
  })
  it('splits 15/end without dropping the 31st',()=>{
    expect(schedulePeriods({...schedule,frequency:'semimonthly'},'2026-10')).toEqual([
      {start:'2026-10-01',end:'2026-10-15',paymentDate:'2026-10-15'},
      {start:'2026-10-16',end:'2026-10-31',paymentDate:'2026-10-31'},
    ])
  })
  it('carries the 31st into the next fixed 15/30 window',()=>{
    expect(schedulePeriods({...schedule,frequency:'semimonthly',second_day:30},'2026-11')[0].start).toBe('2026-10-31')
  })
  it('Monday pays preceding Monday through Sunday across month boundaries',()=>{
    expect(schedulePeriods({...schedule,frequency:'weekly'},'2026-10')[0]).toEqual({start:'2026-09-28',end:'2026-10-04',paymentDate:'2026-10-05'})
  })
  it('moves only payment dates past weekends and holidays',()=>{
    expect(schedulePeriods({...schedule,holiday_rule:'next'},'2026-10',new Set(['2026-11-02']))[0]).toEqual({start:'2026-10-01',end:'2026-10-31',paymentDate:'2026-11-03'})
  })
  it('supports daily and next-month monthly payment',()=>{
    expect(schedulePeriods({...schedule,frequency:'daily'},'2028-02')).toHaveLength(29)
    expect(schedulePeriods({...schedule,payment_day:5},'2026-12')[0].paymentDate).toBe('2027-01-05')
  })
  it('applies assignments from the effective earning date',()=>{
    const history=[{employee_id:'e',schedule_id:'weekly',effective_date:'2026-10-19'}]
    expect(scheduleOnDate('e','2026-10-18',history)).toBe(DEFAULT_PAY_SCHEDULE_ID)
    expect(scheduleOnDate('e','2026-10-19',history)).toBe('weekly')
  })
  it('closes only after Bangkok cutoff',()=>{
    const period={start:'2026-10-01',end:'2026-10-15',paymentDate:'2026-10-15'}
    expect(periodClosed(period,'18:00:00','2026-10-15T17:59')).toBe(false)
    expect(periodClosed(period,'18:00:00','2026-10-15T18:00')).toBe(true)
  })
  it('rejects excessive custom windows',()=>expect(()=>daysBetween('2025-01-01','2026-10-30')).toThrow())
})
describe('stable allocation across payment windows',()=>{
  it('allocates every cent once',()=>{
    expect(Math.round(distributeCents(18000.01,Array(31).fill(1)).reduce((sum,value)=>sum+value,0)*100)).toBe(1800001)
  })
  it('splits full monthly pay evenly between 15 and month end',()=>{
    const days=monthlyDailyAmounts([{startDate:'2026-10-01',endDate:'2026-10-31',monthlyRate:18000,positionAllowance:0,calendarDays:31,payableDays:30,amount:18000,allowanceAmount:0}])
    expect(days.filter(day=>day.date<='2026-10-15').reduce((sum,day)=>sum+day.salary,0)).toBe(9000)
    expect(days.reduce((sum,day)=>sum+day.salary,0)).toBe(18000)
  })
  it('retains EMP00024 partial month 13 times 600',()=>{
    const days=monthlyDailyAmounts([{startDate:'2026-10-19',endDate:'2026-10-31',monthlyRate:18000,positionAllowance:0,calendarDays:13,payableDays:13,amount:7800,allowanceAmount:0}])
    expect(days).toHaveLength(13);expect(days.every(day=>day.salary===600)).toBe(true)
  })
})
