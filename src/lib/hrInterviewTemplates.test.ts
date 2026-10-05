import { describe, expect, it } from 'vitest'
import { resolveInterviewTemplate } from './hrInterviewTemplates'
const templates = [{ id: 'position', name: 'ตำแหน่ง', criteria: [] }, { id: 'department', name: 'แผนก', criteria: [] }]
const assignments = [{ template_id: 'position', position_id: 'p1', department_id: null }, { template_id: 'department', position_id: null, department_id: 'd1' }]
describe('named interview template selection', () => {
  it('uses the position assignment before the department default', () => {
    expect(resolveInterviewTemplate(templates, assignments, 'p1', 'd1')?.id).toBe('position')
  })
  it('falls back to the department for positions without an assignment', () => {
    expect(resolveInterviewTemplate(templates, assignments, 'p2', 'd1')?.id).toBe('department')
  })
  it('does not select an unrelated position template when no assignment exists', () => {
    expect(resolveInterviewTemplate(templates, assignments, 'p3', 'd3')).toBeUndefined()
  })
})
