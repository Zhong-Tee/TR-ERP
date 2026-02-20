import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import RequisitionDetailModal from './RequisitionDetailModal'
import { useWmsModal } from '../useWmsModal'

export default function ApprovalList() {
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [selectedRequisition, setSelectedRequisition] = useState<any | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const { showMessage, MessageModal } = useWmsModal()

  useEffect(() => {
    loadRequisitions()

    const channel = supabase
      .channel('wms-manager-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => {
        loadRequisitions()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [filter])

  const loadRequisitions = async () => {
    try {
      setLoading(true)
      let query = supabase.from('wms_requisitions').select('*').order('created_at', { ascending: false })

      if (filter === 'pending') {
        query = query.eq('status', 'pending')
      }

      const { data, error } = await query
      if (error) throw error

      const rows = data || []
      const userIds = [...new Set(rows.flatMap((r: any) => [r.created_by, r.approved_by].filter(Boolean)))]
      const userMap = new Map<string, string>()
      if (userIds.length > 0) {
        const { data: users } = await supabase.from('us_users').select('id, username').in('id', userIds)
        for (const u of (users ?? []) as { id: string; username: string }[]) userMap.set(u.id, u.username)
      }
      const requisitionsWithUsers = rows.map((req: any) => ({
        ...req,
        created_by_user: req.created_by ? { username: userMap.get(req.created_by) || '-' } : null,
        approved_by_user: req.approved_by ? { username: userMap.get(req.approved_by) || '-' } : null,
      }))

      setRequisitions(requisitionsWithUsers)
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const openDetail = (requisition: any) => {
    setSelectedRequisition(requisition)
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setSelectedRequisition(null)
    loadRequisitions()
  }

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      pending: 'bg-yellow-500 text-yellow-900',
      approved: 'bg-green-500 text-green-900',
      rejected: 'bg-red-500 text-red-900',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return <span className={`px-3 py-1 rounded-lg text-xs font-bold ${badges[status] || 'bg-gray-500'}`}>{labels[status] || status}</span>
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const pendingCount = requisitions.filter((r) => r.status === 'pending').length

  if (loading) {
    return (
      <div className="p-4 text-center text-gray-400">
        <i className="fas fa-spinner fa-spin text-2xl mb-2"></i>
        <div>กำลังโหลด...</div>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="bg-slate-800 p-4 rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-black text-white">รายการรออนุมัติ</h2>
          {pendingCount > 0 && <span className="bg-red-600 text-white px-3 py-1 rounded-lg text-sm font-bold">{pendingCount} รายการ</span>}
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setFilter('pending')}
            className={`px-4 py-2 rounded-xl font-bold text-sm transition-all ${
              filter === 'pending' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
            }`}
          >
            รออนุมัติ ({pendingCount})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-4 py-2 rounded-xl font-bold text-sm transition-all ${
              filter === 'all' ? 'bg-blue-600 text-white shadow-lg' : 'bg-slate-700 text-gray-300'
            }`}
          >
            ทั้งหมด
          </button>
        </div>

        {requisitions.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <i className="fas fa-inbox text-4xl mb-2"></i>
            <div>ไม่มีรายการ{filter === 'pending' ? 'รออนุมัติ' : ''}</div>
          </div>
        ) : (
          <div className="space-y-3">
            {requisitions.map((req) => (
              <div
                key={req.id}
                className="bg-slate-700 p-4 rounded-xl hover:bg-slate-600 transition cursor-pointer"
                onClick={() => openDetail(req)}
              >
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-base font-black text-blue-400 break-words">{req.requisition_id}</span>
                  </div>
                  <div className="text-xs text-gray-400 shrink-0 text-right">{formatDate(req.created_at)}</div>
                </div>
                <div className="text-sm text-gray-300 mb-2">สร้างโดย: {req.created_by_user?.username || '---'}</div>
                <div className="flex items-end justify-between gap-2 mt-2">
                  <div className="flex-1 min-w-0">
                    {req.status === 'approved' && req.approved_by_user && (
                      <div className="text-xs text-green-400 mb-1 flex items-center whitespace-nowrap">
                        <i className="fas fa-check-circle mr-1 shrink-0"></i>
                        <span>
                          อนุมัติโดย: {req.approved_by_user.username} ({formatDate(req.approved_at)})
                        </span>
                      </div>
                    )}
                    {req.status === 'rejected' && req.approved_by_user && (
                      <div className="text-xs text-red-400 mb-1 flex items-center whitespace-nowrap">
                        <i className="fas fa-times-circle mr-1 shrink-0"></i>
                        <span>
                          ปฏิเสธโดย: {req.approved_by_user.username} ({formatDate(req.approved_at)})
                        </span>
                      </div>
                    )}
                    {req.notes && <div className="text-sm text-gray-300 font-medium break-words">หมายเหตุ: {req.notes}</div>}
                    <div className="mt-2 text-xs text-gray-500">
                      <i className="fas fa-hand-pointer mr-1"></i>
                      คลิกเพื่อดูรายละเอียด
                    </div>
                  </div>
                  <div className="shrink-0">{getStatusBadge(req.status)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isModalOpen && selectedRequisition && <RequisitionDetailModal requisition={selectedRequisition} onClose={closeModal} />}
      {MessageModal}
    </div>
  )
}
