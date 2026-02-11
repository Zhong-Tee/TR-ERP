import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import RequisitionDetailModal from './RequisitionDetailModal'
import * as ExcelJS from 'exceljs'
import { useWmsModal } from '../useWmsModal'

export default function RequisitionDashboard() {
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRequisition, setSelectedRequisition] = useState<any | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [filterDateStart, setFilterDateStart] = useState('')
  const [filterDateEnd, setFilterDateEnd] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const { showMessage, MessageModal } = useWmsModal()

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    if (!filterDateStart) setFilterDateStart(today)
    if (!filterDateEnd) setFilterDateEnd(today)
  }, [])

  useEffect(() => {
    if (!filterDateStart || !filterDateEnd) return
    loadRequisitions()

    const channel = supabase
      .channel('wms-admin-requisitions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_requisitions' }, () => {
        loadRequisitions()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [filterDateStart, filterDateEnd, filterStatus])

  const loadRequisitions = async () => {
    try {
      setLoading(true)
      let query = supabase.from('wms_requisitions').select('*').order('created_at', { ascending: false })

      if (filterDateStart) {
        query = query.gte('created_at', filterDateStart + 'T00:00:00')
      }
      if (filterDateEnd) {
        query = query.lte('created_at', filterDateEnd + 'T23:59:59')
      }
      if (filterStatus) {
        query = query.eq('status', filterStatus)
      }

      const { data, error } = await query
      if (error) throw error

      const requisitionsWithUsers = await Promise.all(
        (data || []).map(async (req: any) => {
          const [createdByUser, approvedByUser] = await Promise.all([
            supabase.from('us_users').select('username').eq('id', req.created_by).single(),
            req.approved_by ? supabase.from('us_users').select('username').eq('id', req.approved_by).single() : Promise.resolve({ data: null }),
          ])
          return { ...req, created_by_user: createdByUser.data, approved_by_user: approvedByUser.data }
        })
      )

      setRequisitions(requisitionsWithUsers)
    } catch (error: any) {
      console.error('Error loading requisitions:', error)
      showMessage({ message: `เกิดข้อผิดพลาด: ${error.message}` })
    } finally {
      setLoading(false)
    }
  }

  const openDetail = (requisition: any) => {
    setSelectedRequisition(requisition)
    setIsModalOpen(true)
  }

  const closeModal = () => {
    setIsModalOpen(false)
    setSelectedRequisition(null)
    loadRequisitions()
  }

  const getStatusBadge = (status: string) => {
    const badges: Record<string, string> = {
      pending: 'bg-yellow-500 text-yellow-900',
      approved: 'bg-green-500 text-green-900',
      rejected: 'bg-red-500 text-red-900',
    }
    const labels: Record<string, string> = {
      pending: 'รออนุมัติ',
      approved: 'อนุมัติแล้ว',
      rejected: 'ปฏิเสธ',
    }
    return (
      <span className={`inline-block px-3 py-1 rounded-lg text-xs font-bold text-center min-w-[90px] ${badges[status] || 'bg-gray-500'}`}>
        {labels[status] || status}
      </span>
    )
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const exportToExcel = async () => {
    if (requisitions.length === 0) {
      showMessage({ message: 'ไม่มีข้อมูลสำหรับการดาวน์โหลด กรุณากดค้นหาก่อน!' })
      return
    }

    try {
      const requisitionsWithItems = await Promise.all(
        requisitions.map(async (req: any) => {
          const { data: items } = await supabase.from('wms_requisition_items').select('*').eq('requisition_id', req.requisition_id)
          return { requisition: req, items: items || [] }
        })
      )

      const exportDataWithGroup = requisitionsWithItems.flatMap(({ requisition, items }) => {
        const baseData = {
          รายการเบิก: requisition.requisition_id,
          ผู้เบิก: requisition.created_by_user?.username || '-',
          ผู้อนุมัติ: requisition.approved_by_user?.username || '-',
          วันที่ทำรายการ: formatDate(requisition.created_at),
          วันที่อนุมัติ: formatDate(requisition.approved_at),
          สถานะ: requisition.status === 'pending' ? 'รออนุมัติ' : requisition.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธ',
          หัวข้อการเบิก: requisition.requisition_topic || '-',
          หมายเหตุ: requisition.notes || '-',
        }

        if (!items || items.length === 0) {
          return [
            {
              ...baseData,
              รายการสินค้า: '-',
              จำนวน: '-',
              _requisitionId: requisition.requisition_id,
            },
          ]
        }

        return items.map((item: any) => ({
          ...baseData,
          รายการสินค้า: item.product_name,
          จำนวน: item.qty.toString(),
          _requisitionId: requisition.requisition_id,
        }))
      })

      const exportData = exportDataWithGroup.map(({ _requisitionId, ...rest }) => rest)
      const requisitionIds = exportDataWithGroup.map((row: any) => row._requisitionId)

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('รายการเบิก')

      const headerKeys = Object.keys(exportData[0])
      worksheet.columns = headerKeys.map((key) => ({
        header: key,
        key,
        width: 20,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.height = 25
      const maxColumns = Math.min(headerKeys.length, 10)
      for (let colIndex = 0; colIndex < maxColumns; colIndex++) {
        const cell = headerRow.getCell(colIndex + 1)
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
      }

      let currentRequisitionId: string | null = null
      let useBlueBackground = false

      exportData.forEach((row, rowIndex) => {
        const requisitionId = requisitionIds[rowIndex]
        const excelRow = worksheet.addRow(row)
        if (requisitionId !== currentRequisitionId) {
          currentRequisitionId = requisitionId
          useBlueBackground = !useBlueBackground
        }
        excelRow.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: useBlueBackground ? 'FFE3F2FD' : 'FFFFFFFF' } }
          cell.alignment = { vertical: 'middle', horizontal: 'left' }
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
            right: { style: 'thin', color: { argb: 'FFD0D0D0' } },
          }
        })
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `รายการเบิก_${filterDateStart}_${filterDateEnd}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (error: any) {
      console.error('Error exporting to Excel:', error)
      showMessage({ message: `เกิดข้อผิดพลาดในการดาวน์โหลด: ${error.message}` })
    }
  }

  const stats = {
    total: requisitions.length,
    pending: requisitions.filter((r) => r.status === 'pending').length,
    approved: requisitions.filter((r) => r.status === 'approved').length,
    rejected: requisitions.filter((r) => r.status === 'rejected').length,
  }

  if (loading) {
    return (
      <div className="text-center py-20 text-gray-400">
        <i className="fas fa-spinner fa-spin text-4xl mb-4"></i>
        <div>กำลังโหลด...</div>
      </div>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-3xl font-black text-slate-800">รายการเบิก</h2>
        <button
          onClick={exportToExcel}
          className="bg-green-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-green-700 transition flex items-center gap-2 shadow-md"
        >
          <i className="fas fa-file-excel"></i>
          ดาวน์โหลด Excel
        </button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-6 rounded-2xl border shadow-sm">
          <div className="text-sm text-gray-500 font-bold uppercase mb-1">ทั้งหมด</div>
          <div className="text-3xl font-black text-slate-800">{stats.total}</div>
        </div>
        <div className="bg-white p-6 rounded-2xl border shadow-sm">
          <div className="text-sm text-gray-500 font-bold uppercase mb-1">รออนุมัติ</div>
          <div className="text-3xl font-black text-yellow-600">{stats.pending}</div>
        </div>
        <div className="bg-white p-6 rounded-2xl border shadow-sm">
          <div className="text-sm text-gray-500 font-bold uppercase mb-1">อนุมัติแล้ว</div>
          <div className="text-3xl font-black text-green-600">{stats.approved}</div>
        </div>
        <div className="bg-white p-6 rounded-2xl border shadow-sm">
          <div className="text-sm text-gray-500 font-bold uppercase mb-1">ปฏิเสธ</div>
          <div className="text-3xl font-black text-red-600">{stats.rejected}</div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl border shadow-sm mb-6">
        <div className="flex gap-4 items-end flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <label className="text-sm font-bold text-gray-700 uppercase mb-2 block">วันที่ทำรายการ</label>
            <div className="flex gap-2">
              <input
                type="date"
                value={filterDateStart}
                onChange={(e) => setFilterDateStart(e.target.value)}
                className="border p-2 rounded-lg text-sm outline-none shadow-sm"
              />
              <span className="text-gray-400 self-center">-</span>
              <input
                type="date"
                value={filterDateEnd}
                onChange={(e) => setFilterDateEnd(e.target.value)}
                className="border p-2 rounded-lg text-sm outline-none shadow-sm"
              />
            </div>
          </div>
          <div className="w-48">
            <label className="text-sm font-bold text-gray-700 uppercase mb-2 block">สถานะ</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full border p-2 rounded-lg text-sm outline-none"
            >
              <option value="">ทั้งหมด</option>
              <option value="pending">รออนุมัติ</option>
              <option value="approved">อนุมัติแล้ว</option>
              <option value="rejected">ปฏิเสธ</option>
            </select>
          </div>
          <button
            onClick={loadRequisitions}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 h-[42px]"
          >
            <i className="fas fa-filter mr-2"></i>
            Filter
          </button>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-[16px] uppercase text-gray-400">
              <tr>
                <th className="p-4">รายการเบิก</th>
                <th className="p-4">ผู้เบิก</th>
                <th className="p-4">ผู้อนุมัติ</th>
                <th className="p-4">วันที่ทำรายการ</th>
                <th className="p-4">วันที่อนุมัติ</th>
                <th className="p-4 text-center">สถานะ</th>
                <th className="p-4 text-center">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y text-gray-600">
              {requisitions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-400">
                    <i className="fas fa-inbox text-4xl mb-2"></i>
                    <div>ไม่มีข้อมูล</div>
                  </td>
                </tr>
              ) : (
                requisitions.map((req) => (
                  <tr key={req.id} className="hover:bg-blue-50 border-b transition">
                    <td className="p-4 font-black text-blue-600">{req.requisition_id}</td>
                    <td className="p-4 font-bold text-slate-700">{req.created_by_user?.username || '---'}</td>
                    <td className="p-4 font-bold text-slate-700">{req.approved_by_user?.username || '-'}</td>
                    <td className="p-4 text-gray-500 text-xs">{formatDate(req.created_at)}</td>
                    <td className="p-4 text-gray-500 text-xs">{formatDate(req.approved_at)}</td>
                    <td className="p-4 text-center">{getStatusBadge(req.status)}</td>
                    <td className="p-4 text-center">
                      <button onClick={() => openDetail(req)} className="text-blue-500 font-bold underline hover:text-blue-700">
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && selectedRequisition && <RequisitionDetailModal requisition={selectedRequisition} onClose={closeModal} />}
      {MessageModal}
    </section>
  )
}
