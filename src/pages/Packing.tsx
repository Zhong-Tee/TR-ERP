import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { WorkOrder } from '../types'

export default function Packing() {
  const location = useLocation()
  const preselectedName = (location.state as { workOrderName?: string } | null)?.workOrderName
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [loading, setLoading] = useState(true)
  const highlightedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadWorkOrders()
  }, [])

  useEffect(() => {
    if (preselectedName && workOrders.length > 0 && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [preselectedName, workOrders.length])

  async function loadWorkOrders() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_work_orders')
        .select('*')
        .eq('status', 'กำลังผลิต')
        .order('created_at', { ascending: false })

      if (error) throw error
      setWorkOrders(data || [])
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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">จัดของ</h1>
      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">เลือกใบงาน</h2>
        {workOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบใบงานที่กำลังผลิต
          </div>
        ) : (
          <div className="space-y-2">
            {workOrders.map((wo) => {
              const isPreselected = preselectedName === wo.work_order_name
              return (
              <div
                key={wo.id}
                ref={isPreselected ? highlightedRef : undefined}
                className={`p-4 border rounded-lg hover:bg-gray-50 cursor-pointer transition-colors ${
                  isPreselected ? 'ring-2 ring-blue-500 bg-blue-50/50' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <strong className="text-lg">{wo.work_order_name}</strong>
                    <p className="text-sm text-gray-600">
                      {wo.order_count} บิล
                    </p>
                  </div>
                  <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
                    เริ่มจัดของ
                  </button>
                </div>
              </div>
            )})}
          </div>
        )}
        <p className="text-gray-600 text-sm mt-4">
          Note: Full packing system implementation from index.html will be added
        </p>
      </div>
    </div>
  )
}
