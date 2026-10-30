import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HRCompany } from '../types'
import type { PayrollItem } from './payrollApi'
const state = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc: state.rpc } }))
import { savePayrollRun } from './payrollApi'
const input = {
  month:'2026-10', company:{id:'company-1'} as HRCompany, paymentDate:'2026-10-31',
  items:[{id:'server-id',payroll_run_id:'old-run',employee_id:'employee-1',base_salary:1200,net_pay:1200}] as PayrollItem[],
  confirm:true,expectedVersion:4,
}
beforeEach(() => state.rpc.mockReset().mockResolvedValue({data:{id:'run-1',status:'confirmed',version:6},error:null}))
describe('atomic payroll persistence', () => {
  it.each(['permanent','monthly_uninsured','daily'] as const)('saves %s in one transaction', async payrollType => {
    expect(await savePayrollRun({...input,payrollType})).toMatchObject({id:'run-1',version:6})
    expect(state.rpc).toHaveBeenCalledTimes(1)
    expect(state.rpc).toHaveBeenCalledWith('hr_save_payroll_period',{
      p_run:{company_id:'company-1',payroll_type:payrollType,schedule_id:null,period_start:'2026-10-01',period_end:'2026-10-31',payment_date:'2026-10-31'},
      p_items:[{employee_id:'employee-1',base_salary:1200}],p_confirm:true,p_expected_version:4,
    })
    expect(input.items[0].id).toBe('server-id')
  })
  it('preserves cross-month windows', async () => {
    await savePayrollRun({...input,scheduleId:'weekly',periodStart:'2026-09-28',periodEnd:'2026-10-04'})
    expect(state.rpc.mock.calls[0][1].p_run).toMatchObject({schedule_id:'weekly',period_start:'2026-09-28',period_end:'2026-10-04'})
  })
  it('propagates transaction failures without fallback writes', async () => {
    state.rpc.mockResolvedValue({data:null,error:{message:'Stale version'}})
    await expect(savePayrollRun(input)).rejects.toThrow('Stale version')
    expect(state.rpc).toHaveBeenCalledTimes(1)
  })
  it('can clear an obsolete daily draft', async () => {
    await savePayrollRun({...input,payrollType:'daily',items:[],confirm:false})
    expect(state.rpc.mock.calls[0][1]).toMatchObject({p_items:[],p_confirm:false})
  })
  it('uses actual leap February end', async () => {
    await savePayrollRun({...input,month:'2028-02'})
    expect(state.rpc.mock.calls[0][1].p_run.period_end).toBe('2028-02-29')
  })
})
