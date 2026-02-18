import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import { useAuthContext } from '../../../contexts/AuthContext'
import { useWmsModal } from '../useWmsModal'
import { getProductImageUrl } from '../wmsUtils'
import Modal from '../../ui/Modal'
import * as ExcelJS from 'exceljs'
import type { ProductType } from '../../../types'

interface ReturnRequisition {
  id: string
  return_no: string
  topic?: string | null
  status: string
  created_by?: string | null
  created_at: string
  approved_by?: string | null
  approved_at?: string | null
  note?: string | null
  created_by_user?: { username: string } | null
  approved_by_user?: { username: string } | null
}

interface ReturnItem {
  id: string
  product_id: string
  qty: number
  pr_products?: { product_code: string; product_name: string } | null
}

export default function ReturnRequisitionDashboard() {
  const { user } = useAuthContext()
  const [returns, setReturns] = useState<ReturnRequisition[]>([])
  const [loading, setLoading] = useState(true)
  const [filterDateStart, setFilterDateStart] = useState(() => new Date().toISOString().split('T')[0])
  const [filterDateEnd, setFilterDateEnd] = useState(() => new Date().toISOString().split('T')[0])
  const [filterStatus, setFilterStatus] = useState('')
  const [detailModal, setDetailModal] = useState<{ open: boolean; ret: ReturnRequisition | null; items: ReturnItem[] }>({
    open: false,
    ret: null,
    items: [],
  })
  const [processing, setProcessing] = useState<string | null>(null)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const canManageReturnDecision = ['superadmin', 'admin', 'manager'].includes(user?.role || '')

  // --- Create return state ---
  const [showCreate, setShowCreate] = useState(false)
  const [crSearchTerm, setCrSearchTerm] = useState('')
  const [crProducts, setCrProducts] = useState<any[]>([])
  const [crAllProducts, setCrAllProducts] = useState<any[]>([])
  const [crSelectedItems, setCrSelectedItems] = useState<any[]>([])
  const [crReturnNo, setCrReturnNo] = useState('')
  const [crNotes, setCrNotes] = useState('')
  const [crTopics, setCrTopics] = useState<any[]>([])
  const [crSearching, setCrSearching] = useState(false)
  const [crLoadingProducts, setCrLoadingProducts] = useState(false)
  const [crProductType, setCrProductType] = useState<ProductType>('FG')
  const [crSubmitting, setCrSubmitting] = useState(false)

  useEffect(() => {
    loadReturns()

    const channel = supabase
      .channel('wms-admin-return-reqs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wms_return_requisitions' }, () => {
        loadReturns()
        window.dispatchEvent(new Event('wms-data-changed'))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [filterDateStart, filterDateEnd, filterStatus])

  const loadReturns = async () => {
    setLoading(true)
    try {
      let query = supabase.from('wms_return_requisitions').select('*').order('created_at', { ascending: false })
      if (filterDateStart) query = query.gte('created_at', filterDateStart + 'T00:00:00')
      if (filterDateEnd) query = query.lte('created_at', filterDateEnd + 'T23:59:59')
      if (filterStatus) query = query.eq('status', filterStatus)

      const { data, error } = await query
      if (error) throw error

      const withUsers = await Promise.all(
        (data || []).map(async (r: any) => {
          const [createdBy, approvedBy] = await Promise.all([
            r.created_by ? supabase.from('us_users').select('username').eq('id', r.created_by).single() : Promise.resolve({ data: null }),
            r.approved_by ? supabase.from('us_users').select('username').eq('id', r.approved_by).single() : Promise.resolve({ data: null }),
          ])
          return { ...r, created_by_user: createdBy.data, approved_by_user: approvedBy.data }
        })
      )
      setReturns(withUsers)
    } catch (e: any) {
      console.error('Load return requisitions error:', e)
      showMessage({ message: `โหลดข้อมูลไม่สำเร็จ: ${e.message}` })
    } finally {
      setLoading(false)
    }
  }

  const openDetail = async (ret: ReturnRequisition) => {
    const { data } = await supabase
      .from('wms_return_requisition_items')
      .select('id, product_id, qty, pr_products(product_code, product_name)')
      .eq('return_requisition_id', ret.id)
    setDetailModal({ open: true, ret, items: (data || []) as unknown as ReturnItem[] })
  }

  const handleApprove = async (ret: ReturnRequisition) => {
    if (!canManageReturnDecision) {
      showMessage({ message: 'ไม่มีสิทธิ์อนุมัติรายการคืน' })
      return
    }

    const ok = await showConfirm({
      title: 'อนุมัติใบคืน',
      message: `อนุมัติใบคืน ${ret.return_no}?\nสต๊อคจะถูกเพิ่มกลับตามรายการ`,
    })
    if (!ok) return

    setProcessing(ret.id)
    try {
      const { error } = await supabase.rpc('approve_return_requisition', {
        p_return_id: ret.id,
        p_user_id: user?.id,
      })
      if (error) throw error

      showMessage({ message: `อนุมัติ ${ret.return_no} สำเร็จ — สต๊อคเพิ่มกลับแล้ว` })
      loadReturns()
      setDetailModal((p) => ({ ...p, open: false }))
    } catch (e: any) {
      showMessage({ message: `อนุมัติไม่สำเร็จ: ${e.message}` })
    } finally {
      setProcessing(null)
    }
  }

  const handleReject = async (ret: ReturnRequisition) => {
    if (!canManageReturnDecision) {
      showMessage({ message: 'ไม่มีสิทธิ์ดำเนินการอนุมัติ/ปฏิเสธรายการคืน' })
      return
    }

    const ok = await showConfirm({
      title: 'ไม่อนุมัติใบคืน',
      message: `ไม่อนุมัติใบคืน ${ret.return_no}?`,
    })
    if (!ok) return

    setProcessing(ret.id)
    try {
      const { error } = await supabase.rpc('reject_return_requisition', {
        p_return_id: ret.id,
        p_user_id: user?.id,
      })
      if (error) throw error

      showMessage({ message: `ไม่อนุมัติ ${ret.return_no}` })
      loadReturns()
      setDetailModal((p) => ({ ...p, open: false }))
    } catch (e: any) {
      showMessage({ message: `ดำเนินการไม่สำเร็จ: ${e.message}` })
    } finally {
      setProcessing(null)
    }
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

  const exportToExcel = async () => {
    if (returns.length === 0) {
      showMessage({ message: 'ไม่มีข้อมูลสำหรับการดาวน์โหลด กรุณากดค้นหาก่อน!' })
      return
    }

    try {
      const returnsWithItems = await Promise.all(
        returns.map(async (ret) => {
          const { data: items } = await supabase
            .from('wms_return_requisition_items')
            .select('*, pr_products(product_code, product_name)')
            .eq('return_requisition_id', ret.id)
          return { ret, items: items || [] }
        })
      )

      const exportDataWithGroup = returnsWithItems.flatMap(({ ret, items }) => {
        const baseData = {
          รายการคืน: ret.return_no,
          ผู้คืน: ret.created_by_user?.username || '-',
          ผู้อนุมัติ: ret.approved_by_user?.username || '-',
          วันที่ทำรายการ: formatDate(ret.created_at),
          วันที่อนุมัติ: formatDate(ret.approved_at || ''),
          สถานะ: ret.status === 'pending' ? 'รออนุมัติ' : ret.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธ',
          หมายเหตุ: ret.note || '-',
        }

        if (!items || items.length === 0) {
          return [{ ...baseData, รหัสสินค้า: '-', ชื่อสินค้า: '-', จำนวน: '-', _returnNo: ret.return_no }]
        }

        return items.map((item: any) => ({
          ...baseData,
          รหัสสินค้า: item.pr_products?.product_code || '-',
          ชื่อสินค้า: item.pr_products?.product_name || '-',
          จำนวน: item.qty.toString(),
          _returnNo: ret.return_no,
        }))
      })

      const exportData = exportDataWithGroup.map(({ _returnNo, ...rest }) => rest)
      const returnNos = exportDataWithGroup.map((row: any) => row._returnNo)

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('รายการคืน')

      const headerKeys = Object.keys(exportData[0])
      worksheet.columns = headerKeys.map((key) => ({
        header: key,
        key,
        width: 20,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.height = 25
      const maxColumns = Math.min(headerKeys.length, 11)
      for (let colIndex = 0; colIndex < maxColumns; colIndex++) {
        const cell = headerRow.getCell(colIndex + 1)
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
      }

      let currentReturnNo: string | null = null
      let useBlueBackground = false

      exportData.forEach((row, rowIndex) => {
        const returnNo = returnNos[rowIndex]
        const excelRow = worksheet.addRow(row)
        if (returnNo !== currentReturnNo) {
          currentReturnNo = returnNo
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
      link.download = `รายการคืน_${filterDateStart}_${filterDateEnd}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (error: any) {
      console.error('Error exporting to Excel:', error)
      showMessage({ message: `เกิดข้อผิดพลาดในการดาวน์โหลด: ${error.message}` })
    }
  }

  const stats = {
    total: returns.length,
    pending: returns.filter((r) => r.status === 'pending').length,
    approved: returns.filter((r) => r.status === 'approved').length,
    rejected: returns.filter((r) => r.status === 'rejected').length,
  }

  // --- Create return helpers ---
  const openCreateReturn = async () => {
    setShowCreate(true)
    setCrSelectedItems([])
    setCrNotes('')
    setCrSearchTerm('')
    setCrProducts([])
    setCrProductType('FG')
    await Promise.all([generateCrReturnNo(), loadCrAllProducts('FG'), loadCrTopics()])
  }

  const generateCrReturnNo = async () => {
    const d = new Date()
    const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const { count } = await supabase.from('wms_return_requisitions').select('*', { count: 'exact', head: true }).like('return_no', `RET-${ds}-%`)
    setCrReturnNo(`RET-${ds}-${((count || 0) + 1).toString().padStart(3, '0')}`)
  }

  const loadCrTopics = async () => {
    const { data } = await supabase.from('wms_requisition_topics').select('*').order('topic_name')
    setCrTopics(data || [])
  }

  const loadCrAllProducts = async (pt?: ProductType) => {
    setCrLoadingProducts(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', pt || crProductType)
        .order('product_name')
      setCrAllProducts(data || [])
    } finally {
      setCrLoadingProducts(false)
    }
  }

  const crSearchProducts = async () => {
    if (!crSearchTerm.trim()) { setCrProducts([]); return }
    setCrSearching(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('id, product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', crProductType)
        .or(`product_code.ilike.%${crSearchTerm}%,product_name.ilike.%${crSearchTerm}%`)
        .limit(20)
      setCrProducts(data || [])
    } finally {
      setCrSearching(false)
    }
  }

  const crAddItem = (product: any) => {
    const existing = crSelectedItems.find((i: any) => i.product_code === product.product_code)
    if (existing) {
      setCrSelectedItems(crSelectedItems.map((i: any) => i.product_code === product.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setCrSelectedItems([...crSelectedItems, { ...product, qty: 1, topic: '' }])
    }
  }

  const crRemoveItem = (code: string) => setCrSelectedItems(crSelectedItems.filter((i: any) => i.product_code !== code))

  const crUpdateQty = (code: string, qty: number) => {
    if (qty < 1) { crRemoveItem(code); return }
    setCrSelectedItems(crSelectedItems.map((i: any) => i.product_code === code ? { ...i, qty } : i))
  }

  const crUpdateTopic = (code: string, topic: string) => {
    setCrSelectedItems(crSelectedItems.map((i: any) => i.product_code === code ? { ...i, topic } : i))
  }

  const crSubmit = async () => {
    if (crSelectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (crSelectedItems.some((i: any) => !i.topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อคืนให้ครบทุกรายการ' }); return }
    if (!crNotes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    const ok = await showConfirm({ title: 'ยืนยันสร้างใบคืน', message: `สร้างใบคืน ${crReturnNo}?\nจำนวน ${crSelectedItems.length} รายการ` })
    if (!ok) return

    setCrSubmitting(true)
    try {
      const { error: retErr } = await supabase.from('wms_return_requisitions').insert({
        return_no: crReturnNo,
        topic: null,
        status: 'pending',
        created_by: user?.id,
        note: crNotes.trim() || null,
      }).select().single()
      if (retErr) throw retErr

      const { data: retData } = await supabase.from('wms_return_requisitions').select('id').eq('return_no', crReturnNo).single()
      if (!retData) throw new Error('ไม่พบใบคืนที่สร้าง')

      const items = crSelectedItems
        .filter((i: any) => i.id)
        .map((i: any) => ({ return_requisition_id: retData.id, product_id: i.id, qty: i.qty, topic: i.topic || null }))
      if (items.length > 0) {
        const { error: itemErr } = await supabase.from('wms_return_requisition_items').insert(items)
        if (itemErr) throw itemErr
      }

      showMessage({ message: `สร้างใบคืน ${crReturnNo} สำเร็จ` })
      setShowCreate(false)
      loadReturns()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${e.message}` })
    } finally {
      setCrSubmitting(false)
    }
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
        <h2 className="text-3xl font-black text-slate-800">รายการคืน</h2>
        <div className="flex gap-3">
          <button
            onClick={openCreateReturn}
            className="bg-orange-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-orange-700 transition flex items-center gap-2 shadow-md"
          >
            <i className="fas fa-plus-circle"></i>
            สร้างใบคืน
          </button>
          <button
            onClick={exportToExcel}
            className="bg-green-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-green-700 transition flex items-center gap-2 shadow-md"
          >
            <i className="fas fa-file-excel"></i>
            ดาวน์โหลด Excel
          </button>
        </div>
      </div>

      {/* Stat cards */}
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

      {/* Filters */}
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
            onClick={loadReturns}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 h-[42px]"
          >
            <i className="fas fa-filter mr-2"></i>
            Filter
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white p-6 rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-[16px] uppercase text-gray-400">
              <tr>
                <th className="p-4">รายการคืน</th>
                <th className="p-4">ผู้คืน</th>
                <th className="p-4">วันที่ทำรายการ</th>
                <th className="p-4">หมายเหตุ</th>
                <th className="p-4">วันที่อนุมัติ</th>
                <th className="p-4 text-center">สถานะ</th>
                <th className="p-4 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y text-gray-600">
              {returns.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-400">
                    <i className="fas fa-inbox text-4xl mb-2"></i>
                    <div>ไม่มีข้อมูล</div>
                  </td>
                </tr>
              ) : (
                returns.map((r) => (
                  <tr key={r.id} className="hover:bg-blue-50 border-b transition">
                    <td className="p-4 font-black text-blue-600">{r.return_no}</td>
                    <td className="p-4 font-bold text-slate-700">{r.created_by_user?.username || '-'}</td>
                    <td className="p-4 text-gray-500 text-xs">{formatDate(r.created_at)}</td>
                    <td className="p-4 text-gray-500 text-sm">{r.note || '-'}</td>
                    <td className="p-4 text-gray-500 text-xs">{formatDate(r.approved_at || '')}</td>
                    <td className="p-4 text-center">{getStatusBadge(r.status)}</td>
                    <td className="p-4 text-center">
                      <button onClick={() => openDetail(r)} className="text-blue-500 font-bold underline hover:text-blue-700">
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

      {/* Detail modal */}
      <Modal open={detailModal.open} onClose={() => setDetailModal((p) => ({ ...p, open: false }))} closeOnBackdropClick={true} contentClassName="max-w-4xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          {/* Header */}
          <div className="p-6 border-b border-gray-200 flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <div>
              <h2 className="text-2xl font-black text-white">ใบคืน: {detailModal.ret?.return_no}</h2>
              <div className="mt-2">{detailModal.ret && getStatusBadge(detailModal.ret.status)}</div>
            </div>
            <button
              onClick={() => setDetailModal((p) => ({ ...p, open: false }))}
              className="text-white hover:text-red-200 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/20 transition-all"
              title="ปิดหน้าต่าง (ESC)"
              aria-label="ปิดหน้าต่าง"
            >
              <i className="fas fa-times" style={{ fontSize: '1.5rem', lineHeight: '1' }}></i>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
            {/* Info card */}
            <div className="bg-white p-6 rounded-xl mb-4 border shadow-sm">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">ผู้คืน</div>
                  <div className="font-bold text-slate-800 text-lg">{detailModal.ret?.created_by_user?.username || '-'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">ผู้อนุมัติ</div>
                  <div className="font-bold text-slate-800 text-lg">{detailModal.ret?.approved_by_user?.username || '-'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่ทำรายการ</div>
                  <div className="text-slate-600 text-sm">{detailModal.ret ? formatDate(detailModal.ret.created_at) : '-'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-500 font-bold uppercase mb-1">วันที่อนุมัติ</div>
                  <div className="text-slate-600 text-sm">{detailModal.ret?.approved_at ? formatDate(detailModal.ret.approved_at) : '-'}</div>
                </div>
              </div>
              {detailModal.ret?.note && (
                <div className="mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-500 font-bold uppercase mb-2">หมายเหตุ</div>
                  <div className="text-base text-gray-700 font-medium break-words bg-gray-50 p-3 rounded-lg">
                    {detailModal.ret.note}
                  </div>
                </div>
              )}
            </div>

            {/* Product list */}
            <div className="bg-white p-6 rounded-xl border shadow-sm">
              <h3 className="text-lg font-black text-slate-800 mb-4">รายการสินค้า ({detailModal.items.length} รายการ)</h3>
              {detailModal.items.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <i className="fas fa-inbox text-2xl mb-2"></i>
                  <div>ไม่มีรายการ</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {detailModal.items.map((item, idx) => {
                    const code = (item as any).pr_products?.product_code || ''
                    const name = (item as any).pr_products?.product_name || '-'
                    return (
                      <div key={item.id} className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl border hover:bg-blue-50 transition">
                        <div className="text-lg font-black text-gray-400 w-8 text-center shrink-0">{idx + 1}</div>
                        <img
                          src={getProductImageUrl(code)}
                          className="w-20 h-20 object-cover rounded-lg shrink-0 border-2 border-gray-200"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement
                            target.src = 'https://placehold.co/100x100?text=NO+IMG'
                          }}
                          alt={name}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-slate-800 text-base mb-1">{name}</div>
                          <div className="text-xs text-gray-500">รหัส: {code || '-'}</div>
                        </div>
                        <div className="text-slate-800 font-black text-xl shrink-0 bg-blue-100 px-4 py-2 rounded-lg">
                          x{Number(item.qty).toLocaleString()}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          {detailModal.ret?.status === 'pending' && canManageReturnDecision && (
            <div className="p-4 border-t border-gray-200 flex gap-3 bg-white">
              <button
                type="button"
                onClick={() => detailModal.ret && handleReject(detailModal.ret)}
                disabled={processing === detailModal.ret?.id}
                className="flex-1 bg-red-600 text-white py-3 rounded-xl font-bold hover:bg-red-700 disabled:opacity-50 transition"
              >
                <i className="fas fa-times mr-2"></i>
                ไม่อนุมัติ
              </button>
              <button
                type="button"
                onClick={() => detailModal.ret && handleApprove(detailModal.ret)}
                disabled={processing === detailModal.ret?.id}
                className="flex-1 bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50 transition"
              >
                {processing === detailModal.ret?.id ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i>
                    กำลังดำเนินการ...
                  </>
                ) : (
                  <>
                    <i className="fas fa-check mr-2"></i>
                    อนุมัติ
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* Create Return Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} closeOnBackdropClick={false} contentClassName="max-w-5xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-orange-600 to-orange-700">
            <div>
              <h2 className="text-2xl font-black text-white">สร้างใบคืนสินค้า</h2>
              <span className="text-sm font-bold text-orange-200">{crReturnNo}</span>
            </div>
            <button onClick={() => setShowCreate(false)} className="text-white hover:text-red-200 text-3xl font-bold w-12 h-12 flex items-center justify-center rounded-full hover:bg-white/20 transition-all">
              <i className="fas fa-times" style={{ fontSize: '1.5rem' }}></i>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
            <div className="grid grid-cols-2 gap-6">
              {/* Left: product search & select */}
              <div className="space-y-4">
                <div className="bg-white p-5 rounded-xl border shadow-sm space-y-3">
                  <h3 className="font-bold text-slate-800 text-base">ค้นหาสินค้า</h3>
                  <div className="flex gap-2">
                    {(['FG', 'RM'] as ProductType[]).map((pt) => (
                      <button key={pt} type="button" onClick={() => { setCrProductType(pt); loadCrAllProducts(pt); setCrProducts([]); setCrSearchTerm('') }}
                        className={`flex-1 py-2 rounded-lg font-bold text-sm transition ${crProductType === pt ? 'bg-orange-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        {pt === 'FG' ? 'FG สินค้าสำเร็จรูป' : 'RM วัตถุดิบ'}
                      </button>
                    ))}
                  </div>
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) { const p = crAllProducts.find((x: any) => x.product_code === e.target.value); if (p) crAddItem(p) } }}
                    disabled={crLoadingProducts}
                    className="w-full border p-2.5 rounded-lg text-sm"
                  >
                    <option value="">{crLoadingProducts ? 'กำลังโหลด...' : `-- เลือกสินค้าจากรายการ (${crAllProducts.length}) --`}</option>
                    {crAllProducts.map((p: any) => <option key={p.product_code} value={p.product_code}>{p.product_code} — {p.product_name}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <input type="text" value={crSearchTerm} onChange={(e) => setCrSearchTerm(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && crSearchProducts()}
                      placeholder="รหัสหรือชื่อสินค้า..."
                      className="flex-1 border p-2.5 rounded-lg text-sm" />
                    <button onClick={crSearchProducts} disabled={crSearching} className="bg-orange-600 text-white px-5 py-2.5 rounded-lg font-bold text-sm hover:bg-orange-700 disabled:opacity-50">
                      {crSearching ? '...' : 'ค้นหา'}
                    </button>
                  </div>
                </div>

                {crProducts.length > 0 && (
                  <div className="bg-white p-5 rounded-xl border shadow-sm">
                    <h3 className="font-bold text-slate-800 text-sm mb-3">ผลการค้นหา ({crProducts.length})</h3>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {crProducts.map((p: any) => (
                        <div key={p.product_code} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-orange-50 transition border">
                          <img src={getProductImageUrl(p.product_code)} className="w-14 h-14 object-cover rounded-lg border" alt=""
                            onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }} />
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-800 text-sm truncate">{p.product_name}</div>
                            <div className="text-xs text-gray-500">รหัส: {p.product_code}</div>
                            {p.storage_location && <div className="text-xs text-red-500">จุดเก็บ: {p.storage_location}</div>}
                          </div>
                          <button onClick={() => crAddItem(p)} className="bg-green-600 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-green-700 shrink-0">
                            <i className="fas fa-plus mr-1"></i>เพิ่ม
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Right: selected items & notes */}
              <div className="space-y-4">
                <div className="bg-white p-5 rounded-xl border shadow-sm">
                  <h3 className="font-bold text-slate-800 text-base mb-3">รายการที่เลือก ({crSelectedItems.length})</h3>
                  {crSelectedItems.length === 0 ? (
                    <div className="text-center py-10 text-gray-400">
                      <i className="fas fa-inbox text-3xl mb-2"></i>
                      <div>ยังไม่มีรายการ</div>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[400px] overflow-y-auto">
                      {crSelectedItems.map((item: any) => (
                        <div key={item.product_code} className="p-3 bg-gray-50 rounded-lg border space-y-2">
                          <div className="flex items-center gap-3">
                            <img src={getProductImageUrl(item.product_code)} className="w-14 h-14 object-cover rounded-lg border shrink-0" alt=""
                              onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }} />
                            <div className="flex-1 min-w-0">
                              <div className="font-bold text-slate-800 text-sm truncate">{item.product_name}</div>
                              <div className="text-xs text-gray-500">รหัส: {item.product_code}</div>
                            </div>
                            <button onClick={() => crRemoveItem(item.product_code)} className="text-red-500 hover:text-red-700 p-1"><i className="fas fa-trash"></i></button>
                          </div>
                          <div className="flex items-center gap-3">
                            <select value={item.topic || ''} onChange={(e) => crUpdateTopic(item.product_code, e.target.value)}
                              className={`flex-1 border p-2 rounded-lg text-sm ${item.topic ? 'border-gray-300' : 'border-red-400'}`}>
                              <option value="">-- หัวข้อคืน * --</option>
                              {crTopics.map((t: any) => <option key={t.id} value={t.topic_name}>{t.topic_name}</option>)}
                            </select>
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => crUpdateQty(item.product_code, item.qty - 1)} className="w-8 h-8 rounded-lg bg-red-100 text-red-600 font-bold hover:bg-red-200">-</button>
                              <input type="number" value={item.qty} onChange={(e) => crUpdateQty(item.product_code, Number(e.target.value) || 0)}
                                className="w-14 text-center border rounded-lg p-1.5 text-sm font-bold" min={1} />
                              <button onClick={() => crUpdateQty(item.product_code, item.qty + 1)} className="w-8 h-8 rounded-lg bg-green-100 text-green-600 font-bold hover:bg-green-200">+</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white p-5 rounded-xl border shadow-sm">
                  <label className="block text-sm font-bold text-gray-700 mb-2">หมายเหตุ <span className="text-red-500">*</span></label>
                  <textarea value={crNotes} onChange={(e) => setCrNotes(e.target.value)} placeholder="กรุณากรอกหมายเหตุ..."
                    className={`w-full border p-3 rounded-lg text-sm resize-none ${crNotes.trim() ? 'border-gray-300' : 'border-red-400'}`} rows={3} />
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 border-t bg-white flex justify-end gap-3">
            <button onClick={() => setShowCreate(false)} className="px-6 py-3 rounded-xl font-bold text-gray-600 hover:bg-gray-100 transition">ยกเลิก</button>
            <button onClick={crSubmit} disabled={crSubmitting || crSelectedItems.length === 0}
              className="bg-orange-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-orange-700 disabled:opacity-50 transition flex items-center gap-2">
              {crSubmitting ? <><i className="fas fa-spinner fa-spin"></i>กำลังบันทึก...</> : <><i className="fas fa-check-circle"></i>สร้างใบคืน ({crSelectedItems.length} รายการ)</>}
            </button>
          </div>
        </div>
      </Modal>

      {MessageModal}
      {ConfirmModal}
    </section>
  )
}
