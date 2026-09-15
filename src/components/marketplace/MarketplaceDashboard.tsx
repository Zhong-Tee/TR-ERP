import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import UrgencyBadge from '../common/UrgencyBadge'
import { getUrgencyBadge } from '../../lib/shipDueBadge'
import type { MpOrder, MpSalesUser } from '../../types/marketplace'
import { fetchAllSupabasePages } from '../../lib/supabasePagination'

interface UserStat {
  userId: string | null
  name: string
  open: number // assigned + follow_up
  assigned: number
  followUp: number
  done: number
  cancelled: number
  urgent: number
  overdue: number
  oldestOpenHours: number | null // งานที่ค้างนานสุด (ชม.)
  avgHandleHours: number | null // เวลาเฉลี่ยจาก Assign → เปิดบิล (ชม.)
}

function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const t1 = new Date(a).getTime()
  const t2 = new Date(b).getTime()
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null
  return (t2 - t1) / 3_600_000
}

/** แปลงชั่วโมง (ทศนิยม) → รูปแบบ hh:mm (ชั่วโมงเกิน 24 ได้ เช่น 26:30) */
function fmtHours(h: number | null): string {
  if (h == null) return '-'
  const totalMinutes = Math.round(h * 60)
  const hh = Math.floor(totalMinutes / 60)
  const mm = totalMinutes % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function bangkokDateKey(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function orderDateKey(order: MpOrder): string | null {
  return bangkokDateKey(order.order_date || order.created_at)
}

const STATUS_LABEL: Record<MpOrder['status'], string> = {
  new: 'รอมอบหมาย',
  assigned: 'กำลังทำ',
  follow_up: 'รอติดตาม',
  done: 'เปิดบิลแล้ว',
  cancelled: 'ยกเลิก',
}

export default function MarketplaceDashboard({
  salesUsers,
  refreshKey,
}: {
  salesUsers: MpSalesUser[]
  refreshKey: number
}) {
  const [orders, setOrders] = useState<MpOrder[]>([])
  const [loading, setLoading] = useState(false)
  const today = useMemo(() => bangkokDateKey(new Date().toISOString()) || '', [])
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const now = useMemo(() => new Date(), [refreshKey])
  const invalidDateRange = !!fromDate && !!toDate && fromDate > toDate

  const userById = useMemo(() => {
    const m = new Map<string, MpSalesUser>()
    salesUsers.forEach((u) => m.set(u.id, u))
    return m
  }, [salesUsers])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (invalidDateRange) {
        setOrders([])
        return
      }

      const startAt = fromDate ? `${fromDate}T00:00:00+07:00` : null
      const endAt = toDate ? `${toDate}T23:59:59.999+07:00` : null
      let data: MpOrder[]

      if (!startAt && !endAt) {
        data = await fetchAllSupabasePages<MpOrder>((from, to) =>
          supabase.from('mp_orders').select('*').order('id', { ascending: true }).range(from, to)
        )
      } else {
        const [ordersWithOrderDate, ordersWithoutOrderDate] = await Promise.all([
          fetchAllSupabasePages<MpOrder>((from, to) => {
            let query = supabase
              .from('mp_orders')
              .select('*')
              .not('order_date', 'is', null)
              .order('id', { ascending: true })
            if (startAt) query = query.gte('order_date', startAt)
            if (endAt) query = query.lte('order_date', endAt)
            return query.range(from, to)
          }),
          fetchAllSupabasePages<MpOrder>((from, to) => {
            let query = supabase
              .from('mp_orders')
              .select('*')
              .is('order_date', null)
              .order('id', { ascending: true })
            if (startAt) query = query.gte('created_at', startAt)
            if (endAt) query = query.lte('created_at', endAt)
            return query.range(from, to)
          }),
        ])
        data = [...ordersWithOrderDate, ...ordersWithoutOrderDate]
          .sort((a, b) => a.id.localeCompare(b.id))
      }
      setOrders(data)
    } catch (err) {
      console.error('Error loading dashboard:', err)
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate, invalidDateRange])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const filteredOrders = useMemo(() => {
    if (invalidDateRange) return []
    if (!fromDate && !toDate) return orders
    return orders.filter((order) => {
      const date = orderDateKey(order)
      if (!date) return false
      return (!fromDate || date >= fromDate) && (!toDate || date <= toDate)
    })
  }, [orders, fromDate, toDate, invalidDateRange])

  const { userStats, totals } = useMemo(() => {
    const map = new Map<string, UserStat>()
    const ensure = (userId: string | null): UserStat => {
      const key = userId || '__unassigned__'
      let s = map.get(key)
      if (!s) {
        const u = userId ? userById.get(userId) : null
        s = {
          userId,
          name: u ? u.username || u.email : userId ? 'ผู้ใช้ที่ถูกลบ' : 'ยังไม่มอบหมาย',
          open: 0, assigned: 0, followUp: 0, done: 0, cancelled: 0,
          urgent: 0, overdue: 0, oldestOpenHours: null, avgHandleHours: null,
        }
        map.set(key, s)
      }
      return s
    }

    const totals = { newCount: 0, open: 0, done: 0, cancelled: 0, urgent: 0, overdue: 0 }
    const handleHoursByUser = new Map<string, number[]>()

    for (const o of filteredOrders) {
      if (o.status === 'new') {
        totals.newCount++
        continue
      }
      const s = ensure(o.assigned_to)
      if (o.status === 'assigned' || o.status === 'follow_up') {
        s.open++
        totals.open++
        if (o.status === 'assigned') s.assigned++
        else s.followUp++
        // ความเร่งด่วนของงานที่ยังค้าง
        const badge = getUrgencyBadge(o, now)
        if (badge === 'overdue') { s.overdue++; totals.overdue++ }
        else if (badge === 'urgent') { s.urgent++; totals.urgent++ }
        // อายุงานที่ค้าง (จากเวลา Assign)
        const age = hoursBetween(o.assigned_at, now.toISOString())
        if (age != null && (s.oldestOpenHours == null || age > s.oldestOpenHours)) s.oldestOpenHours = age
      } else if (o.status === 'done') {
        s.done++
        totals.done++
        const h = hoursBetween(o.assigned_at, o.billed_at)
        if (h != null && h >= 0) {
          const key = o.assigned_to || '__unassigned__'
          const arr = handleHoursByUser.get(key) || []
          arr.push(h)
          handleHoursByUser.set(key, arr)
        }
      } else if (o.status === 'cancelled') {
        s.cancelled++
        totals.cancelled++
      }
    }

    for (const [key, arr] of handleHoursByUser) {
      const s = map.get(key)
      if (s && arr.length) s.avgHandleHours = arr.reduce((a, b) => a + b, 0) / arr.length
    }

    const userStats = Array.from(map.values())
      .filter((s) => s.open + s.done + s.cancelled > 0)
      .sort((a, b) => b.open - a.open || b.done - a.done)

    return { userStats, totals }
  }, [filteredOrders, userById, now])

  const urgentOrders = useMemo(() => filteredOrders
    .filter(
      (order) =>
        (order.status === 'assigned' || order.status === 'follow_up') &&
        getUrgencyBadge(order, now) !== null,
    )
    .sort((a, b) => {
      const rank = (order: MpOrder) => (getUrgencyBadge(order, now) === 'overdue' ? 0 : 1)
      return rank(a) - rank(b)
    }), [filteredOrders, now])

  function exportExcel() {
    if (invalidDateRange || filteredOrders.length === 0) return

    const period = fromDate || toDate
      ? `${fromDate || 'ไม่จำกัด'} ถึง ${toDate || 'ไม่จำกัด'}`
      : 'ทั้งหมด'
    const workbook = XLSX.utils.book_new()
    const summarySheet = XLSX.utils.json_to_sheet([
      { รายการ: 'ช่วงวันที่ออเดอร์', จำนวน: period },
      { รายการ: 'รอมอบหมาย', จำนวน: totals.newCount },
      { รายการ: 'กำลังทำ (ค้าง)', จำนวน: totals.open },
      { รายการ: 'ส่งวันนี้', จำนวน: totals.urgent },
      { รายการ: 'ล่าช้า', จำนวน: totals.overdue },
      { รายการ: 'เปิดบิลแล้ว', จำนวน: totals.done },
      { รายการ: 'ยกเลิก', จำนวน: totals.cancelled },
    ])
    summarySheet['!cols'] = [{ wch: 24 }, { wch: 28 }]
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'ภาพรวม')

    const userSheet = XLSX.utils.json_to_sheet(userStats.map((stat) => ({
      ผู้รับผิดชอบ: stat.name,
      คงเหลือ: stat.open,
      รอติดตาม: stat.followUp,
      ส่งวันนี้: stat.urgent,
      ล่าช้า: stat.overdue,
      เสร็จแล้ว: stat.done,
      ยกเลิก: stat.cancelled,
      'ค้างนานสุด (ชม:นาที)': fmtHours(stat.oldestOpenHours),
      'เวลาเฉลี่ย/งาน (ชม:นาที)': fmtHours(stat.avgHandleHours),
    })))
    userSheet['!cols'] = [
      { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 24 }, { wch: 28 },
    ]
    XLSX.utils.book_append_sheet(workbook, userSheet, 'แยกตามผู้รับผิดชอบ')

    const orderSheet = XLSX.utils.json_to_sheet(filteredOrders.map((order) => {
      const user = order.assigned_to ? userById.get(order.assigned_to) : null
      const handleHours = order.status === 'done' ? hoursBetween(order.assigned_at, order.billed_at) : null
      return {
        วันที่ออเดอร์: orderDateKey(order) || '',
        เลขคำสั่งซื้อ: order.marketplace_order_no,
        ช่องทาง: order.channel_code,
        ผู้รับผิดชอบ: user ? user.username || user.email : '',
        สถานะ: STATUS_LABEL[order.status],
        ป้ายกำหนดส่ง: getUrgencyBadge(order, now) === 'overdue' ? 'ล่าช้า' : getUrgencyBadge(order, now) === 'urgent' ? 'ส่งวันนี้' : '',
        เลขบิล: order.billed_bill_no || '',
        'เวลาใช้ดำเนินการ (ชม:นาที)': fmtHours(handleHours),
        หมายเหตุยกเลิก: order.cancel_note || '',
      }
    }))
    orderSheet['!cols'] = [
      { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 24 }, { wch: 16 },
      { wch: 16 }, { wch: 20 }, { wch: 28 }, { wch: 32 },
    ]
    XLSX.utils.book_append_sheet(workbook, orderSheet, 'รายการงาน')

    XLSX.writeFile(workbook, `marketplace_dashboard_${fromDate || 'all'}_${toDate || 'all'}.xlsx`)
  }

  const statCard = (label: string, value: number | string, color: string) => (
    <div className="bg-white rounded-xl border border-surface-200 shadow-soft px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold text-slate-800">ภาพรวมงาน Marketplace</h2>
          {loading && <span className="text-sm text-gray-400">กำลังโหลด...</span>}
        </div>
        <button
          type="button"
          onClick={exportExcel}
          disabled={loading || invalidDateRange || filteredOrders.length === 0}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export Excel
        </button>
      </div>

      <div className="rounded-xl border border-surface-200 bg-white p-4 shadow-soft">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-gray-700">
            จากวันที่
            <input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="mt-1 block rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium text-gray-700">
            ถึงวันที่
            <input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="mt-1 block rounded-lg border border-surface-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          {(fromDate || toDate) && (
            <button
              type="button"
              onClick={() => { setFromDate(''); setToDate('') }}
              className="px-2 py-2 text-sm font-medium text-blue-600 hover:underline"
            >
              ล้างตัวกรอง
            </button>
          )}
          <p className="pb-2 text-xs text-gray-500">กรองตามวันที่ออเดอร์ หากไม่มีจะใช้วันที่นำเข้าระบบ</p>
        </div>
        {invalidDateRange && <p className="mt-2 text-sm text-red-600">วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด</p>}
      </div>

      {/* สรุปภาพรวม */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCard('รอมอบหมาย', totals.newCount, 'text-slate-800')}
        {statCard('กำลังทำ (ค้าง)', totals.open, 'text-blue-600')}
        {statCard('ส่งวันนี้', totals.urgent, 'text-blue-600')}
        {statCard('ล่าช้า', totals.overdue, 'text-red-600')}
        {statCard('เปิดบิลแล้ว', totals.done, 'text-green-600')}
        {statCard('ยกเลิก', totals.cancelled, 'text-gray-500')}
      </div>

      {/* ตารางรายคน */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100">
          <h3 className="font-bold text-slate-800">งานแยกตามผู้รับผิดชอบ</h3>
          <p className="text-xs text-gray-500">
            "ค้างนานสุด" = งานที่ยังไม่เสร็จและถูก Assign มานานสุด · "เวลาเฉลี่ย/งาน" = เวลาเฉลี่ยจาก Assign ถึงเปิดบิล (ยิ่งน้อยยิ่งเร็ว)
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">ผู้รับผิดชอบ</th>
                <th className="text-right px-4 py-3">คงเหลือ</th>
                <th className="text-right px-4 py-3">รอติดตาม</th>
                <th className="text-right px-4 py-3">ส่งวันนี้</th>
                <th className="text-right px-4 py-3">ล่าช้า</th>
                <th className="text-right px-4 py-3">เสร็จแล้ว</th>
                <th className="text-right px-4 py-3">ยกเลิก</th>
                <th className="text-right px-4 py-3">ค้างนานสุด (ชม:นาที)</th>
                <th className="text-right px-4 py-3">เวลาเฉลี่ย/งาน (ชม:นาที)</th>
              </tr>
            </thead>
            <tbody>
              {!loading && userStats.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-gray-400">ยังไม่มีงานที่มอบหมาย</td>
                </tr>
              )}
              {userStats.map((s) => (
                <tr key={s.userId || 'unassigned'} className="border-t border-surface-100">
                  <td className="px-4 py-3 font-semibold text-slate-800">{s.name}</td>
                  <td className="px-4 py-3 text-right font-bold text-blue-600">{s.open}</td>
                  <td className="px-4 py-3 text-right text-purple-600">{s.followUp}</td>
                  <td className="px-4 py-3 text-right text-orange-600">{s.urgent || '-'}</td>
                  <td className="px-4 py-3 text-right text-red-600">{s.overdue || '-'}</td>
                  <td className="px-4 py-3 text-right text-green-600">{s.done}</td>
                  <td className="px-4 py-3 text-right text-gray-400">{s.cancelled || '-'}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={s.oldestOpenHours != null && s.oldestOpenHours > 24 ? 'text-red-600 font-semibold' : 'text-gray-600'}>
                      {fmtHours(s.oldestOpenHours)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtHours(s.avgHandleHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* งานค้างที่ต้องรีบ (ล่าช้า/ส่งด่วน) */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-100">
          <h3 className="font-bold text-slate-800">งานค้างที่ต้องรีบดำเนินการ</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">เลขคำสั่งซื้อ</th>
                <th className="text-left px-4 py-3">ช่องทาง</th>
                <th className="text-left px-4 py-3">ผู้รับผิดชอบ</th>
                <th className="text-left px-4 py-3">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {urgentOrders
                .slice(0, 20)
                .map((o) => {
                  const u = o.assigned_to ? userById.get(o.assigned_to) : null
                  return (
                    <tr key={o.id} className="border-t border-surface-100">
                      <td className="px-4 py-3 font-semibold text-slate-800 whitespace-nowrap">
                        <span className="mr-2">{o.marketplace_order_no}</span>
                        <UrgencyBadge order={o} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">{o.channel_code}</span>
                      </td>
                      <td className="px-4 py-3">{u ? u.username || u.email : '-'}</td>
                      <td className="px-4 py-3">{o.status === 'follow_up' ? 'รอติดตาม' : 'กำลังทำ'}</td>
                    </tr>
                  )
                })}
              {!loading && urgentOrders.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-gray-400">ไม่มีงานเร่งด่วนค้างอยู่ 🎉</td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
