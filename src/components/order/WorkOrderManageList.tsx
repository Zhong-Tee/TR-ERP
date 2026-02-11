import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, WorkOrder } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import OrderDetailView from './OrderDetailView'
import * as XLSX from 'xlsx'

/** ช่องทางที่ใช้ปุ่ม "เรียงใบปะหน้า" (อ้างอิง file/index.html) */
const WAYBILL_SORT_CHANNELS = ['FSPTR', 'SPTR', 'TTTR', 'LZTR', 'SHOP']
/** ช่องทางที่ที่อยู่ไม่ส่งไปใบปะหน้า (SHOP แสดงที่อยู่เหมือน FBTR) */
const ECOMMERCE_CHANNELS = ['LZTR']
/** หมวดสินค้าที่ไม่นับเป็นสินค้าหลัก (นับเป็นอะไหล่เท่านั้น) */
const PICKING_EXCLUDED_CATEGORIES = ['UV', 'STK', 'TUBE']

/** คอลัมน์ระดับรายการใน Export ไฟล์ผลิต — แมป key → ชื่อคอลัมน์ใน pr_category_field_settings */
const EXPORT_ITEM_COLUMNS: Array<{ key: string; label: string; settingsKey: string }> = [
  { key: 'product_name', label: 'ชื่อสินค้า', settingsKey: 'product_name' },
  { key: 'ink_color', label: 'สีหมึก', settingsKey: 'ink_color' },
  { key: 'product_type', label: 'ชั้นที่', settingsKey: 'layer' },
  { key: 'cartoon_pattern', label: 'ลายการ์ตูน', settingsKey: 'cartoon_pattern' },
  { key: 'line_pattern', label: 'ลายเส้น', settingsKey: 'line_pattern' },
  { key: 'font', label: 'ฟอนต์', settingsKey: 'font' },
  { key: 'no_name_line', label: 'ชื่อ ไม่รับชื่อ', settingsKey: 'line_1' },
  { key: 'line_1', label: 'บรรทัด 1', settingsKey: 'line_1' },
  { key: 'line_2', label: 'บรรทัด 2', settingsKey: 'line_2' },
  { key: 'line_3', label: 'บรรทัด 3', settingsKey: 'line_3' },
  { key: 'quantity', label: 'จำนวน', settingsKey: 'quantity' },
  { key: 'notes', label: 'หมายเหตุ', settingsKey: 'notes' },
  { key: 'file_attachment', label: 'ไฟล์แนบ', settingsKey: 'attachment' },
]

interface WorkOrderManageListProps {
  searchTerm?: string
  channelFilter?: string
  onRefresh?: () => void
}

/** Modal แจ้งข้อความ */
type MessageModal = { open: boolean; message: string }
/** Modal ยืนยัน พร้อม callback */
type ConfirmModal = { open: boolean; title: string; message: string; onConfirm: () => void }
/** Modal ใบเบิก — สินค้าหลัก + อะไหล่ (หน้ายาง/โฟม) ตามต้นฉบับ */
type PickingSlipModal = { open: boolean; workOrderName: string | null; mainItems: PickingMainRow[]; spareItems: PickingSpareRow[] }
/** Modal นำเข้าเลขพัสดุ */
type ImportTrackingModal = { open: boolean; workOrderName: string | null }
/** Modal เรียงใบปะหน้า: เปิด + ชื่อใบงาน + ลำดับเลขพัสดุจากออร์เดอร์ */
type WaybillSorterModal = { open: boolean; workOrderName: string | null; trackingNumbers: string[] }
/** สินค้าหลัก: จุดเก็บ, รหัส, รายการ, จำนวนเบิก */
interface PickingMainRow { woName: string; code: string; name: string; location: string; finalQty: number }
/** อะไหล่: รายการอะไหล่, จำนวน */
interface PickingSpareRow { name: string; qty: number }

export default function WorkOrderManageList({
  searchTerm = '',
  channelFilter = '',
  onRefresh,
}: WorkOrderManageListProps) {
  const { user } = useAuthContext()
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [channelByWo, setChannelByWo] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [expandedWo, setExpandedWo] = useState<string | null>(null)
  const [ordersByWo, setOrdersByWo] = useState<Record<string, Order[]>>({})
  const [selectedByWo, setSelectedByWo] = useState<Record<string, Set<string>>>({})
  const [editingTrackingId, setEditingTrackingId] = useState<string | null>(null)
  const [editingTrackingValue, setEditingTrackingValue] = useState('')
  const [updating, setUpdating] = useState(false)
  const [_channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)

  const [messageModal, setMessageModal] = useState<MessageModal>({ open: false, message: '' })
  const [confirmModal, setConfirmModal] = useState<ConfirmModal>({ open: false, title: '', message: '', onConfirm: () => {} })
  const [pickingSlipModal, setPickingSlipModal] = useState<PickingSlipModal>({ open: false, workOrderName: null, mainItems: [], spareItems: [] })
  const [importTrackingModal, setImportTrackingModal] = useState<ImportTrackingModal>({ open: false, workOrderName: null })
  const [waybillSorterModal, setWaybillSorterModal] = useState<WaybillSorterModal>({ open: false, workOrderName: null, trackingNumbers: [] })
  const [wsLog, setWsLog] = useState<string[]>([])
  const [wsStatPdf, setWsStatPdf] = useState<string>('--')
  const [wsStatFound, setWsStatFound] = useState<string>('--')
  const [wsProgress, setWsProgress] = useState(0)
  const [wsMissing, setWsMissing] = useState<string[]>([])
  const [wsProcessing, setWsProcessing] = useState(false)
  const [wsCropTop, setWsCropTop] = useState(25)
  const [wsBatchSize, setWsBatchSize] = useState(25)
  const trackingFileInputRef = useRef<HTMLInputElement>(null)
  const waybillPdfInputRef = useRef<HTMLInputElement>(null)
  const pickingSlipContentRef = useRef<HTMLDivElement>(null)
  /** ตั้งค่าฟิลด์ที่อนุญาตให้กรอกต่อหมวดหมู่ (pr_category_field_settings) — ใช้กรองคอลัมน์ Export ไฟล์ผลิต ให้เหมือนเมนูรอตรวจคำสั่งซื้อ */
  const [categoryFieldSettings, setCategoryFieldSettings] = useState<Record<string, Record<string, boolean>>>({})

  useEffect(() => {
    loadWorkOrders()
  }, [channelFilter, searchTerm])

  // โหลด pr_category_field_settings ครั้งเดียว (เหมือน OrderReviewList)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.from('pr_category_field_settings').select('*')
        if (cancelled) return
        if (error) {
          console.error('Error loading category field settings:', error)
          return
        }
        function toBool(v: unknown, defaultVal = true): boolean {
          if (v === undefined || v === null) return defaultVal
          return v === true || v === 'true'
        }
        const settingsMap: Record<string, Record<string, boolean>> = {}
        if (data && Array.isArray(data)) {
          data.forEach((row: any) => {
            const cat = row.category
            if (cat != null && String(cat).trim() !== '') {
              const key = String(cat).trim()
              settingsMap[key] = {
                product_name: toBool(row.product_name, true),
                ink_color: toBool(row.ink_color, true),
                layer: toBool(row.layer, true),
                cartoon_pattern: toBool(row.cartoon_pattern, true),
                line_pattern: toBool(row.line_pattern, true),
                font: toBool(row.font, true),
                line_1: toBool(row.line_1, true),
                line_2: toBool(row.line_2, true),
                line_3: toBool(row.line_3, true),
                quantity: toBool(row.quantity, true),
                unit_price: toBool(row.unit_price, true),
                notes: toBool(row.notes, true),
                attachment: toBool(row.attachment, true),
              }
            }
          })
        }
        setCategoryFieldSettings(settingsMap)
      } catch (e) {
        if (!cancelled) console.error('Error loading category field settings:', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    async function loadChannels() {
      const { data } = await supabase.from('channels').select('channel_code, channel_name').order('channel_code')
      setChannels(data || [])
    }
    loadChannels()
  }, [])

  async function loadWorkOrders() {
    setLoading(true)
    try {
      let query = supabase
        .from('or_work_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)

      if (channelFilter) {
        query = query.like('work_order_name', `${channelFilter}-%`)
      }

      const { data, error } = await query
      if (error) throw error
      let list: WorkOrder[] = (data || []) as WorkOrder[]
      if (searchTerm.trim()) {
        const { data: orderMatch } = await supabase
          .from('or_orders')
          .select('work_order_name')
          .not('work_order_name', 'is', null)
          .neq('status', 'จัดส่งแล้ว')
          .or(`bill_no.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%`)
        const woNames = new Set((orderMatch || []).map((r: { work_order_name: string }) => r.work_order_name))
        list = list.filter((w) => woNames.has(w.work_order_name))
      }

      if (list.length > 0) {
        const { data: activeOrders } = await supabase
          .from('or_orders')
          .select('work_order_name')
          .not('work_order_name', 'is', null)
          .neq('status', 'จัดส่งแล้ว')
          .in(
            'work_order_name',
            list.map((w) => w.work_order_name)
          )
        const activeSet = new Set((activeOrders || []).map((r: { work_order_name: string }) => r.work_order_name))
        list = list.filter((w) => activeSet.has(w.work_order_name))
      }
      setWorkOrders(list)
      setOrdersByWo({})
      setSelectedByWo({})
      setExpandedWo(null)

      if (list.length > 0) {
        const workOrderNames = list.map((w) => w.work_order_name)
        const { data: orderChannels, error: channelErr } = await supabase
          .from('or_orders')
          .select('work_order_name, channel_code')
          .in('work_order_name', workOrderNames)
        if (!channelErr && orderChannels && orderChannels.length > 0) {
          const map: Record<string, string> = {}
          orderChannels.forEach((r: { work_order_name: string; channel_code: string }) => {
            if (r.work_order_name && !(r.work_order_name in map)) {
              map[r.work_order_name] = r.channel_code ?? ''
            }
          })
          setChannelByWo(map)
        } else {
          setChannelByWo({})
        }
      } else {
        setChannelByWo({})
      }
    } catch (error: any) {
      console.error('Error loading work orders:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message })
    } finally {
      setLoading(false)
    }
  }

  async function loadOrdersForWo(workOrderName: string) {
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, recipient_name, tracking_number, channel_code, customer_address, status, channel_order_no, total_amount, claim_type, admin_user')
        .eq('work_order_name', workOrderName)
        .neq('status', 'จัดส่งแล้ว')
        .order('created_at', { ascending: false })

      if (error) throw error
      const list = (data || []) as Order[]
      setOrdersByWo((prev) => ({ ...prev, [workOrderName]: list }))
      setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set<string>() }))
    } catch (error: any) {
      console.error('Error loading orders for WO:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  function toggleExpand(wo: WorkOrder) {
    if (expandedWo === wo.work_order_name) {
      setExpandedWo(null)
      return
    }
    setExpandedWo(wo.work_order_name)
    if (!ordersByWo[wo.work_order_name]) {
      loadOrdersForWo(wo.work_order_name)
    }
  }

  function toggleBillSelect(workOrderName: string, orderId: string) {
    setSelectedByWo((prev) => {
      const set = new Set(prev[workOrderName] || [])
      if (set.has(orderId)) set.delete(orderId)
      else set.add(orderId)
      return { ...prev, [workOrderName]: set }
    })
  }

  function selectAllBills(workOrderName: string) {
    const orders = ordersByWo[workOrderName] || []
    setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set(orders.map((o) => o.id)) }))
  }

  function clearBillSelection(workOrderName: string) {
    setSelectedByWo((prev) => ({ ...prev, [workOrderName]: new Set<string>() }))
  }

  async function moveSelectedTo(workOrderName: string, newStatus: string) {
    const ids = Array.from(selectedByWo[workOrderName] || [])
    if (ids.length === 0) {
      setMessageModal({ open: true, message: 'กรุณาเลือกบิลอย่างน้อย 1 รายการ' })
      return
    }
    setConfirmModal({
      open: true,
      title: 'ยืนยันการย้ายบิล',
      message: `ต้องการย้าย ${ids.length} บิล ไปสถานะ "${newStatus}" หรือไม่?`,
      onConfirm: () => doMoveSelectedTo(workOrderName, newStatus, ids),
    })
  }

  async function doMoveSelectedTo(workOrderName: string, newStatus: string, ids: string[]) {
    setConfirmModal((prev) => ({ ...prev, open: false }))
    setUpdating(true)
    try {
      const updates: Record<string, unknown> = { status: newStatus }
      if (newStatus === 'รอลงข้อมูล' || newStatus === 'ตรวจสอบแล้ว') {
        updates.work_order_name = null
      }
      if (newStatus === 'ยกเลิก') {
        updates.work_order_name = null
      }
      const { error } = await supabase.from('or_orders').update(updates).in('id', ids)
      if (error) throw error

      // เมื่อไม่มีบิลเหลือในใบงานแล้ว (ไม่ว่าย้ายไปรอลงข้อมูล / ตรวจสอบแล้ว / ยกเลิก) ให้ลบใบงานนั้นออก
      const { data: remaining } = await supabase
        .from('or_orders')
        .select('id')
        .eq('work_order_name', workOrderName)
      if (remaining && remaining.length === 0) {
        const { error: deleteWoError } = await supabase
          .from('or_work_orders')
          .delete()
          .eq('work_order_name', workOrderName)
        if (deleteWoError) {
          console.error('Error deleting empty work order:', deleteWoError)
          setMessageModal({ open: true, message: 'ย้ายบิลสำเร็จ แต่ลบใบงานว่างไม่สำเร็จ: ' + deleteWoError.message })
        } else {
          await supabase.from('plan_jobs').delete().eq('name', workOrderName)
          await loadWorkOrders()
        }
        onRefresh?.()
        return
      }

      const newCount = remaining!.length
      await supabase.from('or_work_orders').update({ order_count: newCount }).eq('work_order_name', workOrderName)
      setWorkOrders((prev) =>
        prev.map((wo) => (wo.work_order_name === workOrderName ? { ...wo, order_count: newCount } : wo))
      )
      await loadOrdersForWo(workOrderName)
      clearBillSelection(workOrderName)
      onRefresh?.()
    } catch (error: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setUpdating(false)
    }
  }

  async function saveTrackingNumber(orderId: string) {
    const value = editingTrackingValue.trim()
    setUpdating(true)
    try {
      const { error } = await supabase
        .from('or_orders')
        .update({ tracking_number: value || null })
        .eq('id', orderId)
      if (error) throw error
      setEditingTrackingId(null)
      setEditingTrackingValue('')
      const woName = Object.keys(ordersByWo).find((wo) => ordersByWo[wo].some((o) => o.id === orderId))
      if (woName) await loadOrdersForWo(woName)
    } catch (error: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setUpdating(false)
    }
  }

  function openCancelWorkOrderConfirm(workOrderName: string) {
    setConfirmModal({
      open: true,
      title: 'ยืนยันยกเลิกใบงาน',
      message: `ต้องการยกเลิกใบงาน "${workOrderName}" หรือไม่?`,
      onConfirm: () => doCancelWorkOrder(workOrderName),
    })
  }

  async function doCancelWorkOrder(workOrderName: string) {
    setConfirmModal((prev) => ({ ...prev, open: false }))
    setUpdating(true)
    try {
      const { error: updateError } = await supabase
        .from('or_orders')
        .update({ work_order_name: null, status: 'ลงข้อมูลเสร็จสิ้น' })
        .eq('work_order_name', workOrderName)
      if (updateError) throw updateError
      const { error: deleteError } = await supabase
        .from('or_work_orders')
        .delete()
        .eq('work_order_name', workOrderName)
      if (deleteError) throw deleteError
      await supabase.from('plan_jobs').delete().eq('name', workOrderName)
      await loadWorkOrders()
      onRefresh?.()
      setMessageModal({ open: true, message: `ยกเลิกใบงาน "${workOrderName}" เรียบร้อย` })
    } catch (error: any) {
      console.error('Error cancelling work order:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (error?.message ?? error) })
    } finally {
      setUpdating(false)
    }
  }

  async function openWaybillSorterModal(workOrderName: string) {
    const { data: ordersData } = await supabase
      .from('or_orders')
      .select('id, tracking_number, bill_no')
      .eq('work_order_name', workOrderName)
      .not('tracking_number', 'is', null)
      .order('bill_no', { ascending: true })
    const withTracking = (ordersData || []).filter((o) => o.tracking_number && String(o.tracking_number).trim() !== '')
    const trackingNumbers = withTracking.map((o) => String(o.tracking_number).trim())
    if (trackingNumbers.length === 0) {
      setMessageModal({ open: true, message: 'ไม่พบเลขพัสดุในใบงานนี้ กรุณานำเข้าเลขพัสดุก่อน' })
      return
    }
    setWsLog(['เตรียมข้อมูลเรียบร้อย กรุณาเลือกไฟล์ PDF ใบปะหน้า'])
    setWsStatPdf('--')
    setWsStatFound('--')
    setWsProgress(0)
    setWsMissing([])
    setWaybillSorterModal({ open: true, workOrderName, trackingNumbers })
  }

  function wsLogAppend(message: string, overwriteFirst = false) {
    setWsLog((prev) => (overwriteFirst && prev.length > 0 ? [message, ...prev.slice(1)] : [message, ...prev]))
  }

  async function processWaybillPdfs(files: FileList | null) {
    if (!files || files.length === 0 || !waybillSorterModal.workOrderName) return
    const workOrderName = waybillSorterModal.workOrderName
    const trackingNumbersRaw = waybillSorterModal.trackingNumbers
    setWsProcessing(true)
    setWsStatPdf(String(files.length))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ocrWorker: any = null
    try {
      const normText = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const normOCR = (s: string) => normText(s).replace(/O/g, '0').replace(/I/g, '1').replace(/Z/g, '2').replace(/S/g, '5').replace(/B/g, '8')
      const targetsText = trackingNumbersRaw.map(normText)
      const targetsOCR = trackingNumbersRaw.map(normOCR)
      const targetsTextSet = new Set(targetsText)
      const targetsOCRSet = new Set(targetsOCR)
      const ocr2textMap = new Map<string, string>()
      trackingNumbersRaw.forEach((_orig, i) => ocr2textMap.set(targetsOCR[i], targetsText[i]))

      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
      const { PDFDocument } = await import('pdf-lib')
      const Tesseract = await import('tesseract.js')

      wsLogAppend('⏳ เริ่มต้นระบบ OCR...')
      ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') setWsLog((p) => [`(OCR ${(m.progress * 100).toFixed(0)}%)`, ...p.slice(1)])
        },
      })
      if (ocrWorker) await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const mapping = new Map<string, { fileIndex: number; pageIndex: number }>()
      const fileBuffers: ArrayBuffer[] = []

      const pageTextNormalized = async (page: { getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }) => {
        const tc = await page.getTextContent()
        let text = ''
        tc.items.forEach((it) => {
          if ('str' in it && it.str) text += it.str + ' '
        })
        return normText(text)
      }
      const renderPageToCanvas = async (
        page: { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } },
        scale = 2
      ) => {
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return canvas
        await page.render({ canvasContext: ctx, viewport }).promise
        return canvas
      }
      const cropTop = (canvas: HTMLCanvasElement, percent: number) => {
        const p = Math.max(5, Math.min(60, percent))
        const h = canvas.height
        const w = canvas.width
        const ch = Math.round(h * (p / 100))
        const c2 = document.createElement('canvas')
        c2.width = w
        c2.height = ch
        const ctx2 = c2.getContext('2d')
        if (ctx2) ctx2.drawImage(canvas, 0, 0, w, ch, 0, 0, w, ch)
        return c2
      }
      const ocrCanvasToNorm = async (canvas: HTMLCanvasElement) => {
        const { data } = await ocrWorker!.recognize(canvas)
        return normOCR(data?.text || '')
      }

      const cropTopPct = wsCropTop || 25
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx]
        wsLogAppend(`🔎 สแกนไฟล์: ${file.name} (${idx + 1}/${files.length})`)
        setWsProgress(Math.round((idx / files.length) * 100))
        await sleep(0)
        const buf = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise
        const results: { trackingKeyText: string; pageIndex: number }[] = []
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const textNorm = await pageTextNormalized(page as { getTextContent: () => Promise<{ items: Array<{ str?: string }> }> })
          let keyText: string | null = null
          for (const t of targetsTextSet) {
            if (textNorm.includes(t)) {
              keyText = t
              break
            }
          }
          if (!keyText) {
            const fullCanvas = await renderPageToCanvas(page as { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } }, 2)
            const topCanvas = cropTop(fullCanvas, cropTopPct)
            const topNorm = await ocrCanvasToNorm(topCanvas)
            for (const k of targetsOCRSet) {
              if (topNorm.includes(k)) {
                keyText = ocr2textMap.get(k) ?? null
                break
              }
            }
          }
          if (!keyText) {
            const fullCanvas = await renderPageToCanvas(page as { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } }, 2)
            const fullNorm = await ocrCanvasToNorm(fullCanvas)
            for (const k of targetsOCRSet) {
              if (fullNorm.includes(k)) {
                keyText = ocr2textMap.get(k) ?? null
                break
              }
            }
          }
          if (keyText) results.push({ trackingKeyText: keyText, pageIndex: i - 1 })
        }
        fileBuffers.push(buf)
        for (const p of results) {
          if (!mapping.has(p.trackingKeyText)) {
            mapping.set(p.trackingKeyText, { fileIndex: idx, pageIndex: p.pageIndex })
            setWsStatFound(String(mapping.size))
          }
        }
      }
      setWsProgress(100)
      wsLogAppend('⏳ รวมหน้าเป็นไฟล์เดียวตามลำดับ...')

      const merged = await PDFDocument.create()
      const docCache = new Map<number, Awaited<ReturnType<typeof PDFDocument.load>>>()
      const missing: string[] = []
      const batchSize = wsBatchSize || 25
      for (let i = 0; i < trackingNumbersRaw.length; i++) {
        const keyText = targetsText[i]
        const original = trackingNumbersRaw[i]
        if (mapping.has(keyText)) {
          const { fileIndex, pageIndex } = mapping.get(keyText)!
          let srcDoc = docCache.get(fileIndex)
          if (!srcDoc) {
            srcDoc = await PDFDocument.load(fileBuffers[fileIndex])
            docCache.set(fileIndex, srcDoc)
          }
          const [copied] = await merged.copyPages(srcDoc, [pageIndex])
          merged.addPage(copied)
        } else {
          missing.push(original)
        }
        if ((i + 1) % batchSize === 0) wsLogAppend(`🧩 รวมหน้า... ${i + 1}/${trackingNumbersRaw.length}`)
        await sleep(0)
      }
      setWsMissing(missing)
      if (missing.length > 0) wsLogAppend(`⚠️ ไม่พบ ${missing.length} รายการ`)
      else wsLogAppend('✅ พบครบทุกเลข')
      wsLogAppend('⏳ กำลังบันทึกไฟล์ PDF...')
      await sleep(0)
      const outBytes = await merged.save()
      const blob = new Blob([outBytes as BlobPart], { type: 'application/pdf' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `sorted_waybills_${workOrderName}.pdf`
      a.click()
      URL.revokeObjectURL(a.href)
      wsLogAppend('✅ เสร็จสิ้น! ดาวน์โหลดไฟล์แล้ว')
    } catch (err: any) {
      console.error(err)
      wsLogAppend('❌ เกิดข้อผิดพลาด: ' + (err?.message ?? err))
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดเรียงใบปะหน้า: ' + (err?.message ?? err) })
    } finally {
      setWsProcessing(false)
      if (ocrWorker) {
        try {
          await ocrWorker.terminate()
          wsLogAppend('ⓘ ปิดระบบ OCR เรียบร้อย')
        } catch (_) {}
      }
    }
  }

  function downloadMissingWaybillCsv() {
    const rows = wsMissing
    const csv = '\uFEFFเลขพัสดุที่ไม่พบ\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'missing_tracking.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  /** ป้องกันการคลิกปุ่มไป trigger toggle แถว (stopPropagation + preventDefault) */
  function onHeaderButtonClick(e: React.MouseEvent, fn: () => void) {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }

  const forceText = (val: string | null | undefined) => {
    const str = String(val ?? '').trim()
    if (str === '') return ''
    if (str.startsWith('+') || str.startsWith('0')) return '\u200B' + str
    return str
  }

  type OrderWithItems = Order & { or_order_items?: Array<{ bill_no?: string; item_uid: string; product_name: string; ink_color: string | null; product_type: string | null; cartoon_pattern: string | null; line_pattern: string | null; font: string | null; line_1: string | null; line_2: string | null; line_3: string | null; no_name_line?: boolean; notes: string | null; file_attachment: string | null; product_id: string }> }

  async function fetchOrdersWithItems(workOrderName: string): Promise<OrderWithItems[]> {
    const { data, error } = await supabase
      .from('or_orders')
      .select('*, or_order_items(*)')
      .eq('work_order_name', workOrderName)
      .order('created_at', { ascending: false })
    if (error) throw error
    const list = (data || []) as OrderWithItems[]
    return list
  }

  /** คืนคอลัมน์ระดับรายการที่ "เปิดให้กรอก" ตาม pr_category_field_settings อย่างน้อยหนึ่งรายการ (เหมือน OrderReviewList) */
  function getVisibleExportItemColumns(
    orders: OrderWithItems[],
    categoryFieldSettings: Record<string, Record<string, boolean>>,
    productCategoryByProductId: Record<string, string>
  ): Array<{ key: string; label: string; settingsKey: string }> {
    const allItems: any[] = []
    orders.forEach((order) => {
      const items = order.or_order_items || (order as any).order_items || []
      allItems.push(...items)
    })
    if (allItems.length === 0) return EXPORT_ITEM_COLUMNS
    const hasSettings = Object.keys(categoryFieldSettings).length > 0
    const hasCategoryMap = Object.keys(productCategoryByProductId).length > 0
    if (!hasSettings || !hasCategoryMap) return EXPORT_ITEM_COLUMNS

    const enabled = new Set<string>()
    for (const def of EXPORT_ITEM_COLUMNS) {
      for (const item of allItems) {
        const productId = item.product_id != null ? String(item.product_id) : null
        const cat = productId ? productCategoryByProductId[productId] : null
        if (!cat || String(cat).trim() === '') {
          enabled.add(def.key)
          break
        }
        const categorySettings = categoryFieldSettings[String(cat).trim()]
        if (!categorySettings) {
          enabled.add(def.key)
          break
        }
        const v = categorySettings[def.settingsKey] as boolean | string | undefined
        if (v === undefined || v === null || v === true || v === 'true') {
          enabled.add(def.key)
          break
        }
      }
    }
    return EXPORT_ITEM_COLUMNS.filter((c) => enabled.has(c.key))
  }

  async function exportProduction(workOrderName: string) {
    try {
      const orders = await fetchOrdersWithItems(workOrderName)
      const ordersInWorkOrder = orders.sort((a, b) => (a.bill_no || '').localeCompare(b.bill_no || ''))
      if (ordersInWorkOrder.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบข้อมูล' })
        return
      }
      const allItems: any[] = []
      ordersInWorkOrder.forEach((order) => {
        const items = order.or_order_items || (order as any).order_items || []
        allItems.push(...items)
      })
      const productIds = Array.from(new Set(allItems.map((i: any) => i.product_id).filter(Boolean)))
      let productCategoryByProductId: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from('pr_products')
          .select('id, product_category')
          .in('id', productIds)
        if (products) {
          products.forEach((p: any) => {
            const cat = p.product_category
            if (cat != null && String(cat).trim() !== '') {
              productCategoryByProductId[String(p.id)] = String(cat).trim()
            }
          })
        }
      }
      const visibleColumns = getVisibleExportItemColumns(ordersInWorkOrder, categoryFieldSettings, productCategoryByProductId)
      const headers = ['ชื่อใบงาน', 'เลขบิล', 'Item UID', ...visibleColumns.map((c) => c.label)]
      const dataToExport: unknown[][] = []
      ordersInWorkOrder.forEach((order) => {
        const items = order.or_order_items || (order as any).order_items || []
        items.forEach((item: any) => {
          const noName = !!item.no_name_line
          const cleanNotes = noName ? ('ไม่รับชื่อ' + ((item.notes || '').replace(/\[SET-.*?\]/g, '').trim() ? ' ' + (item.notes || '').replace(/\[SET-.*?\]/g, '').trim() : '')) : (item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
          const row: unknown[] = [workOrderName, order.bill_no, item.item_uid]
          visibleColumns.forEach((col) => {
            if (col.key === 'no_name_line') row.push(noName ? 'ใช่' : '')
            else if (col.key === 'notes') row.push(cleanNotes)
            else if (col.key === 'line_1' || col.key === 'line_2' || col.key === 'line_3') row.push(forceText(item[col.key]))
            else if (col.key === 'quantity') row.push(1)
            else row.push(item[col.key] ?? '')
          })
          dataToExport.push(row)
        })
      })
      if (dataToExport.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบรายการสินค้า' })
        return
      }
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataToExport])
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'ProductionData')
      XLSX.writeFile(workbook, `Production_${workOrderName}.xlsx`)
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    }
  }

  async function exportBarcode(workOrderName: string) {
    try {
      const orders = await fetchOrdersWithItems(workOrderName)
      if (orders.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบข้อมูล' })
        return
      }
      const headers = ['Item UID', 'ชื่อสินค้า', 'สีหมึก', 'บรรทัด 1', 'หมวด']
      const dataToExport: unknown[][] = []
      orders.forEach((order) => {
        const items = order.or_order_items || (order as any).order_items || []
        items.forEach((item: any) => {
          dataToExport.push([
            item.item_uid,
            item.product_name,
            item.ink_color ?? '',
            forceText(item.line_1),
            'N/A',
          ])
        })
      })
      if (dataToExport.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบรายการสินค้า' })
        return
      }
      const csvContent = '\uFEFF' + [headers, ...dataToExport].map((row) => row.map((val) => `"${String(val ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `Barcode_${workOrderName}.csv`
      link.click()
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    }
  }

  async function exportWaybillCsv(workOrderName: string) {
    try {
      const orders = await fetchOrdersWithItems(workOrderName)
      if (orders.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบออร์เดอร์' })
        return
      }
      const headers = ['bill_no', 'customer_address', 'payment_method', 'total_amount']
      const escapeCsv = (v: string) => {
        const s = String(v ?? '')
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
        return s
      }
      const rows = orders.map((order) => {
        const address = ECOMMERCE_CHANNELS.includes(order.channel_code || '') ? '' : (order.customer_address || '')
        return [escapeCsv(order.bill_no), escapeCsv(address), escapeCsv(order.payment_method || ''), escapeCsv(String(order.total_amount ?? ''))].join(',')
      })
      const csvContent = [headers.join(','), ...rows].join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `Waybill_${workOrderName}.csv`
      link.click()
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    }
  }

  async function openPickingSlipModal(workOrderName: string) {
    try {
      const orders = await fetchOrdersWithItems(workOrderName)
      const itemList: Array<{ product_id: string; product_name: string; product_category?: string; product_code?: string; storage_location?: string; rubber_code?: string }> = []
      orders.forEach((order) => {
        const list = order.or_order_items || (order as any).order_items || []
        list.forEach((item: any) => itemList.push({ ...item, product_id: item.product_id }))
      })
      if (itemList.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบสินค้าในใบงานนี้' })
        return
      }
      const productIds = [...new Set(itemList.map((i) => i.product_id).filter(Boolean))]
      const productMap: Record<string, { product_code?: string; storage_location?: string; product_category?: string; rubber_code?: string }> = {}
      if (productIds.length > 0) {
        const { data: products } = await supabase
          .from('pr_products')
          .select('id, product_code, storage_location, product_category, rubber_code')
          .in('id', productIds)
        ;(products || []).forEach((p: any) => {
          productMap[p.id] = { product_code: p.product_code, storage_location: p.storage_location, product_category: p.product_category, rubber_code: p.rubber_code }
        })
      }
      const itemsInWorkOrder = itemList.map((item) => ({
        ...item,
        product_code: productMap[item.product_id]?.product_code ?? 'N/A',
        storage_location: productMap[item.product_id]?.storage_location ?? 'N/A',
        product_category: productMap[item.product_id]?.product_category ?? '',
        rubber_code: productMap[item.product_id]?.rubber_code,
      }))

      type MainRowWithCat = PickingMainRow & { _category: string }
      const mainMap = new Map<string, MainRowWithCat>()
      itemsInWorkOrder
        .filter((item) => !PICKING_EXCLUDED_CATEGORIES.some((ex) => (item.product_category || '').toUpperCase().includes(ex)))
        .forEach((item) => {
          const key = item.product_id
          const existing = mainMap.get(key)
          const code = item.product_code || 'N/A'
          const name = item.product_name || 'N/A'
          const location = item.storage_location || 'N/A'
          const category = (item.product_category || '').toUpperCase()
          if (existing) {
            existing.finalQty += 1
          } else {
            mainMap.set(key, { woName: workOrderName, code, name, location, finalQty: 1, _category: category })
          }
        })
      const finalMainList: PickingMainRow[] = Array.from(mainMap.values())
        .map((item) => {
          let finalQty = item.finalQty
          if (item._category.includes('CONDO STAMP')) finalQty = Math.ceil(item.finalQty / 5)
          return { woName: item.woName, code: item.code, name: item.name, location: item.location, finalQty }
        })
        .sort((a, b) => a.location.localeCompare(b.location))

      const spareMap = new Map<string, PickingSpareRow>()
      itemsInWorkOrder.forEach((item) => {
        if (item.rubber_code) {
          const key = item.rubber_code
          const existing = spareMap.get(key)
          if (existing) existing.qty += 1
          else spareMap.set(key, { name: `หน้ายาง+โฟม ${item.rubber_code}`, qty: 1 })
        }
      })
      const finalSpareList = Array.from(spareMap.values())

      if (finalMainList.length === 0 && finalSpareList.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบสินค้าในใบงานนี้' })
        return
      }
      setPickingSlipModal({ open: true, workOrderName, mainItems: finalMainList, spareItems: finalSpareList })
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    }
  }

  async function exportAllPickingFinal() {
    const { workOrderName, mainItems, spareItems } = pickingSlipModal
    if (!workOrderName) return
    try {
      if (pickingSlipContentRef.current) {
        try {
          const html2canvas = (await import('html2canvas')).default
          const canvas = await html2canvas(pickingSlipContentRef.current, { scale: 2 })
          const link = document.createElement('a')
          link.download = `ใบเบิก_${workOrderName}.png`
          link.href = canvas.toDataURL('image/png')
          link.click()
        } catch (_) {
          /* PNG skip if html2canvas fails */
        }
      }
      const wb = XLSX.utils.book_new()
      const ws1Headers = [['รหัสทำรายการ', 'รหัสสินค้า', 'รายการสินค้า', 'จุดเก็บ', 'จำนวนเบิก']]
      const ws1Rows = mainItems.map((item) => [item.woName, item.code, item.name, item.location, String(item.finalQty)])
      const ws1 = XLSX.utils.aoa_to_sheet(ws1Headers.concat(ws1Rows))
      XLSX.utils.book_append_sheet(wb, ws1, 'รายการหยิบสินค้า')
      const ws2Headers = [['รายการอะไหล่', 'จำนวนรวม']]
      const ws2Rows = spareItems.map((item) => [item.name, String(item.qty)])
      const ws2 = XLSX.utils.aoa_to_sheet(ws2Headers.concat(ws2Rows))
      XLSX.utils.book_append_sheet(wb, ws2, 'สรุปอะไหล่')
      XLSX.writeFile(wb, `ใบเบิก_${workOrderName}.xlsx`)

      const csvHeaders = ['รหัสทำรายการ', 'รหัสสินค้า', 'รายการสินค้า', 'จุดเก็บ', 'จำนวนเบิก']
      const csvRows = [csvHeaders.join(',')]
      mainItems.forEach((item) => {
        const row = [`"${item.woName}"`, `"${item.code}"`, `"${item.name}"`, `"${item.location}"`, item.finalQty]
        csvRows.push(row.join(','))
      })
      const csvContent = '\uFEFF' + csvRows.join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `ใบเบิก_${workOrderName}.csv`
      link.click()

    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดในการ Export: ' + (err?.message ?? err) })
    }
  }

  function openImportTrackingModal(workOrderName: string) {
    setImportTrackingModal({ open: true, workOrderName })
  }

  async function handleTrackingFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !importTrackingModal.workOrderName) return
    const workOrderName = importTrackingModal.workOrderName
    setImportTrackingModal({ open: false, workOrderName: null })
    e.target.value = ''
    setUpdating(true)
    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const csv = String(event.target?.result ?? '')
        const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '')
        if (lines.length <= 1) throw new Error('ไฟล์ CSV ว่างเปล่า')
        const headers = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''))
        const billNoIndex = headers.findIndex((h) => h.toLowerCase() === 'bill_no')
        const trackingIndex = headers.findIndex((h) => h.toLowerCase() === 'tracking_number')
        if (billNoIndex === -1 || trackingIndex === -1) throw new Error('ไม่พบหัวข้อ bill_no และ tracking_number')
        const updates: { bill_no: string; tracking_number: string }[] = []
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',')
          const bill_no = values[billNoIndex]?.trim().replace(/"/g, '')
          const tracking_number = values[trackingIndex]?.trim().replace(/"/g, '')
          if (bill_no && tracking_number) updates.push({ bill_no, tracking_number })
        }
        if (updates.length === 0) throw new Error('ไม่พบข้อมูลที่ถูกต้อง')
        let updated = 0
        for (const u of updates) {
          const { data: ord } = await supabase.from('or_orders').select('id').eq('bill_no', u.bill_no).maybeSingle()
          if (ord) {
            await supabase.from('or_orders').update({ tracking_number: u.tracking_number }).eq('id', ord.id)
            updated += 1
          }
        }
        const woOrders = ordersByWo[workOrderName]
        if (woOrders) await loadOrdersForWo(workOrderName)
        onRefresh?.()
      } catch (err: any) {
        setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
      } finally {
        setUpdating(false)
      }
    }
    reader.readAsText(file, 'UTF-8')
  }

  if (loading && workOrders.length === 0) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {workOrders.length === 0 ? (
        <div className="text-center py-12 text-gray-500 bg-white rounded-lg border">
          ยังไม่มีใบงานที่สร้าง — สร้างได้ที่เมนู ใบสั่งงาน
        </div>
      ) : (
        <div className="space-y-2">
          {workOrders.map((wo) => {
            const orders = ordersByWo[wo.work_order_name] || []
            const selectedIds = selectedByWo[wo.work_order_name] || new Set<string>()
            const isExpanded = expandedWo === wo.work_order_name
            const channelCode = channelByWo[wo.work_order_name] ?? ''
            const isWaybillSortChannel = WAYBILL_SORT_CHANNELS.includes(channelCode)
            const canCancelWorkOrder = user?.role === 'superadmin' || user?.role === 'admin-tr'

            return (
              <div key={wo.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {/* หัวใบงาน + ปุ่มด้านขวา (เงื่อนไขอ้างอิง file/index.html) */}
                <div
                  className="flex items-center justify-between gap-4 p-4 cursor-pointer hover:bg-gray-50 border-b border-gray-100"
                  onClick={() => toggleExpand(wo)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-400 select-none">{isExpanded ? '▼' : '▶'}</span>
                    <span className="font-semibold text-gray-900 truncate">
                      {wo.work_order_name} ({wo.order_count} บิล)
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => openPickingSlipModal(wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-green-100 text-green-800 rounded text-xs font-medium hover:bg-green-200 disabled:opacity-50"
                    >
                      ทำใบเบิก
                    </button>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => exportProduction(wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded text-xs font-medium hover:bg-blue-200 disabled:opacity-50"
                    >
                      Export (ไฟล์ผลิต)
                    </button>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => exportBarcode(wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200 disabled:opacity-50"
                    >
                      ทำ Barcode
                    </button>
                    {isWaybillSortChannel ? (
                      <button
                        type="button"
                        onClick={(e) => onHeaderButtonClick(e, () => openWaybillSorterModal(wo.work_order_name))}
                        disabled={updating}
                        className="px-3 py-1.5 bg-orange-100 text-orange-800 rounded text-xs font-medium hover:bg-orange-200 disabled:opacity-50"
                      >
                        เรียงใบปะหน้า
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={(e) => onHeaderButtonClick(e, () => exportWaybillCsv(wo.work_order_name))}
                          disabled={updating}
                          className="px-3 py-1.5 bg-yellow-100 text-yellow-800 rounded text-xs font-medium hover:bg-yellow-200 disabled:opacity-50"
                        >
                          Export (ใบปะหน้า)
                        </button>
                        <button
                          type="button"
                          onClick={(e) => onHeaderButtonClick(e, () => openImportTrackingModal(wo.work_order_name))}
                          disabled={updating}
                          className="px-3 py-1.5 bg-cyan-100 text-cyan-800 rounded text-xs font-medium hover:bg-cyan-200 disabled:opacity-50"
                        >
                          นำเข้าเลขพัสดุ
                        </button>
                      </>
                    )}
                    {canCancelWorkOrder && (
                      <button
                        type="button"
                        onClick={(e) => onHeaderButtonClick(e, () => openCancelWorkOrderConfirm(wo.work_order_name))}
                        disabled={updating}
                        className="px-3 py-1.5 bg-red-100 text-red-800 rounded text-xs font-medium hover:bg-red-200 disabled:opacity-50"
                      >
                        ยกเลิกใบงาน
                      </button>
                    )}
                  </div>
                </div>

                {/* รายการบิล (เมื่อเปิด) */}
                {isExpanded && (
                  <div className="p-4 bg-gray-50 border-t border-gray-100">
                    {orders.length === 0 ? (
                      <div className="text-center py-6 text-gray-500">กำลังโหลด...</div>
                    ) : (
                      <>
                        {/* ปุ่มกลุ่ม: เลือกทั้งหมด, คืนไป รอลงข้อมูล, คืนไป ตรวจสอบแล้ว, ยกเลิกบิลที่เลือก */}
                        <div className="flex flex-wrap items-center gap-2 mb-4">
                          <button
                            type="button"
                            onClick={() => selectAllBills(wo.work_order_name)}
                            className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-100"
                          >
                            เลือกทั้งหมด
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'รอลงข้อมูล')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded-lg text-sm font-medium hover:bg-amber-200 disabled:opacity-50"
                          >
                            คืนไป &quot;รอลงข้อมูล&quot;
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'ตรวจสอบแล้ว')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-cyan-100 text-cyan-800 rounded-lg text-sm font-medium hover:bg-cyan-200 disabled:opacity-50"
                          >
                            คืนไป &quot;ตรวจสอบแล้ว&quot;
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSelectedTo(wo.work_order_name, 'ยกเลิก')}
                            disabled={updating || selectedIds.size === 0}
                            className="px-3 py-1.5 bg-red-100 text-red-800 rounded-lg text-sm font-medium hover:bg-red-200 disabled:opacity-50"
                          >
                            ยกเลิกบิลที่เลือก
                          </button>
                        </div>

                        {/* ตารางบิล: ชื่อช่องทาง = or_orders.customer_name, ชื่อลูกค้า = or_orders.recipient_name */}
                        <div className="bg-white rounded-lg border overflow-hidden overflow-x-auto">
                          <table className="w-full text-sm min-w-[720px]">
                            <thead>
                              <tr className="bg-gray-100 border-b">
                                <th className="w-10 p-3 text-left">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.size === orders.length && orders.length > 0}
                                    onChange={(e) => (e.target.checked ? selectAllBills(wo.work_order_name) : clearBillSelection(wo.work_order_name))}
                                    className="rounded border-gray-300"
                                  />
                                </th>
                                <th className="p-3 text-left font-medium min-w-[110px]">เลขบิล</th>
                                <th className="p-3 text-left font-medium min-w-[120px]">ชื่อลูกค้า</th>
                                <th className="p-3 text-left font-medium min-w-[100px]">ชื่อช่องทาง</th>
                                <th className="p-3 text-left font-medium min-w-[110px]">เลขคำสั่งซื้อ</th>
                                <th className="p-3 text-left font-medium min-w-[100px]">ผู้ลงข้อมูล</th>
                                <th className="p-3 pl-2 text-left font-medium w-56">เลขพัสดุ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orders.map((order) => (
                                  <tr key={order.id} className="border-b border-gray-100 hover:bg-gray-50">
                                    <td className="p-3 align-middle">
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.has(order.id)}
                                        onChange={() => toggleBillSelect(wo.work_order_name, order.id)}
                                        className="rounded border-gray-300"
                                      />
                                    </td>
                                    <td className="p-3 align-middle">
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setDetailOrder(order) }} className="text-blue-600 font-medium hover:text-blue-800 hover:underline transition-colors">
                                        {order.bill_no ?? '-'}
                                      </button>
                                      {(order.claim_type != null || (order.bill_no || '').startsWith('REQ')) && (
                                        <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">
                                          เคลม
                                        </span>
                                      )}
                                    </td>
                                    <td className="p-3 align-middle text-gray-700">{order.recipient_name ?? '-'}</td>
                                    <td className="p-3 align-middle text-gray-600">{order.customer_name ?? '-'}</td>
                                    <td className="p-3 align-middle text-gray-600">{order.channel_order_no ?? '-'}</td>
                                    <td className="p-3 align-middle text-gray-600">{order.admin_user ?? '-'}</td>
                                    <td className="p-3 pl-2 align-middle w-56">
                                      {editingTrackingId === order.id ? (
                                        <div className="flex items-center gap-1 w-full max-w-[17.5rem]">
                                          <input
                                            type="text"
                                            value={editingTrackingValue}
                                            onChange={(e) => setEditingTrackingValue(e.target.value)}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') saveTrackingNumber(order.id)
                                              if (e.key === 'Escape') setEditingTrackingId(null)
                                            }}
                                            className="w-48 min-w-0 flex-1 max-w-[14rem] px-2 py-0.5 border rounded text-sm"
                                            autoFocus
                                          />
                                          <button
                                            type="button"
                                            onClick={() => saveTrackingNumber(order.id)}
                                            disabled={updating}
                                            className="shrink-0 px-1.5 py-0.5 bg-blue-500 text-white rounded text-xs"
                                          >
                                            บันทึก
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setEditingTrackingId(null)}
                                            className="shrink-0 px-1.5 py-0.5 border rounded text-xs"
                                          >
                                            ยกเลิก
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setEditingTrackingId(order.id)
                                            setEditingTrackingValue(order.tracking_number || '')
                                          }}
                                          className="flex items-center gap-0.5 text-left w-full min-w-0 px-1.5 py-0.5 rounded hover:bg-gray-100 text-gray-700 text-xs truncate"
                                        >
                                          {order.tracking_number ? (
                                            <span className="truncate">{order.tracking_number}</span>
                                          ) : (
                                            <span className="text-gray-400">ยังไม่มี</span>
                                          )}
                                          <span className="shrink-0 text-gray-400 text-xs">✎</span>
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modal แจ้งข้อความ */}
      <Modal open={messageModal.open} onClose={() => setMessageModal({ open: false, message: '' })} closeOnBackdropClick contentClassName="max-w-md w-full">
        <div className="p-5">
          <p className="text-gray-800 whitespace-pre-wrap">{messageModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={() => setMessageModal({ open: false, message: '' })} className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
              ตกลง
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal ยืนยัน */}
      <Modal open={confirmModal.open} onClose={() => setConfirmModal((p) => ({ ...p, open: false }))} contentClassName="max-w-md w-full">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-2">{confirmModal.title}</h3>
          <p className="text-gray-700 mb-6">{confirmModal.message}</p>
          <div className="flex gap-3 justify-end">
            <button type="button" onClick={() => setConfirmModal((p) => ({ ...p, open: false }))} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
              ยกเลิก
            </button>
            <button type="button" onClick={confirmModal.onConfirm} className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
              ยืนยัน
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal ใบเบิก — ตามต้นฉบับ: สินค้าหลัก + อะไหล่ (หน้ายาง/โฟม) */}
      <Modal open={pickingSlipModal.open} onClose={() => setPickingSlipModal({ open: false, workOrderName: null, mainItems: [], spareItems: [] })} contentClassName="max-w-2xl w-full">
        <div className="p-5">
          <h2 className="text-lg font-bold text-gray-900 mb-4">ใบเบิก: {pickingSlipModal.workOrderName}</h2>

          <div ref={pickingSlipContentRef} className="space-y-4">
            {/* สินค้าหลัก */}
            <div>
              <h3 className="text-base font-semibold text-gray-900 mb-2 flex items-center gap-2">
                <span className="text-xl" role="img" aria-label="สินค้าหลัก">📦</span>
                สินค้าหลัก
              </h3>
              <div className="overflow-x-auto max-h-64 border border-gray-200 rounded-lg">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 text-left border-b border-gray-200 w-[25%]">จุดเก็บ</th>
                      <th className="p-2 text-left border-b border-gray-200 w-[20%]">รหัส</th>
                      <th className="p-2 text-left border-b border-gray-200 w-[40%]">รายการ</th>
                      <th className="p-2 text-center border-b border-gray-200 w-[15%]">จำนวน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pickingSlipModal.mainItems.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="p-2">{row.location}</td>
                        <td className="p-2">{row.code}</td>
                        <td className="p-2">{row.name}</td>
                        <td className="p-2 text-center">{row.finalQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* อะไหล่ (หน้ายาง/โฟม) */}
            {pickingSlipModal.spareItems.length > 0 && (
              <div>
                <h3 className="text-base font-semibold text-gray-900 mb-2 flex items-center gap-2">
                  <span className="text-xl" role="img" aria-label="อะไหล่">🔧</span>
                  อะไหล่ (หน้ายาง/โฟม)
                </h3>
                <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 text-left border-b border-gray-200">รายการอะไหล่</th>
                        <th className="p-2 text-center border-b border-gray-200 w-20">จำนวน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pickingSlipModal.spareItems.map((row, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="p-2">{row.name}</td>
                          <td className="p-2 text-center">{row.qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 justify-end mt-4">
            <button
              type="button"
              onClick={exportAllPickingFinal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium bg-[#6610f2] hover:bg-[#5a0dd9]"
            >
              <span role="img" aria-label="export">🚀</span>
              Export All (PNG, CSV, XLSX)
            </button>
            <button
              type="button"
              onClick={() => setPickingSlipModal({ open: false, workOrderName: null, mainItems: [], spareItems: [] })}
              className="px-4 py-2 rounded-lg bg-gray-600 text-white hover:bg-gray-700"
            >
              ปิด
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal นำเข้าเลขพัสดุ */}
      <Modal open={importTrackingModal.open} onClose={() => setImportTrackingModal({ open: false, workOrderName: null })} contentClassName="max-w-md w-full">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-2">นำเข้าเลขพัสดุ</h3>
          <p className="text-gray-600 text-sm mb-4">เลือกไฟล์ CSV ที่มีหัวข้อ bill_no และ tracking_number</p>
          <input
            ref={trackingFileInputRef}
            type="file"
            accept=".csv"
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700"
            onChange={handleTrackingFileChange}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setImportTrackingModal({ open: false, workOrderName: null })} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
              ปิด
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal เรียงใบปะหน้าตามใบงาน */}
      <Modal
        open={waybillSorterModal.open}
        onClose={() => setWaybillSorterModal({ open: false, workOrderName: null, trackingNumbers: [] })}
        contentClassName="max-w-[700px] w-full"
      >
        <div className="p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-2">เรียงใบปะหน้าตามใบงาน</h2>
          <p className="text-gray-600 text-sm mb-4">ใบงาน: {waybillSorterModal.workOrderName}</p>

          <div className="flex justify-center mb-4">
            <input
              ref={waybillPdfInputRef}
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                processWaybillPdfs(e.target.files)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => waybillPdfInputRef.current?.click()}
              disabled={wsProcessing}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              เลือกไฟล์ PDF ใบปะหน้า
            </button>
          </div>
          <p className="text-center text-xs text-gray-500 mb-4">เลือกหลายไฟล์ PDF ได้ (หรือโฟลเดอร์ในบางเบราว์เซอร์)</p>

          <div className="grid grid-cols-2 gap-4 mb-4 py-4 border-y border-gray-200">
            <div className="text-center">
              <label className="block text-sm text-gray-600 mb-1">สัดส่วนครอบส่วนบนสำหรับ OCR (%)</label>
              <input
                type="number"
                value={wsCropTop}
                onChange={(e) => setWsCropTop(Number(e.target.value) || 25)}
                min={10}
                max={60}
                step={5}
                className="w-28 py-2 border border-gray-300 rounded-lg text-center"
              />
              <p className="text-xs text-gray-500 mt-1">ส่วนใหญ่ 20–30%</p>
            </div>
            <div className="text-center">
              <label className="block text-sm text-gray-600 mb-1">ขนาด batch ตอนรวม (หน้า/ครั้ง)</label>
              <input
                type="number"
                value={wsBatchSize}
                onChange={(e) => setWsBatchSize(Number(e.target.value) || 25)}
                min={5}
                max={100}
                step={5}
                className="w-28 py-2 border border-gray-300 rounded-lg text-center"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 text-center mb-4">
            <div>
              <p className="text-sm text-gray-600 mb-1">เลขในใบงาน</p>
              <p className="text-xl font-bold">{waybillSorterModal.trackingNumbers.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-1">ไฟล์ PDF</p>
              <p className="text-xl font-bold">{wsStatPdf}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600 mb-1">จับคู่สำเร็จ</p>
              <p className="text-xl font-bold text-green-600">{wsStatFound}</p>
            </div>
          </div>

          <div className="mb-4">
            <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 transition-[width] duration-300" style={{ width: `${wsProgress}%` }} />
            </div>
            <pre className="mt-2 p-3 text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg h-28 overflow-y-auto whitespace-pre-wrap">
              {wsLog.join('\n')}
            </pre>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={downloadMissingWaybillCsv}
              disabled={wsMissing.length === 0}
              className="px-4 py-2 rounded-lg bg-cyan-100 text-cyan-800 hover:bg-cyan-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              CSV ที่ไม่พบ
            </button>
            <button
              type="button"
              onClick={() => setWaybillSorterModal({ open: false, workOrderName: null, trackingNumbers: [] })}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              ปิด
            </button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!detailOrder} onClose={() => setDetailOrder(null)} contentClassName="max-w-6xl w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />}
      </Modal>
    </div>
  )
}
