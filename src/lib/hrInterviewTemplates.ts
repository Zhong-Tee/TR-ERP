import { supabase } from './supabase'
export type InterviewCriterion = { name: string; max_score: number }
export type InterviewTemplate = { id: string; name: string; criteria: InterviewCriterion[] }
export type InterviewTemplateAssignment = { template_id: string; position_id: string | null; department_id: string | null }
export function interviewTemplateDisplayName(name: string) { return name.replace(/\s*\[[0-9a-f-]+\]$/i, '') }
export async function loadInterviewTemplateLibrary() {
  const [templates, assignments] = await Promise.all([
    supabase.from('hr_interview_template_sets').select('*').order('name'),
    supabase.from('hr_interview_template_assignments').select('*'),
  ])
  if (templates.error) throw templates.error
  if (assignments.error) throw assignments.error
  return { templates: templates.data as InterviewTemplate[], assignments: assignments.data as InterviewTemplateAssignment[] }
}
export async function saveNamedInterviewTemplate(template: { id?: string; name: string; criteria: InterviewCriterion[] }) {
  const query = template.id ? supabase.from('hr_interview_template_sets').update(template).eq('id', template.id)
    : supabase.from('hr_interview_template_sets').insert(template)
  const { data, error } = await query.select().single()
  if (error) throw error
  return data as InterviewTemplate
}
export async function assignInterviewTemplate(templateId: string, positionId: string, departmentId: string) {
  const { error } = await supabase.rpc('hr_assign_interview_template', {
    p_template_id: templateId, p_position_id: positionId || null, p_department_id: positionId ? null : departmentId || null,
  })
  if (error) throw error
}
export function resolveInterviewTemplate(templates: InterviewTemplate[], assignments: InterviewTemplateAssignment[], positionId?: string, departmentId?: string) {
  const assignment = assignments.find(a => !!positionId && a.position_id === positionId)
    ?? assignments.find(a => !!departmentId && a.department_id === departmentId && !a.position_id)
  return templates.find(t => t.id === assignment?.template_id)
}
export async function inheritDepartmentInterviewTemplate(positionId: string) {
  const { error } = await supabase.from('hr_interview_template_assignments').delete().eq('position_id', positionId)
  if (error) throw error
}
