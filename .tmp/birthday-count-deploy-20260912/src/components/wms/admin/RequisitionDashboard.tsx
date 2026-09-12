import { useState, useEffect } from 'react'
import { useAuthContext } from '../../../contexts/AuthContext'
import { supabase } from '../../../lib/supabase'
import { buildIlikeOr } from '../../../lib/searchFilter'
import { getProductImageUrl } from '../wmsUtils'
import RequisitionDetailModal from './RequisitionDetailModal'
import Modal from '../../ui/Modal'
import * as ExcelJS from 'exceljs'
import { useWmsModal } from '../useWmsModal'
import type { ProductType } from '../../../types'

const PHOTO_REQUIRED_TOPICS = new Set(['ผลิตเสีย', 'สินค้าชำรุด'])
const requiresDamageEvidence = (topic: string) => PHOTO_REQUIRED_TOPICS.has(topic)
const DAMAGE_BUCKET = 'wms-damage-evidence'
const PAGE_SIZE = 25

type ReferenceBill = {
  id: string
  bill_no: string
  channel_code: string
  channel_order_no: string | null
  customer_name: string | null
}

type ChannelOption = { channel_code: string; channel_name: string }

function ReferenceBillSelector({
  selectedOrderId,
  selectedBillNo,
  channels,
  onChange,
}: {
  selectedOrderId: string
  selectedBillNo: string
  channels: ChannelOption[]
  onChange: (bill: ReferenceBill | null) => void
}) {
  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('')
  const [bills, setBills] = useState<ReferenceBill[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      let query = supabase
        .from('or_orders')
        .select('id, bill_no, channel_code, channel_order_no, customer_name')
        .neq('status', 'จัดส่งแล้ว')
        .is('shipped_time', null)
        .order('created_at', { ascending: false })
        .limit(50)

      if (channel) query = query.eq('channel_code', channel)
      if (search.trim()) query = query.or(buildIlikeOr(search, ['bill_no', 'channel_order_no', 'customer_name']))

      const { data, error } = await query
      if (!cancelled) {
        setBills(error ? [] : (data || []) as ReferenceBill[])
        setLoading(false)
      }
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [search, channel])

  const selectedIsMissing = selectedOrderId && !bills.some((bill) => bill.id === selectedOrderId)

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-bold text-amber-800">เลขบิลอ้างอิง *</label>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">เฉพาะยังไม่จัดส่ง</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="ค้นหาเลขบิล / เลขคำสั่งซื้อ / ลูกค้า"
          className="w-full rounded-lg border border-amber-200 bg-white p-2 text-sm outline-none focus:border-amber-500"
        />
        <select
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          className="w-full rounded-lg border border-amber-200 bg-white p-2 text-sm outline-none focus:border-amber-500"
        >
          <option value="">ทุกช่องทาง</option>
          {channels.map((item) => <option key={item.channel_code} value={item.channel_code}>{item.channel_code} - {item.channel_name}</option>)}
        </select>
      </div>
      <select
        value={selectedOrderId || ''}
        onChange={(event) => onChange(bills.find((bill) => bill.id === event.target.value) || null)}
        className={`w-full rounded-lg border bg-white p-2 text-sm outline-none ${selectedOrderId ? 'border-amber-200' : 'border-red-400'}`}
      >
        <option value="">{loading ? 'กำลังค้นหาบิล...' : `-- เลือกเลขบิล (${bills.length}) --`}</option>
        {selectedIsMissing && <option value={selectedOrderId}>{selectedBillNo}</option>}
        {bills.map((bill) => (
          <option key={bill.id} value={bill.id}>
            {bill.bill_no} — {bill.channel_code}{bill.channel_order_no ? ` / ${bill.channel_order_no}` : ''}{bill.customer_name ? ` — ${bill.customer_name}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

export default function RequisitionDashboard() {
  const { user } = useAuthContext()
  const [requisitions, setRequisitions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRequisition, setSelectedRequisition] = useState<any | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [filterDateStart, setFilterDateStart] = useState('')
  const [filterDateEnd, setFilterDateEnd] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterTopic, setFilterTopic] = useState('')
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [listTopics, setListTopics] = useState<string[]>([])
  const [listDamagePhotoUrls, setListDamagePhotoUrls] = useState<Record<string, string>>({})
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal({ showCancelButton: false })

  // --- Create requisition state ---
  const [showCreate, setShowCreate] = useState(false)
  const [cSearchTerm, setCSearchTerm] = useState('')
  const [cProducts, setCProducts] = useState<any[]>([])
  const [cAllProducts, setCAllProducts] = useState<any[]>([])
  const [cSelectedItems, setCSelectedItems] = useState<any[]>([])
  const [cRequisitionId, setCRequisitionId] = useState('')
  const [cTopics, setCTopics] = useState<any[]>([])
  const [cSearching, setCSearching] = useState(false)
  const [cLoadingProducts, setCLoadingProducts] = useState(false)
  const [cProductType, setCProductType] = useState<ProductType>('FG')
  const [cSubmitting, setCSubmitting] = useState(false)
  const [cChannels, setCChannels] = useState<ChannelOption[]>([])

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
  }, [filterDateStart, filterDateEnd, filterStatus, filterTopic, page])

  const loadRequisitions = async () => {
    try {
      setLoading(true)
      const itemRelation = filterTopic
        ? 'wms_requisition_items!inner(requisition_topic,damage_image_paths,reference_bill_no)'
        : 'wms_requisition_items(requisition_topic,damage_image_paths,reference_bill_no)'
      let query = supabase
        .from('wms_requisitions')
        .select(`*, ${itemRelation}`, { count: 'exact' })
        .order('created_at', { ascending: false })

      if (filterDateStart) {
        query = query.gte('created_at', filterDateStart + 'T00:00:00')
      }
      if (filterDateEnd) {
        query = query.lte('created_at', filterDateEnd + 'T23:59:59')
      }
      if (filterStatus) {
        query = query.eq('status', filterStatus)
      }
      if (filterTopic) {
        query = query.eq('wms_requisition_items.requisition_topic', filterTopic)
      }

      query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
      const [{ data, error, count }, { data: topicRows }] = await Promise.all([
        query,
        supabase.from('wms_requisition_topics').select('topic_name').order('topic_name'),
      ])
      if (error) throw error
      setTotalCount(count || 0)
      setListTopics((topicRows || []).map((row: any) => String(row.topic_name || '').trim()).filter(Boolean))

      const rows = data || []
      const damagePaths = [...new Set(rows.flatMap((requisition: any) =>
        (requisition.wms_requisition_items || []).flatMap((item: any) => item.damage_image_paths || [])))] as string[]
      if (damagePaths.length) {
        const { data: signed } = await supabase.storage.from(DAMAGE_BUCKET).createSignedUrls(damagePaths, 3600)
        const urls: Record<string, string> = {}
        ;(signed || []).forEach((row: any, index: number) => {
          if (row.signedUrl) urls[damagePaths[index]] = row.signedUrl
        })
        setListDamagePhotoUrls(urls)
      } else {
        setListDamagePhotoUrls({})
      }
      const userIds = [...new Set(rows.flatMap((r: any) => [r.created_by, r.approved_by].filter(Boolean)))]
      const userMap = new Map<string, string>()
      if (userIds.length > 0) {
        const { data: users } = await supabase.from('us_users').select('id, username').in('id', userIds)
        for (const u of (users ?? []) as { id: string; username: string }[]) userMap.set(u.id, u.username)
      }
      const requisitionsWithUsers = rows.map((req: any) => ({
        ...req,
        created_by_user: req.created_by ? { username: userMap.get(req.created_by) || '-' } : null,
        approved_by_user: req.approved_by ? { username: userMap.get(req.approved_by) || '-' } : null,
      }))

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
          หมายเหตุใบเบิก: requisition.notes || '-',
        }

        if (!items || items.length === 0) {
          return [
            {
              ...baseData,
              รหัสสินค้า: '-',
              รายการสินค้า: '-',
              หัวข้อการเบิก: '-',
              เลขบิลอ้างอิง: '-',
              หมายเหตุ: '-',
              จุดเก็บ: '-',
              จำนวน: '-',
              หน่วย: '-',
              จำนวนรูปหลักฐาน: 0,
              _requisitionId: requisition.requisition_id,
            },
          ]
        }

        return items.map((item: any) => ({
          ...baseData,
          รหัสสินค้า: item.product_code || '-',
          รายการสินค้า: item.product_name || '-',
          หัวข้อการเบิก: item.requisition_topic || '-',
          เลขบิลอ้างอิง: item.reference_bill_no || '-',
          หมายเหตุ: item.item_note?.trim() || '-',
          จุดเก็บ: item.location || '-',
          จำนวน: item.qty.toString(),
          หน่วย: item.unit_name || 'ชิ้น',
          จำนวนรูปหลักฐาน: (item.damage_image_paths || []).length,
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
        width: key === 'รายการสินค้า' ? 32
          : key === 'หมายเหตุ' || key === 'หมายเหตุใบเบิก' ? 36
            : key.includes('วันที่') ? 22
              : 18,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.height = 25
      for (let colIndex = 0; colIndex < headerKeys.length; colIndex++) {
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
          cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true }
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
    total: totalCount,
    pending: requisitions.filter((r) => r.status === 'pending').length,
    approved: requisitions.filter((r) => r.status === 'approved').length,
    rejected: requisitions.filter((r) => r.status === 'rejected').length,
  }

  // --- Create requisition helpers ---
  const openCreateModal = async () => {
    setShowCreate(true)
    setCSelectedItems([])
    setCSearchTerm('')
    setCProducts([])
    setCProductType('FG')
    await Promise.all([generateCRequisitionId(), loadCAllProducts('FG'), loadCTopics(), loadCChannels()])
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
        .select('product_code, product_name, storage_location, unit_name')
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
        .select('product_code, product_name, storage_location, unit_name')
        .eq('is_active', true)
        .eq('product_type', cProductType)
        .or(buildIlikeOr(cSearchTerm, ['product_code', 'product_name']))
        .limit(20)
      setCProducts(data || [])
    } finally {
      setCSearching(false)
    }
  }

  const loadCChannels = async () => {
    const { data } = await supabase.from('channels').select('channel_code, channel_name').order('channel_code')
    setCChannels((data || []) as ChannelOption[])
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const setFilterAndResetPage = (setter: (value: string) => void, value: string) => {
    setPage(1)
    setter(value)
  }

  const getRequisitionTopics = (req: any) => [...new Set<string>((req.wms_requisition_items || [])
    .map((item: any) => String(item.requisition_topic || '').trim())
    .filter(Boolean))]

  useEffect(() => {
    if (!showCreate) return
    const timer = window.setTimeout(() => { void cSearchProducts() }, 250)
    return () => window.clearTimeout(timer)
  }, [cSearchTerm, cProductType, showCreate])

  const cAddItem = (product: any) => {
    const existing = cSelectedItems.find((i: any) => i.product_code === product.product_code)
    if (existing) {
      setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === product.product_code ? { ...i, qty: i.qty + 1 } : i))
    } else {
      setCSelectedItems([...cSelectedItems, { ...product, qty: 1, requisition_topic: '', item_note: '', damage_files: [], damage_previews: [] }])
    }
  }

  const cRemoveItem = (code: string) => setCSelectedItems(cSelectedItems.filter((i: any) => i.product_code !== code))

  const cUpdateQty = (code: string, qty: number) => {
    if (qty < 1) { cRemoveItem(code); return }
    setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === code ? { ...i, qty } : i))
  }

  const cUpdateTopic = (code: string, topic: string) => {
    setCSelectedItems(cSelectedItems.map((i: any) => {
      if (i.product_code !== code) return i
      if (!requiresDamageEvidence(topic)) (i.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...i, requisition_topic: topic,
        reference_order_id: topic === 'ผลิตเสีย' ? i.reference_order_id : null,
        reference_bill_no: topic === 'ผลิตเสีย' ? i.reference_bill_no : '',
        damage_files: requiresDamageEvidence(topic) ? i.damage_files : [],
        damage_previews: requiresDamageEvidence(topic) ? i.damage_previews : [] }
    }))
  }

  const cUpdateReferenceBill = (code: string, bill: ReferenceBill | null) => {
    setCSelectedItems((current) => current.map((item: any) => item.product_code === code
      ? { ...item, reference_order_id: bill?.id || null, reference_bill_no: bill?.bill_no || '' }
      : item))
  }

  const cUpdateNote = (code: string, item_note: string) => {
    setCSelectedItems(cSelectedItems.map((i: any) => i.product_code === code ? { ...i, item_note } : i))
  }

  const cAddDamagePhotos = (code: string, files: FileList | null) => {
    if (!files) return
    setCSelectedItems((current) => current.map((item: any) => {
      if (item.product_code !== code) return item
      const accepted = Array.from(files).filter((file) => file.type.startsWith('image/') && file.size <= 10 * 1024 * 1024)
      const nextFiles = [...(item.damage_files || []), ...accepted].slice(0, 5)
      ;(item.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...item, damage_files: nextFiles, damage_previews: nextFiles.map(URL.createObjectURL) }
    }))
  }

  const cRemoveDamagePhoto = (code: string, index: number) => {
    setCSelectedItems((current) => current.map((item: any) => {
      if (item.product_code !== code) return item
      const nextFiles = (item.damage_files || []).filter((_: File, fileIndex: number) => fileIndex !== index)
      ;(item.damage_previews || []).forEach(URL.revokeObjectURL)
      return { ...item, damage_files: nextFiles, damage_previews: nextFiles.map(URL.createObjectURL) }
    }))
  }

  const cSubmit = async () => {
    if (cSelectedItems.length === 0) { showMessage({ message: 'กรุณาเพิ่มรายการสินค้า' }); return }
    if (cSelectedItems.some((i: any) => !i.requisition_topic)) { showMessage({ message: 'กรุณาเลือกหัวข้อการเบิกให้ครบทุกรายการ' }); return }
    if (cSelectedItems.some((i: any) => requiresDamageEvidence(i.requisition_topic) && !i.item_note?.trim())) {
      showMessage({ message: 'หัวข้อผลิตเสียและสินค้าชำรุดต้องกรอกเหตุผล/หมายเหตุให้ครบทุกรายการ' }); return
    }
    if (cSelectedItems.some((i: any) => requiresDamageEvidence(i.requisition_topic) && !(i.damage_files || []).length)) {
      showMessage({ message: 'หัวข้อผลิตเสียและสินค้าชำรุดต้องแนบรูปอย่างน้อย 1 รูปต่อรายการ' }); return
    }
    if (cSelectedItems.some((i: any) => i.requisition_topic === 'ผลิตเสีย' && !i.reference_order_id)) {
      showMessage({ message: 'หัวข้อผลิตเสียต้องเลือกเลขบิลอ้างอิงให้ครบทุกรายการ' }); return
    }

    const ok = await showConfirm({ title: 'ยืนยันสร้างใบเบิก', message: `สร้างใบเบิก ${cRequisitionId}?\nจำนวน ${cSelectedItems.length} รายการ` })
    if (!ok) return

    setCSubmitting(true)
    const uploadedPaths: string[] = []
    try {
      const { error: reqErr } = await supabase.from('wms_requisitions').insert({
        requisition_id: cRequisitionId,
        created_by: user?.id,
        status: 'pending',
        notes: null,
        requisition_topic: null,
      })
      if (reqErr) throw reqErr

      const items = []
      for (const item of cSelectedItems) {
        const damagePaths: string[] = []
        for (const file of item.damage_files || []) {
          const ext = file.name.split('.').pop() || 'jpg'
          const path = `${user?.id}/${cRequisitionId}/${item.product_code}/${crypto.randomUUID()}.${ext}`
          const { error } = await supabase.storage.from(DAMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
          if (error) throw error
          uploadedPaths.push(path); damagePaths.push(path)
        }
        items.push({ requisition_id: cRequisitionId, product_code: item.product_code, product_name: item.product_name,
          location: item.storage_location || null, qty: item.qty, unit_name: item.unit_name?.trim() || 'ชิ้น', requisition_topic: item.requisition_topic || null,
          item_note: item.item_note?.trim() || null, damage_image_paths: damagePaths,
          reference_order_id: item.reference_order_id || null, reference_bill_no: item.reference_bill_no || null })
      }
      const { error: itemErr } = await supabase.from('wms_requisition_items').insert(items)
      if (itemErr) throw itemErr

      showMessage({ message: `สร้างใบเบิก ${cRequisitionId} สำเร็จ` })
      setShowCreate(false)
      loadRequisitions()
      window.dispatchEvent(new Event('wms-data-changed'))
    } catch (e: any) {
      if (uploadedPaths.length) await supabase.storage.from(DAMAGE_BUCKET).remove(uploadedPaths)
      await supabase.from('wms_requisitions').delete().eq('requisition_id', cRequisitionId)
      showMessage({ message: `สร้างใบเบิกไม่สำเร็จ: ${e.message}` })
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
                onChange={(e) => setFilterAndResetPage(setFilterDateStart, e.target.value)}
                className="border p-2 rounded-lg text-sm outline-none shadow-sm"
              />
              <span className="text-gray-400 self-center">-</span>
              <input
                type="date"
                value={filterDateEnd}
                onChange={(e) => setFilterAndResetPage(setFilterDateEnd, e.target.value)}
                className="border p-2 rounded-lg text-sm outline-none shadow-sm"
              />
            </div>
          </div>
          <div className="w-48">
            <label className="text-sm font-bold text-gray-700 uppercase mb-2 block">สถานะ</label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterAndResetPage(setFilterStatus, e.target.value)}
              className="w-full border p-2 rounded-lg text-sm outline-none"
            >
              <option value="">ทั้งหมด</option>
              <option value="pending">รออนุมัติ</option>
              <option value="approved">อนุมัติแล้ว</option>
              <option value="rejected">ปฏิเสธ</option>
            </select>
          </div>
          <div className="w-52">
            <label className="text-sm font-bold text-gray-700 uppercase mb-2 block">ประเภทใบเบิก</label>
            <select
              value={filterTopic}
              onChange={(e) => setFilterAndResetPage(setFilterTopic, e.target.value)}
              className="w-full border p-2 rounded-lg text-sm outline-none"
            >
              <option value="">ทั้งหมด</option>
              {listTopics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
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
          <table className="w-full text-left text-sm text-slate-700">
            <thead className="bg-slate-50 text-sm font-semibold text-slate-700">
              <tr>
                <th className="p-4">รายการเบิก</th>
                <th className="p-4 text-center">รูปหลักฐาน</th>
                <th className="p-4">ผู้เบิก</th>
                <th className="p-4">ผู้อนุมัติ</th>
                <th className="p-4">วันที่ทำรายการ</th>
                <th className="p-4">วันที่อนุมัติ</th>
                <th className="p-4 text-center">สถานะ</th>
                <th className="p-4 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {requisitions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-400">
                    <i className="fas fa-inbox text-4xl mb-2"></i>
                    <div>ไม่มีข้อมูล</div>
                  </td>
                </tr>
              ) : (
                requisitions.map((req) => (
                  <tr key={req.id} className="border-b border-slate-200 transition-colors hover:bg-blue-50/60">
                    <td className="p-4">
                      <div className="font-black text-blue-600">{req.requisition_id}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {getRequisitionTopics(req).map((topic) => (
                          <div key={topic} className="inline-flex items-center gap-1">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${topic === 'ผลิตเสีย' ? 'bg-red-100 text-red-700 ring-1 ring-red-200' : 'bg-blue-50 text-blue-700'}`}>
                              {topic === 'ผลิตเสีย' && <i className="fas fa-triangle-exclamation mr-1" />}{topic}
                            </span>
                            {topic === 'ผลิตเสีย' && [...new Set<string>((req.wms_requisition_items || [])
                              .filter((item: any) => item.requisition_topic === 'ผลิตเสีย')
                              .map((item: any) => String(item.reference_bill_no || '').trim()).filter(Boolean))].map((billNo) => (
                                <span key={billNo} className="text-xs font-semibold text-amber-700">อ้างอิง: {billNo}</span>
                              ))}
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex min-w-[84px] justify-center -space-x-2">
                        {[...new Set((req.wms_requisition_items || []).flatMap((item: any) => item.damage_image_paths || []))]
                          .slice(0, 3).map((path: any) => listDamagePhotoUrls[path] && (
                            <a key={path} href={listDamagePhotoUrls[path]} target="_blank" rel="noreferrer" className="relative block h-11 w-11 overflow-hidden rounded-lg border-2 border-white bg-gray-100 shadow-sm">
                              <img src={listDamagePhotoUrls[path]} alt="รูปหลักฐาน" className="h-full w-full object-cover" />
                            </a>
                          ))}
                        {!(req.wms_requisition_items || []).some((item: any) => (item.damage_image_paths || []).length) && <span className="text-gray-400">-</span>}
                      </div>
                    </td>
                    <td className="p-4 font-bold text-slate-700">{req.created_by_user?.username || '---'}</td>
                    <td className="p-4 font-bold text-slate-700">{req.approved_by_user?.username || '-'}</td>
                    <td className="p-4 whitespace-nowrap text-base font-medium tabular-nums text-slate-700">{formatDate(req.created_at)}</td>
                    <td className="p-4 whitespace-nowrap text-base font-medium tabular-nums text-slate-700">{formatDate(req.approved_at)}</td>
                    <td className="p-4 text-center">{getStatusBadge(req.status)}</td>
                    <td className="p-4 text-center">
                      <button onClick={() => openDetail(req)} className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100 hover:text-blue-800">
                        ดูรายละเอียด
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between border-t pt-4 text-sm">
          <span className="text-gray-500">แสดง {requisitions.length} จาก {totalCount} ใบ</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="rounded-lg border px-3 py-1.5 font-bold disabled:opacity-40">ก่อนหน้า</button>
            <span className="font-semibold">หน้า {page} / {totalPages}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="rounded-lg border px-3 py-1.5 font-bold disabled:opacity-40">ถัดไป</button>
          </div>
        </div>
      </div>

      {isModalOpen && selectedRequisition && <RequisitionDetailModal requisition={selectedRequisition} onClose={closeModal} />}

      {/* Create Requisition Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} closeOnBackdropClick={false} contentClassName="max-w-5xl">
        <div className="bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
          <div className="p-6 pr-16 border-b flex items-center bg-gradient-to-r from-blue-600 to-blue-700">
            <div>
              <h2 className="text-2xl font-black text-white">สร้างใบเบิกสินค้า</h2>
              <span className="text-sm font-bold text-blue-200">{cRequisitionId}</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
            <div className="grid grid-cols-2 gap-6">
              {/* Left: product search & select */}
              <div className="space-y-4">
                <div className="bg-white p-5 rounded-xl border shadow-sm space-y-3">
                  <h3 className="font-bold text-slate-800 text-base">ค้นหาสินค้า</h3>
                  <div className="flex gap-2">
                    {(['FG', 'RM', 'PP'] as ProductType[]).map((pt) => (
                      <button key={pt} type="button" onClick={() => { setCProductType(pt); loadCAllProducts(pt); setCProducts([]); setCSearchTerm('') }}
                        className={`flex-1 py-2 rounded-lg font-bold text-sm transition ${cProductType === pt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                        {pt === 'FG' ? 'FG สินค้าสำเร็จรูป' : pt === 'RM' ? 'RM วัตถุดิบ' : 'PP สินค้าแปรรูป'}
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
                  <div>
                    <input type="search" value={cSearchTerm} onChange={(e) => setCSearchTerm(e.target.value)}
                      placeholder="รหัสหรือชื่อสินค้า..."
                      className="w-full border p-2.5 rounded-lg text-sm" />
                    {cSearching && <div className="mt-1 text-xs text-gray-400">กำลังกรองรายการ...</div>}
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

              {/* Right: selected items */}
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
                              <span className="ml-1 text-xs font-semibold text-gray-600">{item.unit_name || 'ชิ้น'}</span>
                              <button onClick={() => cUpdateQty(item.product_code, item.qty + 1)} className="w-8 h-8 rounded-lg bg-green-100 text-green-600 font-bold hover:bg-green-200">+</button>
                            </div>
                          </div>
                          {item.requisition_topic === 'ผลิตเสีย' && (
                            <ReferenceBillSelector
                              selectedOrderId={item.reference_order_id || ''}
                              selectedBillNo={item.reference_bill_no || ''}
                              channels={cChannels}
                              onChange={(bill) => cUpdateReferenceBill(item.product_code, bill)}
                            />
                          )}
                          <textarea
                            value={item.item_note || ''}
                            onChange={(e) => cUpdateNote(item.product_code, e.target.value)}
                            placeholder={requiresDamageEvidence(item.requisition_topic) ? 'กรุณาระบุเหตุผล/รายละเอียดความเสียหาย *' : 'หมายเหตุรายการ (ไม่บังคับกรอก)'}
                            className={`w-full border p-2.5 rounded-lg text-sm resize-none ${requiresDamageEvidence(item.requisition_topic) && !item.item_note?.trim() ? 'border-red-400' : 'border-gray-300'}`}
                            rows={2}
                          />
                          {requiresDamageEvidence(item.requisition_topic) && <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-red-700">รูปหลักฐานอย่างน้อย 1 รูป *</span>
                              <label className="cursor-pointer rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white">
                                <i className="fas fa-camera mr-1" />แนบรูป
                                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { cAddDamagePhotos(item.product_code, e.target.files); e.currentTarget.value = '' }} />
                              </label>
                            </div>
                            {!!item.damage_previews?.length ? <div className="grid grid-cols-4 gap-2">
                              {item.damage_previews.map((src: string, index: number) => <div key={src} className="relative aspect-square">
                                <img src={src} alt="รูปหลักฐาน" className="h-full w-full rounded-lg object-cover" />
                                <button type="button" onClick={() => cRemoveDamagePhoto(item.product_code, index)} className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white">×</button>
                              </div>)}
                            </div> : <div className="text-xs text-red-500">ยังไม่ได้แนบรูปหลักฐาน</div>}
                          </div>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 border-t bg-white flex justify-end gap-3">
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
