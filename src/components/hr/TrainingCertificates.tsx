import { useState, useEffect, useCallback, useMemo } from 'react'
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiEye, FiAward, FiCheck, FiClock, FiXCircle } from 'react-icons/fi'
import { fetchCertificates, upsertCertificate, deleteCertificate, fetchEmployees } from '../../lib/hrApi'
import type { HRCertificate, HREmployee } from '../../types'
import Modal from '../ui/Modal'
import { useWmsModal } from '../wms/useWmsModal'

const TYPE_LABELS: Record<string, string> = { internal: 'ภายใน', external: 'ภายนอก' }

const PASS_LABELS: Record<string, { label: string; color: string; icon: typeof FiCheck }> = {
  passed: { label: 'ผ่าน', color: 'bg-green-100 text-green-700', icon: FiCheck },
  failed: { label: 'ไม่ผ่าน', color: 'bg-red-100 text-red-700', icon: FiXCircle },
  pending: { label: 'รอผล', color: 'bg-amber-100 text-amber-700', icon: FiClock },
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: 'แบบร่าง', color: 'bg-gray-100 text-gray-600' },
  issued: { label: 'ออกใบรับรองแล้ว', color: 'bg-emerald-100 text-emerald-700' },
}

const empName = (e?: HREmployee | null) => e ? `${e.first_name} ${e.last_name}` : '-'

const EMPTY_FORM: Partial<HRCertificate> = {
  employee_id: '',
  training_name: '',
  training_type: 'internal',
  description: '',
  trainer: '',
  training_start_date: new Date().toISOString().split('T')[0],
  training_end_date: '',
  training_hours: undefined,
  score: undefined,
  pass_status: 'pending',
  certificate_date: new Date().toISOString().split('T')[0],
  expiry_date: '',
  issued_by: undefined,
  status: 'draft',
  attachment_urls: [],
}

export default function TrainingCertificates() {
  const [certs, setCerts] = useState<HRCertificate[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterPass, setFilterPass] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<Partial<HRCertificate>>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  const [viewItem, setViewItem] = useState<HRCertificate | null>(null)

  const { showConfirm, showMessage, ConfirmModal, MessageModal } = useWmsModal()

  const loadAll = useCallback(async () => {
    try {
      setError(null)
      const [c, e] = await Promise.all([fetchCertificates(), fetchEmployees()])
      setCerts(c)
      setEmployees(e)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const filtered = useMemo(() => {
    let list = certs
    if (filterType) list = list.filter(c => c.training_type === filterType)
    if (filterPass) list = list.filter(c => c.pass_status === filterPass)
    if (filterStatus) list = list.filter(c => c.status === filterStatus)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(c => {
        const name = empName(c.employee).toLowerCase()
        return name.includes(q) || c.certificate_number.toLowerCase().includes(q) || c.training_name.toLowerCase().includes(q)
      })
    }
    return list
  }, [certs, filterType, filterPass, filterStatus, search])

  const expiringSoon = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + 90)
    return certs.filter(c => c.expiry_date && new Date(c.expiry_date) <= cutoff && new Date(c.expiry_date) >= new Date())
  }, [certs])

  const expired = useMemo(() => {
    return certs.filter(c => c.expiry_date && new Date(c.expiry_date) < new Date())
  }, [certs])

  const openCreate = () => { setForm({ ...EMPTY_FORM }); setFormOpen(true) }
  const openEdit = (c: HRCertificate) => { setForm({ ...c }); setFormOpen(true) }

  const handleSave = async () => {
    if (!form.employee_id) { showMessage({ message: 'กรุณาเลือกพนักงาน' }); return }
    if (!form.training_name?.trim()) { showMessage({ message: 'กรุณาระบุชื่อหลักสูตร' }); return }
    if (!form.training_start_date) { showMessage({ message: 'กรุณาระบุวันที่เริ่มอบรม' }); return }
    setSaving(true)
    try {
      await upsertCertificate(form)
      await loadAll()
      setFormOpen(false)
      showMessage({ message: form.id ? 'บันทึกใบรับรองสำเร็จ' : 'สร้างใบรับรองสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (c: HRCertificate) => {
    const yes = await showConfirm({ message: `ต้องการลบใบรับรอง ${c.certificate_number} หรือไม่?` })
    if (!yes) return
    try {
      await deleteCertificate(c.id)
      await loadAll()
      showMessage({ message: 'ลบใบรับรองสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ลบไม่สำเร็จ' })
    }
  }

  const handleIssue = async (c: HRCertificate) => {
    if (c.pass_status !== 'passed') {
      showMessage({ message: 'สามารถออกใบรับรองได้เฉพาะผู้ที่ผ่านการอบรมแล้วเท่านั้น' })
      return
    }
    const yes = await showConfirm({ title: 'ออกใบรับรอง', message: `ยืนยันออกใบรับรอง ${c.certificate_number} ให้ ${empName(c.employee)}?`, confirmText: 'ออกใบรับรอง' })
    if (!yes) return
    try {
      await upsertCertificate({ id: c.id, status: 'issued' })
      await loadAll()
      showMessage({ message: 'ออกใบรับรองสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ' })
    }
  }

  if (loading) return <div className="mt-4 flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" /></div>

  return (
    <div className="mt-4 space-y-6">
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {[
          { label: 'ทั้งหมด', value: certs.length, color: 'bg-surface-50 border-surface-200' },
          { label: 'ผ่านการอบรม', value: certs.filter(c => c.pass_status === 'passed').length, color: 'bg-green-50 border-green-200' },
          { label: 'รอผล', value: certs.filter(c => c.pass_status === 'pending').length, color: 'bg-amber-50 border-amber-200' },
          { label: 'ใกล้หมดอายุ (90 วัน)', value: expiringSoon.length, color: 'bg-orange-50 border-orange-200' },
          { label: 'หมดอายุแล้ว', value: expired.length, color: 'bg-red-50 border-red-200' },
        ].map(s => (
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
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาชื่อ / เลขที่ / หลักสูตร..." className="w-full pl-9 pr-3 py-2 rounded-xl border border-surface-200 text-sm focus:ring-2 focus:ring-emerald-300" />
        </div>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">ประเภททั้งหมด</option>
          <option value="internal">ภายใน</option>
          <option value="external">ภายนอก</option>
        </select>
        <select value={filterPass} onChange={e => setFilterPass(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">ผลทั้งหมด</option>
          {Object.entries(PASS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">สถานะทั้งหมด</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button onClick={openCreate} className="ml-auto flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          <FiPlus className="w-4 h-4" /> บันทึกการอบรม
        </button>
      </div>

      {/* Table */}
      <div className="rounded-xl shadow-soft border border-surface-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 border-b border-surface-200">
                <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขที่</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">พนักงาน</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">หลักสูตร</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">ประเภท</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">วันที่อบรม</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">ผลการอบรม</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">หมดอายุ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">สถานะ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-10 text-gray-400">ไม่พบใบรับรอง</td></tr>
              ) : filtered.map(c => {
                const ps = PASS_LABELS[c.pass_status] || PASS_LABELS.pending
                const st = STATUS_LABELS[c.status] || STATUS_LABELS.draft
                const PassIcon = ps.icon
                const isExpired = c.expiry_date && new Date(c.expiry_date) < new Date()
                return (
                  <tr key={c.id} className="border-b border-surface-100 hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{c.certificate_number}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{empName(c.employee)}</div>
                      <div className="text-xs text-gray-400">{c.employee?.employee_code}</div>
                    </td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <div className="font-medium truncate">{c.training_name}</div>
                      {c.trainer && <div className="text-xs text-gray-400">โดย {c.trainer}</div>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="px-2 py-1 rounded-lg bg-surface-100 text-xs">{TYPE_LABELS[c.training_type] || c.training_type}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-xs">
                      {c.training_start_date}
                      {c.training_end_date && c.training_end_date !== c.training_start_date && (
                        <span className="text-gray-400"> ~ {c.training_end_date}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${ps.color}`}>
                        <PassIcon className="w-3 h-3" />{ps.label}
                      </span>
                      {c.score != null && <div className="text-xs text-gray-400 mt-0.5">{c.score} คะแนน</div>}
                    </td>
                    <td className="px-4 py-3 text-center text-xs">
                      {c.expiry_date ? (
                        <span className={isExpired ? 'text-red-600 font-medium' : ''}>{c.expiry_date}{isExpired && ' (หมดอายุ)'}</span>
                      ) : <span className="text-gray-300">-</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${st.color}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => setViewItem(c)} className="p-1.5 rounded-lg hover:bg-surface-100 text-gray-500" title="ดูรายละเอียด"><FiEye className="w-4 h-4" /></button>
                        {c.status === 'draft' && (
                          <>
                            <button onClick={() => openEdit(c)} className="p-1.5 rounded-lg hover:bg-surface-100 text-blue-600" title="แก้ไข"><FiEdit2 className="w-4 h-4" /></button>
                            <button onClick={() => handleIssue(c)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-700" title="ออกใบรับรอง"><FiAward className="w-4 h-4" /></button>
                            <button onClick={() => handleDelete(c)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-500" title="ลบ"><FiTrash2 className="w-4 h-4" /></button>
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

      {/* Create / Edit Modal */}
      <Modal open={formOpen} onClose={() => setFormOpen(false)} contentClassName="max-w-2xl">
        <div className="p-6 space-y-5">
          <h2 className="text-lg font-bold text-gray-800">{form.id ? 'แก้ไขใบรับรอง' : 'บันทึกการอบรมใหม่'}</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">พนักงาน *</label>
              <select value={form.employee_id || ''} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือกพนักงาน --</option>
                {employees.filter(e => e.employment_status === 'active').map(e => (
                  <option key={e.id} value={e.id}>{e.employee_code} - {e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ประเภทการอบรม</label>
              <select value={form.training_type || 'internal'} onChange={e => setForm(f => ({ ...f, training_type: e.target.value as HRCertificate['training_type'] }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="internal">ภายใน</option>
                <option value="external">ภายนอก</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อหลักสูตร / การอบรม *</label>
            <input type="text" value={form.training_name || ''} onChange={e => setForm(f => ({ ...f, training_name: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="เช่น อบรมความปลอดภัยในโรงงาน" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">รายละเอียด</label>
            <textarea value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="รายละเอียดเพิ่มเติม (ถ้ามี)" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ผู้สอน / สถาบัน</label>
              <input type="text" value={form.trainer || ''} onChange={e => setForm(f => ({ ...f, trainer: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="ชื่อผู้สอนหรือสถาบัน" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">จำนวนชั่วโมงอบรม</label>
              <input type="number" min={0} step={0.5} value={form.training_hours ?? ''} onChange={e => setForm(f => ({ ...f, training_hours: e.target.value ? Number(e.target.value) : undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="ชม." />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันที่เริ่มอบรม *</label>
              <input type="date" value={form.training_start_date || ''} onChange={e => setForm(f => ({ ...f, training_start_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันที่สิ้นสุดอบรม</label>
              <input type="date" value={form.training_end_date || ''} onChange={e => setForm(f => ({ ...f, training_end_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ผลการอบรม</label>
              <select value={form.pass_status || 'pending'} onChange={e => setForm(f => ({ ...f, pass_status: e.target.value as HRCertificate['pass_status'] }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                {Object.entries(PASS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">คะแนน</label>
              <input type="number" min={0} step={0.5} value={form.score ?? ''} onChange={e => setForm(f => ({ ...f, score: e.target.value ? Number(e.target.value) : undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="คะแนนที่ได้" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันหมดอายุใบรับรอง</label>
              <input type="date" value={form.expiry_date || ''} onChange={e => setForm(f => ({ ...f, expiry_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันที่ออกใบรับรอง</label>
              <input type="date" value={form.certificate_date || ''} onChange={e => setForm(f => ({ ...f, certificate_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ผู้ออกใบรับรอง</label>
              <select value={form.issued_by || ''} onChange={e => setForm(f => ({ ...f, issued_by: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.filter(e => e.employment_status === 'active').map(e => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setFormOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 text-sm hover:bg-surface-50">ยกเลิก</button>
            <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {saving ? 'กำลังบันทึก...' : form.id ? 'บันทึก' : 'บันทึกการอบรม'}
            </button>
          </div>
        </div>
      </Modal>

      {/* View Detail Modal */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} contentClassName="max-w-2xl" closeOnBackdropClick>
        {viewItem && (() => {
          const ps = PASS_LABELS[viewItem.pass_status] || PASS_LABELS.pending
          const st = STATUS_LABELS[viewItem.status] || STATUS_LABELS.draft
          const PassIcon = ps.icon
          const isExpired = viewItem.expiry_date && new Date(viewItem.expiry_date) < new Date()
          return (
            <div className="p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-800">ใบรับรอง {viewItem.certificate_number}</h2>
                  <span className={`mt-1 inline-block px-2 py-1 rounded-full text-xs font-medium ${st.color}`}>{st.label}</span>
                </div>
                <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium ${ps.color}`}>
                  <PassIcon className="w-4 h-4" />{ps.label}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">พนักงาน</div>
                  <div className="font-medium">{empName(viewItem.employee)}</div>
                  <div className="text-xs text-gray-400">{viewItem.employee?.employee_code}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">หลักสูตร</div>
                  <div className="font-medium">{viewItem.training_name}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">ประเภท</div>
                  <div className="font-medium">{TYPE_LABELS[viewItem.training_type] || viewItem.training_type}</div>
                </div>
                {viewItem.trainer && (
                  <div>
                    <div className="text-gray-500 text-xs">ผู้สอน / สถาบัน</div>
                    <div className="font-medium">{viewItem.trainer}</div>
                  </div>
                )}
                <div>
                  <div className="text-gray-500 text-xs">วันที่อบรม</div>
                  <div className="font-medium">
                    {viewItem.training_start_date}
                    {viewItem.training_end_date && viewItem.training_end_date !== viewItem.training_start_date && ` ~ ${viewItem.training_end_date}`}
                  </div>
                </div>
                {viewItem.training_hours != null && (
                  <div>
                    <div className="text-gray-500 text-xs">จำนวนชั่วโมง</div>
                    <div className="font-medium">{viewItem.training_hours} ชม.</div>
                  </div>
                )}
                {viewItem.score != null && (
                  <div>
                    <div className="text-gray-500 text-xs">คะแนน</div>
                    <div className="font-medium">{viewItem.score}</div>
                  </div>
                )}
                {viewItem.certificate_date && (
                  <div>
                    <div className="text-gray-500 text-xs">วันที่ออกใบรับรอง</div>
                    <div className="font-medium">{viewItem.certificate_date}</div>
                  </div>
                )}
                {viewItem.expiry_date && (
                  <div>
                    <div className="text-gray-500 text-xs">วันหมดอายุ</div>
                    <div className={`font-medium ${isExpired ? 'text-red-600' : ''}`}>{viewItem.expiry_date}{isExpired && ' (หมดอายุแล้ว)'}</div>
                  </div>
                )}
                {viewItem.issuer && (
                  <div>
                    <div className="text-gray-500 text-xs">ผู้ออกใบรับรอง</div>
                    <div className="font-medium">{empName(viewItem.issuer)}</div>
                  </div>
                )}
              </div>

              {viewItem.description && (
                <div>
                  <div className="text-gray-500 text-xs mb-1">รายละเอียด</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap bg-surface-50 border border-surface-200 rounded-xl p-3">{viewItem.description}</div>
                </div>
              )}

              <div className="flex justify-end">
                <button onClick={() => setViewItem(null)} className="px-4 py-2 rounded-xl border border-surface-200 text-sm hover:bg-surface-50">ปิด</button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {ConfirmModal}
      {MessageModal}
    </div>
  )
}
