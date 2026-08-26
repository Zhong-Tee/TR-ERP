import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../../lib/supabase'
import { calculateDuration, WMS_FULFILLMENT_PICK_OR_LEGACY } from '../wmsUtils'
import { consolidateCondoStampWmsDisplayRows } from '../../../lib/wmsCondoStampConsolidation'
import OrderDetailModal from './OrderDetailModal'
import CancelledBillStockModal, { type CancelledBillSummary } from './CancelledBillStockModal'

type UserRow = { id: string; username: string | null; role: string }

export default function UploadSection() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [filterUser, setFilterUser] = useState('')
  const [filterDateStart, setFilterDateStart] = useState(() => new Date().toISOString().split('T')[0])
  const [filterDateEnd, setFilterDateEnd] = useState(() => new Date().toISOString().split('T')[0])
  /** scope ของ modal รายละเอียด — แยกด้วย work_order_id ไม่ให้ชื่อใบงานซ้ำปนกัน */
  const [detailScope, setDetailScope] = useState<{ workOrderId: string | null; displayName: string } | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [cancelledByWorkOrder, setCancelledByWorkOrder] = useState<Record<string, CancelledBillSummary[]>>({})
  const [cancelledModal, setCancelledModal] = useState<{ workOrderId: string; displayName: string } | null>(null)
  const [tick, setTick] = useState(0)
  // เก็บเวลาล่าสุดสำหรับแต่ละ order เพื่อ freeze เมื่อ COMPLETED
  const durationCacheRef = useRef<Record<string, string>>({})

  useEffect(() => {
    loadUsers()
    loadOrdersDashboard()

    const channel = supabase
      .channel('wms-upload-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_orders' }, () => {
        loadOrdersDashboard()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => loadOrdersDashboard())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_order_items' }, () => loadOrdersDashboard())
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
    let q = supabase.from('wms_orders').select('*, us_users(username)').or(WMS_FULFILLMENT_PICK_OR_LEGACY)

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
      const woId = (obj.work_order_id as string | null | undefined) ?? null
      const key = woId
        ? `${woId}|${obj.assigned_to || ''}`
        : `legacy:${obj.order_id}|${obj.assigned_to || ''}`
      if (!acc[key]) {
        acc[key] = {
          rowKey: key,
          work_order_id: woId,
          display_name: obj.order_id,
          assigned: obj.us_users?.username || '---',
          date: obj.created_at,
          max_end: null,
          items: [],
        }
      }
      acc[key].items.push(obj)
      if (new Date(obj.created_at) < new Date(acc[key].date)) {
        acc[key].date = obj.created_at
      }
      if (obj.end_time) {
        const ce = new Date(obj.end_time)
        if (!acc[key].max_end || ce > new Date(acc[key].max_end)) {
          acc[key].max_end = obj.end_time
        }
      }
      return acc
    }, {})

    for (const o of Object.values(grouped) as any[]) {
      const consolidated = consolidateCondoStampWmsDisplayRows(o.items)
      const activeItems = consolidated.filter((i: any) => i.status !== 'cancelled')
      o.cancelled_count = consolidated.length - activeItems.length
      o.total = activeItems.length
      o.picked_count = activeItems.filter((i: any) =>
        ['picked', 'correct', 'wrong', 'not_find'].includes(i.status)
      ).length
      o.wrong_count = activeItems.filter((i: any) => i.status === 'wrong').length
      o.not_find_count = activeItems.filter((i: any) => i.status === 'not_find').length
      o.oos_count = activeItems.filter((i: any) => i.status === 'out_of_stock').length
    }

    const workOrderIds = [...new Set((data as any[]).map((row) => row.work_order_id).filter(Boolean))]
    const nextCancelledByWo: Record<string, CancelledBillSummary[]> = {}
    if (workOrderIds.length > 0) {
      const { data: orderRows } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, status, work_order_id')
        .in('work_order_id', workOrderIds)
      const orderIds = (orderRows || []).map((row: any) => row.id).filter(Boolean)
      const { data: cancelledItemRows } = orderIds.length
        ? await supabase
            .from('or_order_items')
            .select('order_id')
            .in('order_id', orderIds)
            .not('cancellation_stock_action', 'is', null)
        : { data: [] as any[] }
      const orderIdsWithCancelledItems = new Set((cancelledItemRows || []).map((row: any) => row.order_id))

      ;(orderRows || []).forEach((order: any) => {
        const isFullyCancelled = String(order.status || '') === 'ยกเลิก'
        if (!isFullyCancelled && !orderIdsWithCancelledItems.has(order.id)) return
        const woId = String(order.work_order_id || '')
        if (!woId) return
        if (!nextCancelledByWo[woId]) nextCancelledByWo[woId] = []
        nextCancelledByWo[woId].push({
          id: order.id,
          bill_no: order.bill_no || '-',
          customer_name: order.customer_name || '-',
          partial: !isFullyCancelled,
        })
      })
    }
    setCancelledByWorkOrder(nextCancelledByWo)

    setOrders(Object.values(grouped))
  }

  const openDetailModal = (workOrderId: string | null, displayName: string) => {
    setDetailScope({ workOrderId, displayName })
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
                className="h-[36px] min-w-[150px] rounded border bg-white px-3 text-sm outline-none"
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
                className="h-[36px] min-w-[150px] rounded border bg-white px-3 text-sm outline-none shadow-sm"
              />
              <span className="text-gray-400 text-xs">-</span>
              <input
                type="date"
                value={filterDateEnd}
                onChange={(e) => setFilterDateEnd(e.target.value)}
                className="h-[36px] min-w-[150px] rounded border bg-white px-3 text-sm outline-none shadow-sm"
              />
              <button
                onClick={loadOrdersDashboard}
                className="h-[36px] rounded bg-blue-600 px-4 py-1 text-sm font-bold text-white hover:bg-blue-700"
              >
                Filter
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] table-fixed text-left text-sm" data-tick={tick}>
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[14%]" />
              <col className="w-[11%]" />
              <col className="w-[4.5%]" />
              <col className="w-[4.5%]" />
              <col className="w-[4.5%]" />
              <col className="w-[4.5%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
            </colgroup>
            <thead className="bg-gray-50 text-[15px] font-semibold text-gray-500">
              <tr>
                <th className="px-4 py-4">ใบงาน</th>
                <th className="whitespace-nowrap px-3 py-4 text-center">มอบหมาย</th>
                <th className="whitespace-nowrap px-3 py-4 text-center">พนักงาน</th>
                <th className="whitespace-nowrap px-1.5 py-4 text-center text-[13px]">หยิบแล้ว</th>
                <th className="whitespace-nowrap px-1.5 py-4 text-center text-[13px] text-red-500">หยิบผิด</th>
                <th className="whitespace-nowrap px-1.5 py-4 text-center text-[13px] text-orange-500">ไม่พบ</th>
                <th className="whitespace-nowrap px-1.5 py-4 text-center text-[13px] text-red-700">สินค้าหมด</th>
                <th className="whitespace-nowrap px-1.5 py-4 text-center text-[13px]">ทั้งหมด (หยิบ/รวม)</th>
                <th className="whitespace-nowrap px-3 py-4 text-center">สถานะ</th>
                <th className="whitespace-nowrap px-3 py-4 text-center">ระยะเวลาที่ใช้</th>
                <th className="whitespace-nowrap px-3 py-4 text-center">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y text-gray-600">
              {orders.map((o) => {
                const isWorking = o.items.some((i: any) => ['pending', 'wrong', 'not_find'].includes(i.status))
                const isFullyCancelled = o.total === 0 && o.cancelled_count > 0
                const calculation = o.picked_count - o.wrong_count - o.not_find_count
                const cellClass = 'p-4 text-[16px]'

                return (
                  <tr key={o.rowKey} className="hover:bg-blue-50 border-b transition">
                    <td className={`${cellClass} font-black text-blue-600`}>
                      <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                        <span>{o.display_name}</span>
                      {o.work_order_id && (cancelledByWorkOrder[o.work_order_id]?.length || 0) > 0 && (
                        <button
                          type="button"
                          onClick={() => setCancelledModal({ workOrderId: o.work_order_id, displayName: o.display_name })}
                          className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700 hover:bg-red-100"
                        >
                          <span>ยกเลิกบิล</span>
                          <span>{cancelledByWorkOrder[o.work_order_id].length}</span>
                        </button>
                      )}
                      </div>
                    </td>
                    <td className={`${cellClass} text-center text-gray-500 text-xs`}>
                      {new Date(o.date).toLocaleString('th-TH')}
                    </td>
                    <td className={`${cellClass} text-center font-bold text-slate-700`}>{o.assigned}</td>
                    <td className="w-[72px] px-2 py-4 text-center text-[16px] font-bold text-blue-600">{o.picked_count}</td>
                    <td className="w-[72px] px-2 py-4 text-center text-[16px] font-bold text-red-600">{o.wrong_count}</td>
                    <td className="w-[68px] px-2 py-4 text-center text-[16px] font-bold text-orange-600">{o.not_find_count}</td>
                    <td className="w-[78px] px-2 py-4 text-center text-[16px] font-bold text-red-800">{o.oos_count}</td>
                    <td className="w-[112px] px-2 py-4 text-center text-[16px] font-bold text-gray-500">
                      {calculation} / {o.total}
                    </td>
                    <td className={`${cellClass} text-center`}>
                      <span
                        className={`px-3 py-1 rounded text-xs font-bold uppercase ${
                          isFullyCancelled
                            ? 'bg-red-100 text-red-700'
                            : !isWorking ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {isFullyCancelled ? 'ยกเลิกแล้ว' : !isWorking ? 'เสร็จแล้ว' : 'กำลังดำเนินการ'}
                      </span>
                    </td>
                    <td className={`${cellClass} text-center font-mono text-blue-600 font-bold`}>
                      {(() => {
                        const key = o.rowKey
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
                      <button
                        onClick={() => openDetailModal(o.work_order_id, o.display_name)}
                        className="text-blue-500 font-bold underline"
                      >
                        ดูรายละเอียด
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      </section>

      {isModalOpen && detailScope && (
        <OrderDetailModal
          workOrderId={detailScope.workOrderId}
          orderDisplayName={detailScope.displayName}
          onClose={() => {
            setIsModalOpen(false)
            setDetailScope(null)
            loadOrdersDashboard()
          }}
        />
      )}
      <CancelledBillStockModal
        open={!!cancelledModal}
        workOrderId={cancelledModal?.workOrderId || null}
        displayName={cancelledModal?.displayName || ''}
        cancelledBills={cancelledModal ? cancelledByWorkOrder[cancelledModal.workOrderId] || [] : []}
        onClose={() => setCancelledModal(null)}
        onChanged={loadOrdersDashboard}
      />
    </>
  )
}
