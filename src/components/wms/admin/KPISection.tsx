import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../lib/supabase'
import { formatDuration } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

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
      .select('order_id, created_at, end_time')
      .in('order_id', orderIds)

    const timeMap: Record<string, { start: Date; end: Date | null }> = {}
    if (orderTimes) {
      orderTimes.forEach((ot: any) => {
        if (!timeMap[ot.order_id]) {
          timeMap[ot.order_id] = { start: new Date(ot.created_at), end: ot.end_time ? new Date(ot.end_time) : null }
        }
        const currentStart = new Date(ot.created_at)
        const currentEnd = ot.end_time ? new Date(ot.end_time) : null
        if (currentStart < timeMap[ot.order_id].start) timeMap[ot.order_id].start = currentStart
        if (currentEnd && (!timeMap[ot.order_id].end || currentEnd > timeMap[ot.order_id].end)) {
          timeMap[ot.order_id].end = currentEnd
        }
      })
    }

    let stats = {
      totalOrders: summaries.length,
      sumCorrect: 0,
      sumWrong: 0,
      sumNotFind: 0,
      sumAccuracy: 0,
      totalPickingMs: 0,
      countWithTime: 0,
    }

    const exportData: any[] = []
    const tableData = summaries.map((s: any) => {
      stats.sumCorrect += s.correct_at_first_check
      stats.sumWrong += s.wrong_at_first_check
      stats.sumNotFind += s.not_find_at_first_check
      stats.sumAccuracy += parseFloat(s.accuracy_percent)

      let durationText = '-'
      const times = timeMap[s.order_id]
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
        เวลาหยิบสินค้า: durationText,
        วันที่ตรวจเสร็จ: new Date(s.checked_at).toLocaleString('th-TH'),
      })

      return {
        ...s,
        durationText,
        username: s.us_users?.username || '-',
      }
    })

    const avgAccuracy = stats.totalOrders > 0 ? (stats.sumAccuracy / stats.totalOrders).toFixed(2) : '0.00'
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
              <th className="p-4 text-center">ความแม่นยำ</th>
              <th className="p-4 text-center text-blue-600">เวลาหยิบสินค้า</th>
              <th className="p-4">วันที่ตรวจเสร็จ</th>
            </tr>
          </thead>
          <tbody className="divide-y text-gray-600">
            {kpiData.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-10 text-center italic text-gray-400">
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
                    <span className={`px-2 py-1 rounded-lg font-black ${s.accuracy_percent >= 90 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
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
