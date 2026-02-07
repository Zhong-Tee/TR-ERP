import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'

interface PickerOrderListProps {
  onSelectOrder: (orderId: string) => void
  currentUserId?: string | null
}

export default function PickerOrderList({ onSelectOrder, currentUserId }: PickerOrderListProps) {
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPickerOrderList()

    const channel = supabase
      .channel('wms-picker-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => {
        loadPickerOrderList()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [currentUserId])

  const loadPickerOrderList = async () => {
    if (!currentUserId) return

    const { data } = await supabase
      .from('wms_orders')
      .select('order_id, created_at, status')
      .eq('assigned_to', currentUserId)
      .in('status', ['pending', 'wrong', 'not_find'])

    if (!data || data.length === 0) {
      setOrders([])
      setLoading(false)
      return
    }

    const grouped = (data as any[]).reduce((acc: Record<string, any>, obj) => {
      if (!acc[obj.order_id]) {
        acc[obj.order_id] = { id: obj.order_id, count: 0, date: obj.created_at }
      }
      acc[obj.order_id].count++
      return acc
    }, {})

    setOrders(Object.values(grouped))
    setLoading(false)
  }

  if (loading) {
    return <div className="text-center text-slate-400 py-10">กำลังโหลด...</div>
  }

  if (orders.length === 0) {
    return <div className="text-center text-slate-500 italic py-20">ไม่มีงานมอบหมาย</div>
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <h2 className="text-xl font-black mb-4">รายการใบงานที่ได้รับ</h2>
      <div className="space-y-3 overflow-y-auto pb-4">
        {orders.map((o) => (
          <div
            key={o.id}
            onClick={() => onSelectOrder(o.id)}
            className="bg-white p-5 rounded-3xl text-slate-800 border-2 border-transparent active:border-blue-500 flex justify-between items-center shadow-lg transition-all cursor-pointer"
          >
            <div>
              <div className="text-[18px] text-gray-400 font-black uppercase">เลขใบงาน</div>
              <div className="text-2xl font-black">{o.id}</div>
            </div>
            <div className="bg-blue-600 text-white px-4 py-2 rounded-2xl font-black">{o.count}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
