import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  FiArrowLeft, FiBookOpen, FiDownload, FiEdit2, FiFile, FiFolder,
  FiPlus, FiSave, FiSearch, FiSettings, FiTrash2, FiUpload, FiX,
} from 'react-icons/fi'
import { useAuthContext } from '../contexts/AuthContext'
import {
  createKnowledgeItem, deleteKnowledgeFile, deleteKnowledgeItem, downloadKnowledgeFile,
  fetchKnowledgeCategories, fetchKnowledgeDepartments, fetchKnowledgeItem, fetchKnowledgeItems, fetchKnowledgeMachines,
  KnowledgeAccessLevel, KnowledgeCategory, KnowledgeDepartment, KnowledgeFile, KnowledgeItem, KnowledgeItemInput,
  KnowledgeMachine, saveKnowledgeCategory, updateKnowledgeItem, uploadKnowledgeFiles,
} from '../lib/knowledgeHubApi'

const ACCESS_LABELS: Record<KnowledgeAccessLevel, string> = {
  general: 'ทั่วไป', restricted: 'จำกัดตาม Role', private: 'สำคัญ / Superadmin',
}
const ACCESS_CLASSES: Record<KnowledgeAccessLevel, string> = {
  general: 'bg-emerald-50 text-emerald-700', restricted: 'bg-amber-50 text-amber-700', private: 'bg-rose-50 text-rose-700',
}
const ROLE_OPTIONS = [
  ['admin', 'Admin'], ['sales-tr', 'Sales TR'], ['sales-pump', 'Sales Pump'], ['production', 'Production'],
  ['store', 'Store'], ['account', 'Account'], ['hr', 'HR'], ['technician', 'Technician'],
] as const

function thaiDate(value: string) {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function fileSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const detail = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    const parts = [detail.message, detail.details, detail.hint, detail.code]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (parts.length > 0) return parts.join(' · ')
  }
  return 'เกิดข้อผิดพลาด กรุณาลองใหม่'
}
function Loading() {
  return <div className="flex min-h-[50vh] items-center justify-center"><div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-indigo-600" /></div>
}
function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  if (!text) return null
  return <div className="mb-5 flex items-start justify-between rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{text}</span><button onClick={onClose}><FiX /></button></div>
}

function KnowledgeList() {
  const [items, setItems] = useState<KnowledgeItem[]>([])
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [access, setAccess] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [departments, setDepartments] = useState<KnowledgeDepartment[]>([])
  const [fileType, setFileType] = useState('')

  useEffect(() => {
    Promise.all([fetchKnowledgeItems(), fetchKnowledgeCategories(), fetchKnowledgeDepartments()])
      .then(([itemRows, categoryRows, departmentRows]) => { setItems(itemRows); setCategories(categoryRows); setDepartments(departmentRows) })
      .catch((error) => setNotice(errorText(error)))
      .finally(() => setLoading(false))
  }, [])

  const extensions = useMemo(() => [...new Set(items.flatMap((item) => item.files.map((file) => file.file_extension).filter(Boolean) as string[]))].sort(), [items])
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('th')
    return items.filter((item) => {
      const searchable = [item.knowledge_code, item.title, item.description, item.content, item.category?.name,
        item.machine?.name, item.department?.name, ...item.tags, ...item.files.flatMap((file) => [file.display_name, file.description, file.searchable_text])]
        .filter(Boolean).join(' ').toLocaleLowerCase('th')
      return (!q || searchable.includes(q))
        && (!categoryId || item.category_id === categoryId)
        && (!departmentId || item.department_id === departmentId)
        && (!access || item.access_level === access)
        && (!fileType || item.files.some((file) => file.file_extension === fileType))
    })
  }, [items, search, categoryId, departmentId, access, fileType])

  return <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
    <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-indigo-600 to-sky-500 p-6 text-white shadow-lg sm:p-9">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div><div className="mb-2 flex items-center gap-2 text-indigo-100"><FiBookOpen /><span className="text-sm font-medium">คลังความรู้ของบริษัท</span></div><h1 className="text-3xl font-bold">Knowledge Hub</h1><p className="mt-2 max-w-2xl text-indigo-100">ค้นหาคู่มือ เอกสาร โปรแกรมเครื่องจักร และไฟล์สำหรับงานผลิตได้จากที่เดียว</p></div>
        <div className="flex flex-wrap gap-2"><Link to="/knowledge-hub/categories" className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 font-medium text-white hover:bg-white/25"><FiSettings />หมวดหมู่</Link><Link to="/knowledge-hub/new" className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 font-semibold text-indigo-700 shadow hover:bg-indigo-50"><FiPlus />เพิ่มข้อมูล</Link></div>
      </div>
      <div className="relative mt-7"><FiSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-xl text-slate-400" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อ เนื้อหา Tag ชื่อไฟล์ หรือข้อมูลใน JSON..." className="w-full rounded-2xl border-0 bg-white py-4 pl-12 pr-4 text-base text-slate-900 shadow-md outline-none ring-indigo-200 focus:ring-4" /></div>
    </div>
    <Notice text={notice} onClose={() => setNotice('')} />
    <div className="flex flex-wrap gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="">ทุกหมวดหมู่</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
      <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="">ทุกแผนก</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select>
      <select value={access} onChange={(e) => setAccess(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="">ทุกระดับสิทธิ์</option>{Object.entries(ACCESS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <select value={fileType} onChange={(e) => setFileType(e.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm"><option value="">ทุกประเภทไฟล์</option>{extensions.map((extension) => <option key={extension} value={extension}>.{extension}</option>)}</select>
      <div className="ml-auto self-center text-sm text-slate-500">พบ {filtered.length.toLocaleString()} รายการ</div>
    </div>
    {loading ? <Loading /> : filtered.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-14 text-center"><FiFolder className="mx-auto mb-3 text-4xl text-slate-300" /><p className="font-medium text-slate-600">ยังไม่พบข้อมูล</p><p className="mt-1 text-sm text-slate-400">ลองเปลี่ยนคำค้น หรือเพิ่มข้อมูลรายการแรก</p></div> :
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((item) => <Link key={item.id} to={`/knowledge-hub/${item.id}`} className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md">
        <div className="flex items-start justify-between gap-3"><span className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500">{item.knowledge_code}</span><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${ACCESS_CLASSES[item.access_level]}`}>{ACCESS_LABELS[item.access_level]}</span></div>
        <h2 className="mt-4 line-clamp-2 text-lg font-semibold text-slate-900 group-hover:text-indigo-700">{item.title}</h2><p className="mt-2 line-clamp-2 min-h-10 text-sm text-slate-500">{item.description || 'ไม่มีคำอธิบาย'}</p>
        <div className="mt-4 flex flex-wrap gap-1.5">{item.category && <span className="rounded-lg bg-indigo-50 px-2 py-1 text-xs text-indigo-700">{item.category.name}</span>}{item.department && <span className="rounded-lg bg-violet-50 px-2 py-1 text-xs text-violet-700">{item.department.name}</span>}{item.machine && <span className="rounded-lg bg-sky-50 px-2 py-1 text-xs text-sky-700">{item.machine.name}</span>}{item.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">#{tag}</span>)}</div>
        <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4 text-xs text-slate-400"><span className="flex items-center gap-1"><FiFile /> {item.files.length} ไฟล์</span><span>แก้ไข {thaiDate(item.updated_at)}</span></div>
      </Link>)}</div>}
  </div>
}

function KnowledgeDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [item, setItem] = useState<KnowledgeItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  useEffect(() => { fetchKnowledgeItem(id).then(setItem).catch((error) => setNotice(errorText(error))).finally(() => setLoading(false)) }, [id])
  async function download(file: KnowledgeFile) { try { await downloadKnowledgeFile(file) } catch (error) { setNotice(errorText(error)) } }
  async function remove() {
    if (!item || !window.confirm(`ลบ “${item.title}” และไฟล์ทั้งหมดใช่หรือไม่?`)) return
    try { await deleteKnowledgeItem(item); navigate('/knowledge-hub') } catch (error) { setNotice(errorText(error)) }
  }
  if (loading) return <Loading />
  if (!item) return <div className="p-8"><Notice text={notice || 'ไม่พบข้อมูล'} onClose={() => setNotice('')} /></div>
  return <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6 lg:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><Link to="/knowledge-hub" className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-700"><FiArrowLeft />กลับหน้าค้นหา</Link><div className="flex gap-2"><Link to={`/knowledge-hub/${item.id}/edit`} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><FiEdit2 />แก้ไข</Link><button onClick={remove} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"><FiTrash2 />ลบ</button></div></div>
    <Notice text={notice} onClose={() => setNotice('')} />
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 p-6 sm:p-8"><div className="flex flex-wrap items-center gap-2"><span className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-xs text-slate-500">{item.knowledge_code}</span><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${ACCESS_CLASSES[item.access_level]}`}>{ACCESS_LABELS[item.access_level]}</span>{item.category && <span className="rounded-lg bg-indigo-50 px-2 py-1 text-xs text-indigo-700">{item.category.name}</span>}</div><h1 className="mt-4 text-3xl font-bold text-slate-900">{item.title}</h1>{item.description && <p className="mt-3 text-lg leading-relaxed text-slate-500">{item.description}</p>}<div className="mt-4 flex flex-wrap gap-3 text-sm text-slate-500">{item.department && <span>แผนก: <b>{item.department.name}</b></span>}{item.machine && <span>เครื่องจักร: <b>{item.machine.name}</b></span>}<span>อัปเดต: {thaiDate(item.updated_at)}</span></div></header>
      {item.content && <section className="p-6 sm:p-8"><h2 className="mb-4 text-lg font-semibold text-slate-900">เนื้อหา / วิธีใช้งาน</h2><div className="whitespace-pre-wrap leading-7 text-slate-700">{item.content}</div></section>}
      {item.tags.length > 0 && <div className="border-t border-slate-100 px-6 py-4 sm:px-8">{item.tags.map((tag) => <span key={tag} className="mr-2 inline-block rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600">#{tag}</span>)}</div>}
    </article>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><FiFile className="text-indigo-600" />ไฟล์แนบ ({item.files.length})</h2>{item.files.length === 0 ? <p className="text-sm text-slate-400">ไม่มีไฟล์แนบ</p> : <div className="divide-y divide-slate-100">{item.files.map((file) => <div key={file.id} className="flex items-center gap-3 py-3"><div className="rounded-xl bg-indigo-50 p-3 text-indigo-600"><FiFile /></div><div className="min-w-0 flex-1"><div className="truncate font-medium text-slate-800">{file.display_name}</div><div className="text-xs text-slate-400">{file.file_extension?.toUpperCase() || 'FILE'} · {fileSize(file.file_size)}</div></div><button onClick={() => download(file)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-indigo-300 hover:text-indigo-700"><FiDownload />ดาวน์โหลด</button></div>)}</div>}</section>
  </div>
}

const EMPTY_FORM: KnowledgeItemInput = { title: '', description: '', content: '', category_id: null, machine_id: null, department_id: null, access_level: 'general', tags: [], allowed_roles: [] }

function KnowledgeEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const editing = Boolean(id)
  const [form, setForm] = useState<KnowledgeItemInput>(EMPTY_FORM)
  const [currentFiles, setCurrentFiles] = useState<KnowledgeFile[]>([])
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [machines, setMachines] = useState<KnowledgeMachine[]>([])
  const [departments, setDepartments] = useState<KnowledgeDepartment[]>([])
  const [tagText, setTagText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    Promise.all([fetchKnowledgeCategories(), fetchKnowledgeMachines(), fetchKnowledgeDepartments(), id ? fetchKnowledgeItem(id) : Promise.resolve(null)])
      .then(([categoryRows, machineRows, departmentRows, item]) => { setCategories(categoryRows); setMachines(machineRows); setDepartments(departmentRows); if (item) { setForm({ title: item.title, description: item.description || '', content: item.content || '', category_id: item.category_id, machine_id: item.machine_id, department_id: item.department_id, access_level: item.access_level, tags: item.tags, allowed_roles: item.allowed_roles }); setTagText(item.tags.join(', ')); setCurrentFiles(item.files) } })
      .catch((error) => setNotice(errorText(error))).finally(() => setLoading(false))
  }, [id])
  function addFiles(event: ChangeEvent<HTMLInputElement>) { setNewFiles((old) => [...old, ...Array.from(event.target.files || [])]); event.target.value = '' }
  async function removeExisting(file: KnowledgeFile) { if (!window.confirm(`ลบไฟล์ ${file.display_name} ใช่หรือไม่?`)) return; try { await deleteKnowledgeFile(file); setCurrentFiles((old) => old.filter((row) => row.id !== file.id)) } catch (error) { setNotice(errorText(error)) } }
  function toggleRole(role: string) { setForm((old) => ({ ...old, allowed_roles: old.allowed_roles.includes(role) ? old.allowed_roles.filter((r) => r !== role) : [...old.allowed_roles, role] })) }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!form.title.trim()) { setNotice('กรุณาระบุชื่อเรื่อง'); return }
    setSaving(true); setNotice('')
    try {
      const payload = { ...form, title: form.title.trim(), tags: tagText.split(',').map((tag) => tag.trim()).filter(Boolean) }
      const itemId = id || await createKnowledgeItem(payload)
      if (id) await updateKnowledgeItem(id, payload)
      if (newFiles.length) await uploadKnowledgeFiles(itemId, newFiles)
      navigate(`/knowledge-hub/${itemId}`)
    } catch (error) { setNotice(errorText(error)); setSaving(false) }
  }
  if (loading) return <Loading />
  return <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8"><Link to={id ? `/knowledge-hub/${id}` : '/knowledge-hub'} className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-700"><FiArrowLeft />กลับ</Link><Notice text={notice} onClose={() => setNotice('')} />
    <form onSubmit={submit} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-6"><h1 className="text-2xl font-bold text-slate-900">{editing ? 'แก้ไขข้อมูล' : 'เพิ่มข้อมูลใหม่'}</h1><p className="mt-1 text-sm text-slate-500">กรอกเฉพาะข้อมูลที่จำเป็น แล้วเพิ่มไฟล์ได้หลายรายการ</p></div>
      <div className="space-y-6 p-6"><label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">ชื่อเรื่อง *</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100" placeholder="เช่น โปรแกรมเครื่องพิมพ์ UV รุ่น A" /></label>
        <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">คำอธิบายสั้น</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-indigo-500" /></label>
        <div className="grid gap-5 sm:grid-cols-3"><label><span className="mb-2 block text-sm font-medium text-slate-700">หมวดหมู่</span><select value={form.category_id || ''} onChange={(e) => setForm({ ...form, category_id: e.target.value || null })} className="w-full rounded-xl border border-slate-300 px-4 py-3"><option value="">ไม่ระบุ</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label><span className="mb-2 block text-sm font-medium text-slate-700">แผนก</span><select value={form.department_id || ''} onChange={(e) => setForm({ ...form, department_id: e.target.value || null })} className="w-full rounded-xl border border-slate-300 px-4 py-3"><option value="">ไม่ระบุ</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label><label><span className="mb-2 block text-sm font-medium text-slate-700">เครื่องจักร (ถ้ามี)</span><select value={form.machine_id || ''} onChange={(e) => setForm({ ...form, machine_id: e.target.value || null })} className="w-full rounded-xl border border-slate-300 px-4 py-3"><option value="">ไม่ระบุ</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label></div>
        <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">เนื้อหา / วิธีใช้งาน</span><textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={10} className="w-full rounded-xl border border-slate-300 px-4 py-3 leading-7 outline-none focus:border-indigo-500" placeholder="ใส่วิธีใช้งาน ข้อควรระวัง หรือตำแหน่งติดตั้ง..." /></label>
        <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">Tags / คำค้น <span className="font-normal text-slate-400">(คั่นด้วย comma)</span></span><input value={tagText} onChange={(e) => setTagText(e.target.value)} className="w-full rounded-xl border border-slate-300 px-4 py-3" placeholder="เครื่องพิมพ์, UV, โปรแกรม, production" /></label>
        <fieldset><legend className="mb-3 text-sm font-medium text-slate-700">ระดับการเข้าถึง</legend><div className="grid gap-3 sm:grid-cols-3">{(Object.keys(ACCESS_LABELS) as KnowledgeAccessLevel[]).map((level) => <label key={level} className={`cursor-pointer rounded-xl border p-4 ${form.access_level === level ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100' : 'border-slate-200'}`}><input type="radio" name="access" value={level} checked={form.access_level === level} onChange={() => setForm({ ...form, access_level: level })} className="mr-2" /><span className="font-medium">{ACCESS_LABELS[level]}</span></label>)}</div>{form.access_level === 'restricted' && <div className="mt-3 flex flex-wrap gap-2 rounded-xl bg-slate-50 p-4">{ROLE_OPTIONS.map(([role, label]) => <label key={role} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm shadow-sm"><input type="checkbox" checked={form.allowed_roles.includes(role)} onChange={() => toggleRole(role)} />{label}</label>)}</div>}<p className="mt-2 text-xs text-slate-400">ช่วงเริ่มต้นระบบยังเปิดให้ Superadmin เท่านั้น การตั้งค่านี้เตรียมไว้สำหรับเปิดให้พนักงานภายหลัง</p></fieldset>
        <div><div className="mb-2 text-sm font-medium text-slate-700">ไฟล์แนบ</div><label className="flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center hover:border-indigo-400 hover:bg-indigo-50/30"><FiUpload className="mb-2 text-3xl text-indigo-500" /><span className="font-medium text-slate-700">เลือกไฟล์ได้หลายรายการ</span><span className="mt-1 text-xs text-slate-400">รองรับเอกสาร ZIP โปรแกรมเครื่องจักร JSON และ Script</span><input type="file" multiple className="hidden" onChange={addFiles} /></label>
          {(currentFiles.length > 0 || newFiles.length > 0) && <div className="mt-3 divide-y rounded-xl border border-slate-200">{currentFiles.map((file) => <div key={file.id} className="flex items-center gap-3 p-3"><FiFile className="text-indigo-500" /><span className="min-w-0 flex-1 truncate text-sm">{file.display_name}</span><span className="text-xs text-slate-400">{fileSize(file.file_size)}</span><button type="button" onClick={() => removeExisting(file)} className="p-1 text-rose-500"><FiTrash2 /></button></div>)}{newFiles.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center gap-3 p-3"><FiFile className="text-emerald-500" /><span className="min-w-0 flex-1 truncate text-sm">{file.name}</span><span className="text-xs text-emerald-600">ไฟล์ใหม่ · {fileSize(file.size)}</span><button type="button" onClick={() => setNewFiles((old) => old.filter((_, i) => i !== index))} className="p-1 text-rose-500"><FiX /></button></div>)}</div>}
        </div>
      </div><div className="flex justify-end gap-3 border-t border-slate-100 bg-slate-50 p-5"><button type="button" onClick={() => navigate(-1)} className="rounded-xl border border-slate-300 px-5 py-2.5 font-medium text-slate-600">ยกเลิก</button><button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"><FiSave />{saving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</button></div>
    </form>
  </div>
}

function KnowledgeCategories() {
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [editing, setEditing] = useState<Partial<KnowledgeCategory> & { name: string }>({ name: '', description: '', sort_order: 1, is_active: true })
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  async function load() { try { setCategories(await fetchKnowledgeCategories(true)) } catch (error) { setNotice(errorText(error)) } }
  useEffect(() => { void load() }, [])
  async function submit(event: FormEvent) { event.preventDefault(); if (!editing.name.trim()) return; setSaving(true); try { await saveKnowledgeCategory({ ...editing, name: editing.name.trim() }); setEditing({ name: '', description: '', sort_order: categories.length + 1, is_active: true }); await load() } catch (error) { setNotice(errorText(error)) } finally { setSaving(false) } }
  return <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6 lg:p-8"><Link to="/knowledge-hub" className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-700"><FiArrowLeft />กลับ Knowledge Hub</Link><Notice text={notice} onClose={() => setNotice('')} /><div className="grid gap-5 lg:grid-cols-[1fr_340px]"><div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h1 className="mb-4 text-xl font-bold">หมวดหมู่</h1><div className="divide-y divide-slate-100">{categories.map((category) => <button key={category.id} onClick={() => setEditing(category)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-slate-50"><FiFolder className="text-indigo-500" /><div className="flex-1"><div className="font-medium text-slate-800">{category.name}</div><div className="text-xs text-slate-400">{category.description || 'ไม่มีคำอธิบาย'}</div></div><span className={`rounded-full px-2 py-1 text-xs ${category.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{category.is_active ? 'ใช้งาน' : 'ปิด'}</span></button>)}</div></div><form onSubmit={submit} className="h-fit space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold">{editing.id ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่'}</h2><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="ชื่อหมวดหมู่" className="w-full rounded-xl border border-slate-300 px-3 py-2.5" /><textarea value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="คำอธิบาย" rows={3} className="w-full rounded-xl border border-slate-300 px-3 py-2.5" /><label className="block"><span className="mb-1.5 block text-sm font-medium text-slate-700">ลำดับการแสดง</span><input type="number" min="1" step="1" value={editing.sort_order || 1} onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} className="w-full rounded-xl border border-slate-300 px-3 py-2.5" /><span className="mt-1 block text-xs text-slate-400">ใช้เลข 1, 2, 3 ได้ — เลขน้อยจะแสดงก่อน</span></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.is_active ?? true} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} />เปิดใช้งาน</label><div className="flex gap-2"><button disabled={saving} className="flex-1 rounded-xl bg-indigo-600 px-4 py-2.5 font-medium text-white">{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>{editing.id && <button type="button" onClick={() => setEditing({ name: '', description: '', sort_order: categories.length + 1, is_active: true })} className="rounded-xl border px-3">ยกเลิก</button>}</div></form></div></div>
}

export default function KnowledgeHub() {
  const { user } = useAuthContext()
  const { id } = useParams()
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />
  const path = window.location.pathname
  if (path.endsWith('/categories')) return <KnowledgeCategories />
  if (path.endsWith('/new') || path.endsWith('/edit')) return <KnowledgeEditor />
  if (id) return <KnowledgeDetail />
  return <KnowledgeList />
}
