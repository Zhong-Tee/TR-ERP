import { useEffect, useState } from 'react'
import Modal from '../../ui/Modal'
import { supabase } from '../../../lib/supabase'

interface SentAlertsModalProps {
  pickerId: string
  onClose: () => void
}

interface SentAlertRow {
  id: string
  type: string
  order_id: string
  created_at: string
  is_read: boolean
  product_name?: string
  location?: string
}

export default function SentAlertsModal({ pickerId, onClose }: SentAlertsModalProps) {
  const [alerts, setAlerts] = useState<SentAlertRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    loadAlerts()

    const channel = supabase
      .channel(`picker-sent-alerts-${pickerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_notifications' }, () => {
        loadAlerts()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [pickerId])

  const loadAlerts = async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('wms_notifications')
        .select('id, type, order_id, created_at, is_read')
        .eq('picker_id', pickerId)
        .eq('status', 'unread') // ยังไม่ถูกกด "แก้ไขแล้ว"
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = data || []
      if (rows.length === 0) {
        setAlerts([])
        setLoadError('')
        setLoading(false)
        return
      }

      const orderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))]
      const { data: details, error: detailsError } = await supabase
        .from('wms_orders')
        .select('order_id, product_name, location')
        .in('order_id', orderIds)

      if (detailsError) throw detailsError

      const merged = rows.map((row) => {
        const detail = details?.find((d: any) => d.order_id === row.order_id)
        return {
          ...row,
          product_name: detail?.product_name || '-',
          location: detail?.location || '-',
        }
      })

      setAlerts(merged)
      setLoadError('')
    } catch (e: any) {
      setLoadError(e?.message || 'โหลดข้อมูลไม่สำเร็จ')
      setAlerts([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={true} onClose={onClose} closeOnBackdropClick={true} contentClassName="max-w-2xl">
      <div className="bg-white rounded-3xl overflow-hidden shadow-2xl">
        <div className="px-6 py-4 bg-slate-50 border-b flex items-center justify-between">
          <h3 className="text-xl font-black text-slate-800">แจ้งเตือนที่ส่งไป</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-red-500 text-2xl">
            <i className="fas fa-times-circle" />
          </button>
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-8 text-gray-500">กำลังโหลด...</div>
          ) : loadError ? (
            <div className="text-center py-8 text-red-500">{loadError}</div>
          ) : alerts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">ไม่มีรายการที่รอแก้ไข</div>
          ) : (
            <div className="space-y-3">
              {alerts.map((a, idx) => (
                <div key={a.id} className="rounded-2xl border bg-white p-4">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-black text-slate-800">
                      {idx + 1}. {a.type}
                    </div>
                    <div className="text-xs text-gray-500">{new Date(a.created_at).toLocaleString('th-TH')}</div>
                  </div>
                  <div className="text-sm text-gray-600">ใบงาน: {a.order_id}</div>
                  <div className="text-sm text-gray-600">สินค้า: {a.product_name}</div>
                  <div className="text-sm text-gray-600">จุดจัดเก็บ: {a.location}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
