import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl } from '../wmsUtils'
import RequisitionDetailModal from './RequisitionDetailModal'
import Modal from '../../ui/Modal'
import * as ExcelJS from 'exceljs'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

export default function RequisitionDashboard() {
  const { user } = useAuthContext()
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRequisition, setSelectedRequisition] = useState<any | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [filterDateStart, setFilterDateStart] = useState('')
  const [filterDateEnd, setFilterDateEnd] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  // --- Create requisition state ---
  const [showCreate, setShowCreate] = useState(false)
  const [cSearchTerm, setCSearchTerm] = useState('')
  const [cProducts, setCProducts] = useState<any[]>([])
  const [cAllProducts, setCAllProducts] = useState<any[]>([])
  const [cSelectedItems, setCSelectedItems] = useState<any[]>([])
  const [cRequisitionId, setCRequisitionId] = useState('')
  const [cNotes, setCNotes] = useState('')
  const [cTopics, setCTopics] = useState<any[]>([])
  const [cSearching, setCSearching] = useState(false)
  const [cLoadingProducts, setCLoadingProducts] = useState(false)
  const [cProductType, setCProductType] = useState<ProductType>('FG')
  const [cSubmitting, setCSubmitting] = useState(false)

  useEffect(() => {
    const now = new Date()
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const today = now.toISOString().split('T')[0]
    if (!filterDateStart) setFilterDateStart(monthStart)
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

  // --- Create requisition helpers ---
  const openCreateModal = async () => {
    setShowCreate(true)
    setCSelectedItems([])
    setCNotes('')
    setCSearchTerm('')
    setCProducts([])
    setCProductType('FG')
    await Promise.all([generateCRequisitionId(), loadCAllProducts('FG'), loadCTopics()])
  }

  const generateCRequisitionId = async () => {
    const d = new Date()
    const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const { count } = await supabase.from('wms_requisitions').select('*', { count: 'exact', head: true }).like('requisition_id', `REQ-${ds}-%`)
    setCRequisitionId(`REQ-${ds}-${((count || 0) + 1).toString().padStart(3, '0')}`)
  }

  const loadCTopics = async () => {
    const { data } = await supabase.from('wms_requisition_topics').select('*').order('topic_name')
    setCTopics(data || [])
  }

  const loadCAllProducts = async (pt?: ProductType) => {
    setCLoadingProducts(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', pt || cProductType)
        .order('product_name')
      setCAllProducts(data || [])
    } finally {
      setCLoadingProducts(false)
    }
  }

  const cSearchProducts = async () => {
    if (!cSearchTerm.trim()) { setCProducts([]); return }
    setCSearching(true)
    try {
      const { data } = await supabase
        .from('pr_products')
        .select('product_code, product_name, storage_location')
        .eq('is_active', true)
        .eq('product_type', cProductType)
        .or(`product_code.ilike.%${cSearchTerm}%,product_name.ilike.%${cSearchTerm}%`)
        .limit(20)
      setCProducts(data || [])
    } finally {
      setCSearching(false)
    }
  }

  const cAddItem = (product: any) => {
    const existing = cSelectedItems.find((i: any) => i.product_code === product.product_code)
    if (existing) {
      setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === product.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setCSelectedItems([...cSelectedItems, { ...product, qty: 1, requisition_topic: '' }])
    }
  }

  const cRemoveItem = (code: string) => setCSelectedItems(cSelectedItems.filter((i: any) => i.product_code !== code))

  const cUpdateQty = (code: string, qty: number) => {
    if (qty < 1) { cRemoveItem(code); return }
    setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === code ? { ...i, qty } : i))
  }

  const cUpdateTopic = (code: string, topic: string) => {
    setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === code ? { ...i, requisition_topic: topic } : i))
  }

  const cSubmit = async () => {
    if (cSelectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (cSelectedItems.some((i: any) => !i.requisition_topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อการเบิกให้ครบทุกรายการ' }); return }
    if (!cNotes.trim()) { showMessage({ message: 'กรุณากรอกหมายเหตุ' }); return }

    const ok = await showConfirm({ title: 'ยืนยันสร้างใบเบิก', message: `สร้างใบเบิก ${cRequisitionId}?\nจำนวน ${cSelectedItems.length} รายการ` })
    if (!ok) return

    setCSubmitting(true)
    try {
      const { error: reqErr } = await supabase.from('wms_requisitions').insert({
        requisition_id: cRequisitionId,
        created_by: user?.id,
        status: 'pending',
        notes: cNotes.trim(),
        requisition_topic: null,
      })
      if (reqErr) throw reqErr

      const items = cSelectedItems.map((item: any) => ({
        requisition_id: cRequisitionId,
        product_code: item.product_code,
        product_name: item.product_name,
        location: item.storage_location || null,
        qty: item.qty,
        requisition_topic: item.requisition_topic || null,
      }))
      const { error: itemErr } = await supabase.from('wms_requisition_items').insert(items)
      if (itemErr) throw itemErr

      showMessage({ message: `สร้างใบเบิก ${cRequisitionId} สำเร็จ` })
      setShowCreate(false)
      loadRequisitions()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      showMessage({ message: `เกิดข้อผิดพลาด: ${e.message}` })
    } finally {
      setCSubmitting(false)
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
        <h2 className="text-3xl font-black text-slate-800">รายการเบิก</h2>
        <div className="flex gap-3">
          <button
            onClick={openCreateModal}
            className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-blue-700 transition flex items-center gap-2 shadow-md"
          >
            <i className="fas fa-plus-circle"></i>
            สร้างใบเบิก
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
                <th className="p-4">วันที่ทำรายการ</th>
                <th className="p-4">หมายเหตุ</th>
                <th className="p-4">วันที่อนุมัติ</th>
                <th className="p-4 text-center">สถานะ</th>
                <th className="p-4 text-center">จัดการ</th>
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
                    <td className="p-4 text-gray-500 text-xs">{formatDate(req.created_at)}</td>
                    <td className="p-4 text-gray-500 text-sm">{req.notes || '-'}</td>
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

      {/* Create Requisition Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} closeOnBackdropClick={false} contentClassName="max-w-5xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <div>
              <h2 className="text-2xl font-black text-white">สร้างใบเบิกสินค้า</h2>
              <span className="text-sm font-bold text-blue-200">{cRequisitionId}</span>
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
                      <button key={pt} type="button" onClick={() => { setCProductType(pt); loadCAllProducts(pt); setCProducts([]); setCSearchTerm('') }}
                        className={`flex-1 py-2 rounded-lg font-bold text-sm transition ${cProductType === pt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        {pt === 'FG' ? 'FG สินค้าสำเร็จรูป' : 'RM วัตถุดิบ'}
                      </button>
                    ))}
                  </div>
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) { const p = cAllProducts.find((x: any) => x.product_code === e.target.value); if (p) cAddItem(p) } }}
                    disabled={cLoadingProducts}
                    className="w-full border p-2.5 rounded-lg text-sm"
                  >
                    <option value="">{cLoadingProducts ? 'กำลังโหลด...' : `-- เลือกสินค้าจากรายการ (${cAllProducts.length}) --`}</option>
                    {cAllProducts.map((p: any) => <option key={p.product_code} value={p.product_code}>{p.product_code} — {p.product_name}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <input type="text" value={cSearchTerm} onChange={(e) => setCSearchTerm(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && cSearchProducts()}
                      placeholder="รหัสหรือชื่อสินค้า..."
                      className="flex-1 border p-2.5 rounded-lg text-sm" />
                    <button onClick={cSearchProducts} disabled={cSearching} className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-bold text-sm hover:bg-blue-700 disabled:opacity-50">
                      {cSearching ? '...' : 'ค้นหา'}
                    </button>
                  </div>
                </div>

                {cProducts.length > 0 && (
                  <div className="bg-white p-5 rounded-xl border shadow-sm">
                    <h3 className="font-bold text-slate-800 text-sm mb-3">ผลการค้นหา ({cProducts.length})</h3>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {cProducts.map((p: any) => (
                        <div key={p.product_code} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-blue-50 transition border">
                          <img src={getProductImageUrl(p.product_code)} className="w-14 h-14 object-cover rounded-lg border" alt=""
                            onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }} />
                          <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-800 text-sm truncate">{p.product_name}</div>
                            <div className="text-xs text-gray-500">รหัส: {p.product_code}</div>
                            {p.storage_location && <div className="text-xs text-red-500">จุดเก็บ: {p.storage_location}</div>}
                          </div>
                          <button onClick={() => cAddItem(p)} className="bg-green-600 text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-green-700 shrink-0">
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
                  <h3 className="font-bold text-slate-800 text-base mb-3">รายการที่เลือก ({cSelectedItems.length})</h3>
                  {cSelectedItems.length === 0 ? (
                    <div className="text-center py-10 text-gray-400">
                      <i className="fas fa-inbox text-3xl mb-2"></i>
                      <div>ยังไม่มีรายการ</div>
                    </div>
                  ) : (
                    <div className="space-y-3 max-h-[400px] overflow-y-auto">
                      {cSelectedItems.map((item: any) => (
                        <div key={item.product_code} className="p-3 bg-gray-50 rounded-lg border space-y-2">
                          <div className="flex items-center gap-3">
                            <img src={getProductImageUrl(item.product_code)} className="w-14 h-14 object-cover rounded-lg border shrink-0" alt=""
                              onError={(e) => { (e.target as HTMLImageElement).src = 'https://placehold.co/100x100?text=NO+IMG' }} />
                            <div className="flex-1 min-w-0">
                              <div className="font-bold text-slate-800 text-sm truncate">{item.product_name}</div>
                              <div className="text-xs text-gray-500">รหัส: {item.product_code}</div>
                            </div>
                            <button onClick={() => cRemoveItem(item.product_code)} className="text-red-500 hover:text-red-700 p-1"><i className="fas fa-trash"></i></button>
                          </div>
                          <div className="flex items-center gap-3">
                            <select value={item.requisition_topic || ''} onChange={(e) => cUpdateTopic(item.product_code, e.target.value)}
                              className={`flex-1 border p-2 rounded-lg text-sm ${item.requisition_topic ? 'border-gray-300' : 'border-red-400'}`}>
                              <option value="">-- หัวข้อการเบิก * --</option>
                              {cTopics.map((t: any) => <option key={t.id} value={t.topic_name}>{t.topic_name}</option>)}
                            </select>
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => cUpdateQty(item.product_code, item.qty - 1)} className="w-8 h-8 rounded-lg bg-red-100 text-red-600 font-bold hover:bg-red-200">-</button>
                              <input type="number" value={item.qty} onChange={(e) => cUpdateQty(item.product_code, Number(e.target.value) || 0)}
                                className="w-14 text-center border rounded-lg p-1.5 text-sm font-bold" min={1} />
                              <button onClick={() => cUpdateQty(item.product_code, item.qty + 1)} className="w-8 h-8 rounded-lg bg-green-100 text-green-600 font-bold hover:bg-green-200">+</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white p-5 rounded-xl border shadow-sm">
                  <label className="block text-sm font-bold text-gray-700 mb-2">หมายเหตุ <span className="text-red-500">*</span></label>
                  <textarea value={cNotes} onChange={(e) => setCNotes(e.target.value)} placeholder="กรุณากรอกหมายเหตุ..."
                    className={`w-full border p-3 rounded-lg text-sm resize-none ${cNotes.trim() ? 'border-gray-300' : 'border-red-400'}`} rows={3} />
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 border-t bg-white flex justify-end gap-3">
            <button onClick={() => setShowCreate(false)} className="px-6 py-3 rounded-xl font-bold text-gray-600 hover:bg-gray-100 transition">ยกเลิก</button>
            <button onClick={cSubmit} disabled={cSubmitting || cSelectedItems.length === 0}
              className="bg-green-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-green-700 disabled:opacity-50 transition flex items-center gap-2">
              {cSubmitting ? <><i className="fas fa-spinner fa-spin"></i>กำลังบันทึก...</> : <><i className="fas fa-check-circle"></i>สร้างใบเบิก ({cSelectedItems.length} รายการ)</>}
            </button>
          </div>
        </div>
      </Modal>

      {MessageModal}
      {ConfirmModal}
    </section>
  )
}
