import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import UrgencyBadge from '../common/UrgencyBadge'
import { getUrgencyBadge } from '../../lib/shipDueBadge'
import type { MpOrder, MpSalesUser } from '../../types/marketplace'

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

export default function MarketplaceDashboard({
  salesUsers,
  refreshKey,
}: {
  salesUsers: MpSalesUser[]
  refreshKey: number
}) {
  const [orders, setOrders] = useState<MpOrder[]>([])
  const [loading, setLoading] = useState(false)
  const now = useMemo(() => new Date(), [refreshKey])

  const userById = useMemo(() => {
    const m = new Map<string, MpSalesUser>()
    salesUsers.forEach((u) => m.set(u.id, u))
    return m
  }, [salesUsers])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.from('mp_orders').select('*')
      if (error) throw error
      setOrders((data || []) as MpOrder[])
    } catch (err) {
      console.error('Error loading dashboard:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

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

    for (const o of orders) {
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
  }, [orders, userById, now])

  const statCard = (label: string, value: number | string, color: string) => (
    <div className="bg-white rounded-xl border border-surface-200 shadow-soft px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold text-slate-800">ภาพรวมงาน Marketplace</h2>
        {loading && <span className="text-sm text-gray-400">กำลังโหลด...</span>}
      </div>

      {/* สรุปภาพรวม */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCard('รอมอบหมาย', totals.newCount, 'text-slate-800')}
        {statCard('กำลังทำ (ค้าง)', totals.open, 'text-blue-600')}
        {statCard('ส่งด่วน', totals.urgent, 'text-orange-600')}
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
                <th className="text-right px-4 py-3">ส่งด่วน</th>
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
              {orders
                .filter(
                  (o) =>
                    (o.status === 'assigned' || o.status === 'follow_up') &&
                    getUrgencyBadge(o, now) !== null,
                )
                .sort((a, b) => {
                  const rank = (o: MpOrder) => (getUrgencyBadge(o, now) === 'overdue' ? 0 : 1)
                  return rank(a) - rank(b)
                })
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
              {!loading &&
                orders.filter(
                  (o) => (o.status === 'assigned' || o.status === 'follow_up') && getUrgencyBadge(o, now) !== null,
                ).length === 0 && (
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
