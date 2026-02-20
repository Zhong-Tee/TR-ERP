import { useState, useEffect, useCallback } from 'react'
import { FiEdit2, FiPlus, FiEye, FiFolder, FiChevronRight, FiX } from 'react-icons/fi'
import {
  fetchDocumentCategories,
  fetchDocuments,
  upsertDocument,
  fetchExams,
  upsertExam,
  uploadHRFile,
  getHRFileUrl,
  fetchDepartments,
} from '../../lib/hrApi'
import type { HRDocumentCategory, HRDocument, HRExam, HRDepartment } from '../../types'
import Modal from '../ui/Modal'

const BUCKET = 'hr-company-docs'
// test
const LEVEL_OPTIONS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'ปฏิบัติการ', label: 'ปฏิบัติการ' },
  { value: 'หัวหน้างาน', label: 'หัวหน้างาน' },
  { value: 'ผู้จัดการ', label: 'ผู้จัดการ' },
] as const

type DocWithCategory = HRDocument & { category?: { name: string } }

function buildCategoryTree(categories: HRDocumentCategory[]) {
  const roots = categories.filter((c) => !c.parent_id)
  const byParent = new Map<string, HRDocumentCategory[]>()
  categories.forEach((c) => {
    const key = c.parent_id ?? '__root'
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(c)
  })
  return roots
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => ({
      id: r.id,
      name: r.name,
      children: (byParent.get(r.id) ?? []).sort((a, b) => a.sort_order - b.sort_order).map((c) => ({ id: c.id, name: c.name })),
    }))
}

export default function CompanyDocuments() {
  const [activeTab, setActiveTab] = useState<'docs' | 'exams'>('docs')
  const [categories, setCategories] = useState<HRDocumentCategory[]>([])
  const [documents, setDocuments] = useState<DocWithCategory[]>([])
  const [exams, setExams] = useState<HRExam[]>([])
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [docDeptFilter, setDocDeptFilter] = useState<string>('')
  const [docLevelFilter, setDocLevelFilter] = useState<string>('')
  const [docModalOpen, setDocModalOpen] = useState(false)
  const [editingDoc, setEditingDoc] = useState<HRDocument | null>(null)
  const [docForm, setDocForm] = useState<Partial<HRDocument>>({
    title: '', description: '', category_id: undefined, department_id: undefined, level: undefined,
    version: '1.0', requires_acknowledgment: false,
  })
  const [docFile, setDocFile] = useState<File | null>(null)
  const [docSaving, setDocSaving] = useState(false)
  const [viewDoc, setViewDoc] = useState<DocWithCategory | null>(null)
  const [examModalOpen, setExamModalOpen] = useState(false)
  const [editingExam, setEditingExam] = useState<HRExam | null>(null)
  const [examForm, setExamForm] = useState<Partial<HRExam>>({
    title: '', description: '', department_id: undefined, level: undefined,
    passing_score: 70, time_limit_minutes: 60, questions: [],
  })
  const [examSaving, setExamSaving] = useState(false)
  const [previewExam, setPreviewExam] = useState<HRExam | null>(null)

  const loadCategories = useCallback(async () => { setCategories(await fetchDocumentCategories()) }, [])
  const loadDocuments = useCallback(async () => {
    const data = await fetchDocuments({ category_id: selectedCategoryId ?? undefined, department_id: docDeptFilter || undefined })
    setDocuments(data as DocWithCategory[])
  }, [selectedCategoryId, docDeptFilter])
  const loadExams = useCallback(async () => { setExams(await fetchExams()) }, [])
  const loadDepartments = useCallback(async () => { setDepartments(await fetchDepartments()) }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([loadCategories(), loadDocuments(), loadExams(), loadDepartments()])
      .then(() => { if (!cancelled) setLoading(false) })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ'); setLoading(false) } })
    return () => { cancelled = true }
  }, [loadCategories, loadDocuments, loadExams, loadDepartments])

  const filteredDocs = docLevelFilter ? documents.filter((d) => (d.level ?? '') === docLevelFilter) : documents
  const tree = buildCategoryTree(categories)

  const openDocModal = (doc?: HRDocument) => {
    setEditingDoc(doc ?? null)
    setDocForm({
      title: doc?.title ?? '', description: doc?.description ?? '', category_id: doc?.category_id ?? undefined,
      department_id: doc?.department_id ?? undefined, level: doc?.level ?? undefined, version: doc?.version ?? '1.0',
      requires_acknowledgment: doc?.requires_acknowledgment ?? false, file_url: doc?.file_url, content: doc?.content,
    })
    setDocFile(null)
    setDocModalOpen(true)
  }

  const saveDocument = async () => {
    if (!docForm.title?.trim()) return
    setDocSaving(true)
    setError(null)
    try {
      let fileUrl = docForm.file_url
      if (docFile) {
        const path = `docs/${Date.now()}-${docFile.name}`
        await uploadHRFile(BUCKET, path, docFile)
        fileUrl = path
      }
      await upsertDocument({
        id: editingDoc?.id, title: docForm.title.trim(), description: docForm.description?.trim() || undefined,
        category_id: docForm.category_id || undefined, department_id: docForm.department_id || undefined,
        level: docForm.level || undefined, version: docForm.version || '1.0',
        requires_acknowledgment: docForm.requires_acknowledgment ?? false, file_url: fileUrl, content: docForm.content, is_active: true,
      })
      setDocModalOpen(false)
      await loadDocuments()
      await loadCategories()
    } catch (e) { setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') } finally { setDocSaving(false) }
  }

  const openExamModal = (exam?: HRExam) => {
    setEditingExam(exam ?? null)
    setExamForm({
      title: exam?.title ?? '', description: exam?.description ?? '', department_id: exam?.department_id ?? undefined,
      level: exam?.level ?? undefined, passing_score: exam?.passing_score ?? 70, time_limit_minutes: exam?.time_limit_minutes ?? 60,
      questions: exam?.questions?.length ? [...exam.questions] : [],
    })
    setExamModalOpen(true)
  }

  const addQuestion = () => {
    setExamForm((prev) => ({
      ...prev,
      questions: [...(prev.questions ?? []), { question: '', options: ['', '', '', ''], correct_answer: 0, score: 1 }],
    }))
  }

  const updateQuestion = (idx: number, patch: Partial<HRExam['questions'][0]>) => {
    setExamForm((prev) => {
      const q = [...(prev.questions ?? [])]
      q[idx] = { ...q[idx], ...patch }
      return { ...prev, questions: q }
    })
  }

  const removeQuestion = (idx: number) => {
    setExamForm((prev) => ({ ...prev, questions: prev.questions?.filter((_, i) => i !== idx) ?? [] }))
  }

  const saveExam = async () => {
    if (!examForm.title?.trim()) return
    setExamSaving(true)
    setError(null)
    try {
      await upsertExam({
        id: editingExam?.id, title: examForm.title.trim(), description: examForm.description?.trim() || undefined,
        department_id: examForm.department_id || undefined, level: examForm.level || undefined,
        passing_score: examForm.passing_score ?? 70, time_limit_minutes: examForm.time_limit_minutes ?? undefined,
        questions: examForm.questions ?? [], is_active: true,
      })
      setExamModalOpen(false)
      await loadExams()
    } catch (e) { setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ') } finally { setExamSaving(false) }
  }

  if (loading) return (<div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" /></div>)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">เอกสารบริษัท และข้อสอบ</h1>
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}
      <div className="flex gap-2 border-b border-surface-200">
        <button type="button" onClick={() => setActiveTab('docs')} className={`px-4 py-2 rounded-t-xl font-medium text-sm ${activeTab === 'docs' ? 'bg-emerald-100 text-emerald-800 border border-b-0 border-emerald-200' : 'bg-surface-50 text-gray-600 hover:bg-surface-100'}`}>เอกสาร</button>
        <button type="button" onClick={() => setActiveTab('exams')} className={`px-4 py-2 rounded-t-xl font-medium text-sm ${activeTab === 'exams' ? 'bg-emerald-100 text-emerald-800 border border-b-0 border-emerald-200' : 'bg-surface-50 text-gray-600 hover:bg-surface-100'}`}>ข้อสอบ</button>
      </div>
      {activeTab === 'docs' && (
        <div className="flex gap-6 rounded-xl shadow-soft border border-surface-200 bg-surface-50 overflow-hidden">
          <aside className="w-56 shrink-0 border-r border-surface-200 bg-white p-3">
            <div className="text-xs font-semibold text-gray-500 uppercase mb-2">หมวดหมู่</div>
            <button type="button" onClick={() => setSelectedCategoryId(null)} className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${selectedCategoryId === null ? 'bg-emerald-100 text-emerald-800' : 'hover:bg-surface-100'}`}><FiFolder /> ทั้งหมด</button>
            {tree.map((node) => (
              <div key={node.id} className="mt-1">
                <button type="button" onClick={() => setSelectedCategoryId(node.id)} className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${selectedCategoryId === node.id ? 'bg-emerald-100 text-emerald-800' : 'hover:bg-surface-100'}`}><FiChevronRight className="w-4" /><FiFolder /><span className="truncate">{node.name}</span></button>
                {node.children.map((ch) => (
                  <button key={ch.id} type="button" onClick={() => setSelectedCategoryId(ch.id)} className={`w-full text-left pl-8 pr-3 py-1.5 rounded-lg text-sm flex items-center gap-2 ${selectedCategoryId === ch.id ? 'bg-emerald-100 text-emerald-800' : 'hover:bg-surface-100'}`}><FiFolder className="opacity-70" /><span className="truncate">{ch.name}</span></button>
                ))}
              </div>
            ))}
          </aside>
          <div className="flex-1 min-w-0 p-4">
            <div className="flex flex-wrap gap-3 mb-4">
              <select value={docDeptFilter} onChange={(e) => setDocDeptFilter(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm bg-white">
                <option value="">ทุกแผนก</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select value={docLevelFilter} onChange={(e) => setDocLevelFilter(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm bg-white">
                {LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button type="button" onClick={() => openDocModal()} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 shadow-soft"><FiPlus /> เพิ่มเอกสาร</button>
            </div>
            <div className="rounded-xl border border-surface-200 bg-white overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-100 border-b border-surface-200">
                  <tr><th className="text-left py-3 px-4 font-semibold text-gray-700">ชื่อ</th><th className="text-left py-3 px-4 font-semibold text-gray-700">คำอธิบาย</th><th className="text-left py-3 px-4 font-semibold text-gray-700">แผนก</th><th className="text-left py-3 px-4 font-semibold text-gray-700">ระดับ</th><th className="text-left py-3 px-4 font-semibold text-gray-700">เวอร์ชัน</th><th className="text-right py-3 px-4 font-semibold text-gray-700">จัดการ</th></tr>
                </thead>
                <tbody>
                  {filteredDocs.map((doc) => (
                    <tr key={doc.id} className="border-b border-surface-100 hover:bg-surface-50">
                      <td className="py-3 px-4 font-medium">{doc.title}</td>
                      <td className="py-3 px-4 text-gray-600 max-w-xs truncate">{doc.description ?? '-'}</td>
                      <td className="py-3 px-4">{doc.department_id ? departments.find((d) => d.id === doc.department_id)?.name ?? '-' : 'ทั้งหมด'}</td>
                      <td className="py-3 px-4">{doc.level ?? '-'}</td>
                      <td className="py-3 px-4">{doc.version}</td>
                      <td className="py-3 px-4 text-right">
                        <button type="button" onClick={() => setViewDoc(doc)} className="p-2 text-gray-600 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="ดู"><FiEye /></button>
                        <button type="button" onClick={() => openDocModal(doc)} className="p-2 text-gray-600 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="แก้ไข"><FiEdit2 /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredDocs.length === 0 && <div className="py-12 text-center text-gray-500">ไม่มีเอกสาร</div>}
            </div>
          </div>
        </div>
      )}
      {activeTab === 'exams' && (
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4">
          <div className="flex justify-end mb-4">
            <button type="button" onClick={() => openExamModal()} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 shadow-soft"><FiPlus /> เพิ่มข้อสอบ</button>
          </div>
          <div className="rounded-xl border border-surface-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-100 border-b border-surface-200">
                <tr><th className="text-left py-3 px-4 font-semibold text-gray-700">ชื่อ</th><th className="text-left py-3 px-4 font-semibold text-gray-700">แผนก</th><th className="text-left py-3 px-4 font-semibold text-gray-700">ระดับ</th><th className="text-left py-3 px-4 font-semibold text-gray-700">คะแนนผ่าน</th><th className="text-left py-3 px-4 font-semibold text-gray-700">จำนวนข้อ</th><th className="text-right py-3 px-4 font-semibold text-gray-700">จัดการ</th></tr>
              </thead>
              <tbody>
                {exams.map((exam) => (
                  <tr key={exam.id} className="border-b border-surface-100 hover:bg-surface-50">
                    <td className="py-3 px-4 font-medium">{exam.title}</td>
                    <td className="py-3 px-4">{exam.department_id ? departments.find((d) => d.id === exam.department_id)?.name ?? '-' : '-'}</td>
                    <td className="py-3 px-4">{exam.level ?? '-'}</td>
                    <td className="py-3 px-4">{exam.passing_score}%</td>
                    <td className="py-3 px-4">{exam.questions?.length ?? 0}</td>
                    <td className="py-3 px-4 text-right">
                      <button type="button" onClick={() => setPreviewExam(exam)} className="p-2 text-gray-600 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="ดูตัวอย่าง"><FiEye /></button>
                      <button type="button" onClick={() => openExamModal(exam)} className="p-2 text-gray-600 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="แก้ไข"><FiEdit2 /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {exams.length === 0 && <div className="py-12 text-center text-gray-500">ไม่มีข้อสอบ</div>}
          </div>
        </div>
      )}
      <Modal open={docModalOpen} onClose={() => setDocModalOpen(false)} contentClassName="max-w-lg">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{editingDoc ? 'แก้ไขเอกสาร' : 'เพิ่มเอกสาร'}</h2>
          <div className="space-y-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">ชื่อเอกสาร *</label><input type="text" value={docForm.title ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, title: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">คำอธิบาย</label><textarea value={docForm.description ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, description: e.target.value }))} rows={2} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">หมวดหมู่</label><select value={docForm.category_id ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, category_id: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"><option value="">-- เลือก --</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">แผนก (ว่าง = ทั้งหมด)</label><select value={docForm.department_id ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, department_id: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"><option value="">ทั้งหมด</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">ระดับ</label><select value={docForm.level ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, level: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"><option value="">-- เลือก --</option><option value="ปฏิบัติการ">ปฏิบัติการ</option><option value="หัวหน้างาน">หัวหน้างาน</option><option value="ผู้จัดการ">ผู้จัดการ</option></select></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">เวอร์ชัน</label><input type="text" value={docForm.version ?? ''} onChange={(e) => setDocForm((p) => ({ ...p, version: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">ไฟล์แนบ</label><input type="file" onChange={(e) => setDocFile(e.target.files?.[0] ?? null)} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />{editingDoc?.file_url && !docFile && <p className="text-xs text-gray-500 mt-1">ไฟล์เดิม: {editingDoc.file_url}</p>}</div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={docForm.requires_acknowledgment ?? false} onChange={(e) => setDocForm((p) => ({ ...p, requires_acknowledgment: e.target.checked }))} className="rounded border-surface-300 text-emerald-600" /><span className="text-sm text-gray-700">ต้องยืนยันการอ่าน</span></label>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button type="button" onClick={() => setDocModalOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 text-gray-700 hover:bg-surface-100">ยกเลิก</button>
            <button type="button" onClick={saveDocument} disabled={docSaving || !docForm.title?.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{docSaving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
          </div>
        </div>
      </Modal>
      <Modal open={!!viewDoc} onClose={() => setViewDoc(null)} contentClassName="max-w-2xl">
        {viewDoc && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">{viewDoc.title}</h2>
            {viewDoc.description && <p className="text-sm text-gray-600 mb-4">{viewDoc.description}</p>}
            {viewDoc.file_url ? <a href={getHRFileUrl(BUCKET, viewDoc.file_url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-emerald-600 hover:underline">เปิดไฟล์</a> : viewDoc.content ? <div className="rounded-xl border border-surface-200 p-4 bg-white text-sm whitespace-pre-wrap max-h-96 overflow-y-auto">{viewDoc.content}</div> : <p className="text-gray-500">ไม่มีเนื้อหา</p>}
            <div className="mt-4 flex justify-end"><button type="button" onClick={() => setViewDoc(null)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ปิด</button></div>
          </div>
        )}
      </Modal>
      <Modal open={examModalOpen} onClose={() => setExamModalOpen(false)} contentClassName="max-w-2xl">
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{editingExam ? 'แก้ไขข้อสอบ' : 'เพิ่มข้อสอบ'}</h2>
          <div className="space-y-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">ชื่อข้อสอบ *</label><input type="text" value={examForm.title ?? ''} onChange={(e) => setExamForm((p) => ({ ...p, title: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">คำอธิบาย</label><textarea value={examForm.description ?? ''} onChange={(e) => setExamForm((p) => ({ ...p, description: e.target.value }))} rows={2} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">แผนก</label><select value={examForm.department_id ?? ''} onChange={(e) => setExamForm((p) => ({ ...p, department_id: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"><option value="">-- เลือก --</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">ระดับ</label><select value={examForm.level ?? ''} onChange={(e) => setExamForm((p) => ({ ...p, level: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"><option value="">-- เลือก --</option><option value="ปฏิบัติการ">ปฏิบัติการ</option><option value="หัวหน้างาน">หัวหน้างาน</option><option value="ผู้จัดการ">ผู้จัดการ</option></select></div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700 mb-1">คะแนนผ่าน (%)</label><input type="number" min={0} max={100} value={examForm.passing_score ?? 70} onChange={(e) => setExamForm((p) => ({ ...p, passing_score: Number(e.target.value) || 0 }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
              <div><label className="block text-sm font-medium text-gray-700 mb-1">เวลาจำกัด (นาที)</label><input type="number" min={1} value={examForm.time_limit_minutes ?? 60} onChange={(e) => setExamForm((p) => ({ ...p, time_limit_minutes: Number(e.target.value) || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" /></div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2"><span className="text-sm font-medium text-gray-700">คำถาม (แบบเลือกตอบ)</span><button type="button" onClick={addQuestion} className="text-sm text-emerald-600 hover:underline">+ เพิ่มคำถาม</button></div>
              <div className="space-y-4 max-h-64 overflow-y-auto">
                {(examForm.questions ?? []).map((q, idx) => (
                  <div key={idx} className="rounded-xl border border-surface-200 p-3 bg-surface-50">
                    <div className="flex justify-between items-start gap-2 mb-2"><span className="text-xs font-medium text-gray-500">ข้อ {idx + 1}</span><button type="button" onClick={() => removeQuestion(idx)} className="text-red-600 hover:bg-red-50 p-1 rounded"><FiX className="w-4 h-4" /></button></div>
                    <input type="text" placeholder="คำถาม" value={q.question} onChange={(e) => updateQuestion(idx, { question: e.target.value })} className="w-full rounded-lg border border-surface-200 px-2 py-1.5 text-sm mb-2" />
                    {q.options.map((opt, oi) => (
                      <div key={oi} className="flex items-center gap-2 mb-1">
                        <input type="radio" name={`correct-${idx}`} checked={q.correct_answer === oi} onChange={() => updateQuestion(idx, { correct_answer: oi })} className="text-emerald-600" />
                        <input type="text" placeholder={`ตัวเลือก ${oi + 1}`} value={opt} onChange={(e) => { const opts = [...q.options]; opts[oi] = e.target.value; updateQuestion(idx, { options: opts }) }} className="flex-1 rounded-lg border border-surface-200 px-2 py-1 text-sm" />
                      </div>
                    ))}
                    <div className="mt-2"><label className="text-xs text-gray-500">คะแนนต่อข้อ </label><input type="number" min={0} value={q.score} onChange={(e) => updateQuestion(idx, { score: Number(e.target.value) || 0 })} className="w-16 rounded border border-surface-200 px-2 py-1 text-sm" /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button type="button" onClick={() => setExamModalOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 text-gray-700 hover:bg-surface-100">ยกเลิก</button>
            <button type="button" onClick={saveExam} disabled={examSaving || !examForm.title?.trim()} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{examSaving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
          </div>
        </div>
      </Modal>
      <Modal open={!!previewExam} onClose={() => setPreviewExam(null)} contentClassName="max-w-lg">
        {previewExam && (
          <div className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">{previewExam.title}</h2>
            {previewExam.description && <p className="text-sm text-gray-600 mb-4">{previewExam.description}</p>}
            <p className="text-xs text-gray-500 mb-4">ผ่าน {previewExam.passing_score}% · เวลา {previewExam.time_limit_minutes ?? '-'} นาที · {previewExam.questions?.length ?? 0} ข้อ</p>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {(previewExam.questions ?? []).map((q, idx) => (
                <div key={idx} className="rounded-xl border border-surface-200 p-3 text-sm">
                  <p className="font-medium text-gray-800">{idx + 1}. {q.question}</p>
                  <ul className="mt-2 space-y-1 pl-4">{q.options.map((opt, oi) => <li key={oi} className={q.correct_answer === oi ? 'text-emerald-600 font-medium' : ''}>{String.fromCharCode(65 + oi)}. {opt}{q.correct_answer === oi && ' ✓'}</li>)}</ul>
                  <p className="text-xs text-gray-500 mt-1">คะแนน: {q.score}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" onClick={() => setPreviewExam(null)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ปิด</button></div>
          </div>
        )}
      </Modal>
    </div>
  )
}
