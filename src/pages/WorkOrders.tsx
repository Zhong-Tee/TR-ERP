import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { WorkOrder } from '../types'
import { formatDateTime } from '../lib/utils'

/** ข้อมูลจาก plan_jobs สำหรับแสดง วันที่, เวลาตัด, จำนวนต่อแผนก */
type PlanJobRow = { id: string; name: string; date: string; cut: string | null; qty: Record<string, number> }

export default function WorkOrders() {
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [planJobByWoName, setPlanJobByWoName] = useState<Record<string, PlanJobRow>>({})
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
      const list = (data || []) as WorkOrder[]
      setWorkOrders(list)

      if (list.length > 0) {
        const names = list.map((w) => w.work_order_name)
        const { data: planData, error: planErr } = await supabase
          .from('plan_jobs')
          .select('id, name, date, cut, qty')
          .in('name', names)
          .order('date', { ascending: false })

        if (!planErr && planData && planData.length > 0) {
          const map: Record<string, PlanJobRow> = {}
          ;(planData as PlanJobRow[]).forEach((row) => {
            if (row.name && !(row.name in map)) map[row.name] = row
          })
          setPlanJobByWoName(map)
        } else {
          setPlanJobByWoName({})
        }
      } else {
        setPlanJobByWoName({})
      }
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

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {workOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ยังไม่มีใบงานที่สร้าง — สร้างได้ที่เมนู ใบสั่งงาน
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-100 border-b border-gray-200">
                  <th className="p-3 text-left font-medium text-gray-800">ชื่อใบงาน</th>
                  <th className="p-3 text-left font-medium text-gray-800 min-w-[100px]">วันที่</th>
                  <th className="p-3 text-left font-medium text-gray-800 min-w-[80px]">เวลาตัด</th>
                  <th className="p-3 text-left font-medium text-gray-800 min-w-[160px]">จำนวนต่อแผนก</th>
                  <th className="p-3 text-left font-medium text-gray-800">สถานะ</th>
                  <th className="p-3 text-left font-medium text-gray-800">จำนวนบิล</th>
                  <th className="p-3 text-left font-medium text-gray-800">สร้างเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((wo) => {
                  const plan = planJobByWoName[wo.work_order_name]
                  const qty = plan?.qty ?? {}
                  const deptKeys = Object.keys(qty).filter((k) => Number(qty[k]) > 0)
                  return (
                    <tr key={wo.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="p-3 font-medium text-gray-900">{wo.work_order_name}</td>
                      <td className="p-3 text-gray-700">{plan?.date ?? '-'}</td>
                      <td className="p-3 text-gray-700">
                        {plan?.cut && plan.cut.length >= 5 ? plan.cut.substring(0, 5) : plan?.cut ?? '-'}
                      </td>
                      <td className="p-3">
                        {deptKeys.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {deptKeys.map((d) => (
                              <span
                                key={d}
                                className="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs"
                              >
                                {d}: {Number(qty[d])}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium border ${
                            wo.status === 'กำลังผลิต'
                              ? 'bg-amber-100 text-amber-800 border-amber-200'
                              : wo.status === 'จัดส่งแล้ว'
                              ? 'bg-green-100 text-green-700 border-green-200'
                              : 'bg-gray-100 text-gray-700 border-gray-200'
                          }`}
                        >
                          {wo.status}
                        </span>
                      </td>
                      <td className="p-3 text-gray-700">{wo.order_count} บิล</td>
                      <td className="p-3 text-gray-600">
                        {wo.created_at ? formatDateTime(wo.created_at) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
