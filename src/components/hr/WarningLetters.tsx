import { useState, useEffect, useCallback, useMemo } from 'react'
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiEye, FiAlertTriangle, FiCheck, FiX } from 'react-icons/fi'
import { fetchWarnings, upsertWarning, deleteWarning, fetchEmployees } from '../../lib/hrApi'
import type { HRWarning, HREmployee } from '../../types'
import Modal from '../ui/Modal'
import { useWmsModal } from '../wms/useWmsModal'

const LEVEL_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  verbal: { label: 'ตักเตือนด้วยวาจา', color: 'text-yellow-700', bg: 'bg-yellow-50 border-yellow-200' },
  written_1: { label: 'เตือนเป็นลายลักษณ์อักษร ครั้งที่ 1', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
  written_2: { label: 'เตือนเป็นลายลักษณ์อักษร ครั้งที่ 2', color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
  final: { label: 'เตือนครั้งสุดท้าย', color: 'text-red-800', bg: 'bg-red-100 border-red-300' },
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft: { label: 'แบบร่าง', color: 'bg-gray-100 text-gray-600' },
  issued: { label: 'ออกใบเตือนแล้ว', color: 'bg-blue-100 text-blue-700' },
  acknowledged: { label: 'รับทราบแล้ว', color: 'bg-green-100 text-green-700' },
  appealed: { label: 'อุทธรณ์', color: 'bg-amber-100 text-amber-700' },
  resolved: { label: 'ยุติแล้ว', color: 'bg-gray-200 text-gray-700' },
}

const empName = (e?: HREmployee | null) => e ? `${e.first_name} ${e.last_name}` : '-'

const EMPTY_FORM: Partial<HRWarning> = {
  employee_id: '',
  warning_level: 'verbal',
  subject: '',
  description: '',
  incident_date: new Date().toISOString().split('T')[0],
  issued_date: new Date().toISOString().split('T')[0],
  issued_by: undefined,
  witness_id: undefined,
  employee_response: '',
  status: 'draft',
  resolution_note: '',
  attachment_urls: [],
}

export default function WarningLetters() {
  const [warnings, setWarnings] = useState<HRWarning[]>([])
  const [employees, setEmployees] = useState<HREmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filterLevel, setFilterLevel] = useState('')
  const [filterStatus, setFilterStatus] = useState('')

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<Partial<HRWarning>>({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  const [viewItem, setViewItem] = useState<HRWarning | null>(null)

  const { showConfirm, showMessage, ConfirmModal, MessageModal } = useWmsModal()

  const loadAll = useCallback(async () => {
    try {
      setError(null)
      const [w, e] = await Promise.all([fetchWarnings(), fetchEmployees()])
      setWarnings(w)
      setEmployees(e)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const filtered = useMemo(() => {
    let list = warnings
    if (filterLevel) list = list.filter(w => w.warning_level === filterLevel)
    if (filterStatus) list = list.filter(w => w.status === filterStatus)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(w => {
        const name = empName(w.employee).toLowerCase()
        return name.includes(q) || w.warning_number.toLowerCase().includes(q) || w.subject.toLowerCase().includes(q)
      })
    }
    return list
  }, [warnings, filterLevel, filterStatus, search])

  const openCreate = () => {
    setForm({ ...EMPTY_FORM })
    setFormOpen(true)
  }

  const openEdit = (w: HRWarning) => {
    setForm({ ...w })
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (!form.employee_id) { showMessage({ message: 'กรุณาเลือกพนักงาน' }); return }
    if (!form.subject?.trim()) { showMessage({ message: 'กรุณาระบุเรื่อง' }); return }
    if (!form.incident_date) { showMessage({ message: 'กรุณาระบุวันที่เกิดเหตุ' }); return }
    setSaving(true)
    try {
      await upsertWarning(form)
      await loadAll()
      setFormOpen(false)
      showMessage({ message: form.id ? 'บันทึกใบเตือนสำเร็จ' : 'สร้างใบเตือนสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ' })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (w: HRWarning) => {
    const yes = await showConfirm({ message: `ต้องการลบใบเตือน ${w.warning_number} หรือไม่?` })
    if (!yes) return
    try {
      await deleteWarning(w.id)
      await loadAll()
      showMessage({ message: 'ลบใบเตือนสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ลบไม่สำเร็จ' })
    }
  }

  const handleIssue = async (w: HRWarning) => {
    const yes = await showConfirm({ title: 'ออกใบเตือน', message: `ยืนยันออกใบเตือน ${w.warning_number} ให้ ${empName(w.employee)}?`, confirmText: 'ออกใบเตือน' })
    if (!yes) return
    try {
      await upsertWarning({ id: w.id, status: 'issued' })
      await loadAll()
      showMessage({ message: 'ออกใบเตือนสำเร็จ' })
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ' })
    }
  }

  const handleAcknowledge = async (w: HRWarning) => {
    const yes = await showConfirm({ message: `บันทึกว่าพนักงานรับทราบใบเตือน ${w.warning_number} แล้ว?` })
    if (!yes) return
    try {
      await upsertWarning({ id: w.id, status: 'acknowledged' })
      await loadAll()
    } catch (err) {
      showMessage({ message: err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ' })
    }
  }

  const handleResolve = async (w: HRWarning) => {
    const yes = await showConfirm({ message: `ยืนยันยุติใบเตือน ${w.warning_number}?` })
    if (!yes) return
    try {
      await upsertWarning({ id: w.id, status: 'resolved', resolved_at: new Date().toISOString() })
      await loadAll()
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
          { label: 'ทั้งหมด', value: warnings.length, color: 'bg-surface-50 border-surface-200' },
          { label: 'แบบร่าง', value: warnings.filter(w => w.status === 'draft').length, color: 'bg-gray-50 border-gray-200' },
          { label: 'ออกแล้ว', value: warnings.filter(w => w.status === 'issued').length, color: 'bg-blue-50 border-blue-200' },
          { label: 'รับทราบแล้ว', value: warnings.filter(w => w.status === 'acknowledged').length, color: 'bg-green-50 border-green-200' },
          { label: 'อุทธรณ์', value: warnings.filter(w => w.status === 'appealed').length, color: 'bg-amber-50 border-amber-200' },
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
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="ค้นหาชื่อ / เลขที่ / เรื่อง..." className="w-full pl-9 pr-3 py-2 rounded-xl border border-surface-200 text-sm focus:ring-2 focus:ring-emerald-300" />
        </div>
        <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">ระดับทั้งหมด</option>
          {Object.entries(LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="rounded-xl border border-surface-200 px-3 py-2 text-sm">
          <option value="">สถานะทั้งหมด</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button onClick={openCreate} className="ml-auto flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">
          <FiPlus className="w-4 h-4" /> สร้างใบเตือน
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
                <th className="px-4 py-3 text-left font-semibold text-gray-700">ระดับ</th>
                <th className="px-4 py-3 text-left font-semibold text-gray-700">เรื่อง</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">วันที่เกิดเหตุ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">สถานะ</th>
                <th className="px-4 py-3 text-center font-semibold text-gray-700">จัดการ</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-10 text-gray-400">ไม่พบใบเตือน</td></tr>
              ) : filtered.map(w => {
                const lvl = LEVEL_LABELS[w.warning_level] || LEVEL_LABELS.verbal
                const st = STATUS_LABELS[w.status] || STATUS_LABELS.draft
                return (
                  <tr key={w.id} className="border-b border-surface-100 hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs">{w.warning_number}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{empName(w.employee)}</div>
                      <div className="text-xs text-gray-400">{w.employee?.employee_code}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-medium ${lvl.bg} ${lvl.color}`}>
                        <FiAlertTriangle className="w-3 h-3" />{lvl.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[200px] truncate">{w.subject}</td>
                    <td className="px-4 py-3 text-center text-xs">{w.incident_date}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${st.color}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => setViewItem(w)} className="p-1.5 rounded-lg hover:bg-surface-100 text-gray-500" title="ดูรายละเอียด"><FiEye className="w-4 h-4" /></button>
                        {w.status === 'draft' && (
                          <>
                            <button onClick={() => openEdit(w)} className="p-1.5 rounded-lg hover:bg-surface-100 text-blue-600" title="แก้ไข"><FiEdit2 className="w-4 h-4" /></button>
                            <button onClick={() => handleIssue(w)} className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-700" title="ออกใบเตือน"><FiCheck className="w-4 h-4" /></button>
                            <button onClick={() => handleDelete(w)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-500" title="ลบ"><FiTrash2 className="w-4 h-4" /></button>
                          </>
                        )}
                        {w.status === 'issued' && (
                          <button onClick={() => handleAcknowledge(w)} className="p-1.5 rounded-lg hover:bg-green-50 text-green-700" title="บันทึกรับทราบ"><FiCheck className="w-4 h-4" /></button>
                        )}
                        {(w.status === 'acknowledged' || w.status === 'appealed') && (
                          <button onClick={() => handleResolve(w)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600" title="ยุติ"><FiX className="w-4 h-4" /></button>
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
          <h2 className="text-lg font-bold text-gray-800">{form.id ? 'แก้ไขใบเตือน' : 'สร้างใบเตือนใหม่'}</h2>

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
              <label className="block text-sm font-medium text-gray-700 mb-1">ระดับการเตือน</label>
              <select value={form.warning_level || 'verbal'} onChange={e => setForm(f => ({ ...f, warning_level: e.target.value as HRWarning['warning_level'] }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                {Object.entries(LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">เรื่อง *</label>
            <input type="text" value={form.subject || ''} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="ระบุเรื่องที่เตือน" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">รายละเอียดเหตุการณ์</label>
            <textarea value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="อธิบายรายละเอียดของเหตุการณ์ที่เกิดขึ้น..." />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันที่เกิดเหตุ *</label>
              <input type="date" value={form.incident_date || ''} onChange={e => setForm(f => ({ ...f, incident_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">วันที่ออกใบเตือน</label>
              <input type="date" value={form.issued_date || ''} onChange={e => setForm(f => ({ ...f, issued_date: e.target.value }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ผู้ออกใบเตือน</label>
              <select value={form.issued_by || ''} onChange={e => setForm(f => ({ ...f, issued_by: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.filter(e => e.employment_status === 'active').map(e => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">พยาน</label>
              <select value={form.witness_id || ''} onChange={e => setForm(f => ({ ...f, witness_id: e.target.value || undefined }))} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm">
                <option value="">-- เลือก --</option>
                {employees.filter(e => e.employment_status === 'active').map(e => (
                  <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">คำชี้แจงของพนักงาน</label>
            <textarea value={form.employee_response || ''} onChange={e => setForm(f => ({ ...f, employee_response: e.target.value }))} rows={2} className="w-full rounded-xl border border-surface-200 px-3 py-2 text-sm" placeholder="คำชี้แจงหรือข้อเท็จจริงจากพนักงาน (ถ้ามี)" />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => setFormOpen(false)} className="px-4 py-2 rounded-xl border border-surface-200 text-sm hover:bg-surface-50">ยกเลิก</button>
            <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50 transition-colors">
              {saving ? 'กำลังบันทึก...' : form.id ? 'บันทึก' : 'สร้างใบเตือน'}
            </button>
          </div>
        </div>
      </Modal>

      {/* View Detail Modal */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} contentClassName="max-w-2xl" closeOnBackdropClick>
        {viewItem && (() => {
          const lvl = LEVEL_LABELS[viewItem.warning_level] || LEVEL_LABELS.verbal
          const st = STATUS_LABELS[viewItem.status] || STATUS_LABELS.draft
          return (
            <div className="p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-gray-800">ใบเตือน {viewItem.warning_number}</h2>
                  <span className={`mt-1 inline-block px-2 py-1 rounded-full text-xs font-medium ${st.color}`}>{st.label}</span>
                </div>
                <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-sm font-medium ${lvl.bg} ${lvl.color}`}>
                  <FiAlertTriangle className="w-4 h-4" />{lvl.label}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-500 text-xs">พนักงาน</div>
                  <div className="font-medium">{empName(viewItem.employee)}</div>
                  <div className="text-xs text-gray-400">{viewItem.employee?.employee_code}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">วันที่เกิดเหตุ</div>
                  <div className="font-medium">{viewItem.incident_date}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">วันที่ออกใบเตือน</div>
                  <div className="font-medium">{viewItem.issued_date}</div>
                </div>
                <div>
                  <div className="text-gray-500 text-xs">ผู้ออกใบเตือน</div>
                  <div className="font-medium">{empName(viewItem.issuer)}</div>
                </div>
                {viewItem.witness && (
                  <div>
                    <div className="text-gray-500 text-xs">พยาน</div>
                    <div className="font-medium">{empName(viewItem.witness)}</div>
                  </div>
                )}
              </div>

              <div>
                <div className="text-gray-500 text-xs mb-1">เรื่อง</div>
                <div className="font-medium text-gray-800">{viewItem.subject}</div>
              </div>

              {viewItem.description && (
                <div>
                  <div className="text-gray-500 text-xs mb-1">รายละเอียดเหตุการณ์</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap bg-surface-50 border border-surface-200 rounded-xl p-3">{viewItem.description}</div>
                </div>
              )}

              {viewItem.employee_response && (
                <div>
                  <div className="text-gray-500 text-xs mb-1">คำชี้แจงของพนักงาน</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap bg-blue-50 border border-blue-200 rounded-xl p-3">{viewItem.employee_response}</div>
                </div>
              )}

              {viewItem.resolution_note && (
                <div>
                  <div className="text-gray-500 text-xs mb-1">หมายเหตุการยุติ</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap bg-green-50 border border-green-200 rounded-xl p-3">{viewItem.resolution_note}</div>
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
