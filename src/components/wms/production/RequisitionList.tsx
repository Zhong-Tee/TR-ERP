import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { useWmsModal } from '../useWmsModal'

export default function RequisitionList() {
  const { user } = useAuthContext()
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
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

      const requisitionsWithUsers = await Promise.all(
        (data || []).map(async (req: any) => {
          if (req.approved_by) {
            const { data: userData } = await supabase.from('us_users').select('username').eq('id', req.approved_by).single()
            return { ...req, approved_by_user: userData }
          }
          return req
        })
      )

      setRequisitions(requisitionsWithUsers)
    } catch (error: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setLoading(false)
    }
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
            {requisitions.map((req) => (
              <div key={req.id} className="bg-slate-700 p-4 rounded-xl">
                <div className="flex items-start justify-between mb-2 gap-2">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-base font-black text-blue-400 break-words">{req.requisition_id}</span>
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
                    {req.requisition_topic && (
                      <div className="text-xs text-black bg-white px-2 py-1 rounded font-bold">{req.requisition_topic}</div>
                    )}
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
              </div>
            ))}
          </div>
        )}
      </div>
      {MessageModal}
    </div>
  )
}
