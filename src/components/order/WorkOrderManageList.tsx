import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { buildIlikeOr } from '../../lib/searchFilter'
import { Order, WorkOrder } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import Modal from '../ui/Modal'
import ExpressReceiptNumberInline from '../common/ExpressReceiptNumberInline'
import OrderDetailView from './OrderDetailView'
import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import { extractPhonesFromText, e164ToLocal } from '../../lib/thaiPhone'
import { isRoleInAllowedList } from '../../config/accessPolicy'
import {
  FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN,
  isOrderAllowedInFulfillmentFlow,
  isOrderItemAllowedInFulfillmentFlow,
} from '../../lib/orderFlowFilter'
import { flatBillUnitUid, normalizedLineQuantity } from '../../lib/productionUnits'
import { sortOrderItemsForExport } from '../../lib/orderItemExportSort'
import { createWaybillBarcodeReader, readBarcodesFromPdfPage } from '../../lib/waybillBarcode'
import { EXPORT_ITEM_COLUMNS, buildProductionExportRows as buildProductionExportRowsShared } from '../../lib/productionExportRows'
import {
  fetchPlanDeptSettings,
  resolvePickingDepartment,
  deptExportOrder,
  isStampDepartmentName,
} from '../../lib/planPickingDepartments'
import { downloadFlashWaybillXlsx } from '../../lib/flashWaybillExport'

function pickSpareQtyForLine(lineQty: number, rawCategory: string): number {
  if (String(rawCategory || '').toUpperCase().includes('CONDO STAMP')) return Math.ceil(lineQty / 5)
  return lineQty
}

function formatThaiBuddhistDate(d: Date = new Date()): string {
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`
}

function safeFilePart(s: string): string {
  const t = String(s || '').trim().replace(/[/\\?%*:|"<>]/g, '_')
  return t || 'export'
}

/** PostgREST errors are plain objects, so String(error) would hide the real cause. */
function formatTrackingImportError(error: unknown): string {
  if (error == null) return 'เกิดข้อผิดพลาดโดยไม่ทราบสาเหตุ'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const value = error as Record<string, unknown>
    const parts = [value.message, value.details, value.hint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    if (parts.length > 0) return parts.join(' — ')
    try {
      return JSON.stringify(error)
    } catch {
      return 'เกิดข้อผิดพลาดโดยไม่ทราบสาเหตุ'
    }
  }
  return String(error)
}

/** สร้าง DOM สำหรับถ่าย PNG ใบเบิก (เลย์เอาต์เดียวกับเอกสารอ้างอิง) */
function buildPickingSlipPrintDom(opts: {
  workOrderName: string
  deptTitle: string
  buddhistDateStr: string
  rows: PickingMainRow[]
  spareItems: PickingSpareRow[]
  showSpareSummary: boolean
}): HTMLDivElement {
  const { workOrderName, deptTitle, buddhistDateStr, rows, spareItems, showSpareSummary } = opts
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'box-sizing:border-box;width:820px;padding:28px 32px;background:#fff;color:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.35;'

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:16px;'
  const title = document.createElement('div')
  title.style.cssText = 'font-size:17px;font-weight:700;'
  title.textContent = `ใบเบิกใบงาน: ${workOrderName}`
  const dateEl = document.createElement('div')
  dateEl.style.cssText = 'font-size:14px;font-weight:600;white-space:nowrap;'
  dateEl.textContent = `วันที่: ${buddhistDateStr}`
  header.appendChild(title)
  header.appendChild(dateEl)
  wrap.appendChild(header)

  const deptBar = document.createElement('div')
  deptBar.style.cssText =
    'font-size:15px;font-weight:700;background:#e8e8e8;border:1px solid #000;padding:8px 10px;margin-bottom:4px;'
  deptBar.textContent = `แผนก ${deptTitle}`
  wrap.appendChild(deptBar)

  const table = document.createElement('table')
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px 0;'
  const thead = document.createElement('thead')
  const trh = document.createElement('tr')
  const thBase = 'border:1px solid #000;padding:7px 8px;font-weight:700;background:#f4f4f4;'
  const headers: [string, string][] = [
    ['จุดเก็บ', `${thBase}text-align:left;width:20%;`],
    ['รหัส', `${thBase}text-align:center;width:16%;`],
    ['รายการ', `${thBase}text-align:left;width:49%;`],
    ['จำนวน', `${thBase}text-align:center;width:15%;`],
  ]
  for (const [label, st] of headers) {
    const th = document.createElement('th')
    th.setAttribute('style', st)
    th.textContent = label
    trh.appendChild(th)
  }
  thead.appendChild(trh)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  const tdL = 'border:1px solid #000;padding:6px 8px;vertical-align:top;text-align:left;'
  const tdC = 'border:1px solid #000;padding:6px 8px;vertical-align:top;text-align:center;'
  for (const row of rows) {
    const tr = document.createElement('tr')
    const c1 = document.createElement('td')
    c1.setAttribute('style', tdL)
    c1.textContent = row.location
    const c2 = document.createElement('td')
    c2.setAttribute('style', tdC)
    c2.textContent = row.code
    const c3 = document.createElement('td')
    c3.setAttribute('style', tdL)
    c3.textContent = row.name
    const c4 = document.createElement('td')
    c4.setAttribute('style', tdC)
    c4.textContent = String(row.finalQty)
    tr.appendChild(c1)
    tr.appendChild(c2)
    tr.appendChild(c3)
    tr.appendChild(c4)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrap.appendChild(table)

  if (showSpareSummary && spareItems.length > 0) {
    const spareHead = document.createElement('div')
    spareHead.style.cssText = 'font-size:14px;font-weight:700;margin:12px 0 6px 0;display:flex;align-items:center;gap:6px;'
    const ic = document.createElement('span')
    ic.textContent = '✎'
    ic.setAttribute('style', 'font-size:16px;')
    spareHead.appendChild(ic)
    const st = document.createElement('span')
    st.textContent = 'รายการอะไหล่รวม'
    spareHead.appendChild(st)
    wrap.appendChild(spareHead)

    const stbl = document.createElement('table')
    stbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;'
    const stHead = document.createElement('thead')
    const strh = document.createElement('tr')
    const sth = `${thBase}`
    const h1 = document.createElement('th')
    h1.setAttribute('style', `${sth}text-align:left;width:85%;`)
    h1.textContent = 'รายการอะไหล่'
    const h2 = document.createElement('th')
    h2.setAttribute('style', `${sth}text-align:center;width:15%;`)
    h2.textContent = 'จำนวน'
    strh.appendChild(h1)
    strh.appendChild(h2)
    stHead.appendChild(strh)
    stbl.appendChild(stHead)
    const stBody = document.createElement('tbody')
    for (const s of spareItems) {
      const tr = document.createElement('tr')
      const d1 = document.createElement('td')
      d1.setAttribute('style', tdL)
      d1.textContent = s.label
      const d2 = document.createElement('td')
      d2.setAttribute('style', tdC)
      d2.textContent = String(s.qty)
      tr.appendChild(d1)
      tr.appendChild(d2)
      stBody.appendChild(tr)
    }
    stbl.appendChild(stBody)
    wrap.appendChild(stbl)
  }

  const foot = document.createElement('div')
  foot.style.cssText = 'display:flex;justify-content:space-between;gap:32px;margin-top:28px;padding-top:8px;'
  const mkSign = (label: string) => {
    const box = document.createElement('div')
    box.style.cssText = 'flex:1;min-width:0;'
    const lb = document.createElement('div')
    lb.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:28px;'
    lb.textContent = label
    const line = document.createElement('div')
    line.style.cssText = 'border-bottom:1px dotted #333;height:1px;'
    box.appendChild(lb)
    box.appendChild(line)
    return box
  }
  foot.appendChild(mkSign('ผู้เบิก'))
  foot.appendChild(mkSign('ผู้จ่าย'))
  wrap.appendChild(foot)

  return wrap
}

async function downloadPickingSlipPng(
  opts: Parameters<typeof buildPickingSlipPrintDom>[0],
  fileBase: string
): Promise<void> {
  const html2canvas = (await import('html2canvas')).default
  const node = buildPickingSlipPrintDom(opts)
  node.style.position = 'fixed'
  node.style.left = '-9999px'
  node.style.top = '0'
  document.body.appendChild(node)
  try {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff', logging: false })
    const link = document.createElement('a')
    link.download = `${fileBase}.png`
    link.href = canvas.toDataURL('image/png')
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  } finally {
    document.body.removeChild(node)
  }
}

/** ช่องทางที่ใช้ปุ่ม "เรียงใบปะหน้า" (อ้างอิง file/index.html) */
const WAYBILL_SORT_CHANNELS = ['FSPTR', 'SPTR', 'TTTR', 'LZTR', 'SHOP']
/** ช่องทางที่ที่อยู่ไม่ส่งไปใบปะหน้า (SHOP แสดงที่อยู่เหมือน FBTR) */
// const ECOMMERCE_CHANNELS = ['LZTR']
/** หมวดสินค้าที่ไม่นับเป็นสินค้าหลัก (นับเป็นอะไหล่เท่านั้น) */
const PICKING_EXCLUDED_CATEGORIES = ['UV', 'STK', 'TUBE']

/** ใบงานที่ยกเลิก / ไม่มีบิลในใบงาน (รองรับข้อมูลเก่าที่ order_count=0 แต่ status ยังไม่เป็น ยกเลิก) — ไม่แสดงกับใบงานจัดส่งแล้ว */
function isWorkOrderCancelledRecord(wo: WorkOrder): boolean {
  const st = String(wo.status ?? '').trim()
  if (st === 'จัดส่งแล้ว') return false
  if (st === 'ยกเลิก') return true
  return Number(wo.order_count) === 0
}

/** ให้ตรงกับเงื่อนไขค้นหาที่ใช้กับ or_orders (ไฮไลต์แถวในตาราง) */
function orderMatchesSearch(order: Order, needleLower: string): boolean {
  if (!needleLower) return false
  const fields = [
    order.bill_no,
    order.customer_name,
    order.recipient_name,
    order.tracking_number,
    order.express_receipt_number,
    order.channel_order_no,
  ]
  return fields.some((f) => String(f || '').toLowerCase().includes(needleLower))
}

/** คอลัมน์ Preview ใบปะหน้า — key ตรงกับ WaybillPreviewRow */
const WAYBILL_PREVIEW_COLS: Array<{ key: string; label: string; width: string; required?: boolean }> = [
  { key: 'addressRaw', label: 'Address (ต้นฉบับ)', width: 'min-w-[320px]' },
  { key: 'consigneeName', label: 'ชื่อผู้รับ', width: 'min-w-[240px]', required: true },
  { key: 'address', label: 'ที่อยู่', width: 'min-w-[380px]', required: true },
  { key: 'postalCode', label: 'รหัสไปรษณีย์', width: 'min-w-[100px] w-[110px]', required: true },
  { key: 'phone1', label: 'เบอร์โทร', width: 'min-w-[130px] w-[140px]', required: true },
  { key: 'phone2', label: 'เบอร์โทร 2', width: 'min-w-[130px] w-[140px]' },
  { key: 'cod', label: 'COD', width: 'min-w-[80px] w-[90px]' },
]

/** คอลัมน์ระดับรายการใน Export ไฟล์ผลิต — แมป key → ชื่อคอลัมน์ใน pr_category_field_settings */
interface WorkOrderManageListProps {
  searchTerm?: string
  channelFilter?: string
  dateFrom?: string
  dateTo?: string
  mode?: 'active' | 'all'
  onCountChange?: (count: number) => void
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
type TrackingImportPhase = 'idle' | 'reading' | 'conflict' | 'importing' | 'refreshing' | 'completed' | 'error'
type TrackingImportRow = { bill_no: string; tracking_number: string }
type TrackingImportConflict = { bill_no: string; tracking_numbers: string[] }
type TrackingImportDetail = {
  row_no: number
  bill_no: string
  tracking_number: string
  status: 'updated' | 'unchanged' | 'duplicate' | 'not_found' | 'outside_work_order' | 'invalid' | 'error'
  message: string
}
type TrackingImportProgress = {
  phase: TrackingImportPhase
  total: number
  processed: number
  updated: number
  unchanged: number
  duplicate: number
  notFound: number
  outsideWorkOrder: number
  invalid: number
  failed: number
  message: string
  details: TrackingImportDetail[]
}
type TrackingImportBatchResult = {
  success: boolean
  processed: number
  updated: number
  unchanged: number
  duplicate: number
  not_found: number
  outside_work_order: number
  invalid: number
  failed: number
  results: TrackingImportDetail[]
}
/** Modal เรียงใบปะหน้า: เปิด + ชื่อใบงาน + ลำดับเลขพัสดุจากออร์เดอร์ */
type WaybillSorterModal = { open: boolean; workOrderName: string | null; trackingNumbers: string[] }
/** แถวข้อมูลในตาราง Preview ใบปะหน้า */
interface WaybillPreviewRow { billNo: string; addressRaw: string; consigneeName: string; address: string; postalCode: string; phone1: string; phone2: string; cod: string }
/** Modal Preview ใบปะหน้า */
type WaybillPreviewModal = { open: boolean; workOrderName: string | null; rows: WaybillPreviewRow[] }
/** สินค้าหลัก: จุดเก็บ, รหัส, รายการ, จำนวนเบิก, แผนก (จากตั้งค่า Plan) */
interface PickingMainRow { woName: string; code: string; name: string; location: string; finalQty: number; dept: string }
/** อะไหล่ — ข้อความตาม รหัสหน้ายาง (rubber_code) ในสินค้า */
interface PickingSpareRow { label: string; qty: number }

const TRACKING_IMPORT_BATCH_SIZE = 100
const TRACKING_IMPORT_STATUS_LABELS: Record<TrackingImportDetail['status'], string> = {
  updated: 'สำเร็จ',
  unchanged: 'ข้อมูลเดิม',
  duplicate: 'เลขพัสดุซ้ำ',
  not_found: 'ไม่พบบิล',
  outside_work_order: 'อยู่นอกใบงาน',
  invalid: 'ข้อมูลไม่ถูกต้อง',
  error: 'ผิดพลาด',
}
const EMPTY_TRACKING_IMPORT_PROGRESS: TrackingImportProgress = {
  phase: 'idle',
  total: 0,
  processed: 0,
  updated: 0,
  unchanged: 0,
  duplicate: 0,
  notFound: 0,
  outsideWorkOrder: 0,
  invalid: 0,
  failed: 0,
  message: '',
  details: [],
}

export default function WorkOrderManageList({
  searchTerm = '',
  channelFilter = '',
  dateFrom = '',
  dateTo = '',
  mode = 'active',
  onCountChange,
  onRefresh,
}: WorkOrderManageListProps) {
  const { user } = useAuthContext()
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [channelByWo, setChannelByWo] = useState<Record<string, string>>({}) // key = work_order_id
  /** ใบงานที่มีบิลเคลม (REQ) — ใช้ปุ่มชุดเดียวกับ FBTR (Export ใบปะหน้า + นำเข้าเลขพัสดุ) */
  const [claimByWo, setClaimByWo] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  /** ใบงานที่คลี่อยู่ — รองรับหลายใบ (เช่น หลังค้นหา) */
  const [expandedWoIds, setExpandedWoIds] = useState<Set<string>>(() => new Set())
  const [ordersByWo, setOrdersByWo] = useState<Record<string, Order[]>>({}) // key = work_order_id
  const [selectedByWo, setSelectedByWo] = useState<Record<string, Set<string>>>({}) // key = work_order_id
  const [updating, setUpdating] = useState(false)
  const [_channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  /** จำนวนบิลต่อใบงาน — นับจาก or_orders ชุดเดียวกับตาราง (ไม่พึ่ง order_count ที่อาจค้าง) */
  const [billCountByWo, setBillCountByWo] = useState<Record<string, number>>({})
  /** บิลที่ตรงจากชื่อ/รหัสสินค้า ใช้ไฮไลต์ผลค้นหาในตาราง */
  const [productMatchedOrderIds, setProductMatchedOrderIds] = useState<Set<string>>(() => new Set())

  const [messageModal, setMessageModal] = useState<MessageModal>({ open: false, message: '' })
  /** Modal แสดงสถานะกำลัง Export — กันกดซ้ำระหว่างสร้างไฟล์ */
  const [exportLoading, setExportLoading] = useState<{ open: boolean; message: string }>({ open: false, message: '' })
  const [confirmModal, setConfirmModal] = useState<ConfirmModal>({ open: false, title: '', message: '', onConfirm: () => {} })
  const [pickingSlipModal, setPickingSlipModal] = useState<PickingSlipModal>({
    open: false,
    workOrderName: null,
    mainItems: [],
    spareItems: [],
  })
  const [importTrackingModal, setImportTrackingModal] = useState<ImportTrackingModal>({ open: false, workOrderName: null })
  const [trackingImportProgress, setTrackingImportProgress] = useState<TrackingImportProgress>(EMPTY_TRACKING_IMPORT_PROGRESS)
  const [pendingTrackingRows, setPendingTrackingRows] = useState<TrackingImportRow[]>([])
  const [trackingImportConflicts, setTrackingImportConflicts] = useState<TrackingImportConflict[]>([])
  const [trackingConflictChoices, setTrackingConflictChoices] = useState<Record<string, string>>({})
  const [waybillSorterModal, setWaybillSorterModal] = useState<WaybillSorterModal>({ open: false, workOrderName: null, trackingNumbers: [] })
  const [waybillPreviewModal, setWaybillPreviewModal] = useState<WaybillPreviewModal>({ open: false, workOrderName: null, rows: [] })
  const [wsLog, setWsLog] = useState<string[]>([])
  const [wsStatPdf, setWsStatPdf] = useState<string>('--')
  const [wsStatFound, setWsStatFound] = useState<string>('--')
  const [wsStatMissing, setWsStatMissing] = useState<string>('--')
  const [wsProgress, setWsProgress] = useState(0)
  const [wsMissing, setWsMissing] = useState<string[]>([])
  const [wsProcessing, setWsProcessing] = useState(false)
  const [wsCropTop, setWsCropTop] = useState(25)
  const [wsBatchSize, setWsBatchSize] = useState(25)
  const trackingFileInputRef = useRef<HTMLInputElement>(null)
  const waybillPdfInputRef = useRef<HTMLInputElement>(null)
  const waybillPdfFolderInputRef = useRef<HTMLInputElement>(null)
  const isTrackingImportBusy = ['reading', 'importing', 'refreshing'].includes(trackingImportProgress.phase)
  const trackingImportPercent = trackingImportProgress.phase === 'completed'
    ? 100
    : trackingImportProgress.phase === 'refreshing'
      ? 95
      : trackingImportProgress.phase === 'importing' && trackingImportProgress.total > 0
        ? Math.min(90, 10 + Math.round((trackingImportProgress.processed / trackingImportProgress.total) * 80))
        : trackingImportProgress.phase === 'error' && trackingImportProgress.total > 0
          ? Math.min(90, 10 + Math.round((trackingImportProgress.processed / trackingImportProgress.total) * 80))
        : trackingImportProgress.phase === 'reading'
          ? 5
          : trackingImportProgress.phase === 'conflict'
            ? 10
          : 0
  useEffect(() => {
    loadWorkOrders()
  }, [channelFilter, searchTerm, dateFrom, dateTo, mode])

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
      if (dateFrom) {
        query = query.gte('created_at', `${dateFrom}T00:00:00.000Z`)
      }
      if (dateTo) {
        query = query.lte('created_at', `${dateTo}T23:59:59.999Z`)
      }

      const { data, error } = await query
      if (error) throw error
      let list: WorkOrder[] = (data || []) as WorkOrder[]
      const searchRaw = searchTerm.trim()
      if (searchRaw) {
        const needle = searchRaw.toLowerCase()
        let orderMatchQuery = supabase.from('or_orders').select('work_order_id').not('work_order_id', 'is', null).or(
          buildIlikeOr(searchRaw, ['bill_no', 'customer_name', 'recipient_name', 'tracking_number', 'express_receipt_number', 'channel_order_no'])
        )
        if (mode === 'active') {
          orderMatchQuery = orderMatchQuery
            .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
            .neq('status', 'จัดส่งแล้ว')
        }
        const [orderMatchResult, itemNameResult, productResult] = await Promise.all([
          orderMatchQuery,
          supabase
            .from('or_order_items')
            .select('order_id')
            .or(buildIlikeOr(searchRaw, ['product_name', 'product_type'])),
          supabase
            .from('pr_products')
            .select('id')
            .or(buildIlikeOr(searchRaw, ['product_code', 'product_name'])),
        ])
        if (orderMatchResult.error) throw orderMatchResult.error
        if (itemNameResult.error) throw itemNameResult.error
        if (productResult.error) throw productResult.error

        const matchingProductIds = (productResult.data || []).map((r: { id: string }) => r.id)
        const productOrderIds = new Set((itemNameResult.data || []).map((r: { order_id: string }) => r.order_id))
        if (matchingProductIds.length > 0) {
          const { data: productItemRows, error: productItemError } = await supabase
            .from('or_order_items')
            .select('order_id')
            .in('product_id', matchingProductIds)
          if (productItemError) throw productItemError
          for (const row of productItemRows || []) productOrderIds.add(String(row.order_id))
        }

        const woIdsFromOrders = new Set(
          (orderMatchResult.data || []).map((r: { work_order_id: string }) => r.work_order_id),
        )
        if (productOrderIds.size > 0) {
          let productOrderQuery = supabase
            .from('or_orders')
            .select('id, work_order_id')
            .in('id', Array.from(productOrderIds))
            .not('work_order_id', 'is', null)
          if (mode === 'active') {
            productOrderQuery = productOrderQuery
              .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
              .neq('status', 'จัดส่งแล้ว')
          }
          const { data: matchedProductOrders, error: matchedProductOrdersError } = await productOrderQuery
          if (matchedProductOrdersError) throw matchedProductOrdersError
          const activeProductOrderIds = new Set<string>()
          for (const row of matchedProductOrders || []) {
            if (row.work_order_id) woIdsFromOrders.add(String(row.work_order_id))
            activeProductOrderIds.add(String(row.id))
          }
          setProductMatchedOrderIds(activeProductOrderIds)
        } else {
          setProductMatchedOrderIds(new Set())
        }
        list = list.filter(
          (w) =>
            woIdsFromOrders.has(w.id) ||
            String(w.work_order_name || '')
              .toLowerCase()
              .includes(needle)
        )
      } else {
        setProductMatchedOrderIds(new Set())
      }

      if (mode === 'active' && list.length > 0) {
        const { data: activeOrders } = await supabase
          .from('or_orders')
          .select('work_order_id')
          .not('work_order_id', 'is', null)
          .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
          .neq('status', 'จัดส่งแล้ว')
          .in('work_order_id', list.map((w) => w.id))
        const activeSet = new Set((activeOrders || []).map((r: { work_order_id: string }) => r.work_order_id))
        list = list.filter((w) => activeSet.has(w.id))
      }
      setWorkOrders(list)
      onCountChange?.(list.length)
      setOrdersByWo({})
      setSelectedByWo({})

      let nextBillCounts: Record<string, number> = {}
      if (list.length > 0) {
        const workOrderIds = list.map((w) => w.id)
        let countQuery = supabase.from('or_orders').select('work_order_id').in('work_order_id', workOrderIds)
        if (mode === 'active') {
          countQuery = countQuery
            .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
            .neq('status', 'จัดส่งแล้ว')
        }
        const { data: countRows } = await countQuery
        for (const row of countRows || []) {
          const wid = String((row as { work_order_id: string }).work_order_id)
          nextBillCounts[wid] = (nextBillCounts[wid] || 0) + 1
        }
      }
      setBillCountByWo(nextBillCounts)

      const q = searchTerm.trim()
      if (q && list.length > 0) {
        const toExpand = list.filter((w) => !isWorkOrderCancelledRecord(w)).map((w) => w.id)
        setExpandedWoIds(new Set(toExpand))
        if (toExpand.length > 0) {
          await loadOrdersForWorkOrdersBatch(toExpand)
        }
      } else {
        setExpandedWoIds(new Set())
      }

      if (list.length > 0) {
        const workOrderIds = list.map((w) => w.id)
        const { data: orderChannels, error: channelErr } = await supabase
          .from('or_orders')
          .select('work_order_id, channel_code, bill_no, claim_type')
          .in('work_order_id', workOrderIds)
        if (!channelErr && orderChannels && orderChannels.length > 0) {
          const map: Record<string, string> = {}
          const claimMap: Record<string, boolean> = {}
          orderChannels.forEach(
            (r: { work_order_id: string; channel_code: string; bill_no?: string | null; claim_type?: string | null }) => {
              if (r.work_order_id && !(r.work_order_id in map)) {
                map[r.work_order_id] = r.channel_code ?? ''
              }
              if (r.work_order_id && (r.claim_type != null || String(r.bill_no || '').startsWith('REQ'))) {
                claimMap[r.work_order_id] = true
              }
            },
          )
          setChannelByWo(map)
          setClaimByWo(claimMap)
        } else {
          setChannelByWo({})
          setClaimByWo({})
        }
      } else {
        setChannelByWo({})
        setClaimByWo({})
      }
    } catch (error: any) {
      console.error('Error loading work orders:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message })
    } finally {
      setLoading(false)
    }
  }

  function filterOrdersRowsForMode(rows: unknown[] | null): Order[] {
    let r = (rows || []) as Order[]
    if (mode === 'active') {
      r = r.filter((row: any) => {
        if (!row?.status) return true
        const status = String(row.status)
        if (status === 'จัดส่งแล้ว') return false
        return isOrderAllowedInFulfillmentFlow(status)
      })
    }
    return r
  }

  async function loadOrdersForWorkOrdersBatch(workOrderIds: string[]) {
    if (workOrderIds.length === 0) return
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, recipient_name, tracking_number, express_receipt_number, channel_code, customer_address, status, channel_order_no, total_amount, claim_type, admin_user, work_order_id')
        .in('work_order_id', workOrderIds)
        .order('created_at', { ascending: false })
      if (error) throw error
      const rows = filterOrdersRowsForMode(data)
      const grouped: Record<string, Order[]> = {}
      for (const id of workOrderIds) {
        grouped[id] = []
      }
      for (const row of rows) {
        const wid = String(row.work_order_id || '')
        if (grouped[wid]) grouped[wid].push(row)
      }
      setOrdersByWo((prev) => {
        const next = { ...prev }
        for (const id of workOrderIds) {
          next[id] = grouped[id] || []
        }
        return next
      })
      setBillCountByWo((prev) => {
        const next = { ...prev }
        for (const id of workOrderIds) {
          next[id] = (grouped[id] || []).length
        }
        return next
      })
      setSelectedByWo((prev) => {
        const next = { ...prev }
        for (const id of workOrderIds) {
          next[id] = new Set<string>()
        }
        return next
      })
    } catch (error: any) {
      console.error('Error loading orders batch:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดในการโหลดบิล: ' + error.message })
    }
  }

  async function loadOrdersForWo(workOrderId: string) {
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, recipient_name, tracking_number, express_receipt_number, channel_code, customer_address, status, channel_order_no, total_amount, claim_type, admin_user, work_order_id')
        .eq('work_order_id', workOrderId)
        .order('created_at', { ascending: false })
      if (error) throw error
      const list = filterOrdersRowsForMode(data)
      setOrdersByWo((prev) => ({ ...prev, [workOrderId]: list }))
      setBillCountByWo((prev) => ({ ...prev, [workOrderId]: list.length }))
      setSelectedByWo((prev) => ({ ...prev, [workOrderId]: new Set<string>() }))
    } catch (error: any) {
      console.error('Error loading orders for WO:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  function toggleExpand(wo: WorkOrder) {
    // ใบงานที่ถูกยกเลิกแล้วไม่ให้ขยาย (ไม่มีบิลด้านในแล้ว)
    if (isWorkOrderCancelledRecord(wo)) return
    const willExpand = !expandedWoIds.has(wo.id)
    setExpandedWoIds((prev) => {
      const next = new Set(prev)
      if (next.has(wo.id)) next.delete(wo.id)
      else next.add(wo.id)
      return next
    })
    if (willExpand && !ordersByWo[wo.id]) {
      loadOrdersForWo(wo.id)
    }
  }

  function toggleBillSelect(workOrderId: string, orderId: string) {
    setSelectedByWo((prev) => {
      const set = new Set(prev[workOrderId] || [])
      if (set.has(orderId)) set.delete(orderId)
      else set.add(orderId)
      return { ...prev, [workOrderId]: set }
    })
  }

  function selectAllBills(workOrderId: string) {
    const orders = ordersByWo[workOrderId] || []
    setSelectedByWo((prev) => ({ ...prev, [workOrderId]: new Set(orders.map((o) => o.id)) }))
  }

  function clearBillSelection(workOrderId: string) {
    setSelectedByWo((prev) => ({ ...prev, [workOrderId]: new Set<string>() }))
  }

  function confirmReleaseToWorkQueue(workOrderId: string) {
    const ids = Array.from(selectedByWo[workOrderId] || [])
    if (ids.length === 0) {
      setMessageModal({ open: true, message: 'กรุณาเลือกบิลอย่างน้อย 1 รายการ' })
      return
    }
    setConfirmModal({
      open: true,
      title: 'ยืนยันย้ายไปใบสั่งงาน',
      message: `ต้องการย้าย ${ids.length} บิล ไปเมนู Plan → ใบสั่งงาน หรือไม่?`,
      onConfirm: () => executeReleaseToWorkQueue(workOrderId, ids),
    })
  }

  async function executeReleaseToWorkQueue(workOrderId: string, ids: string[]) {
    setConfirmModal((prev) => ({ ...prev, open: false }))
    setUpdating(true)
    try {
      const { data, error } = await supabase.rpc('rpc_plan_release_orders_to_workqueue_v2', {
        p_work_order_id: workOrderId,
        p_order_ids: ids,
      })
      if (error) throw error
      const result = data as { success?: boolean; error?: string; error_code?: string; remaining_bills?: number } | null
      if (!result?.success) {
        const msg = result?.error || 'ย้ายบิลไม่สำเร็จ'
        setMessageModal({ open: true, message: msg })
        return
      }

      await loadWorkOrders()
      const remaining = (result.remaining_bills ?? 0) as number
      if (remaining > 0) {
        await loadOrdersForWo(workOrderId)
        clearBillSelection(workOrderId)
      }
      onRefresh?.()
      setMessageModal({
        open: true,
        message:
          `ย้ายบิลไปใบสั่งงานเรียบร้อย (${ids.length} บิล)` +
          `\n\nหากมีรายการที่หยิบหรือตรวจสินค้าแล้ว ให้ไปเมนูจัดสินค้า → ตรวจสินค้า แล้วกด "คืนเข้าคลัง" ตามรายการที่มีป้ายย้ายบิล`,
      })
    } catch (error: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setUpdating(false)
    }
  }

  function openCancelWorkOrderConfirm(wo: WorkOrder) {
    setConfirmModal({
      open: true,
      title: 'ยืนยันยกเลิกใบงาน',
      message: `ต้องการยกเลิกใบงาน "${wo.work_order_name}" หรือไม่?`,
      onConfirm: () => doCancelWorkOrder(wo),
    })
  }

  async function doCancelWorkOrder(wo: WorkOrder) {
    setConfirmModal((prev) => ({ ...prev, open: false }))
    setUpdating(true)
    try {
      // ย้ายบิลกลับคิว Plan: เขียนสถานะใบสั่งงานโดยตรง (soft-deprecate สถานะย้ายจากใบงาน)
      const commonResetFields = {
        work_order_id: null,
        work_order_name: null,
        plan_released_from_work_order: null,
        plan_released_from_work_order_id: null,
        plan_released_at: null,
        status: 'ใบสั่งงาน' as const,
      }
      const { error: updateOrdersError } = await supabase
        .from('or_orders')
        .update({ ...commonResetFields })
        .eq('work_order_id', wo.id)
      if (updateOrdersError) throw updateOrdersError
      // ไม่ลบใบงานทิ้ง: เก็บไว้ในแท็บ "ใบงานทั้งหมด" พร้อมสถานะยกเลิก
      const { error: cancelWoError } = await supabase
        .from('or_work_orders')
        .update({ status: 'ยกเลิก', order_count: 0 })
        .eq('id', wo.id)
      if (cancelWoError) throw cancelWoError
      await loadWorkOrders()
      onRefresh?.()
      setMessageModal({ open: true, message: `ยกเลิกใบงาน "${wo.work_order_name}" เรียบร้อย` })
    } catch (error: any) {
      console.error('Error cancelling work order:', error)
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (error?.message ?? error) })
    } finally {
      setUpdating(false)
    }
  }

  async function openWaybillSorterModal(workOrderId: string, workOrderNameForDisplay: string) {
    // เรียงบิลใหม่สุดก่อน — ต้องตรงกับลำดับไฟล์ใบปะหน้า Excel (openWaybillPreview) และ Barcode CSV (fetchOrdersWithItems)
    const { data: ordersData } = await supabase
      .from('or_orders')
      .select('id, tracking_number, bill_no')
      .eq('work_order_id', workOrderId)
      .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
      .not('tracking_number', 'is', null)
      .order('created_at', { ascending: false })
      .order('bill_no', { ascending: false })
    const withTracking = (ordersData || []).filter((o) => o.tracking_number && String(o.tracking_number).trim() !== '')
    const trackingNumbers = withTracking.map((o) => String(o.tracking_number).trim())
    if (trackingNumbers.length === 0) {
      setMessageModal({ open: true, message: 'ไม่พบเลขพัสดุในใบงานนี้ กรุณานำเข้าเลขพัสดุก่อน' })
      return
    }
    setWsLog(['เตรียมข้อมูลเรียบร้อย กรุณาเลือกไฟล์ PDF ใบปะหน้า'])
    setWsStatPdf('--')
    setWsStatFound('--')
    setWsStatMissing('--')
    setWsProgress(0)
    setWsMissing([])
    setWaybillSorterModal({ open: true, workOrderName: workOrderNameForDisplay, trackingNumbers })
  }

  function wsLogAppend(message: string, overwriteFirst = false) {
    setWsLog((prev) => (overwriteFirst && prev.length > 0 ? [message, ...prev.slice(1)] : [message, ...prev]))
  }

  async function processWaybillPdfs(fileInput: FileList | null) {
    if (!fileInput || fileInput.length === 0 || !waybillSorterModal.workOrderName) return
    // กรองเฉพาะ PDF — กรณีเลือกทั้งโฟลเดอร์อาจมีไฟล์ชนิดอื่นปนมา
    const files = Array.from(fileInput).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    if (files.length === 0) {
      setWsLog(['ไม่พบไฟล์ PDF ในโฟลเดอร์/รายการที่เลือก'])
      return
    }
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

      // ตัวอ่านบาร์โค้ดพร้อมใช้ทันที (เบามาก) — OCR ค่อยเปิดเมื่อจำเป็นจริง เพราะต้องโหลดโมเดลหลายสิบ MB
      const barcodeReader = await createWaybillBarcodeReader()
      const ensureOcrWorker = async () => {
        if (ocrWorker) return ocrWorker
        wsLogAppend('⏳ เริ่มต้นระบบ OCR (ใช้เฉพาะหน้าที่อ่านบาร์โค้ดไม่ได้)...')
        const Tesseract = await import('tesseract.js')
        ocrWorker = await Tesseract.createWorker('eng', 1, {
          logger: (m: { status: string; progress: number }) => {
            if (m.status === 'recognizing text') setWsLog((p) => [`(OCR ${(m.progress * 100).toFixed(0)}%)`, ...p.slice(1)])
          },
        })
        await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })
        return ocrWorker
      }

      /** จับคู่เลขที่อ่านได้จากหน้ากับเลขพัสดุในใบงาน — เผื่อรูปแบบต่างกันเล็กน้อยจึงยอมให้เป็น substring ของกันได้ */
      const matchScannedCode = (raw: string): string | null => {
        const code = normText(raw)
        if (!code) return null
        if (targetsTextSet.has(code)) return code
        for (const t of targetsText) {
          if (t.length >= 6 && (code.includes(t) || t.includes(code))) return t
        }
        return null
      }

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
        const worker = await ensureOcrWorker()
        const { data } = await worker.recognize(canvas)
        return normOCR(data?.text || '')
      }

      const cropTopPct = wsCropTop || 25
      const stats = { text: 0, barcode: 0, ocr: 0, skipped: 0 }
      let done = false
      for (let idx = 0; idx < files.length && !done; idx++) {
        const file = files[idx]
        wsLogAppend(`🔎 สแกนไฟล์: ${file.name} (${idx + 1}/${files.length})`)
        await sleep(0)
        const buf = await file.arrayBuffer()
        // pdf.js จะโอน buffer ไปให้ worker (detach) — ต้องส่งสำเนา เก็บต้นฉบับไว้ให้ pdf-lib ใช้รวมไฟล์
        const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise
        fileBuffers.push(buf)
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          let keyText: string | null = null
          /** อ่านบาร์โค้ดของหน้านี้ออกมาได้ — เป็นหลักฐานที่หนักแน่นที่สุดว่าหน้านี้เป็นของใคร */
          let codeRead = false
          /** หน้านี้มี text layer ที่อ่านได้ — ถ้าอ่านได้แต่ไม่ใช่ของใบงานนี้ ก็ไม่ต้องเสียเวลา OCR */
          let hasTextLayer = false

          // ชั้นที่ 1 — text layer (ฟรี ใช้ได้กับ PDF ที่สร้างจากโปรแกรมโดยตรง)
          const textNorm = await pageTextNormalized(page as { getTextContent: () => Promise<{ items: Array<{ str?: string }> }> })
          if (textNorm.length >= 20) {
            hasTextLayer = true
            for (const t of targetsTextSet) {
              if (textNorm.includes(t)) { keyText = t; break }
            }
            if (keyText) stats.text++
          }

          // ชั้นที่ 2 — บาร์โค้ดจาก image object ในไฟล์ PDF (เร็วสุด ไม่ต้อง render หน้า)
          if (!keyText) {
            const codes = await readBarcodesFromPdfPage(page, pdfjsLib.OPS, barcodeReader)
            if (codes.length > 0) {
              codeRead = true
              for (const code of codes) {
                const matched = matchScannedCode(code)
                if (matched) { keyText = matched; stats.barcode++; break }
              }
            }
          }

          // ชั้นที่ 3 — render หน้าครั้งเดียวแล้วอ่านบาร์โค้ดจาก canvas
          // เผื่อ PDF วาดบาร์โค้ดเป็นเส้น vector หรือรวมทั้งหน้าเป็นภาพเดียว จึงไม่มี image object แยกให้ดึง
          let fullCanvas: HTMLCanvasElement | null = null
          if (!keyText && !codeRead) {
            fullCanvas = await renderPageToCanvas(page as { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } }, 2)
            const code = barcodeReader.fromCanvas(fullCanvas)
            if (code) {
              codeRead = true
              const matched = matchScannedCode(code)
              if (matched) { keyText = matched; stats.barcode++ }
            }
          }

          // ชั้นที่ 4 — OCR ใช้เฉพาะหน้าที่อ่านเลขไม่ออกเลยจริง ๆ (ใช้ canvas เดิม ไม่ render ซ้ำ)
          if (!keyText && !codeRead && !hasTextLayer) {
            if (!fullCanvas) fullCanvas = await renderPageToCanvas(page as { getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: unknown) => { promise: Promise<void> } }, 2)
            const topNorm = await ocrCanvasToNorm(cropTop(fullCanvas, cropTopPct))
            for (const k of targetsOCRSet) {
              if (topNorm.includes(k)) { keyText = ocr2textMap.get(k) ?? null; break }
            }
            if (!keyText) {
              const fullNorm = await ocrCanvasToNorm(fullCanvas)
              for (const k of targetsOCRSet) {
                if (fullNorm.includes(k)) { keyText = ocr2textMap.get(k) ?? null; break }
              }
            }
            if (keyText) stats.ocr++
          } else if (!keyText) {
            stats.skipped++
          }

          if (keyText && !mapping.has(keyText)) {
            mapping.set(keyText, { fileIndex: idx, pageIndex: i - 1 })
            setWsStatFound(String(mapping.size))
          }
          page.cleanup()
          setWsProgress(Math.round(((idx + i / pdf.numPages) / files.length) * 100))
          if (mapping.size >= trackingNumbersRaw.length) {
            wsLogAppend(`⚡ พบครบ ${mapping.size} เลขแล้วที่หน้า ${i} — หยุดสแกนส่วนที่เหลือ`)
            done = true
            break
          }
          if (i % 10 === 0) await sleep(0)
        }
      }
      setWsProgress(100)
      wsLogAppend(`📊 บาร์โค้ด ${stats.barcode} · text layer ${stats.text} · OCR ${stats.ocr} · ข้ามหน้าที่ไม่ใช่ของใบงานนี้ ${stats.skipped}`)
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
      setWsStatMissing(String(missing.length))
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

  type OrderWithItems = Order & { or_order_items?: Array<{ bill_no?: string; item_uid: string; quantity?: number; product_name: string; ink_color: string | null; product_type: string | null; cartoon_pattern: string | null; line_pattern: string | null; font: string | null; line_1: string | null; line_2: string | null; line_3: string | null; no_name_line?: boolean; notes: string | null; file_attachment: string | null; product_id: string }> }

  async function fetchOrdersWithItems(workOrderId: string): Promise<OrderWithItems[]> {
    const { data, error } = await supabase
      .from('or_orders')
      .select('*, or_order_items(*)')
      .eq('work_order_id', workOrderId)
      .not('status', 'in', FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN)
      .order('created_at', { ascending: false })
      .order('bill_no', { ascending: false })
    if (error) throw error
    const list = (data || []) as OrderWithItems[]
    return list
      .map((order) => ({
        ...order,
        or_order_items: (order.or_order_items || []).filter((item: any) =>
          isOrderItemAllowedInFulfillmentFlow(item.cancellation_stock_action)
        ),
      }))
      .filter((order) => (order.or_order_items || []).length > 0)
  }

  async function buildProductionExportRows(workOrderId: string, workOrderNameForDisplay: string): Promise<unknown[][]> {
    const orders = await fetchOrdersWithItems(workOrderId)
    if (orders.length === 0) {
      setMessageModal({ open: true, message: 'ไม่พบข้อมูล' })
      return []
    }
    const dataToExport = await buildProductionExportRowsShared(orders as any, () => workOrderNameForDisplay)
    if (dataToExport.length === 0) {
      setMessageModal({ open: true, message: 'ไม่พบรายการสินค้า' })
    }
    return dataToExport
  }

  async function exportProduction(workOrderId: string, workOrderNameForDisplay: string) {
    if (exportLoading.open) return
    setExportLoading({ open: true, message: 'กำลังสร้างไฟล์ผลิต (Excel)... กรุณารอสักครู่' })
    try {
      const dataToExport = await buildProductionExportRows(workOrderId, workOrderNameForDisplay)
      if (dataToExport.length === 0) return
      const visibleColumns = EXPORT_ITEM_COLUMNS
      const headers = ['ชื่อใบงาน', 'เลขบิล', 'Item UID', 'รหัสสินค้า', ...visibleColumns.map((c) => c.label), 'หมวด']
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...dataToExport])
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'ProductionData')
      XLSX.writeFile(workbook, `Production_${workOrderNameForDisplay}.xlsx`)
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    } finally {
      setExportLoading({ open: false, message: '' })
    }
  }

  async function copyProduction(workOrderId: string, workOrderNameForDisplay: string) {
    if (exportLoading.open) return
    setExportLoading({ open: true, message: 'กำลังเตรียมข้อมูลสำหรับคัดลอก... กรุณารอสักครู่' })
    try {
      const dataToCopy = await buildProductionExportRows(workOrderId, workOrderNameForDisplay)
      if (dataToCopy.length === 0) return
      const clipboardText = dataToCopy
        .map((row) =>
          row
            .map((value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' '))
            .join('\t')
        )
        .join('\n')

      await navigator.clipboard.writeText(clipboardText)
      setMessageModal({ open: true, message: `คัดลอกข้อมูลเรียบร้อย ${dataToCopy.length} แถว (ไม่รวมหัวตาราง)` })
    } catch (err: any) {
      setMessageModal({ open: true, message: 'คัดลอกไม่สำเร็จ: ' + (err?.message ?? err) })
    } finally {
      setExportLoading({ open: false, message: '' })
    }
  }

  async function exportBarcode(workOrderId: string, workOrderNameForDisplay: string) {
    if (exportLoading.open) return
    setExportLoading({ open: true, message: 'กำลังสร้างไฟล์ Barcode (CSV)... กรุณารอสักครู่' })
    try {
      const orders = await fetchOrdersWithItems(workOrderId)
      if (orders.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบข้อมูล' })
        return
      }
      const allItems = orders.flatMap((order) => order.or_order_items || (order as any).order_items || [])
      const productIds = Array.from(new Set(allItems.map((item: any) => item.product_id).filter(Boolean)))
      const productCategoryByProductId: Record<string, string> = {}
      if (productIds.length > 0) {
        const { data: products, error: productsError } = await supabase
          .from('pr_products')
          .select('id, product_category')
          .in('id', productIds)
        if (productsError) throw productsError
        ;(products || []).forEach((p: any) => {
          productCategoryByProductId[String(p.id)] = String(p.product_category || '').trim()
        })
      }

      const headers = ['Item UID', 'ชื่อสินค้า', 'สีหมึก', 'บรรทัด 1', 'หมวด']
      const dataToExport: unknown[][] = []
      orders.forEach((order) => {
        const rawItems = order.or_order_items || (order as any).order_items || []
        const items = sortOrderItemsForExport(rawItems)
        const bill = String(order.bill_no ?? '').trim() || '—'
        let unitSeq = 0
        items.forEach((item: any) => {
          const category = productCategoryByProductId[String(item.product_id)] || 'N/A'
          const copies = normalizedLineQuantity(item.quantity)
          for (let c = 0; c < copies; c++) {
            unitSeq++
            dataToExport.push([
              flatBillUnitUid(bill, unitSeq),
              item.product_name,
              item.ink_color ?? '',
              forceText(item.line_1),
              category,
            ])
          }
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
      link.download = `Barcode_${workOrderNameForDisplay}.csv`
      link.click()
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    } finally {
      setExportLoading({ open: false, message: '' })
    }
  }

  /** เปิด Modal Preview ใบปะหน้า — แยกที่อยู่ → ชื่อ / ที่อยู่ / รหัสไปรษณีย์ / เบอร์โทร แล้วแสดง Preview ก่อน Export */
  async function openWaybillPreview(workOrderId: string, workOrderName: string) {
    try {
      setUpdating(true)
      const orders = await fetchOrdersWithItems(workOrderId)
      if (orders.length === 0) {
        setMessageModal({ open: true, message: 'ไม่พบออร์เดอร์' })
        return
      }
      const rows: WaybillPreviewRow[] = []
      for (const order of orders) {
        const addressRaw = (order.billing_details?.original_customer_address || order.customer_address || '').trim()

        // 1. ดึงเบอร์โทรออกจากข้อความ + ใช้ billing_details.mobile_phone เป็น fallback
        const { candidates: phoneCandidates, rest: textAfterPhones } = extractPhonesFromText(addressRaw)
        const localPhones = phoneCandidates.map(e164ToLocal)
        // ถ้าไม่เจอเบอร์ในที่อยู่ ให้ใช้เบอร์จาก billing_details
        const billingPhone = (order.billing_details?.mobile_phone || '').trim()
        if (localPhones.length === 0 && billingPhone) {
          localPhones.push(billingPhone)
        } else if (localPhones.length === 1 && billingPhone && billingPhone !== localPhones[0]) {
          localPhones.push(billingPhone)
        }

        // 2. ดึงรหัสไปรษณีย์ (เลข 5 หลักตัวสุดท้าย)
        const postcodeMatches = [...textAfterPhones.matchAll(/\b(\d{5})\b/g)]
        const postalCode = postcodeMatches.length ? postcodeMatches[postcodeMatches.length - 1][1] : ''
        let textClean = textAfterPhones
        if (postalCode) {
          textClean = textClean
            .replace(/(?:รหัสไปรษณีย์|ปณ\.?)\s*/gi, ' ')
            .replace(new RegExp(`\\b${postalCode}\\b`), ' ')
            .replace(/\s+/g, ' ').trim()
        }

        // 3. ดึงชื่อผู้รับ — ใช้ฟิลด์ structured ก่อน ถ้าไม่มีให้ลอง parse จากบรรทัดแรก
        let consigneeName = (order.recipient_name || '').trim() || (order.customer_name || '').trim()
        let addressClean = textClean

        if (consigneeName) {
          // ตัดชื่อออกจากข้อความที่อยู่ (ถ้าพบใน 50 ตัวอักษรแรก)
          const idx = addressClean.indexOf(consigneeName)
          if (idx >= 0 && idx < 50) {
            addressClean = (addressClean.slice(0, idx) + addressClean.slice(idx + consigneeName.length)).replace(/\s+/g, ' ').trim()
          }
        } else {
          // ลอง parse ชื่อจากบรรทัดแรก
          const lines = textClean.split(/\n/).map(l => l.trim()).filter(Boolean)
          if (lines.length > 0) {
            const first = lines[0]
            const hasAddrCue = /เลขที่|หมู่|ม\.|ต\.|อ\.|จ\.|ถนน|ถ\.|ซอย|ซ\.|แขวง|เขต|ตำบล|อำเภอ|จังหวัด|\d{1,5}\//.test(first)
            if (!hasAddrCue && first.length < 60) {
              consigneeName = first.replace(/[,;:|/\-]+$/g, '').trim()
              addressClean = lines.slice(1).join('\n').replace(/\s+/g, ' ').trim()
            }
          }
        }
        // ลบเศษ separator นำหน้า/ท้าย
        addressClean = addressClean.replace(/^[\s,;:|/\-]+/, '').replace(/[\s,;:|/\-]+$/, '').trim()

        // 4. ใช้ billing_details เป็น fallback สำหรับ postalCode / address
        const bd = order.billing_details
        let finalPostalCode = postalCode || (bd?.postal_code || '')
        let finalAddress = addressClean
        // ถ้า billing_details มีที่อยู่ structured ให้ใช้ประกอบ
        if (!finalAddress && bd?.address_line) {
          finalAddress = [bd.address_line, bd.sub_district, bd.district, bd.province].filter(Boolean).join(' ')
        }
        // ถ้าชื่อยังว่าง ลอง billing
        if (!consigneeName) {
          consigneeName = (order.recipient_name || order.customer_name || '').trim()
        }

        // 5. COD
        const isCod = (order.payment_method || '').toLowerCase().includes('cod')
        const cod = isCod ? String(order.total_amount ?? 0) : '0'

        rows.push({ billNo: order.bill_no, addressRaw, consigneeName, address: finalAddress, postalCode: finalPostalCode, phone1: localPhones[0] || '', phone2: localPhones[1] || '', cod })
      }
      setWaybillPreviewModal({ open: true, workOrderName, rows })
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + (err?.message ?? err) })
    } finally {
      setUpdating(false)
    }
  }

  /** อัปเดตค่าในแถว Preview ใบปะหน้า */
  function updateWaybillPreviewRow(index: number, field: keyof WaybillPreviewRow, value: string) {
    setWaybillPreviewModal(prev => ({
      ...prev,
      rows: prev.rows.map((r, i) => i === index ? { ...r, [field]: value } : r),
    }))
  }

  /** ตรวจสอบแถวมีข้อมูลจำเป็นครบหรือไม่ */
  function isWaybillRowMissing(row: WaybillPreviewRow): boolean {
    return !row.consigneeName.trim() || !row.address.trim() || !row.postalCode.trim() || !row.phone1.trim()
  }

  /** Export ไฟล์ Excel (.xlsx) ตาม Flash Express template */
  async function exportWaybillXlsx() {
    const { workOrderName, rows } = waybillPreviewModal
    if (rows.length === 0) return
    if (exportLoading.open) return
    setExportLoading({ open: true, message: 'กำลังสร้างไฟล์ใบปะหน้า Flash Express (.xlsx)... กรุณารอสักครู่' })
    try {
      await downloadFlashWaybillXlsx(rows, workOrderName || 'output')
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาด Export ใบปะหน้า: ' + (err?.message ?? err) })
    } finally {
      setExportLoading({ open: false, message: '' })
    }
  }

  async function openPickingSlipModal(workOrderId: string, workOrderName: string) {
    try {
      const orders = await fetchOrdersWithItems(workOrderId)
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

      type MainRowWithCat = {
        woName: string
        code: string
        name: string
        location: string
        finalQty: number
        _category: string
      }
      const mainMap = new Map<string, MainRowWithCat>()
      itemsInWorkOrder
        .filter((item) => !PICKING_EXCLUDED_CATEGORIES.some((ex) => (item.product_category || '').toUpperCase().includes(ex)))
        .forEach((item) => {
          const key = item.product_id
          const existing = mainMap.get(key)
          const code = item.product_code || 'N/A'
          const name = item.product_name || 'N/A'
          const location = item.storage_location || 'N/A'
          const rawCategory = String(item.product_category || '').trim()
          const lineQty = normalizedLineQuantity((item as any).quantity)
          if (existing) {
            existing.finalQty += lineQty
          } else {
            mainMap.set(key, { woName: workOrderName, code, name, location, finalQty: lineQty, _category: rawCategory })
          }
        })
      const withCatList = Array.from(mainMap.values()).map((item) => {
        let finalQty = item.finalQty
        if (item._category.toUpperCase().includes('CONDO STAMP')) finalQty = Math.ceil(item.finalQty / 5)
        return { ...item, finalQty }
      })
      const planDeptSettings = await fetchPlanDeptSettings()
      const finalMainList: PickingMainRow[] = withCatList
        .map((item) => ({
          woName: item.woName,
          code: item.code,
          name: item.name,
          location: item.location,
          finalQty: item.finalQty,
          dept: resolvePickingDepartment(item._category, planDeptSettings, item.name),
        }))
        .sort((a, b) => a.location.localeCompare(b.location))

      const spareMap = new Map<string, PickingSpareRow>()
      itemsInWorkOrder.forEach((item) => {
        const rawCat = String(item.product_category || '').trim()
        const lineQty = normalizedLineQuantity((item as any).quantity)
        const spareQty = pickSpareQtyForLine(lineQty, rawCat)
        const rc = item.rubber_code != null ? String(item.rubber_code).trim() : ''
        if (!rc) return
        const existing = spareMap.get(rc)
        if (existing) existing.qty += spareQty
        else spareMap.set(rc, { label: rc, qty: spareQty })
      })
      const finalSpareList = Array.from(spareMap.values()).sort((a, b) =>
        (a.label || '').localeCompare(b.label || '', 'th')
      )

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
      const deptSettings = await fetchPlanDeptSettings()
      const stampLabel = deptSettings.departments.find((d) => isStampDepartmentName(d)) ?? 'STAMP'
      const byDept: Record<string, PickingMainRow[]> = {}
      for (const row of mainItems) {
        if (!byDept[row.dept]) byDept[row.dept] = []
        byDept[row.dept].push(row)
      }
      if (spareItems.length > 0 && !byDept[stampLabel]) {
        byDept[stampLabel] = []
      }
      const candidateKeys = Object.keys(byDept).filter((d) => {
        const n = byDept[d]?.length ?? 0
        if (n > 0) return true
        return spareItems.length > 0 && d === stampLabel
      })
      const ordered = deptExportOrder(deptSettings, candidateKeys)
      const dateStr = formatThaiBuddhistDate()
      for (let i = 0; i < ordered.length; i++) {
        const d = ordered[i]
        const rows = (byDept[d] || []).slice().sort((a, b) => a.location.localeCompare(b.location))
        try {
          await downloadPickingSlipPng(
            {
              workOrderName,
              deptTitle: d,
              buddhistDateStr: dateStr,
              rows,
              spareItems,
              showSpareSummary: isStampDepartmentName(d) && spareItems.length > 0,
            },
            `ใบเบิก_${safeFilePart(workOrderName)}_${safeFilePart(d)}`
          )
        } catch (_) {
          /* PNG รายแผนกล้มเหลว — ข้าม */
        }
        if (i < ordered.length - 1) await new Promise((r) => setTimeout(r, 750))
      }

      const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
      const csvRows: string[] = []
      csvRows.push(['รหัสทำรายการ', 'แผนก', 'รหัสสินค้า', 'รายการสินค้า', 'จุดเก็บ', 'จำนวนเบิก'].join(','))
      mainItems.forEach((item) => {
        csvRows.push(
          [esc(item.woName), esc(item.dept), esc(item.code), esc(item.name), esc(item.location), item.finalQty].join(',')
        )
      })
      if (spareItems.length > 0) {
        csvRows.push('')
        csvRows.push(esc('อะไหล่ (หน้ายาง/โฟม) — รวมทั้งใบงาน'))
        csvRows.push(['รายการอะไหล่ (รหัสหน้ายาง)', 'จำนวนรวม'].join(','))
        spareItems.forEach((item) => {
          csvRows.push([esc(item.label), item.qty].join(','))
        })
      }
      const csvContent = '\uFEFF' + csvRows.join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `ใบเบิก_${safeFilePart(workOrderName)}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setMessageModal({ open: true, message: 'เกิดข้อผิดพลาดในการ Export: ' + (err?.message ?? err) })
    }
  }

  function openImportTrackingModal(workOrderName: string) {
    setTrackingImportProgress({ ...EMPTY_TRACKING_IMPORT_PROGRESS })
    setPendingTrackingRows([])
    setTrackingImportConflicts([])
    setTrackingConflictChoices({})
    setImportTrackingModal({ open: true, workOrderName })
  }

  function closeImportTrackingModal() {
    if (isTrackingImportBusy) return
    setImportTrackingModal({ open: false, workOrderName: null })
    setTrackingImportProgress({ ...EMPTY_TRACKING_IMPORT_PROGRESS })
    setPendingTrackingRows([])
    setTrackingImportConflicts([])
    setTrackingConflictChoices({})
  }

  function prepareTrackingRows(rows: TrackingImportRow[]): {
    rows: TrackingImportRow[]
    conflicts: TrackingImportConflict[]
  } {
    const byBill = new Map<string, { bill_no: string; trackingByKey: Map<string, string> }>()
    for (const row of rows) {
      const billKey = row.bill_no.trim().toUpperCase()
      const trackingKey = row.tracking_number.trim().toUpperCase()
      let group = byBill.get(billKey)
      if (!group) {
        group = { bill_no: row.bill_no.trim(), trackingByKey: new Map() }
        byBill.set(billKey, group)
      }
      if (!group.trackingByKey.has(trackingKey)) {
        group.trackingByKey.set(trackingKey, row.tracking_number.trim())
      }
    }

    const deduplicatedRows: TrackingImportRow[] = []
    const conflicts: TrackingImportConflict[] = []
    for (const group of byBill.values()) {
      const trackingNumbers = [...group.trackingByKey.values()]
      if (trackingNumbers.length > 1) {
        conflicts.push({ bill_no: group.bill_no, tracking_numbers: trackingNumbers })
      } else if (trackingNumbers.length === 1) {
        deduplicatedRows.push({ bill_no: group.bill_no, tracking_number: trackingNumbers[0] })
      }
    }
    return { rows: deduplicatedRows, conflicts }
  }

  /** แมปหัวคอลัมน์ที่รองรับ → ฟิลด์ภายใน */
  const BILL_NO_ALIASES = ['bill_no', 'เลขออเดอร์']
  const TRACKING_ALIASES = ['tracking_number', 'เลขพัสดุ']

  function findHeaderIndex(headers: string[], aliases: string[]): number {
    return headers.findIndex((h) => aliases.some((a) => h.toLowerCase().trim() === a.toLowerCase()))
  }

  /** Parse ไฟล์ .xlsx หรือ .csv แล้วคืน array ของ { bill_no, tracking_number } */
  function parseTrackingFile(file: File): Promise<{ bill_no: string; tracking_number: string }[]> {
    return new Promise((resolve, reject) => {
      const isXlsx = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')

      if (isXlsx) {
        const reader = new FileReader()
        reader.onload = (event) => {
          try {
            const data = new Uint8Array(event.target?.result as ArrayBuffer)
            const wb = XLSX.read(data, { type: 'array' })
            const ws = wb.Sheets[wb.SheetNames[0]]
            const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
            if (rows.length <= 1) throw new Error('ไฟล์ว่างเปล่า')
            const headers = rows[0].map((h) => String(h ?? '').trim())
            const billNoIndex = findHeaderIndex(headers, BILL_NO_ALIASES)
            const trackingIndex = findHeaderIndex(headers, TRACKING_ALIASES)
            if (billNoIndex === -1 || trackingIndex === -1) throw new Error('ไม่พบหัวข้อ เลขออเดอร์/bill_no และ เลขพัสดุ/tracking_number')
            const updates: { bill_no: string; tracking_number: string }[] = []
            for (let i = 1; i < rows.length; i++) {
              const bill_no = String(rows[i]?.[billNoIndex] ?? '').trim()
              const tracking_number = String(rows[i]?.[trackingIndex] ?? '').trim()
              if (bill_no && tracking_number) updates.push({ bill_no, tracking_number })
            }
            resolve(updates)
          } catch (err) { reject(err) }
        }
        reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'))
        reader.readAsArrayBuffer(file)
      } else {
        const reader = new FileReader()
        reader.onload = (event) => {
          try {
            const csv = String(event.target?.result ?? '')
            const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: true })
            if (parsed.errors.length > 0) throw new Error(`อ่าน CSV ไม่สำเร็จ: ${parsed.errors[0].message}`)
            const rows = parsed.data
            if (rows.length <= 1) throw new Error('ไฟล์ CSV ว่างเปล่า')
            const headers = rows[0].map((h) => String(h ?? '').replace(/^\uFEFF/, '').trim())
            const billNoIndex = findHeaderIndex(headers, BILL_NO_ALIASES)
            const trackingIndex = findHeaderIndex(headers, TRACKING_ALIASES)
            if (billNoIndex === -1 || trackingIndex === -1) throw new Error('ไม่พบหัวข้อ เลขออเดอร์/bill_no และ เลขพัสดุ/tracking_number')
            const updates: { bill_no: string; tracking_number: string }[] = []
            for (let i = 1; i < rows.length; i++) {
              const bill_no = String(rows[i]?.[billNoIndex] ?? '').trim()
              const tracking_number = String(rows[i]?.[trackingIndex] ?? '').trim()
              if (bill_no && tracking_number) updates.push({ bill_no, tracking_number })
            }
            resolve(updates)
          } catch (err) { reject(err) }
        }
        reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'))
        reader.readAsText(file, 'UTF-8')
      }
    })
  }

  async function executeTrackingImport(updates: TrackingImportRow[], workOrderName: string) {
    setUpdating(true)
    try {
      if (updates.length === 0) throw new Error('ไม่พบข้อมูลที่ถูกต้อง')

      let processed = 0
      let updated = 0
      let unchanged = 0
      let duplicate = 0
      let notFound = 0
      let outsideWorkOrder = 0
      let invalid = 0
      let failed = 0
      const details: TrackingImportDetail[] = []

      setTrackingImportProgress({
        ...EMPTY_TRACKING_IMPORT_PROGRESS,
        phase: 'importing',
        total: updates.length,
        message: `กำลังบันทึก 0 / ${updates.length} รายการ`,
      })

      for (let batchStart = 0; batchStart < updates.length; batchStart += TRACKING_IMPORT_BATCH_SIZE) {
        const batch = updates.slice(batchStart, batchStart + TRACKING_IMPORT_BATCH_SIZE)
        const { data, error } = await supabase.rpc('rpc_plan_import_tracking_batch', {
          p_work_order_name: workOrderName,
          p_rows: batch,
        })
        if (error) throw error
        const result = data as TrackingImportBatchResult | null
        if (!result?.success) throw new Error('ฐานข้อมูลไม่ยืนยันผลการนำเข้าเลขพัสดุ')

        processed += result.processed ?? batch.length
        updated += result.updated ?? 0
        unchanged += result.unchanged ?? 0
        duplicate += result.duplicate ?? 0
        notFound += result.not_found ?? 0
        outsideWorkOrder += result.outside_work_order ?? 0
        invalid += result.invalid ?? 0
        failed += result.failed ?? 0
        ;(result.results || []).forEach((row) => {
          if (row.status === 'updated' || row.status === 'unchanged') return
          details.push({ ...row, row_no: batchStart + row.row_no })
        })

        setTrackingImportProgress({
          phase: 'importing',
          total: updates.length,
          processed,
          updated,
          unchanged,
          duplicate,
          notFound,
          outsideWorkOrder,
          invalid,
          failed,
          message: `กำลังบันทึก ${processed} / ${updates.length} รายการ`,
          details: [...details],
        })
      }

      setTrackingImportProgress((prev) => ({
        ...prev,
        phase: 'refreshing',
        processed: updates.length,
        message: 'บันทึกครบแล้ว กำลังอัปเดตรายการบิล',
      }))
      const woRecord = workOrders.find((w) => w.work_order_name === workOrderName)
      if (woRecord) await loadOrdersForWo(woRecord.id)
      onRefresh?.()

      setTrackingImportProgress({
        phase: 'completed',
        total: updates.length,
        processed: updates.length,
        updated,
        unchanged,
        duplicate,
        notFound,
        outsideWorkOrder,
        invalid,
        failed,
        message: `นำเข้าเสร็จแล้ว ${updated} / ${updates.length} รายการ`,
        details,
      })
    } catch (err: unknown) {
      const errorMessage = formatTrackingImportError(err)
      setTrackingImportProgress((prev) => ({
        ...prev,
        phase: 'error',
        message: 'เกิดข้อผิดพลาด: ' + errorMessage,
      }))
    } finally {
      setUpdating(false)
    }
  }

  async function handleTrackingFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !importTrackingModal.workOrderName) return
    const workOrderName = importTrackingModal.workOrderName
    e.target.value = ''
    setUpdating(true)
    setPendingTrackingRows([])
    setTrackingImportConflicts([])
    setTrackingConflictChoices({})
    setTrackingImportProgress({
      ...EMPTY_TRACKING_IMPORT_PROGRESS,
      phase: 'reading',
      message: `กำลังอ่านไฟล์ ${file.name}`,
    })
    try {
      const parsedRows = await parseTrackingFile(file)
      if (parsedRows.length === 0) throw new Error('ไม่พบข้อมูลที่ถูกต้อง')
      const prepared = prepareTrackingRows(parsedRows)
      if (prepared.conflicts.length > 0) {
        setPendingTrackingRows(prepared.rows)
        setTrackingImportConflicts(prepared.conflicts)
        setTrackingImportProgress({
          ...EMPTY_TRACKING_IMPORT_PROGRESS,
          phase: 'conflict',
          total: prepared.rows.length + prepared.conflicts.length,
          message: `พบ ${prepared.conflicts.length} ออเดอร์ที่มีหลายเลขพัสดุ กรุณาเลือกเลขที่ต้องการ`,
        })
        return
      }
      await executeTrackingImport(prepared.rows, workOrderName)
    } catch (err: unknown) {
      setTrackingImportProgress((prev) => ({
        ...prev,
        phase: 'error',
        message: 'เกิดข้อผิดพลาด: ' + formatTrackingImportError(err),
      }))
    } finally {
      setUpdating(false)
    }
  }

  async function confirmTrackingConflictChoices() {
    if (!importTrackingModal.workOrderName) return
    const allSelected = trackingImportConflicts.every((conflict) => trackingConflictChoices[conflict.bill_no])
    if (!allSelected) return
    const resolvedRows: TrackingImportRow[] = [
      ...pendingTrackingRows,
      ...trackingImportConflicts.map((conflict) => ({
        bill_no: conflict.bill_no,
        tracking_number: trackingConflictChoices[conflict.bill_no],
      })),
    ]
    setPendingTrackingRows([])
    setTrackingImportConflicts([])
    setTrackingConflictChoices({})
    await executeTrackingImport(resolvedRows, importTrackingModal.workOrderName)
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
          {searchTerm.trim()
            ? 'ไม่พบใบงานตามคำค้น — ลองคำอื่น หรือล้างช่องค้นหา'
            : 'ยังไม่มีใบงานที่สร้าง — สร้างได้ที่เมนู ใบสั่งงาน'}
        </div>
      ) : (
        <div className="space-y-2">
          {workOrders.map((wo) => {
            const orders = ordersByWo[wo.id] || []
            const selectedIds = selectedByWo[wo.id] || new Set<string>()
            const isExpanded = expandedWoIds.has(wo.id)
            const searchNeedle = searchTerm.trim().toLowerCase()
            const isCancelledWorkOrder = isWorkOrderCancelledRecord(wo)
            const channelCode = channelByWo[wo.id] ?? ''
            const isClaimWorkOrder = claimByWo[wo.id] || wo.work_order_name.trim().startsWith('(เคลม)')
            // Older claim work orders were saved without the claim prefix. Keep
            // their stored identifier intact, but present them consistently.
            const displayWorkOrderName = isClaimWorkOrder && !wo.work_order_name.trim().startsWith('(เคลม)')
              ? `(เคลม)${wo.work_order_name}`
              : wo.work_order_name
            // ใบงานเคลม (มีบิล REQ) ใช้ปุ่มชุดเดียวกับ FBTR เสมอ: Export (ใบปะหน้า) + นำเข้าเลขพัสดุ
            const isWaybillSortChannel = WAYBILL_SORT_CHANNELS.includes(channelCode) && !claimByWo[wo.id]
            const canCancelWorkOrder = isRoleInAllowedList(user?.role, ['superadmin', 'sales-tr'])

            return (
              <div
                key={wo.id}
                className={`bg-white rounded-lg border overflow-hidden ${
                  isCancelledWorkOrder ? 'border-red-200 ring-1 ring-red-100' : 'border-gray-200'
                }`}
              >
                {/* หัวใบงาน + ปุ่มด้านขวา (เงื่อนไขอ้างอิง file/index.html) */}
                <div
                  className={`flex flex-wrap items-center justify-between gap-4 p-4 border-b border-gray-100 ${
                    isCancelledWorkOrder
                      ? 'cursor-not-allowed bg-red-50/60 border-red-100'
                      : 'cursor-pointer hover:bg-gray-50 border-gray-100'
                  }`}
                  onClick={() => toggleExpand(wo)}
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="text-gray-400 select-none shrink-0">{isCancelledWorkOrder ? '•' : isExpanded ? '▼' : '▶'}</span>
                    <span className={`font-semibold truncate ${isCancelledWorkOrder ? 'text-red-950' : 'text-gray-900'}`}>
                      {displayWorkOrderName} ({billCountByWo[wo.id] ?? wo.order_count} บิล)
                    </span>
                    {isClaimWorkOrder && (
                      <span className="shrink-0 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        เคลม
                      </span>
                    )}
                    {isCancelledWorkOrder && (
                      <span
                        className="shrink-0 px-2.5 py-1 text-xs font-bold rounded-md bg-red-100 text-red-900 border border-red-300"
                        title="บิลถูกย้ายออกหรือปิดใบงานแล้ว — ไม่มีบิลในใบงาน"
                      >
                        ใบงานนี้ถูกยกเลิก
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => copyProduction(wo.id, wo.work_order_name))}
                      disabled={updating || isCancelledWorkOrder}
                      title={isCancelledWorkOrder ? 'ใบงานนี้ถูกยกเลิกแล้ว ไม่สามารถคัดลอกข้อมูลได้' : undefined}
                      className="px-3 py-1.5 bg-orange-100 text-orange-800 rounded text-xs font-medium hover:bg-orange-200 disabled:opacity-50"
                    >
                      คัดลอก
                    </button>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => openPickingSlipModal(wo.id, wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-green-100 text-green-800 rounded text-xs font-medium hover:bg-green-200 disabled:opacity-50"
                    >
                      ทำใบเบิก
                    </button>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => exportProduction(wo.id, wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-blue-100 text-blue-800 rounded text-xs font-medium hover:bg-blue-200 disabled:opacity-50"
                    >
                      Export (ไฟล์ผลิต)
                    </button>
                    <button
                      type="button"
                      onClick={(e) => onHeaderButtonClick(e, () => exportBarcode(wo.id, wo.work_order_name))}
                      disabled={updating}
                      className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium hover:bg-amber-200 disabled:opacity-50"
                    >
                      ทำ Barcode
                    </button>
                    {isWaybillSortChannel ? (
                      <button
                        type="button"
                        onClick={(e) => onHeaderButtonClick(e, () => openWaybillSorterModal(wo.id, wo.work_order_name))}
                        disabled={updating}
                        className="px-3 py-1.5 bg-orange-100 text-orange-800 rounded text-xs font-medium hover:bg-orange-200 disabled:opacity-50"
                      >
                        เรียงใบปะหน้า
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={(e) => onHeaderButtonClick(e, () => openWaybillPreview(wo.id, wo.work_order_name))}
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
                        onClick={(e) => onHeaderButtonClick(e, () => openCancelWorkOrderConfirm(wo))}
                        disabled={updating || isCancelledWorkOrder}
                        title={isCancelledWorkOrder ? 'ใบงานนี้ถูกยกเลิกแล้ว' : undefined}
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
                    {isCancelledWorkOrder ? (
                      <div className="text-center py-6 text-red-800/90 text-sm font-medium">
                        ใบงานนี้ถูกยกเลิก — บิลถูกย้ายกลับไปใบสั่งงานหรือไม่มีบิลในใบงานแล้ว
                      </div>
                    ) : orders.length === 0 ? (
                      <div className="text-center py-6 text-gray-500">กำลังโหลด...</div>
                    ) : (
                      <>
                        {/* เลือกทั้งหมด + ย้ายไปใบสั่งงาน (ตรวจ WMS picked/correct ใน RPC) */}
                        {mode === 'active' && (
                          <div className="flex flex-wrap items-center gap-2 mb-4">
                            <button
                              type="button"
                              onClick={() => selectAllBills(wo.id)}
                              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-100"
                            >
                              เลือกทั้งหมด
                            </button>
                            <button
                              type="button"
                              onClick={() => confirmReleaseToWorkQueue(wo.id)}
                              disabled={updating || selectedIds.size === 0}
                              className="px-3 py-1.5 bg-indigo-100 text-indigo-900 rounded-lg text-sm font-medium hover:bg-indigo-200 disabled:opacity-50"
                            >
                              ย้ายไปใบสั่งงาน
                            </button>
                          </div>
                        )}

                        {/* ตารางบิล: ชื่อช่องทาง = or_orders.customer_name, ชื่อลูกค้า = or_orders.recipient_name */}
                        <div className="bg-white rounded-lg border overflow-hidden overflow-x-auto">
                          <table className="w-full text-sm min-w-[720px]">
                            <thead>
                              <tr className="bg-gray-100 border-b">
                                {mode === 'active' && (
                                  <th className="w-10 p-3 text-left">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.size === orders.length && orders.length > 0}
                                      onChange={(e) => (e.target.checked ? selectAllBills(wo.id) : clearBillSelection(wo.id))}
                                      className="rounded border-gray-300"
                                    />
                                  </th>
                                )}
                                <th className="p-3 text-left font-medium min-w-[110px]">เลขบิล</th>
                                <th className="p-3 text-left font-medium min-w-[120px]">ชื่อลูกค้า</th>
                                <th className="p-3 text-left font-medium min-w-[100px]">ชื่อช่องทาง</th>
                                <th className="p-3 text-left font-medium min-w-[110px]">เลขคำสั่งซื้อ</th>
                                <th className="p-3 text-left font-medium min-w-[100px]">ผู้สร้างบิล</th>
                                <th className="p-3 pl-2 text-left font-medium w-56">เลขพัสดุ</th>
                              </tr>
                            </thead>
                            <tbody>
                              {orders.map((order) => {
                                const rowMatchesSearch = searchNeedle.length > 0 && (
                                  orderMatchesSearch(order, searchNeedle) || productMatchedOrderIds.has(order.id)
                                )
                                return (
                                  <tr
                                    key={order.id}
                                    className={`border-b border-gray-100 ${
                                      rowMatchesSearch
                                        ? 'bg-amber-100/90 ring-1 ring-inset ring-amber-400/70'
                                        : 'hover:bg-gray-50'
                                    }`}
                                  >
                                    {mode === 'active' && (
                                      <td className="p-3 align-middle">
                                        <input
                                          type="checkbox"
                                          checked={selectedIds.has(order.id)}
                                          onChange={() => toggleBillSelect(wo.id, order.id)}
                                          className="rounded border-gray-300"
                                        />
                                      </td>
                                    )}
                                    <td className="p-3 align-middle">
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setDetailOrder(order) }} className="text-blue-600 font-medium hover:text-blue-800 hover:underline transition-colors">
                                        {order.bill_no ?? '-'}
                                        <ExpressReceiptNumberInline value={order.express_receipt_number} />
                                      </button>
                                      {!isOrderAllowedInFulfillmentFlow(order.status) && (
                                        <div className="mt-1 w-fit rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                                          ยกเลิกบิล
                                        </div>
                                      )}
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
                                      {order.tracking_number ? (
                                        <span className="block truncate px-1.5 py-0.5 text-xs text-gray-700">{order.tracking_number}</span>
                                      ) : (
                                        <span className="block px-1.5 py-0.5 text-xs text-gray-400">ยังไม่มี</span>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
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

      {/* Modal แจ้งข้อความ — z-[80] ให้ลอยเหนือ modal อื่นทุกตัว (เช่น Preview ใบปะหน้า z-50, loading z-[70]) */}
      <Modal open={messageModal.open} onClose={() => setMessageModal({ open: false, message: '' })} closeOnBackdropClick stackClassName="z-[80]" contentClassName="max-w-md w-full">
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

          <div className="space-y-4">
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
                      <th className="p-2 text-left border-b border-gray-200 w-[20%]">จุดเก็บ</th>
                      <th className="p-2 text-left border-b border-gray-200 w-[16%]">รหัส</th>
                      <th className="p-2 text-left border-b border-gray-200 w-[14%]">แผนก</th>
                      <th className="p-2 text-left border-b border-gray-200 min-w-[36%]">รายการ</th>
                      <th className="p-2 text-center border-b border-gray-200 w-[10%]">จำนวน</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pickingSlipModal.mainItems.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="p-2">{row.location}</td>
                        <td className="p-2">{row.code}</td>
                        <td className="p-2 text-gray-700">{row.dept}</td>
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
                        <th className="p-2 text-center border-b border-gray-200 w-24">จำนวน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pickingSlipModal.spareItems.map((row, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="p-2">{row.label}</td>
                          <td className="p-2 text-center tabular-nums">{row.qty}</td>
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
              Export All (PNG, CSV)
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
      <Modal open={importTrackingModal.open} onClose={closeImportTrackingModal} contentClassName="max-w-2xl w-full">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-900 mb-2">นำเข้าเลขพัสดุ</h3>
          <p className="text-gray-600 text-sm mb-1">ใบงาน: <span className="font-semibold text-gray-800">{importTrackingModal.workOrderName}</span></p>
          <p className="text-gray-600 text-sm mb-4">เลือกไฟล์ .xlsx หรือ .csv ที่มีคอลัมน์ เลขออเดอร์ (bill_no) และ เลขพัสดุ (tracking_number)</p>

          {!isTrackingImportBusy && trackingImportProgress.phase !== 'conflict' && (
            <input
              ref={trackingFileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700"
              onChange={handleTrackingFileChange}
            />
          )}

          {trackingImportProgress.phase !== 'idle' && (
            <div className="mt-5 space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                  <span className={`font-semibold ${trackingImportProgress.phase === 'error' ? 'text-red-600' : 'text-gray-700'}`}>
                    {trackingImportProgress.message}
                  </span>
                  <span className="font-bold text-blue-700">{trackingImportPercent}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-gray-200">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${trackingImportProgress.phase === 'error' ? 'bg-red-500' : trackingImportProgress.phase === 'completed' ? 'bg-emerald-500' : 'bg-blue-600'}`}
                    style={{ width: `${trackingImportPercent}%` }}
                  />
                </div>
              </div>

              {trackingImportProgress.phase === 'conflict' && trackingImportConflicts.length > 0 && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    ระบบจะยังไม่บันทึกข้อมูลจนกว่าจะเลือกเลขพัสดุให้ครบทุกออเดอร์ เพื่อป้องกันเลขแถวหลังเขียนทับแถวแรก
                  </div>
                  <div className="max-h-72 space-y-3 overflow-auto pr-1">
                    {trackingImportConflicts.map((conflict) => (
                      <fieldset key={conflict.bill_no} className="rounded-lg border border-gray-200 p-3">
                        <legend className="px-1 text-sm font-bold text-gray-800">ออเดอร์ {conflict.bill_no}</legend>
                        <div className="mt-1 space-y-2">
                          {conflict.tracking_numbers.map((trackingNumber) => (
                            <label
                              key={trackingNumber}
                              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${
                                trackingConflictChoices[conflict.bill_no] === trackingNumber
                                  ? 'border-blue-500 bg-blue-50 text-blue-900'
                                  : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              <input
                                type="radio"
                                name={`tracking-conflict-${conflict.bill_no}`}
                                value={trackingNumber}
                                checked={trackingConflictChoices[conflict.bill_no] === trackingNumber}
                                onChange={() => setTrackingConflictChoices((current) => ({
                                  ...current,
                                  [conflict.bill_no]: trackingNumber,
                                }))}
                              />
                              <span className="font-mono font-semibold">{trackingNumber}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPendingTrackingRows([])
                        setTrackingImportConflicts([])
                        setTrackingConflictChoices({})
                        setTrackingImportProgress({ ...EMPTY_TRACKING_IMPORT_PROGRESS })
                      }}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      ยกเลิกและเลือกไฟล์ใหม่
                    </button>
                    <button
                      type="button"
                      onClick={confirmTrackingConflictChoices}
                      disabled={!trackingImportConflicts.every((conflict) => trackingConflictChoices[conflict.bill_no])}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ยืนยันและนำเข้าต่อ
                    </button>
                  </div>
                </div>
              )}

              {trackingImportProgress.total > 0 && trackingImportProgress.phase !== 'conflict' && (
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-center">
                    <div className="text-xs text-emerald-700">บันทึกสำเร็จ</div>
                    <div className="text-lg font-bold text-emerald-700">{trackingImportProgress.updated}</div>
                  </div>
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-center">
                    <div className="text-xs text-gray-600">ข้อมูลเดิม</div>
                    <div className="text-lg font-bold text-gray-700">{trackingImportProgress.unchanged}</div>
                  </div>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-center">
                    <div className="text-xs text-amber-700">เลขซ้ำ</div>
                    <div className="text-lg font-bold text-amber-700">{trackingImportProgress.duplicate}</div>
                  </div>
                  <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-center">
                    <div className="text-xs text-red-700">ไม่สำเร็จ</div>
                    <div className="text-lg font-bold text-red-700">
                      {trackingImportProgress.notFound + trackingImportProgress.outsideWorkOrder + trackingImportProgress.invalid + trackingImportProgress.failed}
                    </div>
                  </div>
                </div>
              )}

              {trackingImportProgress.details.length > 0 && (
                <div className="max-h-52 overflow-auto rounded-lg border border-gray-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-gray-100 text-gray-600">
                      <tr>
                        <th className="px-3 py-2">แถว</th>
                        <th className="px-3 py-2">เลขออเดอร์</th>
                        <th className="px-3 py-2">สถานะ</th>
                        <th className="px-3 py-2">รายละเอียด</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trackingImportProgress.details.map((row, index) => (
                        <tr key={`${row.row_no}-${row.bill_no}-${index}`} className="border-t border-gray-100">
                          <td className="px-3 py-2">{row.row_no + 1}</td>
                          <td className="px-3 py-2 font-medium">{row.bill_no || '-'}</td>
                          <td className="whitespace-nowrap px-3 py-2">{TRACKING_IMPORT_STATUS_LABELS[row.status]}</td>
                          <td className="px-3 py-2 text-gray-600">{row.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeImportTrackingModal}
              disabled={isTrackingImportBusy}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isTrackingImportBusy ? 'กำลังนำเข้า...' : 'ปิด'}
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

          <div className="flex justify-center gap-2 mb-4">
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
            <input
              ref={waybillPdfFolderInputRef}
              type="file"
              multiple
              className="hidden"
              {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
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
            <button
              type="button"
              onClick={() => waybillPdfFolderInputRef.current?.click()}
              disabled={wsProcessing}
              className="px-4 py-2 rounded-lg border border-blue-600 text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              📁 เลือกโฟลเดอร์
            </button>
          </div>
          <p className="text-center text-xs text-gray-500 mb-4">เลือกหลายไฟล์ PDF พร้อมกันได้ หรือเลือกทั้งโฟลเดอร์ (ระบบใช้เฉพาะไฟล์ .pdf ในโฟลเดอร์)</p>

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

          <div className="grid grid-cols-4 gap-4 text-center mb-4">
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
            <div>
              <p className="text-sm text-gray-600 mb-1">ไม่พบ</p>
              {/* เป็นสีแดงเมื่อมีรายการที่หาไม่เจอ — ถ้าเจอครบ (0) ใช้สีเทาเพื่อไม่ให้อ่านผิดว่าเป็นข้อผิดพลาด */}
              <p className={`text-xl font-bold ${wsStatMissing !== '--' && wsStatMissing !== '0' ? 'text-red-600' : 'text-gray-400'}`}>{wsStatMissing}</p>
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

      {/* Modal Preview ใบปะหน้า — กว้างเกือบเต็มจอ ให้อ่านข้อมูลแต่ละคอลัมน์ง่าย */}
      <Modal
        open={waybillPreviewModal.open}
        onClose={() => setWaybillPreviewModal({ open: false, workOrderName: null, rows: [] })}
        contentClassName="max-w-[1800px] w-full"
      >
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">ตรวจสอบและ Export ใบปะหน้า</h2>
              <p className="text-base text-gray-500 mt-0.5">
                ใบงาน: <span className="font-semibold text-gray-700">{waybillPreviewModal.workOrderName}</span>
                {' '}&bull;{' '}{waybillPreviewModal.rows.length} แถว
                {waybillPreviewModal.rows.some(isWaybillRowMissing) && (
                  <span className="ml-2 text-red-600 font-medium">
                    (มี {waybillPreviewModal.rows.filter(isWaybillRowMissing).length} แถวข้อมูลไม่ครบ)
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-2 pr-10">
              <button
                type="button"
                onClick={exportWaybillXlsx}
                disabled={waybillPreviewModal.rows.length === 0 || exportLoading.open}
                className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
              >
                {exportLoading.open ? 'กำลัง Export...' : 'Export เป็น Excel (.xlsx)'}
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-auto max-h-[calc(100vh-220px)] border border-gray-200 rounded-xl">
            <table className="w-full border-collapse text-base">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-3 bg-gray-100 border-b border-gray-200 text-left text-sm font-bold text-gray-600 uppercase tracking-wide w-8">#</th>
                  {WAYBILL_PREVIEW_COLS.map(col => (
                    <th key={col.key} className={`px-2 py-3 bg-gray-100 border-b border-gray-200 text-left text-sm font-bold text-gray-600 uppercase tracking-wide ${col.width}`}>
                      {col.label}
                      {col.required && <span className="text-red-400 ml-0.5">*</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {waybillPreviewModal.rows.map((row, idx) => {
                  const missing = isWaybillRowMissing(row)
                  const stripe = idx % 2 === 0 ? 'bg-white' : 'bg-blue-50/60'
                  const rowBg = missing ? 'bg-red-50' : stripe
                  return (
                    <tr key={idx} className={`${rowBg} hover:bg-blue-100/40 transition-colors`}>
                      <td className="px-2 py-2 border-b border-gray-100 text-gray-500 text-sm text-center tabular-nums">{idx + 1}</td>
                      {WAYBILL_PREVIEW_COLS.map(col => {
                        const val = row[col.key as keyof WaybillPreviewRow]
                        const isEmpty = col.required && !val.trim()
                        const isReadOnly = col.key === 'addressRaw'
                        const isMultiLine = col.key === 'address' || col.key === 'addressRaw' || col.key === 'consigneeName'
                        return (
                          <td key={col.key} className={`px-1.5 py-1.5 border-b border-gray-100 align-top ${col.width}`}>
                            {isReadOnly ? (
                              <div className="px-2 py-2 text-base text-gray-600 whitespace-pre-line leading-relaxed max-h-32 overflow-y-auto">{val}</div>
                            ) : (
                              <textarea
                                value={val}
                                onChange={(e) => updateWaybillPreviewRow(idx, col.key as keyof WaybillPreviewRow, e.target.value)}
                                rows={isMultiLine ? 3 : 1}
                                className={`w-full px-2 py-2 text-base leading-relaxed rounded-md border resize-vertical focus:outline-none focus:ring-1 focus:ring-blue-400
                                  ${isEmpty ? 'border-red-300 bg-red-50/50' : 'border-gray-200 bg-transparent hover:border-gray-300'}
                                `}
                              />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Footer hint */}
          <p className="text-sm text-gray-500 mt-3 text-center">
            คอลัมน์ที่มี <span className="text-red-400 font-bold">*</span> เป็นข้อมูลจำเป็น &bull;
            แก้ไขข้อมูลได้โดยคลิกที่ช่อง &bull;
            กด Export เพื่อดาวน์โหลดไฟล์ Flash Express (.xlsx)
          </p>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!detailOrder} onClose={() => setDetailOrder(null)} contentClassName="max-w-[96vw] w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} />}
      </Modal>

      {/* Modal แสดงสถานะกำลัง Export — ซ้อนเหนือ modal อื่น (z-[70]) และปิดเองเมื่อเสร็จ */}
      <Modal open={exportLoading.open} onClose={() => {}} showCloseButton={false} stackClassName="z-[70]" contentClassName="max-w-sm w-full">
        <div className="p-6 flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" aria-hidden />
          <p className="text-gray-800 font-medium text-center">{exportLoading.message}</p>
          <p className="text-xs text-gray-400 text-center">ระบบกำลังเตรียมไฟล์ — หน้าต่างนี้จะปิดเองเมื่อดาวน์โหลดเสร็จ</p>
        </div>
      </Modal>
    </div>
  )
}
