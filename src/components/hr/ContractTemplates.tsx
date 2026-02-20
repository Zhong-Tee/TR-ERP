import React, { useState, useEffect, useCallback } from 'react'
import {
  FiFileText,
  FiPlus,
  FiEdit2,
  FiUser,
  FiSave,
  FiAlertCircle,
  FiDownload,
} from 'react-icons/fi'
import {
  fetchContractTemplates,
  upsertContractTemplate,
  fetchContracts,
  upsertContract,
  fetchEmployees,
} from '../../lib/hrApi'
import type { HRContractTemplate, HRContract, HREmployee } from '../../types'
import Modal from '../ui/Modal'

const PLACEHOLDER_SOURCES = [
  { value: 'employee_name', label: 'ชื่อพนักงาน' },
  { value: 'position', label: 'ตำแหน่ง' },
  { value: 'salary', label: 'เงินเดือน' },
  { value: 'department', label: 'แผนก' },
  { value: 'hire_date', label: 'วันที่เริ่มงาน' },
  { value: 'custom', label: 'กำหนดเอง' },
] as const

function extractPlaceholders(content: string): { key: string; label: string; source: string }[] {
  const keys = new Set<string>()
  const regex = /\{\{([^}]+)\}\}/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) keys.add(m[1].trim())
  return Array.from(keys).map((key) => ({
    key,
    label: key,
    source: 'employee_name',
  }))
}

function replacePlaceholders(
  content: string,
  placeholders: { key: string; label: string; source?: string }[],
  employee: HREmployee | null,
  customValues: Record<string, string>
): string {
  let out = content
  for (const p of placeholders) {
    const needle = `{{${p.key}}}`
    let value = customValues[p.key]
    if (value !== undefined && value !== '') {
      out = out.split(needle).join(value)
      continue
    }
    if (p.source === 'custom') {
      out = out.split(needle).join(customValues[p.key] ?? '')
      continue
    }
    if (!employee) {
      out = out.split(needle).join('')
      continue
    }
    switch (p.source) {
      case 'employee_name':
        value = [employee.first_name, employee.last_name].filter(Boolean).join(' ')
        break
      case 'position':
        value = (employee.position as { name?: string } | undefined)?.name ?? employee.position_id ?? ''
        break
      case 'salary':
        value = employee.salary != null ? String(employee.salary) : ''
        break
      case 'department':
        value = (employee.department as { name?: string } | undefined)?.name ?? employee.department_id ?? ''
        break
      case 'hire_date':
        value = employee.hire_date ?? ''
        break
      default:
        value = ''
    }
    out = out.split(needle).join(value ?? '')
  }
  return out
}

export default function ContractTemplates() {
  const [templates, setTemplates] = useState<HRContractTemplate[]>([])
  const [contracts, setContracts] = useState<HRContract[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<HRContractTemplate | null>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formPlaceholders, setFormPlaceholders] = useState<{ key: string; label: string; source: string }[]>([])
  const [savingTemplate, setSavingTemplate] = useState(false)

  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createEmployeeId, setCreateEmployeeId] = useState('')
  const [createEmployeeSearch, setCreateEmployeeSearch] = useState('')
  const [createTemplateId, setCreateTemplateId] = useState('')
  const [createCustomValues, setCreateCustomValues] = useState<Record<string, string>>({})
  const [savingContract, setSavingContract] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [pdfRef, setPdfRef] = useState<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [t, c, e] = await Promise.all([
        fetchContractTemplates(),
        fetchContracts(),
        fetchEmployees({ status: 'active' }),
      ])
      setTemplates(t)
      setContracts(c)
      setEmployees(e)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openEditor = (t: HRContractTemplate | null) => {
    setEditingTemplate(t)
    setFormName(t?.name ?? '')
    setFormDescription(t?.description ?? '')
    setFormContent(t?.template_content ?? '')
    setFormPlaceholders(
      t?.placeholders?.length
        ? t.placeholders.map((p) => ({ key: p.key, label: p.label, source: p.source ?? 'employee_name' }))
        : []
    )
    setEditorOpen(true)
  }

  const updatePlaceholdersFromContent = () => {
    const extracted = extractPlaceholders(formContent)
    const byKey = new Map(formPlaceholders.map((p) => [p.key, p]))
    const merged = extracted.map((e) => {
      const existing = byKey.get(e.key)
      return existing
        ? { key: e.key, label: existing.label, source: existing.source }
        : { key: e.key, label: e.label, source: e.source }
    })
    setFormPlaceholders(merged)
  }

  const saveTemplate = async () => {
    setSavingTemplate(true)
    setError(null)
    try {
      await upsertContractTemplate({
        id: editingTemplate?.id,
        name: formName,
        description: formDescription || undefined,
        template_content: formContent,
        placeholders: formPlaceholders.map((p) => ({ key: p.key, label: p.label, source: p.source })),
        is_active: true,
        version: editingTemplate ? editingTemplate.version + 1 : 1,
      })
      setEditorOpen(false)
      setEditingTemplate(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกเทมเพลตไม่สำเร็จ')
    } finally {
      setSavingTemplate(false)
    }
  }

  const templateById = new Map(templates.map((t) => [t.id, t]))
  const employeeSearchLower = createEmployeeSearch.trim().toLowerCase()
  const filteredEmployees = employeeSearchLower
    ? employees.filter(
        (e) =>
          e.employee_code?.toLowerCase().includes(employeeSearchLower) ||
          e.first_name?.toLowerCase().includes(employeeSearchLower) ||
          e.last_name?.toLowerCase().includes(employeeSearchLower) ||
          e.nickname?.toLowerCase().includes(employeeSearchLower)
      )
    : employees
  const selectedEmployee = employees.find((e) => e.id === createEmployeeId) ?? null
  const selectedTemplate = templates.find((t) => t.id === createTemplateId) ?? null

  useEffect(() => {
    if (!selectedTemplate || !selectedEmployee) {
      setPreviewHtml('')
      return
    }
    const html = replacePlaceholders(
      selectedTemplate.template_content,
      selectedTemplate.placeholders ?? [],
      selectedEmployee,
      createCustomValues
    )
    setPreviewHtml(html)
  }, [selectedTemplate, selectedEmployee, createCustomValues])

  const openCreateContract = () => {
    setCreateEmployeeId('')
    setCreateEmployeeSearch('')
    setCreateTemplateId(templates[0]?.id ?? '')
    setCreateCustomValues({})
    setCreateModalOpen(true)
  }

  const saveContractDraft = async () => {
    if (!selectedTemplate || !selectedEmployee) return
    setSavingContract(true)
    setError(null)
    try {
      const content = replacePlaceholders(
        selectedTemplate.template_content,
        selectedTemplate.placeholders ?? [],
        selectedEmployee,
        createCustomValues
      )
      await upsertContract({
        employee_id: selectedEmployee.id,
        template_id: selectedTemplate.id,
        content,
        start_date: undefined,
        end_date: undefined,
        salary: selectedEmployee.salary,
        position: (selectedEmployee.position as { name?: string } | undefined)?.name,
        status: 'draft',
      })
      setCreateModalOpen(false)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกสัญญาไม่สำเร็จ')
    } finally {
      setSavingContract(false)
    }
  }

  const generatePdf = async () => {
    if (!pdfRef) return
    try {
      const html2pdf = (await import('html2pdf.js')).default
      await html2pdf().set({
        margin: 10,
        filename: `contract_${selectedEmployee?.employee_code ?? 'draft'}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      }).from(pdfRef).save()
    } catch (e) {
      console.error(e)
      setError('สร้าง PDF ไม่สำเร็จ')
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-soft">
        <p className="text-emerald-600">กำลังโหลด...</p>
      </div>
    )
  }

  return (
    <div className="flex gap-6 rounded-xl bg-white p-6 shadow-soft">
      <section className="w-72 shrink-0 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-emerald-900">เทมเพลตสัญญา</h2>
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-soft hover:bg-emerald-700"
          >
            <FiPlus /> เพิ่ม
          </button>
        </div>
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-800">
            <FiAlertCircle /> {error}
          </div>
        )}
        <ul className="space-y-1">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => openEditor(t)}
                className="flex w-full items-center gap-2 rounded-xl border border-emerald-200 px-3 py-2 text-left text-sm text-emerald-900 hover:bg-emerald-50"
              >
                <FiFileText className="shrink-0 text-emerald-600" />
                <span className="truncate">{t.name}</span>
                <FiEdit2 className="ml-auto shrink-0 text-emerald-500" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="min-w-0 flex-1">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-emerald-900">สัญญาที่สร้างแล้ว</h3>
          <button
            type="button"
            onClick={openCreateContract}
            className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-soft hover:bg-emerald-700"
          >
            <FiUser /> สร้างสัญญาจากเทมเพลต
          </button>
        </div>
        <div className="overflow-x-auto rounded-xl border border-emerald-200 shadow-soft">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-emerald-200 bg-emerald-50/80">
                <th className="p-2 font-semibold text-emerald-900">เลขที่สัญญา</th>
                <th className="p-2 font-semibold text-emerald-900">พนักงาน</th>
                <th className="p-2 font-semibold text-emerald-900">เทมเพลต</th>
                <th className="p-2 font-semibold text-emerald-900">วันที่เริ่ม-สิ้นสุด</th>
                <th className="p-2 font-semibold text-emerald-900">สถานะ</th>
                <th className="p-2 font-semibold text-emerald-900">Actions</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const emp = c.employee
                const name = emp
                  ? [emp.first_name, emp.last_name].filter(Boolean).join(' ')
                  : c.employee_id
                const tpl = c.template_id ? templateById.get(c.template_id) : null
                const dateRange =
                  c.start_date || c.end_date
                    ? `${c.start_date ?? '-'} ถึง ${c.end_date ?? '-'}`
                    : '-'
                const statusLabel = { draft: 'ฉบับร่าง', active: 'มีผล', expired: 'หมดอายุ', terminated: 'สิ้นสุด' }[c.status] ?? c.status
                return (
                  <tr key={c.id} className="border-b border-emerald-100 hover:bg-emerald-50/50">
                    <td className="p-2">{c.contract_number ?? '-'}</td>
                    <td className="p-2">{name}</td>
                    <td className="p-2">{tpl?.name ?? '-'}</td>
                    <td className="p-2">{dateRange}</td>
                    <td className="p-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          c.status === 'draft'
                            ? 'bg-amber-100 text-amber-800'
                            : c.status === 'active'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {statusLabel}
                      </span>
                    </td>
                    <td className="p-2">-</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {contracts.length === 0 && (
            <p className="p-4 text-center text-sm text-emerald-600">ยังไม่มีสัญญา</p>
          )}
        </div>
      </section>

      <Modal
        open={editorOpen}
        onClose={() => { setEditorOpen(false); setEditingTemplate(null) }}
        contentClassName="max-w-4xl"
      >
        <div className="border-b border-emerald-200 p-4">
          <h3 className="text-lg font-semibold text-emerald-900">
            {editingTemplate ? 'แก้ไขเทมเพลต' : 'เพิ่มเทมเพลต'}
          </h3>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-emerald-800">ชื่อ</label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className="w-full rounded-xl border border-emerald-200 px-3 py-2 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-emerald-800">คำอธิบาย</label>
            <input
              type="text"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              className="w-full rounded-xl border border-emerald-200 px-3 py-2 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-emerald-800">{'เนื้อหา (HTML, ใช้ {{placeholder}})'}</label>
              <button
                type="button"
                onClick={updatePlaceholdersFromContent}
                className="text-xs text-emerald-600 hover:underline"
              >
                ดึง placeholders จากเนื้อหา
              </button>
            </div>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              rows={12}
              className="w-full rounded-xl border border-emerald-200 px-3 py-2 font-mono text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            />
          </div>
          {formPlaceholders.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-emerald-800">Placeholders</label>
              <ul className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/30 p-3">
                {formPlaceholders.map((p, i) => (
                  <li key={p.key} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-emerald-700">{'{{' + p.key + '}}'}</span>
                    <input
                      type="text"
                      value={p.label}
                      onChange={(e) => {
                        const next = [...formPlaceholders]
                        next[i] = { ...next[i], label: e.target.value }
                        setFormPlaceholders(next)
                      }}
                      placeholder="Label"
                      className="w-32 rounded-lg border border-emerald-200 px-2 py-1 text-sm"
                    />
                    <select
                      value={p.source}
                      onChange={(e) => {
                        const next = [...formPlaceholders]
                        next[i] = { ...next[i], source: e.target.value }
                        setFormPlaceholders(next)
                      }}
                      className="rounded-lg border border-emerald-200 px-2 py-1 text-sm"
                    >
                      {PLACEHOLDER_SOURCES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-emerald-200 p-4">
          <button
            type="button"
            onClick={() => { setEditorOpen(false); setEditingTemplate(null) }}
            className="rounded-xl border border-emerald-200 px-4 py-2 text-emerald-800 hover:bg-emerald-50"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={saveTemplate}
            disabled={savingTemplate || !formName.trim()}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow-soft hover:bg-emerald-700 disabled:opacity-50"
          >
            <FiSave /> {savingTemplate ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
        </div>
      </Modal>

      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        contentClassName="max-w-4xl"
      >
        <div className="border-b border-emerald-200 p-4">
          <h3 className="text-lg font-semibold text-emerald-900">สร้างสัญญาจากเทมเพลต</h3>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-emerald-800">พนักงาน (ค้นหาชื่อ/รหัส)</label>
            <input
              type="text"
              value={createEmployeeSearch}
              onChange={(e) => setCreateEmployeeSearch(e.target.value)}
              placeholder="พิมพ์ชื่อหรือรหัสพนักงาน..."
              className="mb-2 w-full rounded-xl border border-emerald-200 px-3 py-2 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            />
            <select
              value={createEmployeeId}
              onChange={(e) => setCreateEmployeeId(e.target.value)}
              className="w-full rounded-xl border border-emerald-200 px-3 py-2 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              <option value="">-- เลือกพนักงาน --</option>
              {filteredEmployees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employee_code} - {emp.first_name} {emp.last_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-emerald-800">เทมเพลต</label>
            <select
              value={createTemplateId}
              onChange={(e) => setCreateTemplateId(e.target.value)}
              className="w-full rounded-xl border border-emerald-200 px-3 py-2 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {selectedTemplate?.placeholders?.filter((p) => p.source === 'custom').length ? (
            <div>
              <label className="mb-1 block text-sm font-medium text-emerald-800">ค่ากำหนดเอง</label>
              <div className="space-y-2">
                {selectedTemplate.placeholders
                  .filter((p) => p.source === 'custom')
                  .map((p) => (
                    <div key={p.key} className="flex items-center gap-2">
                      <span className="w-32 text-sm text-emerald-700">{p.label || p.key}</span>
                      <input
                        type="text"
                        value={createCustomValues[p.key] ?? ''}
                        onChange={(e) =>
                          setCreateCustomValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                        className="flex-1 rounded-lg border border-emerald-200 px-2 py-1"
                      />
                    </div>
                  ))}
              </div>
            </div>
          ) : null}
          <div>
            <label className="mb-1 block text-sm font-medium text-emerald-800">ตัวอย่าง (Preview)</label>
            <div
              ref={setPdfRef}
              className="max-h-96 overflow-auto rounded-xl border border-emerald-200 bg-white p-4 text-sm prose prose-emerald max-w-none"
              dangerouslySetInnerHTML={{ __html: previewHtml || '<p class="text-gray-400">เลือกพนักงานและเทมเพลต</p>' }}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-emerald-200 p-4">
          <button
            type="button"
            onClick={() => setCreateModalOpen(false)}
            className="rounded-xl border border-emerald-200 px-4 py-2 text-emerald-800 hover:bg-emerald-50"
          >
            ปิด
          </button>
          <button
            type="button"
            onClick={generatePdf}
            disabled={!pdfRef || !selectedEmployee}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-600 px-4 py-2 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            <FiDownload /> สร้าง PDF
          </button>
          <button
            type="button"
            onClick={saveContractDraft}
            disabled={savingContract || !selectedEmployee || !selectedTemplate}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow-soft hover:bg-emerald-700 disabled:opacity-50"
          >
            <FiSave /> {savingContract ? 'กำลังบันทึก...' : 'บันทึกเป็นฉบับร่าง'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
