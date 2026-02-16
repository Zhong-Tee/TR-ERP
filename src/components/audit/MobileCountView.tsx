import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchAuditById, fetchAuditItems, saveCount, submitAuditForReview } from '../../lib/auditApi'
import { getPublicUrl } from '../../lib/qcApi'
import type { InventoryAudit, InventoryAuditItem } from '../../types'
import BarcodeScanner from './BarcodeScanner'
import CountProgress from './CountProgress'
import ProductCountCard from './ProductCountCard'

type Mode = 'list' | 'scan'
type ToastType = 'success' | 'error' | 'warning'

interface Toast {
  type: ToastType
  message: string
}

export default function MobileCountView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuthContext()

  const [audit, setAudit] = useState<InventoryAudit | null>(null)
  const [items, setItems] = useState<InventoryAuditItem[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('list')
  const [selectedItem, setSelectedItem] = useState<InventoryAuditItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null)

  function showToast(type: ToastType, message: string) {
    setToast({ type, message })
    setTimeout(() => setToast(null), 3000)
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
      console.error('Load audit data failed:', e)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { loadData() }, [loadData])

  const countedCount = useMemo(() => items.filter((i) => i.is_counted).length, [items])
  const totalCount = items.length

  const productCodeMap = useMemo(() => {
    const map: Record<string, InventoryAuditItem> = {}
    items.forEach((item) => {
      if (item.pr_products?.product_code) {
        map[item.pr_products.product_code] = item
      }
    })
    return map
  }, [items])

  function handleScanResult(code: string) {
    setScannerOpen(false)
    const item = productCodeMap[code]
    if (item) {
      setSelectedItem(item)
    } else {
      showToast('warning', `ไม่พบสินค้ารหัส "${code}" ในรายการ Audit นี้`)
    }
  }

  async function handleSaveCount(data: {
    countedQty: number
    locationMatch: boolean
    actualLocation?: string
    countedSafetyStock?: number
  }) {
    if (!selectedItem || !user?.id) return
    setSaving(true)
    try {
      await saveCount({
        auditItemId: selectedItem.id,
        countedQty: data.countedQty,
        locationMatch: data.locationMatch,
        actualLocation: data.actualLocation || null,
        countedSafetyStock: data.countedSafetyStock ?? null,
        countedBy: user.id,
      })
      setSelectedItem(null)
      await loadData()
    } catch (e: any) {
      console.error('Save count failed:', e)
      showToast('error', 'บันทึกไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  function requestSubmitForReview() {
    setConfirmModal({
      message: 'ยืนยันส่งผลตรวจนับเพื่อรีวิว?',
      onConfirm: doSubmitForReview,
    })
  }

  async function doSubmitForReview() {
    if (!id) return
    setConfirmModal(null)
    setSubmitting(true)
    try {
      await submitAuditForReview(id)
      showToast('success', 'ส่งผลตรวจนับเรียบร้อย')
      setTimeout(() => navigate('/warehouse/audit'), 1500)
    } catch (e: any) {
      console.error('Submit failed:', e)
      showToast('error', 'ส่งไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    )
  }

  if (!audit) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <div className="text-gray-500 text-lg">ไม่พบข้อมูล Audit</div>
        <button
          onClick={() => navigate('/warehouse/audit')}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg"
        >
          กลับ
        </button>
      </div>
    )
  }

  // If an item is selected, show the count card
  if (selectedItem) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 max-w-lg mx-auto">
        <ProductCountCard
          item={selectedItem}
          onSave={handleSaveCount}
          onCancel={() => setSelectedItem(null)}
          saving={saving}
        />
        {/* Toast on count card view */}
        {toast && <MobileToast toast={toast} />}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <div className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-500">Audit</div>
              <div className="font-bold text-gray-900">{audit.audit_no}</div>
            </div>
            <button
              onClick={() => navigate('/warehouse/audit')}
              className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50"
            >
              กลับ
            </button>
          </div>
          <div className="mt-3">
            <CountProgress counted={countedCount} total={totalCount} />
          </div>
        </div>
      </div>

      {/* Mode Tabs */}
      <div className="max-w-lg mx-auto w-full px-4 pt-3">
        <div className="flex bg-gray-200 rounded-xl p-1">
          <button
            onClick={() => setMode('list')}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
              mode === 'list'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            รายการ
          </button>
          <button
            onClick={() => { setMode('scan'); setScannerOpen(true) }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
              mode === 'scan'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            สแกน
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 max-w-lg mx-auto w-full px-4 py-3 pb-24">
        {mode === 'list' && (
          <div className="space-y-2">
            {items.map((item) => {
              const productCode = item.pr_products?.product_code || ''
              const productName = item.pr_products?.product_name || ''
              const imageUrl = getPublicUrl('product-images', productCode, '.jpg')
              const isCounted = item.is_counted

              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                    isCounted
                      ? 'border-green-200 bg-green-50'
                      : 'border-gray-200 bg-white hover:border-blue-300'
                  }`}
                >
                  <div className="w-14 h-14 rounded-lg bg-gray-100 flex-shrink-0 overflow-hidden flex items-center justify-center">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={productCode}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    ) : (
                      <span className="text-gray-300 text-2xl">&#128247;</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-gray-900 truncate">{productCode}</div>
                    <div className="text-xs text-gray-500 truncate">{productName}</div>
                    <div className="text-xs text-red-600 font-medium mt-0.5">
                      {item.system_location || item.storage_location || '-'}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    {isCounted ? (
                      <div className="flex flex-col items-end">
                        <span className="text-xs font-bold text-green-600 bg-green-100 px-2 py-0.5 rounded-full">
                          นับแล้ว
                        </span>
                        <span className="text-lg font-bold text-green-700 mt-0.5">
                          {item.counted_qty}
                        </span>
                        {item.counted_safety_stock != null && (
                          <span className="text-xs text-blue-600 font-medium mt-0.5">
                            SS: {item.counted_safety_stock}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                        ยังไม่นับ
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {mode === 'scan' && !scannerOpen && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <div className="text-gray-400 text-6xl">&#128247;</div>
            <div className="text-gray-500 text-center">
              กดปุ่มด้านล่างเพื่อเปิดกล้องสแกน
            </div>
            <button
              onClick={() => setScannerOpen(true)}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold text-lg active:scale-95 transition-all"
            >
              เปิดกล้องสแกน
            </button>
          </div>
        )}
      </div>

      {/* Bottom Actions */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg">
        <div className="max-w-lg mx-auto px-4 py-3 flex gap-3">
          {mode === 'scan' && (
            <button
              onClick={() => setScannerOpen(true)}
              className="flex-1 py-3.5 bg-green-600 text-white rounded-xl font-bold active:scale-95 transition-all"
            >
              สแกนบาร์โค้ด
            </button>
          )}
          {countedCount > 0 && audit.status === 'in_progress' && (
            <button
              onClick={requestSubmitForReview}
              disabled={submitting}
              className={`${mode === 'scan' ? '' : 'flex-1'} py-3.5 px-6 bg-orange-500 text-white rounded-xl font-bold disabled:opacity-50 active:scale-95 transition-all`}
            >
              {submitting ? 'กำลังส่ง...' : `ส่งรีวิว (${countedCount}/${totalCount})`}
            </button>
          )}
        </div>
      </div>

      {/* Barcode Scanner Modal */}
      {scannerOpen && (
        <BarcodeScanner
          onScan={handleScanResult}
          onClose={() => setScannerOpen(false)}
        />
      )}

      {/* Toast */}
      {toast && <MobileToast toast={toast} />}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmModal(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-orange-100 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-gray-800 font-semibold">{confirmModal.message}</p>
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
        </div>
      )}
    </div>
  )
}

function MobileToast({ toast }: { toast: Toast }) {
  const bgMap: Record<ToastType, string> = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    warning: 'bg-amber-500',
  }
  const iconMap: Record<ToastType, string> = {
    success: '\u2713',
    error: '\u2717',
    warning: '!',
  }

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-[fadeInDown_0.3s_ease-out]">
      <div className={`${bgMap[toast.type]} text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-semibold`}>
        <span className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">
          {iconMap[toast.type]}
        </span>
        {toast.message}
      </div>
    </div>
  )
}
