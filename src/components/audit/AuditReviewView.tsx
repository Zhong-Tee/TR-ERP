import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  fetchAuditById,
  fetchAuditItems,
  completeAudit,
  closeAudit,
  createAdjustmentFromAudit,
} from '../../lib/auditApi'
import type { InventoryAudit, InventoryAuditItem } from '../../types'
import Modal from '../ui/Modal'
import AuditSummaryStats from './AuditSummaryStats'
import VarianceTable from './VarianceTable'
import LocationMismatchTable from './LocationMismatchTable'
import SafetyStockTable from './SafetyStockTable'

type Tab = 'qty' | 'location' | 'safety'

export default function AuditReviewView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuthContext()

  const [audit, setAudit] = useState<InventoryAudit | null>(null)
  const [items, setItems] = useState<InventoryAuditItem[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('qty')
  const [showOnlyMismatch, setShowOnlyMismatch] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [creatingAdj, setCreatingAdj] = useState(false)

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [modalType, setModalType] = useState<'success' | 'error'>('success')
  const [modalTitle, setModalTitle] = useState('')
  const [modalMessage, setModalMessage] = useState('')
  // Confirm modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string
    message: string
    onConfirm: () => void
  } | null>(null)

  function showModal(type: 'success' | 'error', title: string, message: string) {
    setModalType(type)
    setModalTitle(title)
    setModalMessage(message)
    setModalOpen(true)
  }

  const loadData = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const [auditData, itemsData] = await Promise.all([
        fetchAuditById(id),
        fetchAuditItems(id),
      ])
      setAudit(auditData)
      setItems(itemsData)
    } catch (e) {
      console.error('Load review data failed:', e)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { loadData() }, [loadData])

  const stats = useMemo(() => {
    const counted = items.filter((i) => i.is_counted)
    const totalItems = counted.length
    const qtyMatched = counted.filter((i) => Number(i.variance) === 0).length
    const qtyMismatch = totalItems - qtyMatched
    const accuracyPercent = totalItems > 0 ? (qtyMatched / totalItems) * 100 : null

    const locationChecked = counted.filter((i) => i.location_match !== null)
    const locationMatched = locationChecked.filter((i) => i.location_match === true).length
    const locationMismatch = locationChecked.length - locationMatched
    const locationAccuracy = locationChecked.length > 0
      ? (locationMatched / locationChecked.length) * 100
      : null

    const safetyChecked = counted.filter((i) => i.safety_stock_match !== null)
    const safetyMatched = safetyChecked.filter((i) => i.safety_stock_match === true).length
    const safetyMismatch = safetyChecked.length - safetyMatched
    const safetyAccuracy = safetyChecked.length > 0
      ? (safetyMatched / safetyChecked.length) * 100
      : null

    return {
      totalItems,
      qtyMatched,
      qtyMismatch,
      accuracyPercent,
      locationChecked: locationChecked.length,
      locationMatched,
      locationMismatch,
      locationAccuracy,
      safetyChecked: safetyChecked.length,
      safetyMatched,
      safetyMismatch,
      safetyAccuracy,
    }
  }, [items])

  function requestComplete() {
    setConfirmModal({
      title: 'ยืนยันปิดการตรวจนับ',
      message: 'ปิดการตรวจนับโดยไม่สร้างใบปรับสต๊อค ต้องการดำเนินการใช่หรือไม่?',
      onConfirm: doComplete,
    })
  }

  async function doComplete() {
    if (!id || !user?.id) return
    setConfirmModal(null)
    setCompleting(true)
    try {
      await closeAudit(id)
      showModal('success', 'ปิดการตรวจนับสำเร็จ', 'สถานะ Audit เปลี่ยนเป็น "ปิดแล้ว"')
      await loadData()
    } catch (e: any) {
      showModal('error', 'ไม่สำเร็จ', e?.message || String(e))
    } finally {
      setCompleting(false)
    }
  }

  function requestCreateAdjustment() {
    setConfirmModal({
      title: 'ยืนยันสร้างใบปรับสต๊อค',
      message: 'ต้องการสร้างใบปรับสต๊อคจากผลต่าง Audit นี้ใช่หรือไม่?',
      onConfirm: doCreateAdjustment,
    })
  }

  async function doCreateAdjustment() {
    if (!id || !user?.id) return
    setConfirmModal(null)
    setCreatingAdj(true)
    try {
      const adj = await createAdjustmentFromAudit(id, user.id)
      await completeAudit(id, user.id)
      showModal('success', 'สร้างใบปรับสต๊อคสำเร็จ', `เลขที่ ${adj.adjust_no}\nรอการอนุมัติจากผู้จัดการ`)
      await loadData()
    } catch (e: any) {
      showModal('error', 'ไม่สำเร็จ', e?.message || String(e))
    } finally {
      setCreatingAdj(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    )
  }

  if (!audit) {
    return (
      <div className="text-center py-12 text-gray-500">
        ไม่พบข้อมูล Audit
        <br />
        <button onClick={() => navigate('/warehouse/audit')} className="mt-4 text-blue-600 underline">
          กลับ
        </button>
      </div>
    )
  }

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'qty', label: 'ผลต่างจำนวน', badge: stats.qtyMismatch },
    { key: 'location', label: 'จุดเก็บไม่ตรง', badge: stats.locationMismatch },
    { key: 'safety', label: 'Safety Stock', badge: stats.safetyMismatch },
  ]

  return (
    <div className="space-y-6 mt-12">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            รีวิวผล Audit: {audit.audit_no}
          </h1>
          <div className="text-sm text-gray-500 mt-1">
            สถานะ:{' '}
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-bold ${
              audit.status === 'review' ? 'bg-amber-500 text-white'
                : audit.status === 'completed' ? 'bg-green-500 text-white'
                  : 'bg-gray-400 text-white'
            }`}>
              {audit.status}
            </span>
            {audit.note && <span className="ml-3 text-gray-400">| {audit.note}</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {audit.status === 'review' && !audit.adjustment_id && (
            <button
              onClick={requestCreateAdjustment}
              disabled={creatingAdj}
              className="px-4 py-2 bg-orange-500 text-white rounded-xl hover:bg-orange-600 font-semibold text-sm disabled:opacity-50"
            >
              {creatingAdj ? 'กำลังสร้าง...' : 'สร้างใบปรับสต๊อค'}
            </button>
          )}
          {audit.status === 'review' && (
            <button
              onClick={requestComplete}
              disabled={completing}
              className="px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 font-semibold text-sm disabled:opacity-50"
            >
              {completing ? 'กำลังปิด...' : 'ปิดการตรวจนับ'}
            </button>
          )}
          {audit.adjustment_id && (
            <span className="px-4 py-2 bg-blue-100 text-blue-700 rounded-xl text-sm font-medium">
              มีใบปรับสต๊อคแล้ว
            </span>
          )}
          <button
            onClick={() => navigate('/warehouse/audit')}
            className="px-4 py-2 border rounded-xl hover:bg-gray-50 text-sm"
          >
            กลับ
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <AuditSummaryStats {...stats} />

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="flex border-b">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 py-3 text-sm font-semibold transition-colors relative ${
                tab === t.key
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold bg-red-500 text-white">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === 'qty' && (
          <div className="p-4">
            <label className="flex items-center gap-2 mb-3 text-sm">
              <input
                type="checkbox"
                checked={showOnlyMismatch}
                onChange={(e) => setShowOnlyMismatch(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              แสดงเฉพาะรายการที่มีผลต่าง
            </label>
            <VarianceTable items={items} showOnlyMismatch={showOnlyMismatch} />
          </div>
        )}

        {tab === 'location' && (
          <div className="p-4">
            <LocationMismatchTable items={items} />
          </div>
        )}

        {tab === 'safety' && (
          <div className="p-4">
            <SafetyStockTable items={items} />
          </div>
        )}
      </div>

      {/* Result Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} contentClassName="max-w-md">
        <div className="p-6 text-center">
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
          <h3 className={`text-lg font-bold ${modalType === 'success' ? 'text-green-800' : 'text-red-800'}`}>
            {modalTitle}
          </h3>
          <div className="mt-3 text-sm text-gray-600 whitespace-pre-line">{modalMessage}</div>
          <button
            type="button"
            onClick={() => setModalOpen(false)}
            className={`mt-6 px-8 py-2.5 rounded-xl font-semibold text-white transition-colors ${
              modalType === 'success' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
            }`}
          >
            ปิด
          </button>
        </div>
      </Modal>

      {/* Confirm Modal */}
      {confirmModal && (
        <Modal open={true} onClose={() => setConfirmModal(null)} contentClassName="max-w-sm">
          <div className="p-6 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">{confirmModal.title}</h3>
            <p className="mt-2 text-sm text-gray-600">{confirmModal.message}</p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 py-2.5 border-2 rounded-xl font-semibold text-gray-600 hover:bg-gray-50"
              >
                ยกเลิก
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="flex-1 py-2.5 bg-orange-500 text-white rounded-xl font-semibold hover:bg-orange-600"
              >
                ยืนยัน
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
