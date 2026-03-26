import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../lib/supabase'
import { formatDuration, WMS_FULFILLMENT_PICK_OR_LEGACY } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

type RowKpiStatus = 'valid' | 'mixed_returned' | 'returned_only' | 'no_items' | 'no_first_check'

export default function KPISection() {
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [selectedUser, setSelectedUser] = useState('')
  const [users, setUsers] = useState<any[]>([])
  const [kpiData, setKpiData] = useState<any[]>([])
  const [kpiStats, setKpiStats] = useState<any | null>(null)
  const [kpiDataForExport, setKpiDataForExport] = useState<any[]>([])
  const { showMessage, MessageModal } = useWmsModal()

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    setDateStart(today)
    setDateEnd(today)
    loadUsers()
  }, [])

  const loadUsers = async () => {
    const { data } = await supabase.from('us_users').select('*').order('username')
    if (data) {
      setUsers(data.filter((u) => u.role === 'picker'))
    }
  }

  const loadKPI = async () => {
    let q = supabase
      .from('wms_order_summaries')
      .select('*, us_users!picker_id(username)')
      .gte('checked_at', dateStart + 'T00:00:00')
      .lte('checked_at', dateEnd + 'T23:59:59')

    if (selectedUser) {
      q = q.eq('picker_id', selectedUser)
    }

    const { data: summaries } = await q.order('checked_at', { ascending: false })

    if (!summaries || summaries.length === 0) {
      setKpiData([])
      setKpiStats(null)
      setKpiDataForExport([])
      return
    }

    const orderIds = summaries.map((s: any) => s.order_id)
    const { data: orderTimes } = await supabase
      .from('wms_orders')
      .select('order_id, created_at, end_time, status')
      .in('order_id', orderIds)
      .or(WMS_FULFILLMENT_PICK_OR_LEGACY)

    const orderAggMap: Record<string, { start: Date; end: Date | null; returnedCount: number; nonReturnedCount: number }> = {}
    if (orderTimes) {
      orderTimes.forEach((ot: any) => {
        if (!orderAggMap[ot.order_id]) {
          orderAggMap[ot.order_id] = {
            start: new Date(ot.created_at),
            end: ot.end_time ? new Date(ot.end_time) : null,
            returnedCount: 0,
            nonReturnedCount: 0,
          }
        }
        const currentStart = new Date(ot.created_at)
        const currentEnd = ot.end_time ? new Date(ot.end_time) : null
        if (currentStart < orderAggMap[ot.order_id].start) orderAggMap[ot.order_id].start = currentStart
        const existingEnd = orderAggMap[ot.order_id].end
        if (currentEnd && (!existingEnd || currentEnd > existingEnd)) {
          orderAggMap[ot.order_id].end = currentEnd
        }
        if (ot.status === 'returned') {
          orderAggMap[ot.order_id].returnedCount++
        } else {
          orderAggMap[ot.order_id].nonReturnedCount++
        }
      })
    }

    let stats = {
      totalOrders: summaries.length,
      sumCorrect: 0,
      sumWrong: 0,
      sumNotFind: 0,
      sumAccuracy: 0,
      accuracyDenominatorCount: 0,
      totalPickingMs: 0,
      countWithTime: 0,
    }

    const exportData: any[] = []
    const tableData = summaries.map((s: any) => {
      stats.sumCorrect += s.correct_at_first_check
      stats.sumWrong += s.wrong_at_first_check
      stats.sumNotFind += s.not_find_at_first_check
      const firstCheckCount =
        (Number(s.correct_at_first_check) || 0) +
        (Number(s.wrong_at_first_check) || 0) +
        (Number(s.not_find_at_first_check) || 0)
      const totalItems = Number(s.total_items) || 0
      const orderAgg = orderAggMap[s.order_id]
      const returnedCount = orderAgg?.returnedCount || 0
      const nonReturnedCount = orderAgg?.nonReturnedCount || 0
      const isReturnedOnly = returnedCount > 0 && nonReturnedCount === 0
      const hasReturned = returnedCount > 0
      const hasFirstCheck = firstCheckCount > 0
      const isNoItems = totalItems <= 0

      let rowKpiStatus: RowKpiStatus = 'valid'
      if (isNoItems) rowKpiStatus = 'no_items'
      else if (isReturnedOnly) rowKpiStatus = 'returned_only'
      else if (!hasFirstCheck) rowKpiStatus = 'no_first_check'
      else if (hasReturned) rowKpiStatus = 'mixed_returned'

      const includeInAccuracy = !isNoItems && !isReturnedOnly && hasFirstCheck
      if (includeInAccuracy) {
        stats.sumAccuracy += parseFloat(s.accuracy_percent)
        stats.accuracyDenominatorCount++
      }

      let durationText = '-'
      const times = orderAggMap[s.order_id]
      if (times && times.start && times.end) {
        const diff = times.end.getTime() - times.start.getTime()
        if (diff > 0) {
          durationText = formatDuration(diff)
          stats.totalPickingMs += diff
          stats.countWithTime++
        }
      }

      exportData.push({
        'ใบงาน (Order ID)': s.order_id,
        พนักงาน: s.us_users?.username || '-',
        รายการทั้งหมด: s.total_items,
        'หยิบถูก (First)': s.correct_at_first_check,
        'หยิบผิด (First)': s.wrong_at_first_check,
        'ไม่พบ (First)': s.not_find_at_first_check,
        'ความแม่นยำ (%)': s.accuracy_percent + '%',
        สถานะแถว: rowKpiStatus,
        นำไปคิดความแม่นยำ: includeInAccuracy ? 'ใช่' : 'ไม่ใช่',
        เวลาหยิบสินค้า: durationText,
        วันที่ตรวจเสร็จ: new Date(s.checked_at).toLocaleString('th-TH'),
      })

      return {
        ...s,
        durationText,
        username: s.us_users?.username || '-',
        rowKpiStatus,
        includeInAccuracy,
      }
    })

    const avgAccuracy = stats.accuracyDenominatorCount > 0
      ? (stats.sumAccuracy / stats.accuracyDenominatorCount).toFixed(2)
      : '0.00'
    const avgPickingTime = stats.countWithTime > 0 ? formatDuration(stats.totalPickingMs / stats.countWithTime) : '00:00:00'

    setKpiStats({
      ...stats,
      avgAccuracy,
      avgPickingTime,
    })
    setKpiData(tableData)
    setKpiDataForExport(exportData)
  }

  const exportKPIToExcel = () => {
    if (kpiDataForExport.length === 0) {
      showMessage({ message: 'ไม่มีข้อมูลสำหรับการดาวน์โหลด กรุณากดค้นหาก่อน!' })
      return
    }

    const ws = XLSX.utils.json_to_sheet(kpiDataForExport)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'KPI_Performance')
    const fileName = `KPI_Report_${new Date().toISOString().split('T')[0]}.xlsx`
    XLSX.writeFile(wb, fileName)
  }

  return (
    <section>
      <h2 className="text-3xl font-black mb-6 text-slate-800">KPI Performance</h2>
      <div className="bg-white p-6 rounded-2xl shadow-sm border mb-8 flex gap-4 items-end flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <label className="text-sm font-bold text-gray-700 uppercase block mb-1">วันที่เริ่มต้น</label>
          <input
            type="date"
            value={dateStart}
            onChange={(e) => setDateStart(e.target.value)}
            className="w-full border px-2 rounded-lg text-sm h-[42px]"
          />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="text-sm font-bold text-gray-700 uppercase block mb-1">วันที่สิ้นสุด</label>
          <input
            type="date"
            value={dateEnd}
            onChange={(e) => setDateEnd(e.target.value)}
            className="w-full border px-2 rounded-lg text-sm h-[42px]"
          />
        </div>
        <div className="w-64 min-w-[200px]">
          <label className="text-sm font-bold text-gray-700 uppercase block mb-1">เลือก User</label>
          <select
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
            className="w-full border px-2.5 rounded-lg text-sm h-[42px]"
          >
            <option value="">ทั้งหมด</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username || u.id}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadKPI}
            className="bg-blue-600 text-white px-8 h-[42px] rounded-lg font-bold shadow-md hover:bg-blue-700 transition"
          >
            ค้นหา
          </button>
          <button
            onClick={exportKPIToExcel}
            className="bg-green-600 text-white px-6 h-[42px] rounded-lg font-bold shadow-md hover:bg-green-700 transition flex items-center gap-2"
          >
            <i className="fas fa-file-excel"></i> ดาวน์โหลด Excel
          </button>
        </div>
      </div>

      {kpiStats && (
        <div className="grid grid-cols-6 gap-4 mb-8">
          <div className="bg-blue-600 text-white p-5 rounded-2xl text-center shadow-md">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">ใบงานที่ตรวจแล้ว</div>
            <div className="text-3xl font-black">{kpiStats.totalOrders}</div>
          </div>
          <div className="bg-green-500 text-white p-5 rounded-2xl text-center shadow-md">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">หยิบถูกรวม</div>
            <div className="text-3xl font-black">{kpiStats.sumCorrect}</div>
          </div>
          <div className="bg-red-500 text-white p-5 rounded-2xl text-center shadow-md">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">หยิบผิดรวม</div>
            <div className="text-3xl font-black">{kpiStats.sumWrong}</div>
          </div>
          <div className="bg-orange-500 text-white p-5 rounded-2xl text-center shadow-md">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">ไม่เจอรอบแรก</div>
            <div className="text-3xl font-black">{kpiStats.sumNotFind}</div>
          </div>
          <div className="bg-slate-700 text-white p-5 rounded-2xl text-center shadow-md">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">ความแม่นยำเฉลี่ย</div>
            <div className="text-3xl font-black">{kpiStats.avgAccuracy}%</div>
          </div>
          <div className="bg-indigo-600 text-white p-5 rounded-2xl text-center shadow-md border-l-4 border-indigo-300">
            <div className="text-[16px] font-bold uppercase opacity-80 mb-1">เฉลี่ยเวลาหยิบ</div>
            <div className="text-2xl font-mono font-black">{kpiStats.avgPickingTime}</div>
          </div>
        </div>
      )}

      <div className="bg-white p-6 rounded-2xl shadow-sm border overflow-hidden">
        <h3 className="font-bold text-slate-800 mb-4">รายละเอียดข้อมูลจากการกรอง</h3>
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-[16px] uppercase text-slate-600 font-bold border-b">
            <tr>
              <th className="p-4">Order ID (ใบงาน)</th>
              <th className="p-4">พนักงานจัด</th>
              <th className="p-4 text-center">รายการ</th>
              <th className="p-4 text-center text-green-600">ถูก (First)</th>
              <th className="p-4 text-center text-red-600">ผิด (First)</th>
              <th className="p-4 text-center text-orange-600">ไม่พบ (First)</th>
              <th className="p-4 text-center">สถานะแถว</th>
              <th className="p-4 text-center">ความแม่นยำ</th>
              <th className="p-4 text-center text-blue-600">เวลาหยิบสินค้า</th>
              <th className="p-4">วันที่ตรวจเสร็จ</th>
            </tr>
          </thead>
          <tbody className="divide-y text-gray-600">
            {kpiData.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-10 text-center italic text-gray-400">
                  {kpiStats === null ? 'กรุณากดค้นหาเพื่อดูข้อมูล' : 'ไม่มีข้อมูลในช่วงเวลาที่เลือก'}
                </td>
              </tr>
            ) : (
              kpiData.map((s) => (
                <tr key={s.id} className="border-b hover:bg-gray-50 transition">
                  <td className="p-4 text-[16px] font-bold text-blue-600">{s.order_id}</td>
                  <td className="p-4 text-[16px]">{s.username}</td>
                  <td className="p-4 text-[16px] text-center">{s.total_items}</td>
                  <td className="p-4 text-[16px] text-center text-green-600 font-bold">{s.correct_at_first_check}</td>
                  <td className="p-4 text-[16px] text-center text-red-600 font-bold">{s.wrong_at_first_check}</td>
                  <td className="p-4 text-[16px] text-center text-orange-500 font-bold">{s.not_find_at_first_check}</td>
                  <td className="p-4 text-[16px] text-center">
                    <span className={`px-2 py-1 rounded-lg font-black ${
                      s.rowKpiStatus === 'valid'
                        ? 'bg-green-100 text-green-700'
                        : s.rowKpiStatus === 'mixed_returned'
                          ? 'bg-blue-100 text-blue-700'
                          : s.rowKpiStatus === 'returned_only'
                            ? 'bg-slate-100 text-slate-700'
                            : s.rowKpiStatus === 'no_items'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-orange-100 text-orange-700'
                    }`}>
                      {s.rowKpiStatus === 'valid'
                        ? 'ตรวจจริง'
                        : s.rowKpiStatus === 'mixed_returned'
                          ? 'Mixed (correct+returned)'
                          : s.rowKpiStatus === 'returned_only'
                            ? 'มีรายการคืนคลัง'
                            : s.rowKpiStatus === 'no_items'
                              ? 'ไม่มีรายการ'
                              : 'ไม่เข้าเกณฑ์ KPI'}
                    </span>
                  </td>
                  <td className="p-4 text-[16px] text-center">
                    <span className={`px-2 py-1 rounded-lg font-black ${
                      s.includeInAccuracy
                        ? (s.accuracy_percent >= 90 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')
                        : 'bg-gray-100 text-gray-500'
                    }`}>
                      {s.accuracy_percent}%
                    </span>
                  </td>
                  <td className="p-4 text-[16px] text-center font-mono font-bold text-blue-700">{s.durationText}</td>
                  <td className="p-4 text-[16px] text-gray-400 text-xs">
                    {new Date(s.checked_at).toLocaleString('th-TH')}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {MessageModal}
    </section>
  )
}
