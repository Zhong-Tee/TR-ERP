import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import RequisitionDetailModal from './RequisitionDetailModal'
import { useWmsModal } from '../useWmsModal'

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all'

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'pending', label: 'รออนุมัติ' },
  { key: 'approved', label: 'อนุมัติแล้ว' },
  { key: 'rejected', label: 'ปฏิเสธ' },
  { key: 'all', label: 'ทั้งหมด' },
]

export default function ApprovalList() {
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [selectedRequisition, setSelectedRequisition] = useState<any | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')
  const [topicFilter, setTopicFilter] = useState('all')
  const { showMessage, MessageModal } = useWmsModal({ showCancelButton: false })

  const loadRequisitions = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true)

      // โหลด items และ Picker ล่วงหน้า เพื่อให้การเปิดรายละเอียดครั้งแรกไม่ต้องรอ query ใหม่
      const [requisitionResult, pickerResult] = await Promise.all([
        supabase
          .from('wms_requisitions')
          .select('*, wms_requisition_items(*)')
          .order('created_at', { ascending: false }),
        supabase.from('us_users').select('id, username').eq('role', 'picker').order('username'),
      ])

      if (requisitionResult.error) throw requisitionResult.error
      if (pickerResult.error) throw pickerResult.error

      const rows = requisitionResult.data || []
      const userIds = [...new Set(rows.flatMap((row: any) => [row.created_by, row.approved_by].filter(Boolean)))]
      const requisitionNumbers = rows.map((row: any) => row.requisition_id).filter(Boolean)
      const userMap = new Map<string, string>()
      const [usersResult, ordersResult] = await Promise.all([
        userIds.length > 0
          ? supabase.from('us_users').select('id, username').in('id', userIds)
          : Promise.resolve({ data: [] as Array<{ id: string; username: string }>, error: null }),
        requisitionNumbers.length > 0
          ? supabase.from('wms_orders').select('order_id, status').in('order_id', requisitionNumbers)
          : Promise.resolve({ data: [] as Array<{ order_id: string; status: string }>, error: null }),
      ])
      if (usersResult.error) throw usersResult.error
      if (ordersResult.error) throw ordersResult.error
      for (const user of usersResult.data ?? []) userMap.set(user.id, user.username)

      const orderStatuses = new Map<string, string[]>()
      for (const order of ordersResult.data ?? []) {
        const statuses = orderStatuses.get(order.order_id) || []
        statuses.push(order.status)
        orderStatuses.set(order.order_id, statuses)
      }

      setRequisitions(rows.map((requisition: any) => ({
        ...requisition,
        items: requisition.wms_requisition_items || [],
        fulfillmentStatuses: orderStatuses.get(requisition.requisition_id) || [],
        preloadedPickers: pickerResult.data || [],
        created_by_user: requisition.created_by
          ? { username: userMap.get(requisition.created_by) || '-' }
          : null,
        approved_by_user: requisition.approved_by
          ? { username: userMap.get(requisition.approved_by) || '-' }
          : null,
      })))
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [showMessage])

  useEffect(() => {
    loadRequisitions()

    const channel = supabase
      .channel('wms-manager-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => {
        loadRequisitions(false)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisition_items' }, () => {
        loadRequisitions(false)
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadRequisitions])

  const statusCounts = useMemo(() => ({
    pending: requisitions.filter((row) => row.status === 'pending').length,
    approved: requisitions.filter((row) => row.status === 'approved').length,
    rejected: requisitions.filter((row) => row.status === 'rejected').length,
    all: requisitions.length,
  }), [requisitions])

  const topics = useMemo(() => {
    const values = requisitions.flatMap((row) =>
      (row.items || []).map((item: any) => String(item.requisition_topic || '').trim()).filter(Boolean)
    )
    return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'th'))
  }, [requisitions])

  const filteredRequisitions = useMemo(() => requisitions.filter((row) => {
    if (statusFilter !== 'all' && row.status !== statusFilter) return false
    if (topicFilter === 'all') return true
    return (row.items || []).some((item: any) => String(item.requisition_topic || '').trim() === topicFilter)
  }), [requisitions, statusFilter, topicFilter])

  const openDetail = (requisition: any) => {
    setSelectedRequisition(requisition)
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setSelectedRequisition(null)
    loadRequisitions(false)
  }

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      pending: 'bg-amber-100 text-amber-800 border-amber-200',
      approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
      rejected: 'bg-red-100 text-red-700 border-red-200',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return (
      <span className={`rounded-lg border px-3 py-1 text-xs font-bold ${badges[status] || 'border-gray-200 bg-gray-100 text-gray-700'}`}>
        {labels[status] || status}
      </span>
    )
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    return new Date(dateString).toLocaleString('th-TH', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  }

  const getStockProgress = (requisition: any) => {
    if (requisition.status !== 'approved') return null
    const statuses: string[] = requisition.fulfillmentStatuses || []
    if (statuses.length === 0) {
      return <span className="text-red-600"><i className="fas fa-triangle-exclamation mr-1" />ไม่พบงาน Picker — กรุณาตรวจสอบ</span>
    }
    const correctCount = statuses.filter((status) => status === 'correct').length
    if (correctCount === statuses.length) {
      return <span className="text-emerald-700"><i className="fas fa-boxes-stacked mr-1" />ตัดสต๊อกครบแล้ว</span>
    }
    if (correctCount > 0) {
      return <span className="text-blue-700"><i className="fas fa-boxes-stacked mr-1" />ตัดสต๊อกแล้ว {correctCount}/{statuses.length} รายการ</span>
    }
    if (statuses.some((status) => status === 'picked')) {
      return <span className="text-amber-700"><i className="fas fa-clock mr-1" />หยิบแล้ว รอตรวจยืนยันก่อนตัดสต๊อก</span>
    }
    return <span className="text-gray-500"><i className="fas fa-clock mr-1" />รอ Picker หยิบ — ยังไม่ตัดสต๊อก</span>
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">
        <i className="fas fa-spinner fa-spin mb-2 text-2xl" />
        <div>กำลังโหลดรายการใบเบิก...</div>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black text-gray-900">รายการอนุมัติใบเบิก</h2>
            <p className="mt-1 text-xs text-gray-500">เลือกสถานะหรือหัวข้อการเบิกเพื่อดูรายการได้ง่ายขึ้น</p>
          </div>
          {statusCounts.pending > 0 && (
            <span className="rounded-lg bg-red-600 px-3 py-1 text-sm font-bold text-white">
              รอดำเนินการ {statusCounts.pending} รายการ
            </span>
          )}
        </div>

        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="กรองสถานะใบเบิก">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === filter.key}
                onClick={() => setStatusFilter(filter.key)}
                className={`rounded-xl px-4 py-2 text-sm font-bold transition-all ${
                  statusFilter === filter.key
                    ? 'bg-blue-600 text-white shadow-md'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {filter.label} ({statusCounts[filter.key]})
              </button>
            ))}
          </div>

          <label className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-600">
            <span className="shrink-0">หัวข้อการเบิก</span>
            <select
              value={topicFilter}
              onChange={(event) => setTopicFilter(event.target.value)}
              className="min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            >
              <option value="all">ทุกหัวข้อ</option>
              {topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
            </select>
          </label>
        </div>

        {filteredRequisitions.length === 0 ? (
          <div className="py-10 text-center text-gray-500">
            <i className="fas fa-inbox mb-2 text-4xl" />
            <div>ไม่พบรายการตามตัวกรองที่เลือก</div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRequisitions.map((requisition) => {
              const requisitionTopics: string[] = [...new Set<string>((requisition.items || [])
                .map((item: any) => String(item.requisition_topic || '').trim())
                .filter(Boolean))]
              return (
                <button
                  type="button"
                  key={requisition.id}
                  className="w-full rounded-xl bg-gray-50 p-4 text-left transition hover:bg-blue-50 hover:ring-1 hover:ring-blue-200"
                  onClick={() => openDetail(requisition)}
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <span className="break-words text-base font-black text-blue-600">{requisition.requisition_id}</span>
                    <span className="shrink-0 text-right text-xs text-gray-500">{formatDate(requisition.created_at)}</span>
                  </div>
                  <div className="mb-2 text-sm text-gray-600">สร้างโดย: {requisition.created_by_user?.username || '---'}</div>
                  {requisitionTopics.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {requisitionTopics.map((topic) => (
                        <span key={topic} className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">{topic}</span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {requisition.status === 'approved' && requisition.approved_by_user && (
                        <div className="mb-1 text-xs text-green-600">
                          <i className="fas fa-check-circle mr-1" />
                          อนุมัติโดย: {requisition.approved_by_user.username} ({formatDate(requisition.approved_at)})
                        </div>
                      )}
                      {requisition.status === 'rejected' && requisition.approved_by_user && (
                        <div className="mb-1 text-xs text-red-500">
                          <i className="fas fa-times-circle mr-1" />
                          ปฏิเสธโดย: {requisition.approved_by_user.username} ({formatDate(requisition.approved_at)})
                        </div>
                      )}
                      {getStockProgress(requisition) && (
                        <div className="mb-1 text-xs font-semibold">{getStockProgress(requisition)}</div>
                      )}
                      {requisition.notes && <div className="break-words text-sm text-gray-600">หมายเหตุ: {requisition.notes}</div>}
                      <div className="mt-2 text-xs text-gray-500">
                        <i className="fas fa-hand-pointer mr-1" />ดูรายละเอียด {requisition.items?.length || 0} รายการ
                      </div>
                    </div>
                    <div className="shrink-0">{getStatusBadge(requisition.status)}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {isModalOpen && selectedRequisition && (
        <RequisitionDetailModal requisition={selectedRequisition} onClose={closeModal} />
      )}
      {MessageModal}
    </div>
  )
}
