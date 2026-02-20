import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

export default function RequisitionList() {
  const { user } = useAuthContext()
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailItems, setDetailItems] = useState<any[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const { showMessage, MessageModal } = useWmsModal()

  useEffect(() => {
    if (!user?.id) return
    loadRequisitions()

    const channel = supabase
      .channel('wms-production-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions', filter: `created_by=eq.${user?.id}` }, () => {
        loadRequisitions()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  const loadRequisitions = async () => {
    try {
      const { data, error } = await supabase
        .from('wms_requisitions')
        .select('*')
        .eq('created_by', user?.id)
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = data || []
      const approverIds = [...new Set(rows.map((r: any) => r.approved_by).filter(Boolean))]
      const userMap = new Map<string, string>()
      if (approverIds.length > 0) {
        const { data: users } = await supabase.from('us_users').select('id, username').in('id', approverIds)
        for (const u of (users ?? []) as { id: string; username: string }[]) userMap.set(u.id, u.username)
      }
      const requisitionsWithUsers = rows.map((req: any) => ({
        ...req,
        approved_by_user: req.approved_by ? { username: userMap.get(req.approved_by) || '-' } : null,
      }))

      setRequisitions(requisitionsWithUsers)
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const toggleDetail = async (requisitionId: string) => {
    if (expandedId === requisitionId) {
      setExpandedId(null)
      setDetailItems([])
      return
    }
    setExpandedId(requisitionId)
    setDetailLoading(true)
    try {
      const { data, error } = await supabase
        .from('wms_requisition_items')
        .select('*')
        .eq('requisition_id', requisitionId)
        .order('created_at', { ascending: true })
      if (error) throw error
      setDetailItems(sortOrderItems(data || []))
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
      setDetailItems([])
    } finally {
      setDetailLoading(false)
    }
  }

  const imgUrl = (productCode: string) => {
    if (productCode === 'SPARE_PART') return getProductImageUrl('spare_part')
    return getProductImageUrl(productCode)
  }

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      pending: 'bg-yellow-500 text-white',
      approved: 'bg-green-500 text-white',
      rejected: 'bg-red-500 text-white',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return (
      <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold text-center min-w-[90px] ${badges[status] || 'bg-gray-500 text-white'}`}>
        {labels[status] || status}
      </span>
    )
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
        <h2 className="text-xl font-black text-white mb-4">รายการใบเบิกของฉัน</h2>
        {requisitions.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <i className="fas fa-inbox text-4xl mb-2"></i>
            <div>ยังไม่มีใบเบิก</div>
          </div>
        ) : (
          <div className="space-y-3">
            {requisitions.map((req) => {
              const isExpanded = expandedId === req.requisition_id
              return (
                <div key={req.id} className="bg-slate-700 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleDetail(req.requisition_id)}
                    className="w-full text-left p-4 active:bg-slate-600 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-2 gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-xs font-black text-blue-400 break-words">{req.requisition_id}</span>
                        <i className={`fas fa-chevron-down text-[10px] text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                      </div>
                      <div className="text-xs text-gray-400 shrink-0 text-right">
                        <div>{formatDate(req.created_at)}</div>
                        {req.notes && (
                          <div className="text-sm text-gray-300 font-medium break-words mt-1 max-w-[200px]">หมายเหตุ: {req.notes}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-end justify-between gap-2 mt-2">
                      <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                        {req.status === 'approved' && req.approved_by_user && (
                          <div className="text-xs text-green-400 flex flex-col">
                            <div>
                              <i className="fas fa-check-circle mr-1"></i>
                              อนุมัติโดย: {req.approved_by_user.username}
                            </div>
                            <div className="ml-4 mt-1">{formatDate(req.approved_at)}</div>
                          </div>
                        )}
                        {req.status === 'rejected' && req.approved_by_user && (
                          <div className="text-xs text-red-400 flex flex-col">
                            <div>
                              <i className="fas fa-times-circle mr-1"></i>
                              ปฏิเสธโดย: {req.approved_by_user.username}
                            </div>
                            <div className="ml-4 mt-1">{formatDate(req.approved_at)}</div>
                          </div>
                        )}
                      </div>
                      <div className="shrink-0">{getStatusBadge(req.status)}</div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-slate-600 px-4 pb-4 pt-3">
                      {detailLoading ? (
                        <div className="text-center py-4 text-gray-400">
                          <i className="fas fa-spinner fa-spin mr-2"></i>กำลังโหลด...
                        </div>
                      ) : detailItems.length === 0 ? (
                        <div className="text-center py-4 text-gray-500 text-sm">ไม่มีรายการสินค้า</div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-xs font-bold text-gray-400 mb-2">
                            รายการสินค้า ({detailItems.length} รายการ)
                          </div>
                          {detailItems.map((item, idx) => (
                            <div key={item.id} className="flex items-center gap-3 p-2.5 bg-slate-800 rounded-xl">
                              <div className="text-sm font-black text-gray-500 w-6 text-center shrink-0">{idx + 1}</div>
                              <img
                                src={imgUrl(item.product_code)}
                                className="w-14 h-14 object-cover rounded-lg shrink-0 border border-slate-600"
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement
                                  target.src = 'https://placehold.co/100x100?text=NO+IMG'
                                }}
                                alt={item.product_name}
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-bold text-white text-sm leading-tight">{item.product_name}</div>
                                <div className="text-[11px] text-gray-400 mt-0.5">รหัส: {item.product_code}</div>
                                {item.location && (
                                  <div className="text-[11px] text-red-400">จุดเก็บ: {item.location}</div>
                                )}
                              </div>
                              <div className="text-white font-bold text-base shrink-0 bg-blue-600/30 px-3 py-1 rounded-lg">
                                x{item.qty}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {MessageModal}
    </div>
  )
}
