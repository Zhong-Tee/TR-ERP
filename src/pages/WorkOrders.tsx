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
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [channelFilter, setChannelFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  useEffect(() => {
    loadWorkOrders()
  }, [channelFilter, dateFrom, dateTo, statusFilter])

  useEffect(() => {
    loadChannels()
  }, [])

  async function loadChannels() {
    try {
      const { data, error } = await supabase
        .from('channels')
        .select('channel_code, channel_name')
        .order('channel_code', { ascending: true })
      if (error) throw error
      setChannels(data || [])
    } catch (error) {
      console.error('Error loading channels:', error)
    }
  }

  async function loadWorkOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_work_orders')
        .select('*')
        .order('created_at', { ascending: false })

      if (channelFilter) {
        query = query.ilike('work_order_name', `${channelFilter}-%`)
      }
      if (dateFrom) {
        query = query.gte('created_at', `${dateFrom}T00:00:00.000Z`)
      }
      if (dateTo) {
        query = query.lte('created_at', `${dateTo}T23:59:59.999Z`)
      }
      if (statusFilter) {
        query = query.eq('status', statusFilter)
      }

      const { data, error } = await query.limit(200)

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
      <div className="bg-surface-50 p-4 rounded-2xl shadow-soft border border-surface-200">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-semibold text-surface-700 mb-1">ช่องทาง</label>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="px-3 py-2.5 border border-surface-300 rounded-xl bg-surface-50 text-base"
            >
              <option value="">ทั้งหมด</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name || ch.channel_code}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-surface-700 mb-1">สถานะ</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2.5 border border-surface-300 rounded-xl bg-surface-50 text-base"
            >
              <option value="">ทั้งหมด</option>
              <option value="กำลังผลิต">กำลังผลิต</option>
              <option value="จัดส่งแล้ว">จัดส่งแล้ว</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-surface-700 mb-1">จากวันที่</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2.5 border border-surface-300 rounded-xl bg-surface-50 text-base"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-surface-700 mb-1">ถึงวันที่</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2.5 border border-surface-300 rounded-xl bg-surface-50 text-base"
            />
          </div>
        </div>
      </div>

      <div className="bg-surface-50 rounded-2xl shadow-soft border border-surface-200 overflow-hidden">
        {workOrders.length === 0 ? (
          <div className="text-center py-12 text-surface-500">
            ยังไม่มีใบงานที่สร้าง — สร้างได้ที่เมนู ใบสั่งงาน
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-4 text-left font-semibold">ชื่อใบงาน</th>
                  <th className="p-4 text-left font-semibold min-w-[100px]">วันที่</th>
                  <th className="p-4 text-left font-semibold min-w-[80px]">เวลาตัด</th>
                  <th className="p-4 text-left font-semibold min-w-[160px]">จำนวนต่อแผนก</th>
                  <th className="p-4 text-left font-semibold">สถานะ</th>
                  <th className="p-4 text-left font-semibold">จำนวนบิล</th>
                  <th className="p-4 text-left font-semibold">สร้างเมื่อ</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((wo, idx) => {
                  const plan = planJobByWoName[wo.work_order_name]
                  const qty = plan?.qty ?? {}
                  const deptKeys = Object.keys(qty).filter((k) => Number(qty[k]) > 0)
                  return (
                    <tr key={wo.id} className={`border-b border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-4 font-semibold text-surface-900">{wo.work_order_name}</td>
                      <td className="p-4 text-surface-700">{plan?.date ?? '-'}</td>
                      <td className="p-4 text-surface-700">
                        {plan?.cut && plan.cut.length >= 5 ? plan.cut.substring(0, 5) : plan?.cut ?? '-'}
                      </td>
                      <td className="p-4">
                        {deptKeys.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {deptKeys.map((d) => {
                              const deptColor: Record<string, string> = {
                                PACK: 'bg-blue-100 text-blue-700 border-blue-300',
                                STAMP: 'bg-purple-100 text-purple-700 border-purple-300',
                                SEW: 'bg-pink-100 text-pink-700 border-pink-300',
                                CUT: 'bg-orange-100 text-orange-700 border-orange-300',
                                PRINT: 'bg-green-100 text-green-700 border-green-300',
                                HEAT: 'bg-red-100 text-red-700 border-red-300',
                                EMB: 'bg-yellow-100 text-yellow-700 border-yellow-300',
                                FOLD: 'bg-teal-100 text-teal-700 border-teal-300',
                              }
                              const colorClass = deptColor[d.toUpperCase()] || 'bg-gray-100 text-gray-700 border-gray-300'
                              return (
                                <span
                                  key={d}
                                  className={`rounded-full border px-2.5 py-1 text-xs font-bold ${colorClass}`}
                                >
                                  {d}: {Number(qty[d])}
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <span className="text-surface-400">-</span>
                        )}
                      </td>
                      <td className="p-4">
                        <span
                          className={`inline-flex px-3 py-1.5 rounded-full text-xs font-bold ${
                            wo.status === 'กำลังผลิต'
                              ? 'bg-amber-500 text-white'
                              : wo.status === 'จัดส่งแล้ว'
                              ? 'bg-green-500 text-white'
                              : 'bg-gray-200 text-gray-700'
                          }`}
                        >
                          {wo.status}
                        </span>
                      </td>
                      <td className="p-4 text-surface-700">{wo.order_count} บิล</td>
                      <td className="p-4 text-surface-600">
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
