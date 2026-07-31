import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { parseBangkokDateTime } from '../../lib/marketplaceImport'
import { computeDueTimestamps } from '../../lib/shipDueBadge'
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
  configs,
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
  const [search, setSearch] = useState('')
  const [draftOnly, setDraftOnly] = useState(false)
  const [openOrder, setOpenOrder] = useState<MpOrder | null>(null)
  const [repairingPaymentTimes, setRepairingPaymentTimes] = useState(false)
  const [repairingOrderTotals, setRepairingOrderTotals] = useState(false)

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

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (draftOnly && !o.draft_saved_at) return false
      if (!q) return true
      const assignee = o.assigned_to ? userById.get(o.assigned_to) : null
      return [
        o.marketplace_order_no,
        o.buyer_username,
        o.channel_code,
        o.recipient_name,
        o.phone,
        o.tracking_no,
        o.follow_up_note,
        o.cancel_note,
        o.billed_bill_no,
        assignee?.username,
        assignee?.email,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [orders, search, draftOnly, userById])

  const readOnly = status === 'done' || status === 'cancelled'

  const repairablePaymentTimes = useMemo(() => {
    return orders.flatMap((order) => {
      if (order.payment_time || !order.raw_snapshot) return []
      const rawValue = order.raw_snapshot['Paid Time'] ?? order.raw_snapshot['เวลาการชำระสินค้า']
      const paymentTime = parseBangkokDateTime(rawValue)
      return paymentTime ? [{ order, paymentTime }] : []
    })
  }, [orders])

  const repairableOrderTotals = useMemo(() => {
    return orders.flatMap((order) => {
      if (order.order_total != null || !order.raw_snapshot) return []
      const rawValue = order.raw_snapshot['Order Amount']
      if (rawValue == null || rawValue === '') return []
      const orderTotal = Number(String(rawValue).replace(/,/g, '').trim())
      return Number.isFinite(orderTotal) ? [{ order, orderTotal }] : []
    })
  }, [orders])

  async function repairPaymentTimes() {
    if (!isAdmin || repairablePaymentTimes.length === 0) return
    setRepairingPaymentTimes(true)
    try {
      for (const { order, paymentTime } of repairablePaymentTimes) {
        const rule = configs.find((config) => config.id === order.config_id)?.due_rule
        const due = computeDueTimestamps(paymentTime, rule)
        const { error } = await supabase
          .from('mp_orders')
          .update({ payment_time: paymentTime, ...due })
          .eq('id', order.id)
          .is('payment_time', null)
        if (error) throw error
      }
      await loadOrders()
      onChanged()
    } catch (err) {
      console.error('Error repairing marketplace payment times:', err)
    } finally {
      setRepairingPaymentTimes(false)
    }
  }

  async function repairOrderTotals() {
    if (!isAdmin || repairableOrderTotals.length === 0) return
    setRepairingOrderTotals(true)
    try {
      for (const { order, orderTotal } of repairableOrderTotals) {
        const { error } = await supabase
          .from('mp_orders')
          .update({ order_total: orderTotal })
          .eq('id', order.id)
          .is('order_total', null)
        if (error) throw error
      }
      await loadOrders()
      onChanged()
    } catch (err) {
      console.error('Error repairing marketplace order totals:', err)
    } finally {
      setRepairingOrderTotals(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold text-slate-800 mr-auto">{STATUS_TITLES[status]}</h2>
        {isAdmin && repairablePaymentTimes.length > 0 && (
          <button
            type="button"
            disabled={repairingPaymentTimes}
            onClick={repairPaymentTimes}
            className="px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            {repairingPaymentTimes
              ? 'กำลังซ่อมเวลา...'
              : `ซ่อมเวลาชำระเงิน (${repairablePaymentTimes.length})`}
          </button>
        )}
        {isAdmin && repairableOrderTotals.length > 0 && (
          <button
            type="button"
            disabled={repairingOrderTotals}
            onClick={repairOrderTotals}
            className="px-3 py-2 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 disabled:opacity-50"
          >
            {repairingOrderTotals
              ? 'กำลังซ่อมยอดรวม...'
              : `ซ่อมยอดรวมออเดอร์ (${repairableOrderTotals.length})`}
          </button>
        )}
        <button
          type="button"
          onClick={() => setDraftOnly((v) => !v)}
          title="กรองเฉพาะงานที่บันทึกร่างแล้ว"
          className={`px-3 py-2 rounded-lg border font-medium whitespace-nowrap transition-colors ${
            draftOnly
              ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
              : 'bg-white text-blue-600 border-blue-300 hover:bg-blue-50'
          }`}
        >
          บันทึกร่าง
        </button>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหา"
          className="border border-gray-300 rounded-lg px-3 py-2 w-full sm:w-80"
        />
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
              {!loading && filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                    {search.trim() ? 'ไม่พบรายการที่ค้นหา' : 'ไม่มีรายการ'}
                  </td>
                </tr>
              )}
              {!loading &&
                filteredOrders.map((o) => {
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
                        {o.draft_saved_at && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-blue-100 text-blue-700 border border-blue-300">
                            บันทึกร่าง
                          </span>
                        )}
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
          isAdmin={isAdmin}
          salesUsers={salesUsers}
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
