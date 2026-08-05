import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiEye, FiCheck, FiX, FiUpload, FiStar, FiUsers } from 'react-icons/fi'
import {
  fetchAnnouncements,
  fetchAnnouncementCategories,
  upsertAnnouncement,
  deleteAnnouncement,
  setAnnouncementApproval,
  fetchAnnouncementAckStatus,
  fetchDepartments,
  fetchEmployeeByUserId,
  uploadHRFile,
  ANNOUNCEMENT_BUCKET,
} from '../../lib/hrApi'
import type {
  HRAnnouncement,
  HRAnnouncementCategory,
  HRAnnouncementAckStatus,
  HRDepartment,
} from '../../types'
import Modal from '../ui/Modal'
import { useWmsModal } from '../wms/useWmsModal'
import { useAuthContext } from '../../contexts/AuthContext'
import { AttachmentStrip } from './employee/AttachmentViewer'

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: 'รออนุมัติ', color: 'bg-amber-100 text-amber-800' },
  published: { label: 'เผยแพร่แล้ว', color: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'ไม่อนุมัติ', color: 'bg-red-100 text-red-700' },
}

/** ผู้มีสิทธิ์สร้าง/แก้ไขประกาศ — ต้องตรงกับ hr_can_manage_announcements() ใน DB */
const MANAGE_ROLES = ['superadmin', 'admin', 'account']

type FormState = {
  id?: string
  category_id: string
  title: string
  content: string
  is_pinned: boolean
  target_all_departments: boolean
  department_ids: string[]
  attachment_urls: string[]
}

const EMPTY_FORM: FormState = {
  category_id: '',
  title: '',
  content: '',
  is_pinned: false,
  target_all_departments: true,
  department_ids: [],
  attachment_urls: [],
}

const personName = (e?: { first_name?: string; last_name?: string; nickname?: string } | null) => {
  if (!e) return '-'
  const name = [e.first_name, e.last_name].filter(Boolean).join(' ')
  return e.nickname ? `${name} (${e.nickname})` : name || '-'
}

const thaiDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-'

export default function AnnouncementManagement() {
  const { user } = useAuthContext()
  const canManage = MANAGE_ROLES.includes(user?.role ?? '')

  const [announcements, setAnnouncements] = useState<HRAnnouncement[]>([])
  const [categories, setCategories] = useState<HRAnnouncementCategory[]>([])
  const [departments, setDepartments] = useState<HRDepartment[]>([])
  /** hr_employees.id ของผู้ใช้ปัจจุบัน — ใช้เช็คว่าเราเป็นผู้อนุมัติของประกาศไหน */
  const [myEmployeeId, setMyEmployeeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterCategory, setFilterCategory] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [viewItem, setViewItem] = useState<HRAnnouncement | null>(null)
  const [ackStatus, setAckStatus] = useState<HRAnnouncementAckStatus[] | null>(null)
  const [ackLoading, setAckLoading] = useState(false)
  const [acting, setActing] = useState(false)

  /** ประกาศที่กำลังจะกด "ไม่อนุมัติ" — เปิดกล่องกรอกเหตุผล */
  const [rejectTarget, setRejectTarget] = useState<HRAnnouncement | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { showConfirm, showMessage, ConfirmModal, MessageModal } = useWmsModal()

  const loadAll = useCallback(async () => {
    try {
      setError(null)
      const [list, cats, depts, emp] = await Promise.all([
        fetchAnnouncements(),
        fetchAnnouncementCategories(),
        fetchDepartments(),
        user?.id ? fetchEmployeeByUserId(user.id) : Promise.resolve(null),
      ])
      setAnnouncements(list)
      setCategories(cats)
      setDepartments(depts)
      setMyEmployeeId(emp?.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { loadAll() }, [loadAll])

  // เปิดรายละเอียดแล้วโหลดสถานะการรับทราบ (เฉพาะประกาศที่เผยแพร่แล้ว)
  useEffect(() => {
    if (!viewItem || viewItem.status !== 'published' || !canManage) {
      setAckStatus(null)
      return
    }
    let cancelled = false
    setAckLoading(true)
    fetchAnnouncementAckStatus(viewItem.id)
      .then((rows) => { if (!cancelled) setAckStatus(rows) })
      .catch(() => { if (!cancelled) setAckStatus([]) })
      .finally(() => { if (!cancelled) setAckLoading(false) })
    return () => { cancelled = true }
  }, [viewItem, canManage])

  const filtered = useMemo(() => {
    let list = announcements
    if (filterStatus) list = list.filter((a) => a.status === filterStatus)
    if (filterCategory) list = list.filter((a) => a.category_id === filterCategory)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((a) =>
        a.title.toLowerCase().includes(q) ||
        (a.content ?? '').toLowerCase().includes(q) ||
        (a.category?.name ?? '').toLowerCase().includes(q))
    }
    return list
  }, [announcements, filterStatus, filterCategory, search])

  const approvalSummary = (a: HRAnnouncement) => {
    const total = a.approvals?.length ?? 0
    const approved = a.approvals?.filter((ap) => ap.status === 'approved').length ?? 0
    return { total, approved }
  }

  /** รายการอนุมัติของเราในประกาศนี้ที่ยังไม่ได้กด */
  const myPendingApproval = (a: HRAnnouncement) =>
    a.approvals?.find((ap) => ap.employee_id === myEmployeeId && ap.status === 'pending') ?? null

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id ?? '' })
    setFormOpen(true)
  }

  const openEdit = (a: HRAnnouncement) => {
    setForm({
      id: a.id,
      category_id: a.category_id ?? '',
      title: a.title,
      content: a.content ?? '',
      is_pinned: a.is_pinned,
      target_all_departments: a.target_all_departments,
      department_ids: (a.departments ?? []).map((d) => d.department_id),
      attachment_urls: a.attachment_urls ?? [],
    })
    setFormOpen(true)
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    try {
      const paths: string[] = []
      for (const file of Array.from(files)) {
        const path = `${Date.now()}_${file.name}`
        paths.push(await uploadHRFile(ANNOUNCEMENT_BUCKET, path, file))
      }
      setForm((f) => ({ ...f, attachment_urls: [...f.attachment_urls, ...paths] }))
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'อัปโหลดไฟล์ไม่สำเร็จ' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSave = async () => {
    if (!form.title.trim()) { showMessage({ message: 'กรุณาระบุหัวข้อประกาศ' }); return }
    if (!form.content.trim()) { showMessage({ message: 'กรุณาระบุเนื้อหาประกาศ' }); return }
    if (!form.target_all_departments && form.department_ids.length === 0) {
      showMessage({ message: 'กรุณาเลือกแผนกที่ต้องการส่งประกาศ' })
      return
    }
    setSaving(true)
    try {
      await upsertAnnouncement(
        {
          id: form.id,
          category_id: form.category_id || null,
          title: form.title.trim(),
          content: form.content.trim(),
          is_pinned: form.is_pinned,
          target_all_departments: form.target_all_departments,
          attachment_urls: form.attachment_urls,
          ...(form.id ? {} : { created_by: myEmployeeId ?? undefined, created_by_user: user?.id }),
        },
        form.department_ids
      )
      await loadAll()
      setFormOpen(false)
      showMessage({ message: form.id ? 'บันทึกประกาศแล้ว — ผู้อนุมัติต้องกดอนุมัติใหม่ทั้งหมด' : 'สร้างประกาศแล้ว รอผู้อนุมัติ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (a: HRAnnouncement) => {
    const yes = await showConfirm({ message: `ต้องการลบประกาศ "${a.title}" หรือไม่?` })
    if (!yes) return
    try {
      await deleteAnnouncement(a.id)
      await loadAll()
      if (viewItem?.id === a.id) setViewItem(null)
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ลบไม่สำเร็จ' })
    }
  }

  const handleApprove = async (a: HRAnnouncement) => {
    const approval = myPendingApproval(a)
    if (!approval) return
    const yes = await showConfirm({ title: 'อนุมัติประกาศ', message: `ยืนยันอนุมัติประกาศ "${a.title}"?`, confirmText: 'อนุมัติ' })
    if (!yes) return
    setActing(true)
    try {
      await setAnnouncementApproval(approval.id, 'approved')
      const list = await fetchAnnouncements()
      setAnnouncements(list)
      setViewItem((prev) => (prev ? list.find((x) => x.id === prev.id) ?? null : null))
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'อนุมัติไม่สำเร็จ' })
    } finally {
      setActing(false)
    }
  }

  const confirmReject = async () => {
    if (!rejectTarget) return
    const approval = myPendingApproval(rejectTarget)
    if (!approval) return
    setActing(true)
    try {
      await setAnnouncementApproval(approval.id, 'rejected', rejectReason.trim() || undefined)
      const list = await fetchAnnouncements()
      setAnnouncements(list)
      setViewItem((prev) => (prev ? list.find((x) => x.id === prev.id) ?? null : null))
      setRejectTarget(null)
      setRejectReason('')
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ' })
    } finally {
      setActing(false)
    }
  }

  if (loading) {
    return <div className="mt-4 flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" /></div>
  }

  const ackDone = ackStatus?.filter((r) => r.acknowledged) ?? []
  const ackPending = ackStatus?.filter((r) => !r.acknowledged) ?? []

  return (
    <div className="mt-4 space-y-6">
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'ทั้งหมด', value: announcements.length, color: 'bg-surface-50 border-surface-200' },
          { label: 'รออนุมัติ', value: announcements.filter((a) => a.status === 'pending').length, color: 'bg-amber-50 border-amber-200' },
          { label: 'เผยแพร่แล้ว', value: announcements.filter((a) => a.status === 'published').length, color: 'bg-emerald-50 border-emerald-200' },
          { label: 'รอฉันอนุมัติ', value: announcements.filter((a) => myPendingApproval(a)).length, color: 'bg-blue-50 border-blue-200' },
        ].map((s) => (
          <div key={s.label} className={`rounded-xl border p-4 ${s.color}`}>
            <div className="text-2xl font-bold">{s.value}</div>
            <div className="text-xs text-gray-500 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาหัวข้อ / เนื้อหา / ประเภท..."
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-surface-200 text-sm focus:ring-2 focus:ring-emerald-300"
          />
        </div>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">ประเภททั้งหมด</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">สถานะทั้งหมด</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        {canManage && (
          <button onClick={openCreate} className="ml-auto flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
            <FiPlus className="w-4 h-4" /> สร้างประกาศ
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl shadow-soft border border-surface-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 border-b border-surface-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">หัวข้อ</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">ประเภท</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">กลุ่มเป้าหมาย</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">สถานะ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">อนุมัติ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">วันที่สร้าง</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">ไม่พบประกาศ</td></tr>
              ) : filtered.map((a) => {
                const st = STATUS_LABELS[a.status] ?? STATUS_LABELS.pending
                const { total, approved } = approvalSummary(a)
                const mine = myPendingApproval(a)
                return (
                  <tr key={a.id} className="border-b border-surface-100 hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-3 max-w-[280px]">
                      <div className="flex items-center gap-1.5 font-medium truncate">
                        {a.is_pinned && <FiStar className="w-3.5 h-3.5 text-amber-500 shrink-0" title="ประกาศสำคัญ" />}
                        <span className="truncate">{a.title}</span>
                      </div>
                      <div className="text-xs text-gray-400 truncate">โดย {personName(a.creator)}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{a.category?.name ?? '-'}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {a.target_all_departments
                        ? 'ทั้งบริษัท'
                        : (a.departments ?? []).map((d) => d.department?.name).filter(Boolean).join(', ') || '-'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${st.color}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-xs">
                      {total === 0 ? <span className="text-gray-400">ไม่มีผู้อนุมัติ</span> : `${approved}/${total}`}
                    </td>
                    <td className="px-4 py-3 text-center text-xs">{thaiDateTime(a.created_at)}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => setViewItem(a)} className="p-1.5 rounded-lg hover:bg-surface-100 text-gray-500" title="ดูรายละเอียด"><FiEye className="w-4 h-4" /></button>
                        {mine && (
                          <>
                            <button onClick={() => handleApprove(a)} disabled={acting} className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-700" title="อนุมัติ"><FiCheck className="w-4 h-4" /></button>
                            <button onClick={() => setRejectTarget(a)} disabled={acting} className="p-1.5 rounded-lg hover:bg-red-50 text-red-600" title="ไม่อนุมัติ"><FiX className="w-4 h-4" /></button>
                          </>
                        )}
                        {canManage && (
                          <>
                            <button onClick={() => openEdit(a)} className="p-1.5 rounded-lg hover:bg-surface-100 text-blue-600" title="แก้ไข"><FiEdit2 className="w-4 h-4" /></button>
                            <button onClick={() => handleDelete(a)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-500" title="ลบ"><FiTrash2 className="w-4 h-4" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit */}
      <Modal open={formOpen} onClose={() => setFormOpen(false)} contentClassName="max-w-3xl">
        <div className="p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-800">{form.id ? 'แก้ไขประกาศ' : 'สร้างประกาศใหม่'}</h2>
          {form.id && (
            <p className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 px-4 py-2 text-xs">
              แก้ไขเนื้อหาแล้ว ผู้อนุมัติทุกคนต้องกดอนุมัติใหม่อีกครั้ง
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">หัวข้อประกาศ *</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
                placeholder="เช่น ประกาศวันหยุดสงกรานต์ 2569"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ประเภท</label>
              <select
                value={form.category_id}
                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}
                className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
              >
                <option value="">-- ไม่ระบุ --</option>
                {categories.filter((c) => c.is_active || c.id === form.category_id).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">เนื้อหา *</label>
            <textarea
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              rows={10}
              className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
              placeholder="พิมพ์เนื้อหาประกาศ..."
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_pinned}
              onChange={(e) => setForm((f) => ({ ...f, is_pinned: e.target.checked }))}
              className="rounded"
            />
            <FiStar className="w-4 h-4 text-amber-500" />
            ติดดาวเป็นประกาศสำคัญ (แสดงบนสุด)
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">กลุ่มเป้าหมาย</label>
            <div className="flex gap-2 mb-2">
              {([[true, 'ทั้งบริษัท'], [false, 'เลือกแผนก']] as [boolean, string][]).map(([all, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, target_all_departments: all }))}
                  className={`px-4 py-2 rounded-xl text-sm font-medium border ${
                    form.target_all_departments === all
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-gray-600 border-surface-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {!form.target_all_departments && (
              <div className="flex flex-wrap gap-2 rounded-xl border border-surface-200 p-3">
                {departments.map((d) => {
                  const checked = form.department_ids.includes(d.id)
                  return (
                    <label key={d.id} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm cursor-pointer border ${checked ? 'bg-emerald-50 border-emerald-300' : 'bg-white border-surface-200'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setForm((f) => ({
                          ...f,
                          department_ids: e.target.checked
                            ? [...f.department_ids, d.id]
                            : f.department_ids.filter((x) => x !== d.id),
                        }))}
                        className="rounded"
                      />
                      {d.name}
                    </label>
                  )
                })}
                {departments.length === 0 && <span className="text-sm text-gray-400">ยังไม่มีข้อมูลแผนก</span>}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ไฟล์แนบ</label>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf"
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 rounded-xl border-2 border-dashed border-emerald-300 text-emerald-700 px-4 py-2.5 text-sm hover:bg-emerald-50 disabled:opacity-60"
            >
              <FiUpload className="w-4 h-4" />
              {uploading ? 'กำลังอัปโหลด...' : 'แนบไฟล์ (รูป/PDF)'}
            </button>
            {form.attachment_urls.length > 0 && (
              <ul className="mt-2 space-y-1">
                {form.attachment_urls.map((path) => (
                  <li key={path} className="flex items-center justify-between gap-2 rounded-lg bg-surface-50 px-3 py-2 text-xs">
                    <span className="truncate">{path.replace(/^\d{10,}_/, '')}</span>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, attachment_urls: f.attachment_urls.filter((p) => p !== path) }))}
                      className="text-red-500 hover:text-red-700 shrink-0"
                    >
                      ลบ
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ยกเลิก</button>
            <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Detail */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} contentClassName="max-w-3xl">
        {viewItem && (
          <div className="p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                  {viewItem.is_pinned && <FiStar className="w-4 h-4 text-amber-500" />}
                  {viewItem.title}
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  {viewItem.category?.name ?? 'ไม่ระบุประเภท'} · โดย {personName(viewItem.creator)} · {thaiDateTime(viewItem.created_at)}
                </p>
              </div>
              <span className={`shrink-0 px-2 py-1 rounded-full text-xs font-medium ${(STATUS_LABELS[viewItem.status] ?? STATUS_LABELS.pending).color}`}>
                {(STATUS_LABELS[viewItem.status] ?? STATUS_LABELS.pending).label}
              </span>
            </div>

            {viewItem.status === 'rejected' && viewItem.reject_reason && (
              <div className="rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-2 text-sm">
                เหตุผลที่ไม่อนุมัติ: {viewItem.reject_reason}
              </div>
            )}

            <div className="rounded-xl border border-surface-200 bg-white p-4 text-sm whitespace-pre-wrap">
              {viewItem.content}
            </div>

            {viewItem.attachment_urls?.length > 0 && (
              <AttachmentStrip
                label="ไฟล์แนบ"
                items={viewItem.attachment_urls.map((path) => ({ bucket: ANNOUNCEMENT_BUCKET, path }))}
              />
            )}

            {/* ผู้อนุมัติ */}
            <div>
              <h3 className="text-sm font-semibold text-gray-800 mb-2">ผู้อนุมัติ</h3>
              {(viewItem.approvals?.length ?? 0) === 0 ? (
                <p className="text-sm text-gray-400">ยังไม่ได้ตั้งค่าผู้อนุมัติ — ประกาศเผยแพร่ทันทีที่สร้าง</p>
              ) : (
                <ul className="space-y-2">
                  {viewItem.approvals!.map((ap) => (
                    <li key={ap.id} className="flex items-center justify-between gap-2 rounded-xl border border-surface-200 px-3 py-2 text-sm">
                      <span>{personName(ap.employee)}</span>
                      <span className="flex items-center gap-2">
                        {ap.acted_at && <span className="text-xs text-gray-400">{thaiDateTime(ap.acted_at)}</span>}
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          ap.status === 'approved' ? 'bg-emerald-100 text-emerald-800'
                            : ap.status === 'rejected' ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-800'
                        }`}>
                          {ap.status === 'approved' ? 'อนุมัติแล้ว' : ap.status === 'rejected' ? 'ไม่อนุมัติ' : 'ยังไม่อนุมัติ'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {myPendingApproval(viewItem) && (
                <div className="flex gap-2 mt-3">
                  <button onClick={() => setRejectTarget(viewItem)} disabled={acting} className="flex-1 py-2.5 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">ไม่อนุมัติ</button>
                  <button onClick={() => handleApprove(viewItem)} disabled={acting} className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">อนุมัติ</button>
                </div>
              )}
            </div>

            {/* การรับทราบ */}
            {viewItem.status === 'published' && canManage && (
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                  <FiUsers className="w-4 h-4" />
                  การรับทราบ
                  {ackStatus && (
                    <span className="text-xs font-normal text-gray-500">
                      รับทราบแล้ว {ackDone.length} จาก {ackStatus.length} คน
                    </span>
                  )}
                </h3>
                {ackLoading ? (
                  <p className="text-sm text-gray-400">กำลังโหลด...</p>
                ) : !ackStatus?.length ? (
                  <p className="text-sm text-gray-400">ไม่มีพนักงานในกลุ่มเป้าหมาย</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs font-semibold text-amber-800 mb-2">ยังไม่รับทราบ ({ackPending.length})</p>
                      <ul className="space-y-1 max-h-52 overflow-y-auto">
                        {ackPending.length === 0
                          ? <li className="text-xs text-amber-700">รับทราบครบทุกคนแล้ว</li>
                          : ackPending.map((r) => (
                            <li key={r.employee_id} className="text-xs text-amber-900">
                              {r.employee_name}
                              <span className="text-amber-600"> · {r.department_name ?? '-'}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs font-semibold text-emerald-800 mb-2">รับทราบแล้ว ({ackDone.length})</p>
                      <ul className="space-y-1 max-h-52 overflow-y-auto">
                        {ackDone.length === 0
                          ? <li className="text-xs text-emerald-700">ยังไม่มีใครกดรับทราบ</li>
                          : ackDone.map((r) => (
                            <li key={r.employee_id} className="text-xs text-emerald-900">
                              {r.employee_name}
                              <span className="text-emerald-600"> · {thaiDateTime(r.acknowledged_at)}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <button type="button" onClick={() => setViewItem(null)} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ปิด</button>
            </div>
          </div>
        )}
      </Modal>

      {/* ไม่อนุมัติ — กรอกเหตุผล */}
      <Modal open={!!rejectTarget} onClose={() => setRejectTarget(null)} contentClassName="max-w-md" stackClassName="z-[60]">
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-800">ไม่อนุมัติประกาศ</h2>
          <p className="text-sm text-gray-600">{rejectTarget?.title}</p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            placeholder="เหตุผลที่ไม่อนุมัติ (ไม่บังคับ)"
            className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setRejectTarget(null); setRejectReason('') }} className="px-4 py-2 rounded-xl border border-surface-200 hover:bg-surface-100">ยกเลิก</button>
            <button type="button" onClick={confirmReject} disabled={acting} className="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
              {acting ? 'กำลังบันทึก...' : 'ยืนยันไม่อนุมัติ'}
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmModal}
      {MessageModal}
    </div>
  )
}
