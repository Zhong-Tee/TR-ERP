import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../../lib/supabase'
import { calculateDuration } from '../wmsUtils'
import OrderDetailModal from './OrderDetailModal'

type UserRow = { id: string; username: string | null; role: string }

export default function UploadSection() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [filterUser, setFilterUser] = useState('')
  const [filterDateStart, setFilterDateStart] = useState('')
  const [filterDateEnd, setFilterDateEnd] = useState('')
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [tick, setTick] = useState(0)
  // เก็บเวลาล่าสุดสำหรับแต่ละ order เพื่อ freeze เมื่อ COMPLETED
  const durationCacheRef = useRef<Record<string, string>>({})

  useEffect(() => {
    loadUsers()
    loadOrdersDashboard()
    const today = new Date().toISOString().split('T')[0]
    setFilterDateStart(today)
    setFilterDateEnd(today)

    const channel = supabase
      .channel('wms-upload-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => {
        loadOrdersDashboard()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setTick((prev) => prev + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (filterDateStart || filterDateEnd || filterUser) {
      loadOrdersDashboard()
    }
  }, [filterDateStart, filterDateEnd, filterUser])

  const loadUsers = async () => {
    const { data } = await supabase.from('us_users').select('id, username, role').order('username')
    if (data) {
      setUsers(data as UserRow[])
    }
  }

  const loadOrdersDashboard = async () => {
    let q = supabase.from('wms_orders').select('*, us_users(username)')

    if (filterDateStart) {
      q = q.gte('created_at', filterDateStart + 'T00:00:00')
    }
    if (filterDateEnd) {
      q = q.lte('created_at', filterDateEnd + 'T23:59:59')
    }
    if (filterUser) {
      q = q.eq('assigned_to', filterUser)
    }

    const { data } = await q.order('created_at', { ascending: false })
    if (!data) return

    const grouped = (data as any[]).reduce((acc: Record<string, any>, obj) => {
      const key = obj.order_id + (obj.assigned_to || '')
      if (!acc[key]) {
        acc[key] = {
          id: obj.order_id,
          picked_count: 0,
          wrong_count: 0,
          not_find_count: 0,
          oos_count: 0,
          total: 0,
          assigned: obj.us_users?.username || '---',
          date: obj.created_at,
          max_end: null,
          items: [],
        }
      }
      acc[key].items.push(obj)
      acc[key].total++
      // เก็บ created_at ที่เก่าที่สุด (min) เป็นเวลาเริ่มต้นของ group
      if (new Date(obj.created_at) < new Date(acc[key].date)) {
        acc[key].date = obj.created_at
      }
      if (['picked', 'correct', 'wrong', 'not_find'].includes(obj.status)) {
        acc[key].picked_count++
      }
      if (obj.status === 'wrong') acc[key].wrong_count++
      if (obj.status === 'not_find') acc[key].not_find_count++
      if (obj.status === 'out_of_stock') acc[key].oos_count++
      if (obj.end_time) {
        const ce = new Date(obj.end_time)
        if (!acc[key].max_end || ce > new Date(acc[key].max_end)) {
          acc[key].max_end = obj.end_time
        }
      }
      return acc
    }, {})

    setOrders(Object.values(grouped))
  }

  const openDetailModal = (orderId: string) => {
    setSelectedOrderId(orderId)
    setIsModalOpen(true)
  }

  const pickers = users.filter((u) => u.role === 'picker')

  return (
    <>
      <section>
        <div className="bg-white p-6 rounded-2xl shadow-sm border overflow-hidden">
          <div className="flex justify-between items-center mb-6 pb-4 border-b flex-wrap gap-2">
            <h3 className="font-bold text-slate-800">Dashboard รายการใบงาน</h3>
            <div className="flex gap-2 items-center flex-wrap">
              <select
                value={filterUser}
                onChange={(e) => setFilterUser(e.target.value)}
                className="border p-2 rounded text-xs bg-white outline-none h-[32px]"
              >
                <option value="">พนักงานทั้งหมด</option>
                {pickers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username || u.id}
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={filterDateStart}
                onChange={(e) => setFilterDateStart(e.target.value)}
                className="border p-2 rounded text-xs outline-none shadow-sm h-[32px]"
              />
              <span className="text-gray-400 text-xs">-</span>
              <input
                type="date"
                value={filterDateEnd}
                onChange={(e) => setFilterDateEnd(e.target.value)}
                className="border p-2 rounded text-xs outline-none shadow-sm h-[32px]"
              />
              <button
                onClick={loadOrdersDashboard}
                className="bg-blue-600 text-white px-4 py-1 rounded text-xs font-bold hover:bg-blue-700 h-[32px]"
              >
                Filter
              </button>
            </div>
          </div>
          <table className="w-full text-left text-sm" data-tick={tick}>
            <thead className="bg-gray-50 text-[16px] uppercase text-gray-400">
              <tr>
                <th className="p-4">ใบงาน (ORDER ID)</th>
                <th className="p-4 text-center">มอบหมาย</th>
                <th className="p-4 text-center">พนักงาน</th>
                <th className="p-4 text-center">หยิบแล้ว</th>
                <th className="p-4 text-center text-red-500">หยิบผิด</th>
                <th className="p-4 text-center text-orange-500">ไม่พบ</th>
                <th className="p-4 text-center text-red-700">สินค้าหมด</th>
                <th className="p-4 text-center">ทั้งหมด (หยิบ/รวม)</th>
                <th className="p-4 text-center">สถานะภาพรวม</th>
                <th className="p-4 text-center">ระยะเวลาที่ใช้</th>
                <th className="p-4 text-center">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y text-gray-600">
              {orders.map((o) => {
                const isWorking = o.items.some((i: any) => ['pending', 'wrong', 'not_find'].includes(i.status))
                const calculation = o.picked_count - o.wrong_count - o.not_find_count
                const cellClass = 'p-4 text-[16px]'

                return (
                  <tr key={o.id} className="hover:bg-blue-50 border-b transition">
                    <td className={`${cellClass} font-black text-blue-600`}>{o.id}</td>
                    <td className={`${cellClass} text-center text-gray-500 text-xs`}>
                      {new Date(o.date).toLocaleString('th-TH')}
                    </td>
                    <td className={`${cellClass} text-center font-bold text-slate-700`}>{o.assigned}</td>
                    <td className={`${cellClass} text-center font-bold text-blue-600`}>{o.picked_count}</td>
                    <td className={`${cellClass} text-center font-bold text-red-600`}>{o.wrong_count}</td>
                    <td className={`${cellClass} text-center font-bold text-orange-600`}>{o.not_find_count}</td>
                    <td className={`${cellClass} text-center font-bold text-red-800`}>{o.oos_count}</td>
                    <td className={`${cellClass} text-center font-bold text-gray-500`}>
                      {calculation} / {o.total}
                    </td>
                    <td className={`${cellClass} text-center`}>
                      <span
                        className={`px-3 py-1 rounded text-xs font-bold uppercase ${
                          !isWorking ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {!isWorking ? 'COMPLETED' : 'IN PROGRESS'}
                      </span>
                    </td>
                    <td className={`${cellClass} text-center font-mono text-blue-600 font-bold`}>
                      {(() => {
                        const key = o.id + (o.assigned || '')
                        if (!isWorking && o.max_end) {
                          // COMPLETED + มี end_time → คำนวณจริง แล้ว cache
                          const d = calculateDuration(o.date, o.max_end)
                          durationCacheRef.current[key] = d
                          return d
                        }
                        if (!isWorking && !o.max_end) {
                          // COMPLETED + ไม่มี end_time → freeze ที่ค่าล่าสุดที่เคย cache ไว้
                          return durationCacheRef.current[key] || calculateDuration(o.date, o.date)
                        }
                        // IN PROGRESS → คำนวณ live แล้ว cache ไว้
                        const d = calculateDuration(o.date, null)
                        durationCacheRef.current[key] = d
                        return d
                      })()}
                    </td>
                    <td className={`${cellClass} text-center`}>
                      <button onClick={() => openDetailModal(o.id)} className="text-blue-500 font-bold underline">
                        View
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isModalOpen && selectedOrderId && (
        <OrderDetailModal
          orderId={selectedOrderId}
          onClose={() => {
            setIsModalOpen(false)
            setSelectedOrderId(null)
            loadOrdersDashboard()
          }}
        />
      )}
    </>
  )
}
