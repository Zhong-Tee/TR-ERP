import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import { getPublicUrl } from '../lib/qcApi'
import { supabase } from '../lib/supabase'
import { Order, OrderItem, WorkOrder } from '../types'
import Modal from '../components/ui/Modal'
import {
  addQueueItem,
  deleteQueueItem,
  getFolderHandle,
  listQueueItems,
  setAccessToken,
  setFolderHandle,
  setSupabaseConfig,
  updateQueueItem,
  type UploadQueueItem,
} from '../lib/packingQueue'

type OrderWithItems = Order & {
  or_order_items?: (OrderItem & { pr_products?: { product_code?: string | null } })[]
  order_items?: (OrderItem & { pr_products?: { product_code?: string | null } })[]
}

type PackingItem = {
  tracking_number: string
  customer_name: string
  order_id: string
  product_name: string
  product_code: string | null
  details: string
  ink_color: string | null
  shelf_location: string | null
  cartoon_pattern: string | null
  line_pattern: string | null
  font: string | null
  item_uid: string
  scanned: boolean
  parcelScanned: boolean
  isOrderComplete: boolean
  needsTaxInvoice: boolean
  needsCashBill: boolean
  claim_type: string | null
  claim_details: string | null
  file_attachment: string | null
  notes: string | null
  qc_status: 'pass' | 'fail' | null
}

type WorkOrderStatus = {
  hasTracking: boolean
  isPartiallyPacked: boolean
}

type RecordingState = {
  status: 'idle' | 'recording' | 'uploading' | 'error'
  tracking: string | null
  error?: string
}

const INACTIVITY_LIMIT = 60_000

function naturalSortCompare(a: string, b: string) {
  const re = /(\d+)/g
  const aParts = String(a).split(re)
  const bParts = String(b).split(re)
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i += 1) {
    const partA = aParts[i]
    const partB = bParts[i]
    if (i % 2 === 1) {
      const numA = parseInt(partA, 10)
      const numB = parseInt(partB, 10)
      if (numA !== numB) return numA - numB
    } else if (partA !== partB) {
      return partA.localeCompare(partB)
    }
  }
  return aParts.length - bParts.length
}

export default function Packing() {
  const { user } = useAuthContext()
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [workOrderStatus, setWorkOrderStatus] = useState<Record<string, WorkOrderStatus>>({})
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'selection' | 'main'>('selection')
  const [selectionTab, setSelectionTab] = useState<'new' | 'shipped' | 'queue'>('new')
  const [shippedOrders, setShippedOrders] = useState<
    Array<{
      id: string
      work_order_name: string | null
      shipped_time: string | null
      channel_code: string | null
      shipped_by: string | null
    }>
  >([])
  const [shippedDateFilter, setShippedDateFilter] = useState('')
  const [shippedChannelFilter, setShippedChannelFilter] = useState('')
  const [shippedPackerFilter, setShippedPackerFilter] = useState('')
  const [aggregatedData, setAggregatedData] = useState<PackingItem[][]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [currentWorkOrderName, setCurrentWorkOrderName] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: '' | 'success' | 'error' }>({
    text: '',
    type: ''
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [parcelScanValue, setParcelScanValue] = useState('')
  const [itemScanValue, setItemScanValue] = useState('')
  const [recordingState, setRecordingState] = useState<RecordingState>({ status: 'idle', tracking: null })
  const [isLoadingOrders, setIsLoadingOrders] = useState(false)
  const [previewModal, setPreviewModal] = useState<{ open: boolean; message: string }>({ open: false, message: '' })
  const [folderHandle, setFolderHandleState] = useState<FileSystemDirectoryHandle | null>(null)
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([])
  const [queueLoading, setQueueLoading] = useState(false)
  const [dialog, setDialog] = useState<{
    open: boolean
    mode: 'alert' | 'confirm'
    title: string
    message: string
    confirmText?: string
    cancelText?: string
  }>({ open: false, mode: 'alert', title: '', message: '' })
  const [shippedEdit, setShippedEdit] = useState<{
    open: boolean
    workOrderName: string
    shippedBy: string
    shippedDate: string
    shippedTime: string
  } | null>(null)

  const parcelScanRef = useRef<HTMLInputElement>(null)
  const itemScanRef = useRef<HTMLInputElement>(null)
  const inactivityTimerRef = useRef<number | null>(null)
  const currentIndexRef = useRef(currentIndex)
  const aggregatedDataRef = useRef(aggregatedData)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingStartRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const previewLoadingRef = useRef(false)
  const confirmActionRef = useRef<null | (() => void)>(null)
  const stopAdvanceRef = useRef(false)

  const ensurePlanDeptStart = async (workOrderName: string) => {
    if (!workOrderName) return
    const { data, error } = await supabase.from('plan_jobs').select('id, tracks').eq('name', workOrderName).single()
    if (error || !data) return
    const tracks = (data.tracks || {}) as Record<string, Record<string, { start: string | null; end: string | null }>>
    const dept = 'PACK'
    const procNames = ['ทำใบปะหน้า', 'แพ็ค']
    tracks[dept] = tracks[dept] || {}
    procNames.forEach((p) => {
      if (!tracks[dept][p]) tracks[dept][p] = { start: null, end: null }
    })
    const firstProc = procNames[0]
    if (tracks[dept][firstProc]?.start) return
    tracks[dept][firstProc].start = new Date().toISOString()
    await supabase.from('plan_jobs').update({ tracks }).eq('id', data.id)
  }

  const checkAndMarkPackEnd = async (workOrderName: string) => {
    if (!workOrderName) return
    const { count } = await supabase
      .from('or_orders')
      .select('id', { count: 'exact', head: true })
      .eq('work_order_name', workOrderName)
      .neq('status', 'จัดส่งแล้ว')
    if ((count || 0) !== 0) return
    const { data, error } = await supabase.from('plan_jobs').select('id, tracks').eq('name', workOrderName).single()
    if (error || !data) return
    const tracks = (data.tracks || {}) as Record<string, Record<string, { start: string | null; end: string | null }>>
    const dept = 'PACK'
    const procNames = ['ทำใบปะหน้า', 'แพ็ค']
    tracks[dept] = tracks[dept] || {}
    const now = new Date().toISOString()
    procNames.forEach((p) => {
      if (!tracks[dept][p]) tracks[dept][p] = { start: null, end: null }
      if (!tracks[dept][p].start) tracks[dept][p].start = now
      tracks[dept][p].end = now
    })
    await supabase.from('plan_jobs').update({ tracks }).eq('id', data.id)
  }

  const handleSelectNewWorkOrder = async (workOrderName: string, hasTracking: boolean) => {
    if (!hasTracking) {
      openAlert('ใบงานนี้ยังไม่มีเลขพัสดุ ไม่สามารถจัดของได้')
      return
    }
    await ensurePlanDeptStart(workOrderName)
    await loadPackingData(workOrderName)
  }

  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  useEffect(() => {
    aggregatedDataRef.current = aggregatedData
  }, [aggregatedData])

  const isQcPassGroup = (group: PackingItem[]) => group.every((item) => item.qc_status === 'pass')

  const goToNextGroup = () => {
    const nextIndex = aggregatedDataRef.current.findIndex(
      (g, idx) => idx !== currentIndexRef.current && !g.every((item) => item.scanned) && !g[0].isOrderComplete
    )
    if (nextIndex !== -1) {
      setCurrentIndex(nextIndex)
    }
  }

  useEffect(() => {
    loadWorkOrdersForPacking()
    return () => {
      cleanupRecording(true, true)
      clearInactivityTimer()
    }
  }, [])

  useEffect(() => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || ''
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || ''
    if (supabaseUrl && supabaseAnonKey) {
      setSupabaseConfig(supabaseUrl, supabaseAnonKey).catch(() => null)
    }
    const syncToken = async () => {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token || null
      await setAccessToken(token)
    }
    syncToken().catch(() => null)
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token || null).catch(() => null)
    })
    loadFolderFromSettings().catch(() => null)
    refreshQueue().catch(() => null)
    const timer = window.setInterval(() => {
      refreshQueue().catch(() => null)
    }, 5000)
    return () => {
      window.clearInterval(timer)
      authSub?.subscription?.unsubscribe()
    }
  }, [])

  async function loadFolderFromSettings() {
    const handle = await getFolderHandle()
    if (!handle) return
    const perm = await handle.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') {
      setFolderHandleState(handle)
      return
    }
    const req = await handle.requestPermission({ mode: 'readwrite' })
    if (req === 'granted') {
      setFolderHandleState(handle)
    }
  }

  async function selectFolder() {
    if (!('showDirectoryPicker' in window)) {
      openAlert('เบราว์เซอร์นี้ไม่รองรับการเลือกโฟลเดอร์ (ต้องใช้ Chrome/Edge)')
      return
    }
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' })
    await setFolderHandle(handle)
    setFolderHandleState(handle)
  }

  async function refreshQueue() {
    setQueueLoading(true)
    const list = await listQueueItems()
    const sorted = list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    setQueueItems(sorted)
    setQueueLoading(false)
    if (folderHandle) {
      await cleanupLocalFiles(folderHandle, sorted)
    }
  }

  async function cleanupLocalFiles(handle: FileSystemDirectoryHandle, items: UploadQueueItem[]) {
    const targets = items.filter((i) => i.status === 'success' && !i.localDeleted)
    for (const item of targets) {
      try {
        await handle.removeEntry(item.filename)
        await updateQueueItem(item.id, { localDeleted: true })
      } catch (_err) {
        // ignore cleanup failure
      }
    }
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
  }

  const openAlert = (message: string, title = 'แจ้งเตือน') => {
    setDialog({ open: true, mode: 'alert', title, message, confirmText: 'รับทราบ' })
  }

  const openConfirm = (message: string, onConfirm: () => void, title = 'ยืนยันการทำรายการ') => {
    confirmActionRef.current = onConfirm
    setDialog({ open: true, mode: 'confirm', title, message, confirmText: 'ตกลง', cancelText: 'ยกเลิก' })
  }

  const closeDialog = () => {
    setDialog((prev) => ({ ...prev, open: false }))
    confirmActionRef.current = null
  }

  const saveShippedEdit = async () => {
    if (!shippedEdit) return
    const { workOrderName, shippedBy, shippedDate, shippedTime } = shippedEdit
    if (!workOrderName) return
    let shippedTimeIso: string | null = null
    if (shippedDate) {
      const time = shippedTime && shippedTime.length === 5 ? shippedTime : '00:00'
      shippedTimeIso = new Date(`${shippedDate}T${time}:00`).toISOString()
    }
    const { error } = await supabase
      .from('or_orders')
      .update({
        shipped_by: shippedBy || null,
        shipped_time: shippedTimeIso
      })
      .eq('work_order_name', workOrderName)
      .eq('status', 'จัดส่งแล้ว')
    if (error) {
      openAlert('บันทึกการแก้ไขไม่สำเร็จ: ' + error.message)
      return
    }
    setShippedOrders((prev) =>
      prev.map((row) =>
        row.work_order_name === workOrderName
          ? { ...row, shipped_by: shippedBy || null, shipped_time: shippedTimeIso }
          : row
      )
    )
    setShippedEdit(null)
    openAlert('บันทึกการแก้ไขเรียบร้อยแล้ว')
  }

  const completedIndices = useMemo(() => {
    const set = new Set<number>()
    aggregatedData.forEach((group, index) => {
      if (group.every((item) => item.scanned)) set.add(index)
    })
    return set
  }, [aggregatedData])

  const hasPendingCompleted = useMemo(() => {
    let hasPending = false
    completedIndices.forEach((idx) => {
      const group = aggregatedData[idx]
      if (group && !group[0].isOrderComplete) hasPending = true
    })
    return hasPending
  }, [completedIndices, aggregatedData])

  const allGroupsShipped = useMemo(() => {
    if (aggregatedData.length === 0) return false
    return aggregatedData.every((group) => group[0].isOrderComplete)
  }, [aggregatedData])

  const currentGroup = useMemo(() => {
    if (currentIndex < 0) return null
    return aggregatedData[currentIndex] || null
  }, [aggregatedData, currentIndex])

  const newWorkOrders = useMemo(() => {
    return workOrders
  }, [workOrders])

  const shippedOrdersFiltered = useMemo(() => {
    return shippedOrders.filter((row) => {
      if (!row.work_order_name) return false
      if (shippedDateFilter) {
        const date = row.shipped_time ? new Date(row.shipped_time).toISOString().slice(0, 10) : ''
        if (date !== shippedDateFilter) return false
      }
      if (shippedChannelFilter && row.channel_code !== shippedChannelFilter) return false
      if (shippedPackerFilter && row.shipped_by !== shippedPackerFilter) return false
      return true
    })
  }, [shippedOrders, shippedDateFilter, shippedChannelFilter, shippedPackerFilter])

  const shippedWorkOrders = useMemo(() => {
    const grouped = new Map<
      string,
      { work_order_name: string; order_count: number; shipped_time: string | null; channels: Set<string>; packers: Set<string> }
    >()
    shippedOrdersFiltered.forEach((row) => {
      if (!row.work_order_name) return
      const existing = grouped.get(row.work_order_name) || {
        work_order_name: row.work_order_name,
        order_count: 0,
        shipped_time: null,
        channels: new Set<string>(),
        packers: new Set<string>()
      }
      existing.order_count += 1
      if (row.shipped_time && (!existing.shipped_time || row.shipped_time > existing.shipped_time)) {
        existing.shipped_time = row.shipped_time
      }
      if (row.channel_code) existing.channels.add(row.channel_code)
      if (row.shipped_by) existing.packers.add(row.shipped_by)
      grouped.set(row.work_order_name, existing)
    })
    return Array.from(grouped.values()).sort((a, b) => (a.shipped_time || '').localeCompare(b.shipped_time || ''))
  }, [shippedOrdersFiltered])

  const shippedChannels = useMemo(() => {
    const values = shippedOrders
      .map((row) => row.channel_code)
      .filter((c): c is string => Boolean(c && c.trim()))
    return Array.from(new Set(values)).sort()
  }, [shippedOrders])

  const shippedPackers = useMemo(() => {
    const values = shippedOrders
      .map((row) => row.shipped_by)
      .filter((p): p is string => Boolean(p && p.trim()))
    return Array.from(new Set(values)).sort()
  }, [shippedOrders])

  useEffect(() => {
    if (!currentGroup) return
    const trackingNumber = currentGroup[0].tracking_number
    const parcelScanned = currentGroup[0].parcelScanned
    const isFullyScanned = currentGroup.every((item) => item.scanned)
    ensurePreview().catch(() => null)
    if (recordingState.status === 'recording' && (recordingState.tracking !== trackingNumber || !parcelScanned)) {
      stopRecording()
    }
    if (recordingState.status === 'idle' && parcelScanned && !isFullyScanned) {
      startRecording(trackingNumber).catch((error) => {
        setRecordingState({ status: 'error', tracking: trackingNumber, error: error?.message || 'เริ่มบันทึกไม่สำเร็จ' })
      })
    }
  }, [currentGroup, recordingState.status, recordingState.tracking])

  useEffect(() => {
    if (!currentGroup) return
    const isParcelScanned = currentGroup[0].parcelScanned
    const isDone = currentGroup[0].isOrderComplete
    const isFullyScanned = currentGroup.every((item) => item.scanned)

    if (isDone) {
      setStatusMessage({ text: '✅ จัดส่งเรียบร้อย', type: 'success' })
    } else if (!isParcelScanned) {
      setStatusMessage({ text: 'รอสแกนเลขพัสดุ...', type: '' })
      parcelScanRef.current?.focus()
    } else if (isFullyScanned) {
      setStatusMessage({ text: '🟢 แสกนครบแล้ว!', type: 'success' })
    } else {
      setStatusMessage({ text: 'รอสแกนสินค้า...', type: '' })
      itemScanRef.current?.focus()
    }
  }, [currentGroup])

  useEffect(() => {
    if (currentIndex >= 0) startInactivityTimer()
  }, [currentIndex])

  function clearInactivityTimer() {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current)
      inactivityTimerRef.current = null
    }
  }

  function startInactivityTimer() {
    clearInactivityTimer()
    const index = currentIndexRef.current
    if (index < 0) return
    const group = aggregatedDataRef.current[index]
    if (!group || group.every((item) => item.scanned)) return

    inactivityTimerRef.current = window.setTimeout(async () => {
      const latestIndex = currentIndexRef.current
      const latestGroup = aggregatedDataRef.current[latestIndex]
      if (!latestGroup) return
      const hasStarted = latestGroup.some((item) => item.scanned || item.parcelScanned)
      if (hasStarted) {
        await performResetAction(latestIndex)
        setStatusMessage({ text: '⚠️ รีเซ็ตอัตโนมัติเนื่องจากไม่มีการเคลื่อนไหวเกิน 1 นาที', type: 'error' })
      }
    }, INACTIVITY_LIMIT)
  }

  async function loadWorkOrdersForPacking() {
    setLoading(true)
    setView('selection')
    try {
      const { data, error } = await supabase
        .from('or_work_orders')
        .select('*')
        .eq('status', 'กำลังผลิต')
        .order('created_at', { ascending: false })

      if (error) throw error
      const orders = data || []
      setWorkOrders(orders)

      if (orders.length > 0) {
        const names = orders.map((wo) => wo.work_order_name)
        const { data: allProductionOrders } = await supabase
          .from('or_orders')
          .select('work_order_name, tracking_number, packing_meta, or_order_items(packing_status)')
          .in('work_order_name', names)

        const statusMap: Record<string, WorkOrderStatus> = {}
        orders.forEach((wo) => {
          const ordersInWo = (allProductionOrders || []).filter((o: any) => o.work_order_name === wo.work_order_name)
          const hasTracking = ordersInWo.some((o: any) => o.tracking_number)
          const isPartiallyPacked = ordersInWo.some(
            (o: any) =>
              o.packing_meta?.parcelScanned ||
              (o.or_order_items || []).some((oi: any) => oi.packing_status === 'สแกนแล้ว')
          )
          statusMap[wo.work_order_name] = { hasTracking, isPartiallyPacked }
        })
        setWorkOrderStatus(statusMap)
      } else {
        setWorkOrderStatus({})
      }

      const { data: shippedData, error: shippedError } = await supabase
        .from('or_orders')
        .select('id, work_order_name, shipped_time, channel_code, shipped_by')
        .eq('status', 'จัดส่งแล้ว')
        .not('work_order_name', 'is', null)
      if (shippedError) throw shippedError
      setShippedOrders((shippedData || []) as typeof shippedOrders)
    } catch (error: any) {
      console.error('Error loading work orders:', error)
      openAlert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadPackingData(workOrderName: string) {
    setIsLoadingOrders(true)
    setCurrentWorkOrderName(workOrderName)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*, pr_products(product_code))')
        .eq('work_order_name', workOrderName)
        .order('bill_no', { ascending: true })

      if (error) throw error
      const orders = (data || []) as OrderWithItems[]
      const ordersWithTracking = orders.filter((order) => order.tracking_number && order.tracking_number.trim() !== '')
      const itemUids = ordersWithTracking.flatMap((order) =>
        (order.or_order_items || order.order_items || []).map((item) => item.item_uid).filter(Boolean)
      )
      const qcStatusMap = await fetchQcStatusMap(itemUids)
      prepareDataForPacking(ordersWithTracking, qcStatusMap)
      setView('main')
    } catch (error: any) {
      openAlert('ดึงข้อมูลไม่ได้: ' + error.message)
    } finally {
      setIsLoadingOrders(false)
    }
  }

  async function fetchQcStatusMap(itemUids: Array<string | null | undefined>) {
    const uniqueUids = Array.from(new Set(itemUids.filter((uid): uid is string => !!uid && String(uid).trim() !== '')))
    if (uniqueUids.length === 0) return {}
    const { data, error } = await supabase
      .from('qc_records')
      .select('item_uid, status, created_at')
      .in('item_uid', uniqueUids)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('QC status load error:', error)
      return {}
    }
    const map: Record<string, 'pass' | 'fail'> = {}
    ;(data || []).forEach((row: any) => {
      const uid = row.item_uid
      if (!uid || map[uid]) return
      if (row.status === 'pass' || row.status === 'fail') map[uid] = row.status
    })
    return map
  }

  function prepareDataForPacking(orders: OrderWithItems[], qcStatusMap: Record<string, 'pass' | 'fail'>) {
    const flatData: PackingItem[] = []
    orders.forEach((order) => {
      const isOrderShipped = order.status === 'จัดส่งแล้ว'
      const isParcelScanned = order.packing_meta?.parcelScanned || false
      const items = order.or_order_items || (order.order_items || [])
      items.forEach((item) => {
        const qcStatus = item.item_uid ? qcStatusMap[item.item_uid] || null : null
        flatData.push({
          tracking_number: order.tracking_number || '',
          customer_name: order.customer_name || '',
          order_id: order.id,
          product_name: item.product_name || '',
          product_code: item.pr_products?.product_code || null,
          details: [item.line_1, item.line_2, item.line_3].filter(Boolean).join(' // '),
          ink_color: item.ink_color,
          shelf_location: item.product_type,
          cartoon_pattern: item.cartoon_pattern,
          line_pattern: item.line_pattern,
          font: item.font,
          item_uid: item.item_uid,
          scanned: item.packing_status === 'สแกนแล้ว',
          parcelScanned: isParcelScanned,
          isOrderComplete: isOrderShipped,
          needsTaxInvoice: order.billing_details?.request_tax_invoice || false,
          needsCashBill: order.billing_details?.request_cash_bill || false,
          claim_type: order.claim_type,
          claim_details: order.claim_details,
          file_attachment: item.file_attachment,
          notes: item.notes,
          qc_status: qcStatus
        })
      })
    })

    const grouped: Record<string, PackingItem[]> = {}
    const trackingOrder: string[] = []
    flatData.forEach((item) => {
      if (!grouped[item.tracking_number]) {
        grouped[item.tracking_number] = []
        trackingOrder.push(item.tracking_number)
      }
      grouped[item.tracking_number].push(item)
    })

    const aggregated = trackingOrder.map((tracking) => grouped[tracking])
    setAggregatedData(aggregated)
    if (aggregated.length === 0) {
      setCurrentIndex(-1)
      return
    }
    const nextIndex = aggregated.findIndex(
      (group) => !group.every((item) => item.scanned) && !group[0].isOrderComplete
    )
    setCurrentIndex(nextIndex !== -1 ? nextIndex : 0)
    startInactivityTimer()
  }

  async function performResetAction(index = currentIndexRef.current) {
    if (index < 0 || !currentWorkOrderName) return
    const group = aggregatedDataRef.current[index]
    if (!group) return

    const itemUids = group.map((item) => item.item_uid)
    const { error: itemError } = await supabase
      .from('or_order_items')
      .update({ packing_status: null, item_scan_time: null })
      .in('item_uid', itemUids)

    const { error: orderError } = await supabase
      .from('or_orders')
      .update({
        status: 'ใบงานกำลังผลิต',
        packing_meta: null,
        shipped_by: null,
        shipped_time: null
      })
      .eq('id', group[0].order_id)

    if (!itemError && !orderError) {
      await loadPackingData(currentWorkOrderName)
    } else {
      console.error('Reset Error:', itemError || orderError)
    }
  }

  async function handleParcelScan() {
    if (!currentGroup) return
    const scanValue = parcelScanValue.trim().toUpperCase()
    if (!scanValue) return
    const group = currentGroup
    if (!isQcPassGroup(group)) {
      playErrorSound()
      setStatusMessage({ text: '❌ ยังไม่ได้ QC Pass ครบทุกชิ้น', type: 'error' })
      return
    }
    if (scanValue === String(group[0].tracking_number).trim().toUpperCase()) {
      const scannedBy = user?.username || user?.email || 'unknown'
      const { error: orderUpdateError } = await supabase
        .from('or_orders')
        .update({
          packing_meta: { parcelScanned: true, scannedBy, scanTime: new Date().toISOString() }
        })
        .eq('id', group[0].order_id)
      if (orderUpdateError) {
        console.error('Error updating parcel scan:', orderUpdateError)
      } else {
        const { error: logError } = await supabase.from('pk_packing_logs').insert({
          order_id: group[0].order_id,
          item_id: null,
          packed_by: scannedBy,
          notes: 'parcel_scan'
        })
        if (logError) console.warn('Failed to log parcel scan:', logError)
      }

      setAggregatedData((prev) =>
        prev.map((g, idx) =>
          idx === currentIndex ? g.map((item) => ({ ...item, parcelScanned: true })) : g
        )
      )
      setParcelScanValue('')
      setStatusMessage({ text: '', type: '' })
      startInactivityTimer()
      playSuccessSound()
      startRecording(group[0].tracking_number).catch((error) => {
        setRecordingState({
          status: 'error',
          tracking: group[0].tracking_number,
          error: error?.message || 'เริ่มบันทึกไม่สำเร็จ'
        })
      })
    } else {
      playErrorSound()
      setStatusMessage({ text: '❌ เลขพัสดุไม่ตรงกับที่เลือก', type: 'error' })
    }
  }

  async function handleItemScan() {
    if (!currentGroup) return
    const scanValue = itemScanValue.trim().toUpperCase()
    if (!scanValue) return
    const group = currentGroup
    const itemToScan = group.find((item) => !item.scanned && item.item_uid === scanValue)
    if (itemToScan) {
      const { data: updatedItems, error: itemError } = await supabase
        .from('or_order_items')
        .update({ item_scan_time: new Date().toISOString(), packing_status: 'สแกนแล้ว' })
        .eq('item_uid', itemToScan.item_uid)
        .select('id')
      if (itemError) {
        console.error('Error updating item scan:', itemError)
      } else {
        const scannedBy = user?.username || user?.email || 'unknown'
        const itemId = updatedItems?.[0]?.id ?? null
        const { error: logError } = await supabase.from('pk_packing_logs').insert({
          order_id: itemToScan.order_id,
          item_id: itemId,
          packed_by: scannedBy,
          notes: 'item_scan'
        })
        if (logError) console.warn('Failed to log item scan:', logError)
      }

      setItemScanValue('')
      playSuccessSound()
      startInactivityTimer()

      setAggregatedData((prev) =>
        prev.map((g, idx) =>
          idx === currentIndex
            ? g.map((item) => (item.item_uid === itemToScan.item_uid ? { ...item, scanned: true } : item))
            : g
        )
      )

      const updatedGroup = group.map((item) =>
        item.item_uid === itemToScan.item_uid ? { ...item, scanned: true } : item
      )
      if (updatedGroup.every((item) => item.scanned)) {
        clearInactivityTimer()
        setStatusMessage({ text: '✅ สแกนครบแล้ว!', type: 'success' })
        const nextIndex = aggregatedDataRef.current.findIndex(
          (g, idx) => idx !== currentIndex && !g.every((item) => item.scanned) && !g[0].isOrderComplete
        )
        if (nextIndex !== -1) {
          setTimeout(() => {
            setCurrentIndex(nextIndex)
          }, 700)
        }
      }
    } else {
      playErrorSound()
      setStatusMessage({ text: '❌ สินค้าไม่ถูกต้องหรือถูกสแกนแล้ว', type: 'error' })
    }
  }

  async function shipAllScannedOrders() {
    setIsLoadingOrders(true)
    try {
      const ids: string[] = []
      completedIndices.forEach((index) => {
        const group = aggregatedData[index]
        if (group && !group[0].isOrderComplete) ids.push(group[0].order_id)
      })
      if (ids.length === 0) {
        openAlert('ไม่มีบิลที่แสกนครบรอส่ง')
        setIsLoadingOrders(false)
        return
      }

      const shippedBy = user?.username || user?.email || 'unknown'
      const { error } = await supabase
        .from('or_orders')
        .update({ status: 'จัดส่งแล้ว', shipped_by: shippedBy, shipped_time: new Date().toISOString() })
        .in('id', ids)

      if (error) throw error
      openAlert(`จัดส่งสำเร็จ ${ids.length} รายการ!`)
      playSuccessSound()
      if (currentWorkOrderName) {
        await checkAndMarkPackEnd(currentWorkOrderName)
        await loadPackingData(currentWorkOrderName)
      }
    } catch (error: any) {
      openAlert(error.message)
    } finally {
      setIsLoadingOrders(false)
    }
  }

  async function finalizeWorkOrder() {
    if (!currentWorkOrderName) return
    openConfirm('ปิดใบงานนี้?', async () => {
      await supabase.from('or_work_orders').update({ status: 'จัดส่งแล้ว' }).eq('work_order_name', currentWorkOrderName)
      await checkAndMarkPackEnd(currentWorkOrderName)
      openAlert('ปิดใบงานเรียบร้อย')
      await loadWorkOrdersForPacking()
    })
  }

  function playSuccessSound() {
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg')
    audio.play().catch(() => null)
  }

  function playErrorSound() {
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg')
    audio.play().catch(() => null)
  }

  async function handleOrderClick(index: number) {
    if (index === currentIndex) return
    const previousIndex = currentIndexRef.current
    if (previousIndex !== -1 && previousIndex !== index) {
      const oldGroup = aggregatedDataRef.current[previousIndex]
      if (oldGroup && !oldGroup.every((item) => item.scanned)) {
        const hasStarted = oldGroup.some((item) => item.scanned || item.parcelScanned)
        if (hasStarted) {
          await performResetAction(previousIndex)
        }
      }
    }
    setCurrentIndex(index)
  }

  function getRecordingLabel() {
    if (!currentGroup) return 'พร้อมบันทึก'
    if (recordingState.status === 'recording') return 'กำลังบันทึก'
    const isFullyScanned = currentGroup.every((item) => item.scanned)
    if (isFullyScanned) return 'บันทึกเสร็จสิ้น'
    if (currentGroup[0].parcelScanned) return 'กำลังบันทึก'
    return 'พร้อมบันทึก'
  }

  function getRecordingBadgeClass() {
    if (!currentGroup) return 'bg-green-100 text-green-700'
    if (recordingState.status === 'recording') return 'bg-red-100 text-red-700'
    const isFullyScanned = currentGroup.every((item) => item.scanned)
    if (isFullyScanned) return 'bg-blue-100 text-blue-700'
    if (currentGroup[0].parcelScanned) return 'bg-red-100 text-red-700'
    return 'bg-green-100 text-green-700'
  }

  async function ensurePreview(): Promise<boolean> {
    if (streamRef.current && videoRef.current?.srcObject) return true
    if (previewLoadingRef.current) return !!streamRef.current
    previewLoadingRef.current = true
    if (!navigator?.mediaDevices?.getUserMedia) {
      setPreviewModal({
        open: true,
        message: 'ไม่สามารถเปิดกล้องได้ (อุปกรณ์ไม่รองรับหรือไม่ได้เปิดผ่าน https)'
      })
      previewLoadingRef.current = false
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        try {
          await videoRef.current.play()
        } catch (err: any) {
          const msg = String(err?.message || '')
          if (msg.includes('interrupted by a new load request')) {
            previewLoadingRef.current = false
            return true
          }
          throw err
        }
      }
      previewLoadingRef.current = false
      setRecordingState((prev) =>
        prev.status === 'error' ? { status: 'idle', tracking: null } : prev
      )
      return true
    } catch (error: any) {
      previewLoadingRef.current = false
      const msg = String(error?.message || '')
      if (msg.includes('interrupted by a new load request')) {
        return true
      }
      setPreviewModal({
        open: true,
        message: error?.message || 'ไม่สามารถเปิดกล้องได้ กรุณาอนุญาตสิทธิ์กล้อง'
      })
      return false
    }
  }

  async function startRecording(trackingNumber: string) {
    if (recordingState.status === 'recording') return
    if (!folderHandle) {
      openAlert('กรุณาเลือกโฟลเดอร์จัดเก็บก่อนเริ่มบันทึก')
      return
    }
    try {
      const ok = await ensurePreview()
      if (!ok && !streamRef.current) {
        throw new Error('ไม่สามารถเปิดกล้องได้')
      }
      if (!streamRef.current) {
        throw new Error('ไม่สามารถเปิดกล้องได้')
      }

      const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ''
      const recorder = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recordingChunksRef.current = []
      recordingStartRef.current = Date.now()
      setRecordingState({ status: 'recording', tracking: trackingNumber })

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data)
      }

      recorder.onstop = async () => {
        if (!recordingChunksRef.current.length) {
          cleanupRecording()
          return
        }

        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'video/webm' })
        const durationSeconds = recordingStartRef.current
          ? Math.round((Date.now() - recordingStartRef.current) / 1000)
          : null
        await queueRecording(blob, trackingNumber, durationSeconds || undefined)
        cleanupRecording(true)
        if (stopAdvanceRef.current) {
          stopAdvanceRef.current = false
          goToNextGroup()
        }
      }

      recorder.start()
    } catch (error: any) {
      cleanupRecording()
      throw error
    }
  }

  function cleanupRecording(markIdle = true, stopStream = false) {
    recorderRef.current = null
    recordingChunksRef.current = []
    recordingStartRef.current = null
    if (stopStream) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
    if (markIdle) {
      setRecordingState({ status: 'idle', tracking: null })
    }
  }

  async function queueRecording(blob: Blob, trackingNumber: string, durationSeconds?: number) {
    if (!currentWorkOrderName || !currentGroup) return
    if (!folderHandle) {
      openAlert('ยังไม่ได้เลือกโฟลเดอร์จัดเก็บ กรุณาเลือกโฟลเดอร์ก่อน')
      return
    }
    setRecordingState({ status: 'uploading', tracking: trackingNumber })
    try {
      await requestNotificationPermission()
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `${timestamp}.webm`
      const path = `work_orders/${currentWorkOrderName}/${trackingNumber}/${filename}`

      const fileHandle = await folderHandle.getFileHandle(filename, { create: true })
      const writable = await fileHandle.createWritable()
      await writable.write(blob)
      await writable.close()

      const recordedBy = user?.username || user?.email || 'unknown'
      const item: UploadQueueItem = {
        id: crypto.randomUUID(),
        workOrderName: currentWorkOrderName,
        trackingNumber,
        orderId: currentGroup[0].order_id,
        filename,
        storagePath: path,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        retryCount: 0,
        lastError: null,
        durationSeconds: durationSeconds ?? null,
        fileType: blob.type || 'video/webm',
        fileSize: blob.size,
        recordedBy,
        recordedAt: new Date().toISOString(),
        blob
      }
      await addQueueItem(item)
      await refreshQueue()
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready
        if ('sync' in reg) {
          await reg.sync.register('packing-upload')
        }
        reg.active?.postMessage({ type: 'sync-now' })
      }
    } catch (error: any) {
      setRecordingState({ status: 'error', tracking: trackingNumber, error: error.message })
      openAlert('บันทึกไฟล์ลงโฟลเดอร์ไม่สำเร็จ: ' + error.message)
      return
    } finally {
      setRecordingState({ status: 'idle', tracking: null })
    }
  }

  function stopRecording() {
    if (recordingState.status !== 'recording') {
      cleanupRecording()
      return
    }
    recorderRef.current?.stop()
  }

  function stopRecordingAndAdvance() {
    if (recordingState.status !== 'recording') return
    stopAdvanceRef.current = true
    stopRecording()
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  return (
    <div className="space-y-4 flex flex-col min-h-0 h-full flex-1">

      {view === 'selection' ? (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">เลือกใบงาน</h2>
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              className={`px-3 py-2 rounded-full text-sm font-medium border ${
                selectionTab === 'new' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300'
              }`}
              onClick={() => setSelectionTab('new')}
            >
              ใบงานใหม่
              <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs">
                {newWorkOrders.length}
              </span>
            </button>
            <button
              className={`px-3 py-2 rounded-full text-sm font-medium border ${
                selectionTab === 'shipped' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300'
              }`}
              onClick={() => setSelectionTab('shipped')}
            >
              จัดส่งแล้ว
            </button>
            <button
              className={`px-3 py-2 rounded-full text-sm font-medium border ${
                selectionTab === 'queue' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-gray-300'
              }`}
              onClick={() => setSelectionTab('queue')}
            >
              คิวอัปโหลด
            </button>
          </div>

          {selectionTab === 'new' ? (
            newWorkOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-500">ไม่พบใบงานใหม่</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {newWorkOrders.map((wo) => {
                  const status = workOrderStatus[wo.work_order_name]
                  const hasTracking = status?.hasTracking ?? true
                  const isPartiallyPacked = status?.isPartiallyPacked ?? false
                  let statusIcon = '📦'
                  if (!hasTracking) statusIcon = '⚠️'
                  else if (isPartiallyPacked) statusIcon = '🔄'
                  const statusText = !hasTracking ? ' (รอเลขพัสดุ)' : ''
                  return (
                    <button
                      key={wo.id}
                      className={`p-4 border rounded-lg text-left hover:bg-gray-50 transition-colors ${
                        !hasTracking ? 'bg-yellow-50 border-yellow-200' : ''
                      }`}
                      onClick={() => {
                        handleSelectNewWorkOrder(wo.work_order_name, hasTracking)
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-lg font-semibold">
                            {statusIcon} {wo.work_order_name}
                          </div>
                          <div className="text-sm text-gray-600">
                            {wo.order_count} บิล{statusText}
                          </div>
                        </div>
                        <span className="text-blue-600 font-medium">เริ่มจัดของ</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : selectionTab === 'shipped' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">วันที่</label>
                  <input
                    type="date"
                    value={shippedDateFilter}
                    onChange={(e) => setShippedDateFilter(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ช่องทาง</label>
                  <select
                    value={shippedChannelFilter}
                    onChange={(e) => setShippedChannelFilter(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="">ทั้งหมด</option>
                    {shippedChannels.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ผู้แพ็ค</label>
                  <select
                    value={shippedPackerFilter}
                    onChange={(e) => setShippedPackerFilter(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  >
                    <option value="">ทั้งหมด</option>
                    {shippedPackers.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {shippedWorkOrders.length === 0 ? (
                <div className="text-center py-12 text-gray-500">ไม่พบใบงานที่จัดส่งแล้ว</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {shippedWorkOrders.map((wo) => (
                    <button
                      key={wo.work_order_name}
                      className="p-4 border rounded-lg bg-gray-50 text-left hover:bg-gray-100 transition-colors"
                      onClick={() => {
                        const name = wo.work_order_name
                        const rows = shippedOrders.filter((row) => row.work_order_name === name)
                        const latest = rows.reduce<string | null>((acc, row) => {
                          if (!row.shipped_time) return acc
                          if (!acc || row.shipped_time > acc) return row.shipped_time
                          return acc
                        }, null)
                        const firstPacker = rows.find((r) => r.shipped_by)?.shipped_by || ''
                        let shippedDate = ''
                        let shippedTime = ''
                        if (latest) {
                          const d = new Date(latest)
                          const yyyy = d.getFullYear()
                          const mm = String(d.getMonth() + 1).padStart(2, '0')
                          const dd = String(d.getDate()).padStart(2, '0')
                          shippedDate = `${yyyy}-${mm}-${dd}`
                          shippedTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                        }
                        setShippedEdit({
                          open: true,
                          workOrderName: name,
                          shippedBy: firstPacker,
                          shippedDate,
                          shippedTime
                        })
                      }}
                    >
                      <div className="text-lg font-semibold">✅ {wo.work_order_name}</div>
                      <div className="text-sm text-gray-600">
                        {wo.order_count} บิล • {wo.shipped_time ? new Date(wo.shipped_time).toLocaleString('th-TH') : '-'}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        ช่องทาง: {Array.from(wo.channels).join(', ') || '-'}
                      </div>
                      <div className="text-xs text-gray-500">
                        ผู้แพ็ค: {Array.from(wo.packers).join(', ') || '-'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                  onClick={selectFolder}
                >
                  เลือกโฟลเดอร์จัดเก็บ
                </button>
                <div className="text-sm text-gray-600">
                  โฟลเดอร์ปัจจุบัน:{' '}
                  <span className="font-semibold">{folderHandle?.name || 'ยังไม่ได้เลือก'}</span>
                </div>
              </div>
              {queueLoading ? (
                <div className="text-center py-6 text-gray-500">กำลังโหลดคิว...</div>
              ) : queueItems.length === 0 ? (
                <div className="text-center py-6 text-gray-500">ไม่มีคิวอัปโหลด</div>
              ) : (
                <div className="space-y-2">
                  {queueItems.map((item) => (
                    <div key={item.id} className="border rounded-lg p-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {item.workOrderName} • {item.trackingNumber}
                        </div>
                        <div className="text-xs text-gray-500">
                          {item.filename} • {item.status}
                          {item.localDeleted ? ' (ลบไฟล์แล้ว)' : ''}
                        </div>
                        {item.lastError && (
                          <div className="text-xs text-red-600 truncate">Error: {item.lastError}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {item.status === 'failed' && (
                          <button
                            className="px-3 py-1 text-sm bg-yellow-500 text-white rounded hover:bg-yellow-600"
                            onClick={async () => {
                              await updateQueueItem(item.id, { status: 'pending', lastError: null })
                              await refreshQueue()
                              if ('serviceWorker' in navigator) {
                                const reg = await navigator.serviceWorker.ready
                                if ('sync' in reg) {
                                  await reg.sync.register('packing-upload')
                                }
                                reg.active?.postMessage({ type: 'sync-now' })
                              }
                            }}
                          >
                            อัปโหลดใหม่
                          </button>
                        )}
                        {item.status === 'success' && (
                          <button
                            className="px-3 py-1 text-sm bg-gray-200 rounded hover:bg-gray-300"
                            onClick={async () => {
                              await deleteQueueItem(item.id)
                              await refreshQueue()
                            }}
                          >
                            ลบรายการ
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 flex-1 min-h-0 h-full">
          {isLoadingOrders && (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          )}

          <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold">
                จัดของ: {currentWorkOrderName || '-'}
              </h2>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                    onClick={loadWorkOrdersForPacking}
                  >
                    ❮ กลับไปเลือกใบงาน
                  </button>
                {hasPendingCompleted && (
                  <button
                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                    onClick={shipAllScannedOrders}
                  >
                    จัดส่งออร์เดอร์ที่สำเร็จ
                  </button>
                )}
                <button
                  className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600"
                  onClick={async () => {
                    if (!currentGroup) return
                    openConfirm('ยืนยัน "แพ็คใหม่"? (ข้อมูลที่แสกนไปแล้วในบิลนี้จะถูกล้างทั้งหมด)', async () => {
                      await performResetAction(currentIndex)
                    })
                  }}
                >
                  แพ็คใหม่
                </button>
                {allGroupsShipped && (
                  <button
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                    onClick={finalizeWorkOrder}
                  >
                    ย้ายไป "จัดส่งแล้ว"
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 flex-1 min-h-0 h-full items-stretch">
            <div className="bg-white p-4 rounded-lg shadow space-y-3 h-full min-h-0 flex flex-col">
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="font-semibold text-sm">
                  สำเร็จ {completedIndices.size} / {aggregatedData.length}
                </span>
                <input
                  className="border rounded px-2 py-1 text-sm flex-1 min-w-0"
                  placeholder="ค้นหาเลขพัสดุ..."
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
              </div>
              <div className="space-y-2 flex-1 min-h-0 overflow-y-auto pr-1">
                {aggregatedData.map((group, index) => {
                  const isDone = group[0].isOrderComplete
                  const isFullScanned = group.every((item) => item.scanned)
                  const icon = isDone ? '✅' : isFullScanned ? '🟢' : '📦'
                  const tracking = group[0].tracking_number
                  if (searchTerm && !tracking.toLowerCase().includes(searchTerm.toLowerCase())) return null
                  return (
                    <button
                      key={`${tracking}-${index}`}
                      className={`w-full text-left p-2 rounded border ${
                        index === currentIndex ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                      }`}
                      onClick={() => handleOrderClick(index)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold">
                            {icon} {tracking}
                          </div>
                          <div className="text-xs text-gray-500">{group[0].customer_name || 'N/A'}</div>
                        </div>
                        <div
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            isQcPassGroup(group) ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {isQcPassGroup(group) ? 'QC Pass' : 'ยังไม่ QC'}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-4 flex flex-col min-h-0 h-full">
              {currentGroup ? (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
                    <div className="bg-white p-4 rounded-lg shadow space-y-3">
                      <div className="space-y-2">
                        <h3 className="font-semibold text-center">ขั้นตอนที่ 1: สแกนเลขพัสดุ</h3>
                        <input
                          ref={parcelScanRef}
                          className="w-full border-2 border-green-500 rounded px-3 py-2 text-center"
                          placeholder="ยิงบาร์โค้ดเลขพัสดุที่กล่อง"
                          value={parcelScanValue}
                          onChange={(event) => setParcelScanValue(event.target.value.toUpperCase())}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              handleParcelScan()
                            }
                          }}
                          disabled={currentGroup[0].parcelScanned || currentGroup[0].isOrderComplete || !isQcPassGroup(currentGroup)}
                        />
                      </div>
                      <div className="space-y-2">
                        <h3 className="font-semibold text-center">ขั้นตอนที่ 2: สแกนสินค้า</h3>
                        <input
                          ref={itemScanRef}
                          className="w-full border-2 border-blue-500 rounded px-3 py-2 text-center"
                          placeholder="ยิงบาร์โค้ด Item UID"
                          value={itemScanValue}
                          onChange={(event) => setItemScanValue(event.target.value.toUpperCase())}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              handleItemScan()
                            }
                          }}
                          disabled={
                            !currentGroup[0].parcelScanned ||
                            currentGroup[0].isOrderComplete ||
                            currentGroup.every((item) => item.scanned)
                          }
                        />
                      </div>
                      <div
                        className={`text-center font-semibold ${
                          statusMessage.type === 'success'
                            ? 'text-green-600'
                            : statusMessage.type === 'error'
                            ? 'text-red-600'
                            : 'text-gray-700'
                        }`}
                      >
                        {statusMessage.text}
                      </div>
                    </div>

                    <div className="bg-white p-4 rounded-lg shadow space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="font-semibold">บันทึกวิดีโอ</h3>
                        <span className={`px-2 py-1 rounded text-xs font-medium ${getRecordingBadgeClass()}`}>
                          {getRecordingLabel()}
                        </span>
                      </div>
                      <video ref={videoRef} className="w-full h-[150px] rounded bg-black object-contain" muted playsInline />
                      {recordingState.status === 'error' && (
                        <p className="text-sm text-red-600">{recordingState.error}</p>
                      )}
                      <p className="text-xs text-gray-500">ไฟล์จะถูกอัปโหลดไปที่ Supabase เมื่อหยุดบันทึก</p>
                    </div>
                  </div>

                  <div className="bg-white p-4 rounded-lg shadow space-y-4 flex-1 min-h-0 overflow-x-auto overflow-y-visible h-full flex flex-col relative">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="text-lg font-semibold">
                            เลขพัสดุ: {currentGroup[0].tracking_number}
                          </div>
                          <button
                            type="button"
                            onClick={stopRecordingAndAdvance}
                            disabled={recordingState.status !== 'recording'}
                            className="px-3 py-1.5 text-sm font-semibold rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-40"
                          >
                            หยุดบันทึก
                          </button>
                        </div>
                        <div className="text-sm text-gray-600">ลูกค้า: {currentGroup[0].customer_name}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm text-gray-500">จำนวน</div>
                        <div className="text-2xl font-bold">
                          {currentGroup.filter((item) => item.scanned).length}/{currentGroup.length}
                        </div>
                      </div>
                    </div>

                    {(currentGroup[0].claim_type || currentGroup[0].needsTaxInvoice || currentGroup[0].needsCashBill) && (
                      <div className="space-y-2">
                        {currentGroup[0].claim_type && (
                          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded p-3 text-sm">
                            ⚠️ ออร์เดอร์เคลม: {currentGroup[0].claim_type} {currentGroup[0].claim_details || ''}
                          </div>
                        )}
                        {currentGroup[0].needsTaxInvoice && (
                          <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 text-sm">
                            ‼️ โปรดทราบ: ออร์เดอร์นี้ต้องการใบกำกับภาษี
                          </div>
                        )}
                        {!currentGroup[0].needsTaxInvoice && currentGroup[0].needsCashBill && (
                          <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded p-3 text-sm">
                            ‼️ โปรดทราบ: ออร์เดอร์นี้ต้องการบิลเงินสด
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex-1 min-h-0 overflow-visible h-full">
                      <table className="min-w-full border-collapse">
                      <thead className="bg-gray-100">
                        <tr className="text-left text-sm">
                          <th className="p-2 border">รูปสินค้า</th>
                          <th className="p-2 border">รูปลาย</th>
                          <th className="p-2 border">สินค้า</th>
                          <th className="p-2 border">ชั้น</th>
                          <th className="p-2 border">สีหมึก</th>
                          <th className="p-2 border">ลาย//เส้น</th>
                          <th className="p-2 border">ฟอนต์</th>
                          <th className="p-2 border">รายละเอียด</th>
                          <th className="p-2 border">หมายเหตุ</th>
                          <th className="p-2 border">ไฟล์</th>
                        </tr>
                        </thead>
                        <tbody>
                        {currentGroup
                          .slice()
                          .sort((a, b) => {
                            if (a.scanned === b.scanned) return naturalSortCompare(a.item_uid, b.item_uid)
                            return a.scanned ? 1 : -1
                          })
                          .map((item) => {
                            const combinedPattern = [item.cartoon_pattern, item.line_pattern].filter(Boolean).join(' // ')
                            const displayNotes = (item.notes || '').replace(/\[SET-.*?\]/g, '').trim()
                            const fileLink =
                              item.file_attachment &&
                              (item.file_attachment.startsWith('http') || item.file_attachment.includes('www.'))
                                ? item.file_attachment.startsWith('http')
                                  ? item.file_attachment
                                  : `https://${item.file_attachment}`
                                : null
                            const productImageUrl = getPublicUrl('product-images', item.product_code, '.jpg')
                            const patternName = item.cartoon_pattern || item.line_pattern || ''
                            const patternImageUrl = patternName ? getPublicUrl('cartoon-patterns', patternName, '.jpg') : ''
                            return (
                              <tr key={item.item_uid} className={item.scanned ? 'bg-green-50' : ''}>
                                <td className="p-2 border align-middle">
                                  <div className="flex flex-col items-center">
                                    <div className="relative group origin-left">
                                      <div className="w-20 h-20 border rounded bg-white flex items-center justify-center">
                                        {productImageUrl ? (
                                          <img
                                            src={productImageUrl}
                                            alt={item.product_name}
                                            className="w-full h-full object-contain"
                                          />
                                        ) : (
                                          <span className="text-xs text-gray-400">ไม่มีรูป</span>
                                        )}
                                      </div>
                                      {productImageUrl && (
                                        <img
                                          src={productImageUrl}
                                          alt={item.product_name}
                                          className="pointer-events-none absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 object-contain transition-transform duration-150 ease-out group-hover:scale-[3.5] group-hover:translate-x-[20%] z-[60]"
                                        />
                                      )}
                                    </div>
                                    <small className="mt-1">{item.item_uid}</small>
                                  </div>
                                </td>
                                <td className="p-2 border align-middle">
                                  <div className="flex flex-col items-center">
                                    <div className="relative group origin-left">
                                      <div className="w-20 h-20 border rounded bg-white flex items-center justify-center">
                                        {patternImageUrl ? (
                                          <img
                                            src={patternImageUrl}
                                            alt={patternName || 'pattern'}
                                            className="w-full h-full object-contain"
                                          />
                                        ) : (
                                          <span className="text-xs text-gray-400">ไม่มีรูป</span>
                                        )}
                                      </div>
                                      {patternImageUrl && (
                                        <img
                                          src={patternImageUrl}
                                          alt={patternName || 'pattern'}
                                          className="pointer-events-none absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 object-contain transition-transform duration-150 ease-out group-hover:scale-[3.5] group-hover:translate-x-[20%] z-[60]"
                                        />
                                      )}
                                    </div>
                                    <small className="mt-1">{patternName || '-'}</small>
                                  </div>
                                </td>
                                <td className="p-2 border">
                                  <div className="flex flex-col gap-1">
                                    {item.qc_status === 'pass' ? (
                                      <span className="inline-flex items-center justify-center rounded-full bg-green-100 text-green-700 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        QC Pass
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center justify-center rounded-full bg-red-100 text-red-700 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        ยังไม่ได้ QC
                                      </span>
                                    )}
                                    <span>{item.product_name}</span>
                                  </div>
                                </td>
                                <td className="p-2 border">
                                  {(item.shelf_location || '').trim() === 'ชั้น1' ? '' : (item.shelf_location || '')}
                                </td>
                                <td className="p-2 border">{item.ink_color || ''}</td>
                                <td className="p-2 border">{combinedPattern}</td>
                                <td className="p-2 border">{item.font || ''}</td>
                                <td className="p-2 border">{item.details || ''}</td>
                                <td className="p-2 border">{displayNotes}</td>
                                <td className="p-2 border">
                                  {fileLink ? (
                                    <a href={fileLink} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                                      เปิดลิงก์
                                    </a>
                                  ) : (
                                    item.file_attachment || ''
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center text-gray-500 py-10">ไม่พบข้อมูลออร์เดอร์</div>
              )}
            </div>
          </div>
        </div>
      )}
      <Modal
        open={previewModal.open}
        onClose={() => setPreviewModal({ open: false, message: '' })}
        closeOnBackdropClick
        contentClassName="max-w-md"
      >
        <div className="p-5 space-y-3">
          <h3 className="text-lg font-semibold">ไม่สามารถแสดงพรีวิววิดีโอ</h3>
          <p className="text-sm text-gray-700">{previewModal.message}</p>
          <div className="flex justify-end">
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              onClick={() => setPreviewModal({ open: false, message: '' })}
            >
              รับทราบ
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={dialog.open}
        onClose={closeDialog}
        closeOnBackdropClick={dialog.mode === 'alert'}
        contentClassName="max-w-md"
      >
        <div className="p-5 space-y-4">
          <h3 className="text-lg font-semibold">{dialog.title}</h3>
          <p className="text-sm text-gray-700">{dialog.message}</p>
          <div className="flex justify-end gap-2">
            {dialog.mode === 'confirm' && (
              <button
                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                onClick={closeDialog}
              >
                {dialog.cancelText || 'ยกเลิก'}
              </button>
            )}
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              onClick={() => {
                const action = confirmActionRef.current
                closeDialog()
                action?.()
              }}
            >
              {dialog.confirmText || 'ตกลง'}
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={Boolean(shippedEdit?.open)}
        onClose={() => setShippedEdit(null)}
        closeOnBackdropClick
        contentClassName="max-w-md"
      >
        <div className="p-5 space-y-4">
          <h3 className="text-lg font-semibold">แก้ไขใบงานที่จัดส่งแล้ว</h3>
          <div className="text-sm text-gray-600">
            ใบงาน: <span className="font-semibold">{shippedEdit?.workOrderName}</span>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">วันที่จัดส่ง</label>
              <input
                type="date"
                value={shippedEdit?.shippedDate || ''}
                onChange={(e) =>
                  setShippedEdit((prev) => (prev ? { ...prev, shippedDate: e.target.value } : prev))
                }
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">เวลา</label>
              <input
                type="time"
                value={shippedEdit?.shippedTime || ''}
                onChange={(e) =>
                  setShippedEdit((prev) => (prev ? { ...prev, shippedTime: e.target.value } : prev))
                }
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">ผู้แพ็ค</label>
              <input
                type="text"
                value={shippedEdit?.shippedBy || ''}
                onChange={(e) =>
                  setShippedEdit((prev) => (prev ? { ...prev, shippedBy: e.target.value } : prev))
                }
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder="ระบุชื่อผู้แพ็ค"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
              onClick={() => setShippedEdit(null)}
            >
              ยกเลิก
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              onClick={saveShippedEdit}
            >
              บันทึก
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
