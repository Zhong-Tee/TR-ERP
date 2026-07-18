import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDateTime } from '../../lib/utils'
import UrgencyBadge from '../common/UrgencyBadge'
import MarketplaceOrderModal from './MarketplaceOrderModal'
import type { User } from '../../types'
import type { MpChannelConfig, MpOrder, MpOrderStatus, MpSalesUser } from '../../types/marketplace'

const STATUS_TITLES: Record<Exclude<MpOrderStatus, 'new'>, string> = {
  assigned: 'งานที่มอบหมายแล้ว',
  follow_up: 'รอติดตาม',
  done: 'เสร็จสิ้น (เปิดบิลแล้ว)',
  cancelled: 'ยกเลิกบิล',
}

export default function MarketplaceWorkList({
  status,
  user,
  isAdmin,
  salesUsers,
  refreshKey,
  onChanged,
}: {
  status: Exclude<MpOrderStatus, 'new'>
  user: User
  isAdmin: boolean
  configs: MpChannelConfig[]
  salesUsers: MpSalesUser[]
  refreshKey: number
  onChanged: () => void
}) {
  const [orders, setOrders] = useState<MpOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [filterUser, setFilterUser] = useState('')
  const [openOrder, setOpenOrder] = useState<MpOrder | null>(null)

  const userById = useMemo(() => {
    const m = new Map<string, MpSalesUser>()
    salesUsers.forEach((u) => m.set(u.id, u))
    return m
  }, [salesUsers])

  const loadOrders = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('mp_orders')
        .select('*')
        .eq('status', status)
        .order(status === 'done' ? 'billed_at' : status === 'cancelled' ? 'cancelled_at' : 'assigned_at', {
          ascending: false,
        })
      // sales ถูกจำกัดด้วย RLS อยู่แล้ว — filter เพิ่มเฉพาะ admin ที่เลือกกรอง
      if (isAdmin && filterUser) query = query.eq('assigned_to', filterUser)
      const { data, error } = await query
      if (error) throw error
      setOrders((data || []) as MpOrder[])
    } catch (err) {
      console.error('Error loading mp_orders:', err)
    } finally {
      setLoading(false)
    }
  }, [status, isAdmin, filterUser])

  useEffect(() => {
    loadOrders()
  }, [loadOrders, refreshKey])

  const readOnly = status === 'done' || status === 'cancelled'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-slate-800 mr-auto">{STATUS_TITLES[status]}</h2>
        {isAdmin && (
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2"
          >
            <option value="">ผู้รับผิดชอบ: ทั้งหมด</option>
            {salesUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username || u.email}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">เลขคำสั่งซื้อ</th>
                <th className="text-left px-4 py-3">ช่องทาง</th>
                <th className="text-left px-4 py-3">ผู้ซื้อ</th>
                <th className="text-left px-4 py-3">เวลาชำระเงิน</th>
                <th className="text-left px-4 py-3">ผู้รับผิดชอบ</th>
                <th className="text-left px-4 py-3">วันที่ Assign</th>
                {status === 'follow_up' && <th className="text-left px-4 py-3">โน้ตติดตาม</th>}
                {status === 'done' && <th className="text-left px-4 py-3">เลขบิล</th>}
                {status === 'done' && <th className="text-left px-4 py-3">เปิดบิลเมื่อ</th>}
                {status === 'cancelled' && <th className="text-left px-4 py-3">เหตุผลยกเลิก</th>}
                {status === 'cancelled' && <th className="text-left px-4 py-3">ยกเลิกเมื่อ</th>}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">กำลังโหลด...</td>
                </tr>
              )}
              {!loading && orders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">ไม่มีรายการ</td>
                </tr>
              )}
              {!loading &&
                orders.map((o) => {
                  const assignee = o.assigned_to ? userById.get(o.assigned_to) : null
                  return (
                    <tr
                      key={o.id}
                      className="border-t border-surface-100 cursor-pointer hover:bg-blue-50/40"
                      onClick={() => setOpenOrder(o)}
                    >
                      <td className="px-4 py-3 font-semibold text-slate-800 whitespace-nowrap">
                        <span className="mr-2">{o.marketplace_order_no}</span>
                        <UrgencyBadge order={o} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">
                          {o.channel_code}
                        </span>
                      </td>
                      <td className="px-4 py-3">{o.buyer_username || '-'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {o.payment_time ? formatDateTime(o.payment_time) : '-'}
                      </td>
                      <td className="px-4 py-3">
                        {assignee ? assignee.username || assignee.email : o.assigned_to ? '...' : '-'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {o.assigned_at ? formatDateTime(o.assigned_at) : '-'}
                      </td>
                      {status === 'follow_up' && (
                        <td className="px-4 py-3 max-w-[240px] truncate text-purple-700">
                          {o.follow_up_note || '-'}
                        </td>
                      )}
                      {status === 'done' && (
                        <td className="px-4 py-3 font-semibold text-green-700 whitespace-nowrap">
                          {o.billed_bill_no || '-'}
                        </td>
                      )}
                      {status === 'done' && (
                        <td className="px-4 py-3 whitespace-nowrap">
                          {o.billed_at ? formatDateTime(o.billed_at) : '-'}
                        </td>
                      )}
                      {status === 'cancelled' && (
                        <td className="px-4 py-3 max-w-[240px] truncate text-red-700">{o.cancel_note || '-'}</td>
                      )}
                      {status === 'cancelled' && (
                        <td className="px-4 py-3 whitespace-nowrap">
                          {o.cancelled_at ? formatDateTime(o.cancelled_at) : '-'}
                        </td>
                      )}
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </div>

      {openOrder && (
        <MarketplaceOrderModal
          mpOrder={openOrder}
          readOnly={readOnly}
          user={user}
          onClose={() => setOpenOrder(null)}
          onChanged={() => {
            onChanged()
            loadOrders()
          }}
        />
      )}
    </div>
  )
}
