import { supabase } from './supabase'

export const HR_MY_OPEN_TASK_COUNT_EVENT = 'hr-my-open-task-count'

export async function loadHrMyOpenTaskCount(userId: string): Promise<number> {
  const { data: employee, error: employeeError } = await supabase
    .from('hr_employees')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()
  if (employeeError) throw employeeError
  if (!employee?.id) return 0

  const { data: participants, error: participantError } = await supabase
    .from('hr_task_participants')
    .select('task_id')
    .eq('employee_id', employee.id)
    .eq('role', 'assignee')
  if (participantError) throw participantError

  const taskIds = [...new Set((participants ?? []).map((row) => row.task_id))]
  if (taskIds.length === 0) return 0

  const { count, error: taskError } = await supabase
    .from('hr_tasks')
    .select('*', { count: 'exact', head: true })
    .in('id', taskIds)
    .in('status', ['new', 'acknowledged', 'in_progress', 'review', 'revision', 'paused'])
  if (taskError) throw taskError
  return count || 0
}

export function broadcastHrMyOpenTaskCount(count: number) {
  window.dispatchEvent(new CustomEvent(HR_MY_OPEN_TASK_COUNT_EVENT, { detail: { count } }))
}
