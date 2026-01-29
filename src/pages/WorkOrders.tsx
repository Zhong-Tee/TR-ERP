import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { WorkOrder } from '../types'
import { formatDateTime } from '../lib/utils'

export default function WorkOrders() {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadWorkOrders()
  }, [])

  async function loadWorkOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_work_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (error) throw error
      setWorkOrders((data || []) as WorkOrder[])
    } catch (error: any) {
      console.error('Error loading work orders:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">ใบงาน</h1>
      <p className="text-gray-600">
        รายการใบงานที่สร้างจากเมนู ใบสั่งงาน — เลือกใบงานเพื่อจัดของได้ที่เมนู จัดของ
      </p>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {workOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ยังไม่มีใบงาน — สร้างใบงานได้ที่เมนู ออเดอร์ → ใบสั่งงาน
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100 border-b">
                  <th className="p-3 text-left font-medium">ชื่อใบงาน</th>
                  <th className="p-3 text-left font-medium">สถานะ</th>
                  <th className="p-3 text-left font-medium">จำนวนบิล</th>
                  <th className="p-3 text-left font-medium">สร้างเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((wo) => (
                  <tr key={wo.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="p-3">
                      <span className="font-medium text-blue-600">{wo.work_order_name}</span>
                    </td>
                    <td className="p-3">
                      <span
                        className={`inline-flex px-2 py-1 rounded text-xs font-medium ${
                          wo.status === 'กำลังผลิต'
                            ? 'bg-amber-100 text-amber-800'
                            : wo.status === 'จัดส่งแล้ว'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {wo.status}
                      </span>
                    </td>
                    <td className="p-3 text-gray-700">{wo.order_count} บิล</td>
                    <td className="p-3 text-gray-600 text-xs">
                      {wo.created_at ? formatDateTime(wo.created_at) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
