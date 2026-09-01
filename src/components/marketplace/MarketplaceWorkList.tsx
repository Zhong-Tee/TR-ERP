import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiArrowDown, FiArrowUp, FiMinus } from 'react-icons/fi'
import { supabase } from '../../lib/supabase'
import { parseBangkokDateTime } from '../../lib/marketplaceImport'
import { computeDueTimestamps } from '../../lib/shipDueBadge'
import { formatDateTime } from '../../lib/utils'
import UrgencyBadge from '../common/UrgencyBadge'
import MarketplaceOrderModal from './MarketplaceOrderModal'
import { useWmsModal } from '../wms/useWmsModal'
import type { User } from '../../types'
import type { MpChannelConfig, MpOrder, MpOrderStatus, MpSalesUser } from '../../types/marketplace'

const STATUS_TITLES: Record<Exclude<MpOrderStatus, 'new'>, string> = {
  assigned: 'งานที่มอบหมายแล้ว',
  follow_up: 'รอติดตาม',
  done: 'เสร็จสิ้น (เปิดบิลแล้ว)',
  cancelled: 'ยกเลิกบิล',
}

const PAYMENT_SORT_TITLES = {
  none: 'คลิกเพื่อเรียงตามเวลาชำระเงิน (เก่าไปใหม่)',
  asc: 'เรียงเวลาชำระเงินเก่าไปใหม่ (คลิกเพื่อเรียงใหม่ไปเก่า)',
  desc: 'เรียงเวลาชำระเงินใหม่ไปเก่า (คลิกเพื่อยกเลิกการเรียง)',
} as const

export default function MarketplaceWorkList({
  status,
  user,
  isAdmin,
  canAssign,
  configs,
  salesUsers,
  users,
  refreshKey,
  onChanged,
}: {
  status: Exclude<MpOrderStatus, 'new'>
  user: User
  isAdmin: boolean
  canAssign: boolean
  configs: MpChannelConfig[]
  salesUsers: MpSalesUser[]
  users: MpSalesUser[]
  refreshKey: number
  onChanged: () => void
}) {
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [orders, setOrders] = useState<MpOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [filterUser, setFilterUser] = useState('')
  const [filterChannel, setFilterChannel] = useState('')
  /** null = เรียงตามค่าเริ่มต้นของแท็บ (วันที่ assign/เปิดบิล/ยกเลิก ล่าสุดก่อน) */
  const [paymentSort, setPaymentSort] = useState<'asc' | 'desc' | null>(null)
  const [search, setSearch] = useState('')
  const [draftOnly, setDraftOnly] = useState(false)
  const [openOrder, setOpenOrder] = useState<MpOrder | null>(null)
  const [repairingPaymentTimes, setRepairingPaymentTimes] = useState(false)
  const [repairingOrderTotals, setRepairingOrderTotals] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkAssigneeId, setBulkAssigneeId] = useState('')
  const [bulkAssigning, setBulkAssigning] = useState(false)
  const canFilterAssignee = canAssign
  const canBulkAssign = status === 'assigned' && canAssign
  const assignableUsers = useMemo(() => salesUsers.filter((candidate) => candidate.role !== 'sales-pump'), [salesUsers])

  const userById = useMemo(() => {
    const m = new Map<string, MpSalesUser>()
    users.forEach((u) => m.set(u.id, u))
    return m
  }, [users])

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
      // แถบ Assign ของผู้ใช้ทั่วไป = งานที่รับผิดชอบเอง + งานที่ตนเป็นผู้มอบหมาย
      // superadmin เห็นงานที่ Assign ทั้งหมดของทุกคน
      if (status === 'assigned' && user.role !== 'superadmin') {
        query = query.or(`assigned_to.eq.${user.id},assigned_by.eq.${user.id}`)
      }
      const { data, error } = await query
      if (error) throw error
      setOrders((data || []) as MpOrder[])
    } catch (err) {
      console.error('Error loading mp_orders:', err)
    } finally {
      setLoading(false)
    }
  }, [status, user.id, user.role])

  useEffect(() => {
    loadOrders()
  }, [loadOrders, refreshKey])

  /** ช่องทางที่เลือกกรองได้ — เอาเฉพาะที่มีจริงในรายการของแท็บนี้ */
  const channelOptions = useMemo(() => {
    const codes = new Set<string>()
    orders.forEach((o) => {
      if (o.channel_code) codes.add(o.channel_code)
    })
    return [...codes].sort((a, b) => a.localeCompare(b))
  }, [orders])

  // ช่องทางที่เลือกไว้หายไปจากรายการ (เช่นโหลดใหม่แล้วไม่มีงานช่องทางนั้น) → ล้างตัวกรอง
  useEffect(() => {
    if (filterChannel && !channelOptions.includes(filterChannel)) setFilterChannel('')
  }, [channelOptions, filterChannel])

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = orders.filter((o) => {
      if (filterUser && o.assigned_to !== filterUser) return false
      if (draftOnly && !o.draft_saved_at) return false
      if (filterChannel && o.channel_code !== filterChannel) return false
      if (!q) return true
      const assignee = o.assigned_to ? userById.get(o.assigned_to) : null
      return [
        o.marketplace_order_no,
        o.buyer_username,
        o.channel_code,
        o.recipient_name,
        o.phone,
        o.tracking_no,
        o.express_receipt_number,
        o.follow_up_note,
        o.cancel_note,
        o.billed_bill_no,
        assignee?.username,
        assignee?.email,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
    if (!paymentSort) return rows
    // ไม่มีเวลาชำระเงิน → ไว้ท้ายสุดเสมอ ไม่ว่าจะเรียงทางไหน
    return [...rows].sort((a, b) => {
      const ta = a.payment_time ? new Date(a.payment_time).getTime() : null
      const tb = b.payment_time ? new Date(b.payment_time).getTime() : null
      if (ta == null || tb == null) return ta == null ? (tb == null ? 0 : 1) : -1
      return paymentSort === 'asc' ? ta - tb : tb - ta
    })
  }, [orders, search, draftOnly, filterChannel, filterUser, paymentSort, userById])

  const readOnly = status === 'done' || status === 'cancelled'
  const selectedCount = useMemo(
    () => orders.reduce((count, order) => count + (selectedIds.has(order.id) ? 1 : 0), 0),
    [orders, selectedIds],
  )
  const allVisibleSelected = canBulkAssign
    && filteredOrders.length > 0
    && filteredOrders.every((order) => selectedIds.has(order.id))

  function toggleSelected(orderId: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }

  function selectAllVisible() {
    setSelectedIds((current) => {
      const next = new Set(current)
      filteredOrders.forEach((order) => next.add(order.id))
      return next
    })
  }

  function clearAllSelected() {
    setSelectedIds(new Set())
  }

  async function handleBulkAssign() {
    if (!canBulkAssign || selectedCount === 0) return
    const target = assignableUsers.find((candidate) => candidate.id === bulkAssigneeId)
    if (!target) {
      showMessage({ message: 'กรุณาเลือกผู้รับผิดชอบคนใหม่' })
      return
    }
    const selectedOrderIds = orders.filter((order) => selectedIds.has(order.id)).map((order) => order.id)
    if (selectedOrderIds.length === 0) return
    const confirmed = await showConfirm({
      title: 'เปลี่ยนผู้รับผิดชอบหลายรายการ',
      message: `เปลี่ยนผู้รับผิดชอบ ${selectedOrderIds.length} งาน เป็น “${target.username || target.email}” ใช่หรือไม่?`,
      confirmText: 'เปลี่ยนผู้รับผิดชอบ',
    })
    if (!confirmed) return

    setBulkAssigning(true)
    try {
      let affected = 0
      const assignedAt = new Date().toISOString()
      for (let index = 0; index < selectedOrderIds.length; index += 200) {
        const ids = selectedOrderIds.slice(index, index + 200)
        const { data, error } = await supabase
          .from('mp_orders')
          .update({
            assigned_to: target.id,
            assigned_by: user.id,
            assigned_at: assignedAt,
          })
          .in('id', ids)
          .eq('status', 'assigned')
          .select('id')
        if (error) throw error
        affected += (data || []).length
      }
      clearAllSelected()
      setBulkAssigneeId('')
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      onChanged()
      await loadOrders()
      showMessage({ title: 'เปลี่ยนผู้รับผิดชอบแล้ว', message: `อัปเดตสำเร็จ ${affected} งาน` })
    } catch (err) {
      showMessage({ title: 'เปลี่ยนผู้รับผิดชอบไม่สำเร็จ', message: (err as Error).message })
    } finally {
      setBulkAssigning(false)
    }
  }

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
        <h2 className="text-xl font-bold text-slate-800 mr-auto">
          {STATUS_TITLES[status]}
          {status === 'assigned' && (
            <span className="ml-2 inline-flex min-w-7 h-7 px-2 items-center justify-center rounded-full bg-orange-500 text-white text-sm font-bold align-middle">
              {orders.length}
            </span>
          )}
        </h2>
        {canBulkAssign && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2">
            <span className="text-sm font-semibold text-green-800">เลือกแล้ว {selectedCount}</span>
            <button
              type="button"
              onClick={selectAllVisible}
              disabled={filteredOrders.length === 0 || allVisibleSelected}
              className="px-3 py-1.5 rounded-lg border border-green-300 bg-white text-green-700 font-medium hover:bg-green-100 disabled:opacity-40"
            >
              ทั้งหมด
            </button>
            <button
              type="button"
              onClick={clearAllSelected}
              disabled={selectedCount === 0}
              className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              ล้าง
            </button>
            <select
              value={bulkAssigneeId}
              onChange={(event) => setBulkAssigneeId(event.target.value)}
              className="border border-green-300 rounded-lg bg-white px-3 py-1.5 min-w-[190px]"
            >
              <option value="">— ผู้รับผิดชอบคนใหม่ —</option>
              {assignableUsers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.username || candidate.email}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleBulkAssign}
              disabled={bulkAssigning || selectedCount === 0 || !bulkAssigneeId}
              className="px-4 py-1.5 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 disabled:opacity-40"
            >
              {bulkAssigning ? 'กำลังเปลี่ยน...' : 'เปลี่ยนผู้รับผิดชอบ'}
            </button>
          </div>
        )}
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
        <select
          value={filterChannel}
          onChange={(e) => setFilterChannel(e.target.value)}
          aria-label="กรองช่องทาง"
          className="border border-gray-300 rounded-lg px-3 py-2 w-full sm:w-auto sm:min-w-[180px]"
        >
          <option value="">— ทุกช่องทาง —</option>
          {channelOptions.map((code) => {
            const configName = configs.find((c) => c.channel_code === code)?.name
            return (
              <option key={code} value={code}>
                {configName ? `${configName} (${code})` : code}
              </option>
            )
          })}
        </select>
        {canFilterAssignee && (
          <select
            value={filterUser}
            onChange={(e) => setFilterUser(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2"
          >
            <option value="">ผู้รับผิดชอบ: ทั้งหมด</option>
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username || u.email}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1050px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                {canBulkAssign && (
                  <th className="px-3 py-3 w-12 text-center">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={(event) => event.target.checked ? selectAllVisible() : clearAllSelected()}
                      aria-label="เลือกงานทั้งหมดที่แสดง"
                      className="w-4 h-4 accent-green-600"
                    />
                  </th>
                )}
                <th className="text-left px-4 py-3">เลขคำสั่งซื้อ</th>
                <th className="text-left px-4 py-3">ช่องทาง</th>
                <th className="text-left px-4 py-3">ผู้ซื้อ</th>
                <th className="text-left px-4 py-3">
                  {/* คลิกวน: ค่าเริ่มต้นของแท็บ → เก่าไปใหม่ → ใหม่ไปเก่า → ค่าเริ่มต้น */}
                  <button
                    type="button"
                    onClick={() =>
                      setPaymentSort((prev) => (prev === null ? 'asc' : prev === 'asc' ? 'desc' : null))
                    }
                    title={PAYMENT_SORT_TITLES[paymentSort ?? 'none']}
                    aria-label={PAYMENT_SORT_TITLES[paymentSort ?? 'none']}
                    className={`inline-flex items-center gap-2 hover:text-blue-600 ${
                      paymentSort ? 'text-blue-600 font-semibold' : ''
                    }`}
                  >
                    เวลาชำระเงิน
                    {paymentSort === 'asc' ? (
                      <FiArrowUp className="w-4 h-4" />
                    ) : paymentSort === 'desc' ? (
                      <FiArrowDown className="w-4 h-4" />
                    ) : (
                      <FiMinus className="w-4 h-4" />
                    )}
                    {paymentSort && (
                      <span className="text-xs font-normal whitespace-nowrap">
                        {paymentSort === 'asc' ? 'เก่าไปใหม่' : 'ใหม่ไปเก่า'}
                      </span>
                    )}
                  </button>
                </th>
                <th className="text-left px-4 py-3">ผู้รับผิดชอบ</th>
                {status === 'assigned' && <th className="text-left px-4 py-3">ผู้มอบหมาย</th>}
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
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">กำลังโหลด...</td>
                </tr>
              )}
              {!loading && filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                    {search.trim() ? 'ไม่พบรายการที่ค้นหา' : 'ไม่มีรายการ'}
                  </td>
                </tr>
              )}
              {!loading &&
                filteredOrders.map((o) => {
                  const assignee = o.assigned_to ? userById.get(o.assigned_to) : null
                  const assigner = o.assigned_by ? userById.get(o.assigned_by) : null
                  return (
                    <tr
                      key={o.id}
                      className={`border-t border-surface-100 cursor-pointer hover:bg-blue-50/40 ${
                        selectedIds.has(o.id) ? 'bg-green-50/70' : ''
                      }`}
                      onClick={() => setOpenOrder(o)}
                    >
                      {canBulkAssign && (
                        <td className="px-3 py-3 text-center" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(o.id)}
                            onChange={() => toggleSelected(o.id)}
                            aria-label={`เลือกงาน ${o.marketplace_order_no}`}
                            className="w-4 h-4 accent-green-600"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-semibold text-slate-800 whitespace-nowrap">
                        <span className="mr-2">{o.marketplace_order_no}</span>
                        <UrgencyBadge order={o} />
                        {o.express_receipt_number && (
                          <div className="mt-1 font-mono text-xs font-semibold text-cyan-700">
                            รับด่วน: {o.express_receipt_number}
                          </div>
                        )}
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
                      {status === 'assigned' && (
                        <td className="px-4 py-3">
                          {assigner ? assigner.username || assigner.email : o.assigned_by ? '...' : '-'}
                        </td>
                      )}
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
          readOnly={readOnly || openOrder.assigned_to !== user.id}
          user={user}
          canAssign={canAssign && openOrder.assigned_to === user.id}
          salesUsers={salesUsers}
          onClose={() => setOpenOrder(null)}
          onChanged={() => {
            onChanged()
            loadOrders()
          }}
        />
      )}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
