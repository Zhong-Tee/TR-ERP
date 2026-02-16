import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { createAudit, fetchAuditors } from '../../lib/auditApi'
import type { AuditType } from '../../types'
import Modal from '../ui/Modal'
import ScopeSelector from './ScopeSelector'

export default function CreateAuditForm() {
  const navigate = useNavigate()
  const { user } = useAuthContext()
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  // Scope
  const [auditType, setAuditType] = useState<AuditType>('full')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedLocations, setSelectedLocations] = useState<string[]>([])
  const [locationSearch, setLocationSearch] = useState('')
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])

  // Auditor assignment
  const [auditors, setAuditors] = useState<{ id: string; username: string }[]>([])
  const [selectedAuditors, setSelectedAuditors] = useState<string[]>([])

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'success' | 'error'>('success')
  const [modalTitle, setModalTitle] = useState('')
  const [modalMessage, setModalMessage] = useState('')

  useEffect(() => {
    fetchAuditors()
      .then(setAuditors)
      .catch(console.error)
  }, [])

  function toggleAuditor(id: string) {
    setSelectedAuditors((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    )
  }

  function getScopeFilter(): Record<string, string[]> | undefined {
    if (auditType === 'category' && selectedCategories.length) {
      return { categories: selectedCategories }
    }
    if (auditType === 'location' && selectedLocations.length) {
      return { locations: selectedLocations }
    }
    if (auditType === 'custom' && selectedProductIds.length) {
      return { product_ids: selectedProductIds }
    }
    return undefined
  }

  function canSave() {
    if (selectedAuditors.length === 0) return false
    if (auditType === 'category' && selectedCategories.length === 0) return false
    if (auditType === 'location' && selectedLocations.length === 0) return false
    if (auditType === 'custom' && selectedProductIds.length === 0) return false
    return true
  }

  function showModal(type: 'success' | 'error', title: string, message: string) {
    setModalType(type)
    setModalTitle(title)
    setModalMessage(message)
    setModalOpen(true)
  }

  function handleModalClose() {
    setModalOpen(false)
    if (modalType === 'success') {
      navigate('/warehouse/audit')
    }
  }

  async function handleSave() {
    if (!canSave() || !user?.id) return
    setSaving(true)
    try {
      const audit = await createAudit({
        auditType,
        scopeFilter: getScopeFilter(),
        assignedTo: selectedAuditors,
        note,
        userId: user.id,
      })
      showModal(
        'success',
        'สร้างใบ Audit สำเร็จ',
        `เลขที่ ${audit.audit_no}\nจำนวนรายการที่ต้องตรวจนับ: ${audit.total_items || 0} รายการ`
      )
    } catch (e: any) {
      console.error('Create audit failed:', e)
      showModal('error', 'สร้างใบ Audit ไม่สำเร็จ', e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6 mt-12 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">สร้างใบ Audit ใหม่</h1>
        <button
          type="button"
          onClick={() => navigate('/warehouse/audit')}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm"
        >
          กลับ
        </button>
      </div>

      {/* Freeze Warning */}
      <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <span className="text-orange-500 text-xl mt-0.5">&#9888;</span>
          <div>
            <div className="font-semibold text-orange-800">คำเตือน: การเคลื่อนไหวสต๊อคระหว่าง Audit</div>
            <div className="text-sm text-orange-700 mt-1">
              ระบบจะ Snapshot จำนวนสต๊อค ณ ตอนสร้างใบ Audit
              หากมีการขาย/เบิกจ่าย/รับสินค้าระหว่างนับ อาจทำให้ตัวเลขคลาดเคลื่อนได้
              แนะนำให้หยุดการเคลื่อนไหวสต๊อคก่อนเริ่ม Audit
            </div>
          </div>
        </div>
      </div>

      {/* Scope */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <ScopeSelector
          auditType={auditType}
          onTypeChange={setAuditType}
          selectedCategories={selectedCategories}
          onCategoriesChange={setSelectedCategories}
          selectedLocations={selectedLocations}
          onLocationsChange={setSelectedLocations}
          locationSearch={locationSearch}
          onLocationSearchChange={setLocationSearch}
          selectedProductIds={selectedProductIds}
          onProductIdsChange={setSelectedProductIds}
        />
      </div>

      {/* Assign Auditor */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-3">
        <label className="block text-sm font-semibold text-gray-700">
          มอบหมายผู้ตรวจนับ (role: auditor) <span className="text-red-500">*</span>
        </label>
        {auditors.length === 0 ? (
          <div className="text-sm text-gray-400 py-4 text-center border rounded-lg">
            ยังไม่มี user ที่มี role "auditor" ในระบบ กรุณาเพิ่มก่อน
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {auditors.map((a) => (
              <label
                key={a.id}
                className={`flex items-center gap-2 p-3 rounded-lg cursor-pointer border transition-colors ${
                  selectedAuditors.includes(a.id)
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedAuditors.includes(a.id)}
                  onChange={() => toggleAuditor(a.id)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="font-medium text-sm">{a.username}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Note */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-2">
        <label className="block text-sm font-semibold text-gray-700">หมายเหตุ</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="คำอธิบายเพิ่มเติม (ไม่บังคับ)"
          className="w-full px-3 py-2 border rounded-lg text-sm"
          rows={3}
        />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 pb-8">
        <button
          type="button"
          onClick={() => navigate('/warehouse/audit')}
          className="px-6 py-2.5 border rounded-xl hover:bg-gray-50 font-medium"
        >
          ยกเลิก
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !canSave()}
          className="px-6 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-semibold"
        >
          {saving ? 'กำลังสร้าง...' : 'สร้างใบ Audit'}
        </button>
      </div>

      {/* Result Modal */}
      <Modal open={modalOpen} onClose={handleModalClose} contentClassName="max-w-md">
        <div className="p-6 text-center">
          {/* Icon */}
          <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
            modalType === 'success' ? 'bg-green-100' : 'bg-red-100'
          }`}>
            {modalType === 'success' ? (
              <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>

          {/* Title */}
          <h3 className={`text-lg font-bold ${
            modalType === 'success' ? 'text-green-800' : 'text-red-800'
          }`}>
            {modalTitle}
          </h3>

          {/* Message */}
          <div className="mt-3 text-sm text-gray-600 whitespace-pre-line">
            {modalMessage}
          </div>

          {/* Button */}
          <button
            type="button"
            onClick={handleModalClose}
            className={`mt-6 px-8 py-2.5 rounded-xl font-semibold text-white transition-colors ${
              modalType === 'success'
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            {modalType === 'success' ? 'ไปหน้า Audit' : 'ปิด'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
