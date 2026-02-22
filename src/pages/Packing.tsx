import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { getPublicUrl, fetchInkTypes } from '../lib/qcApi'
import { supabase } from '../lib/supabase'
import { Order, OrderItem, WorkOrder, InkType } from '../types'
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
  qc_status: 'pass' | 'fail' | 'skip' | null
}

type WorkOrderStatus = {
  hasTracking: boolean
  isPartiallyPacked: boolean
  qcCompleted: boolean
  qcSkipped: boolean
  totalItems: number
  packedItems: number
  totalBills: number
  packedBills: number
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
  const { hasAccess } = useMenuAccess()
  const isViewOnly = user?.role === 'superadmin' || user?.role === 'admin'
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [workOrderStatus, setWorkOrderStatus] = useState<Record<string, WorkOrderStatus>>({})
  const [planStartTimes, setPlanStartTimes] = useState<Record<string, string | null>>({})
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
  const [shippedDateFrom, setShippedDateFrom] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [shippedDateTo, setShippedDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [shippedChannelFilter, setShippedChannelFilter] = useState('')
  const [shippedPackerFilter, setShippedPackerFilter] = useState('')
  const [aggregatedData, setAggregatedData] = useState<PackingItem[][]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [currentWorkOrderName, setCurrentWorkOrderName] = useState<string | null>(null)
  const [packStartTime, setPackStartTime] = useState<Date | null>(null)
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

  const [billingCheckConfirmed, setBillingCheckConfirmed] = useState(false)

  // Ink types for color display
  const [inkTypes, setInkTypes] = useState<InkType[]>([])

  // Hover zoom image state (fixed overlay to escape overflow clipping)
  const [hoverImage, setHoverImage] = useState<{ url: string; rect: DOMRect } | null>(null)

  function getInkColor(inkName: string | null | undefined): string {
    if (!inkName) return '#ddd'
    const ink = inkTypes.find((i) => i.ink_name === inkName)
    return ink?.hex_code || '#ddd'
  }

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
    const now = new Date().toISOString()
    const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
      p_job_name: workOrderName,
      p_dept: 'PACK',
      p_patch: { 'เริ่มแพ็ค': { start_if_null: now } },
    })
    if (error) console.error('PACK ensurePlanDeptStart error:', error.message)
  }

  const checkAndMarkPackEnd = async (workOrderName: string) => {
    if (!workOrderName) return
    const { count } = await supabase
      .from('or_orders')
      .select('id', { count: 'exact', head: true })
      .eq('work_order_name', workOrderName)
      .neq('status', 'จัดส่งแล้ว')
    if ((count || 0) !== 0) return
    const now = new Date().toISOString()
    const procNames = ['เริ่มแพ็ค', 'เสร็จแล้ว']
    const patch: Record<string, Record<string, string>> = {}
    procNames.forEach((p) => {
      patch[p] = { start_if_null: now, end: now }
    })
    const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
      p_job_name: workOrderName,
      p_dept: 'PACK',
      p_patch: patch,
    })
    if (error) console.error('PACK checkAndMarkPackEnd error:', error.message)
  }

  const handleSelectNewWorkOrder = async (workOrderName: string, hasTracking: boolean, qcReady: boolean) => {
    if (!hasTracking) {
      openAlert('ใบงานนี้ยังไม่มีเลขพัสดุ ไม่สามารถจัดของได้')
      return
    }
    if (!qcReady) {
      openAlert('ใบงานนี้ยัง QC ไม่ครบ ไม่สามารถจัดของได้')
      return
    }
    const skipTrack = user?.role === 'superadmin' || user?.role === 'admin'
    if (!skipTrack) await ensurePlanDeptStart(workOrderName)

    let startTime: Date = new Date()
    const { data: planJob } = await supabase
      .from('plan_jobs')
      .select('tracks')
      .eq('name', workOrderName)
      .order('date', { ascending: false })
      .limit(1)
      .single()
    const planStart = planJob?.tracks?.PACK?.['เริ่มแพ็ค']?.start
    if (planStart) startTime = new Date(planStart)

    setPackStartTime(startTime)
    await loadPackingData(workOrderName)
  }

  useEffect(() => {
    currentIndexRef.current = currentIndex
  }, [currentIndex])

  useEffect(() => {
    aggregatedDataRef.current = aggregatedData
  }, [aggregatedData])

  const isQcPassGroup = (group: PackingItem[]) => group.every((item) => item.qc_status === 'pass' || item.qc_status === 'skip')

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
    fetchInkTypes().then(setInkTypes).catch(() => null)
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
    refreshQueue(true).catch(() => null)
    const timer = window.setInterval(() => {
      refreshQueue(false).catch(() => null)
    }, 5000)
    return () => {
      window.clearInterval(timer)
      authSub?.subscription?.unsubscribe()
    }
  }, [])

  async function loadFolderFromSettings() {
    const handle = await getFolderHandle()
    if (!handle) return
    const perm = await (handle as any).queryPermission?.({ mode: 'readwrite' })
    if (perm === 'granted') {
      setFolderHandleState(handle)
      return
    }
    const req = await (handle as any).requestPermission?.({ mode: 'readwrite' })
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

  async function refreshQueue(showLoading = false) {
    if (showLoading) setQueueLoading(true)
    const list = await listQueueItems()
    const sorted = list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    setQueueItems(sorted)
    if (showLoading) setQueueLoading(false)
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

  const openConfirm = (message: string, onConfirm: () => void, title = 'ยืนยันการทำรายการ', confirmText = 'ตกลง', cancelText = 'ยกเลิก') => {
    confirmActionRef.current = onConfirm
    setDialog({ open: true, mode: 'confirm', title, message, confirmText, cancelText })
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

  const allGroupsScanned = useMemo(() => {
    if (aggregatedData.length === 0) return false
    return completedIndices.size === aggregatedData.length
  }, [completedIndices, aggregatedData])

  const currentGroup = useMemo(() => {
    if (currentIndex < 0) return null
    return aggregatedData[currentIndex] || null
  }, [aggregatedData, currentIndex])

  const newWorkOrders = useMemo(() => {
    return workOrders
  }, [workOrders])

  // readyCount removed — unused

  // แจ้ง Sidebar ทุกครั้งที่จำนวนใบงานใหม่ทั้งหมดเปลี่ยน
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('packing-ready-count', { detail: { count: workOrders.length } }))
  }, [workOrders.length])

  const shippedOrdersFiltered = useMemo(() => {
    return shippedOrders.filter((row) => {
      if (!row.work_order_name) return false
      const date = row.shipped_time ? new Date(row.shipped_time).toISOString().slice(0, 10) : ''
      if (shippedDateFrom && date < shippedDateFrom) return false
      if (shippedDateTo && date > shippedDateTo) return false
      if (shippedChannelFilter && row.channel_code !== shippedChannelFilter) return false
      if (shippedPackerFilter && row.shipped_by !== shippedPackerFilter) return false
      return true
    })
  }, [shippedOrders, shippedDateFrom, shippedDateTo, shippedChannelFilter, shippedPackerFilter])

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
      if (latestGroup.every((item) => item.scanned)) return
      const hasStarted = latestGroup.some((item) => item.scanned || item.parcelScanned)
      if (hasStarted) {
        await performResetAction(latestIndex)
        setStatusMessage({ text: '⚠️ รีเซ็ตอัตโนมัติเนื่องจากไม่มีการเคลื่อนไหวเกิน 1 นาที', type: 'error' })
      }
    }, INACTIVITY_LIMIT)
  }

  async function loadWorkOrdersForPacking() {
    clearInactivityTimer()
    setLoading(true)
    setView('selection')
    setPackStartTime(null)
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
        const [
          { data: allProductionOrders },
          { data: finishedSessions },
          { data: skipLogsData },
        ] = await Promise.all([
          supabase
            .from('or_orders')
            .select('id, channel_code, work_order_name, tracking_number, packing_meta, or_order_items(packing_status)')
            .in('work_order_name', names),
          supabase
            .from('qc_sessions')
            .select('filename')
            .not('end_time', 'is', null)
            .in('filename', names.map((n) => `WO-${n}`)),
          supabase
            .from('qc_skip_logs')
            .select('work_order_name')
            .in('work_order_name', names),
        ])

        const finishedWoSet = new Set(
          (finishedSessions || []).map((s: any) => (s.filename as string).replace(/^WO-/, ''))
        )
        const skippedWoSet = new Set(
          (skipLogsData || []).map((s: any) => s.work_order_name as string)
        )

        const statusMap: Record<string, WorkOrderStatus> = {}
        orders.forEach((wo) => {
          const ordersInWo = (allProductionOrders || []).filter((o: any) => o.work_order_name === wo.work_order_name)
          const hasTracking = ordersInWo.some((o: any) => o.tracking_number)
          const isPartiallyPacked = ordersInWo.some(
            (o: any) =>
              o.packing_meta?.parcelScanned ||
              (o.or_order_items || []).some((oi: any) => oi.packing_status === 'สแกนแล้ว')
          )
          let totalItems = 0
          let packedItems = 0
          let packedBills = 0
          const billsWithTracking = ordersInWo.filter((o: any) => o.tracking_number)
          billsWithTracking.forEach((o: any) => {
            const items = o.or_order_items || []
            totalItems += items.length
            const scannedCount = items.filter((oi: any) => oi.packing_status === 'สแกนแล้ว').length
            packedItems += scannedCount
            if (items.length > 0 && scannedCount === items.length) packedBills++
          })
          statusMap[wo.work_order_name] = {
            hasTracking,
            isPartiallyPacked,
            qcCompleted: finishedWoSet.has(wo.work_order_name),
            qcSkipped: skippedWoSet.has(wo.work_order_name),
            totalItems,
            packedItems,
            totalBills: billsWithTracking.length,
            packedBills,
          }
        })
        setWorkOrderStatus(statusMap)

        // OFFICE: auto-ship เมื่อ QC เสร็จ (ไม่ต้องจัดส่งจริง)
        for (const wo of orders) {
          const st = statusMap[wo.work_order_name]
          if (!st || !(st.qcCompleted || st.qcSkipped)) continue
          const ordersInWo = (allProductionOrders || []).filter((o: any) => o.work_order_name === wo.work_order_name)
          const allOffice = ordersInWo.length > 0 && ordersInWo.every((o: any) => o.channel_code === 'OFFICE')
          if (!allOffice) continue
          const officeIds = ordersInWo.map((o: any) => o.id as string)
          const shippedBy = user?.username || user?.email || 'system'
          await supabase.from('or_orders').update({ status: 'จัดส่งแล้ว', shipped_by: shippedBy, shipped_time: new Date().toISOString() }).in('id', officeIds)
          await supabase.from('or_work_orders').update({ status: 'จัดส่งแล้ว' }).eq('work_order_name', wo.work_order_name)
        }

        const { data: planJobs } = await supabase
          .from('plan_jobs')
          .select('name, tracks')
          .in('name', names)
        const timeMap: Record<string, string | null> = {}
        ;(planJobs || []).forEach((pj: any) => {
          const start = pj.tracks?.PACK?.['เริ่มแพ็ค']?.start ?? null
          if (start) timeMap[pj.name] = start
        })
        setPlanStartTimes(timeMap)
      } else {
        setWorkOrderStatus({})
        setPlanStartTimes({})
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
      .select('item_uid, status, remark, created_at')
      .in('item_uid', uniqueUids)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('QC status load error:', error)
      return {}
    }
    const map: Record<string, 'pass' | 'fail' | 'skip'> = {}
    ;(data || []).forEach((row: any) => {
      const uid = row.item_uid
      if (!uid || map[uid]) return
      if (row.status === 'pass' && row.remark === 'ข้ามการ QC') {
        map[uid] = 'skip'
      } else if (row.status === 'pass' || row.status === 'fail') {
        map[uid] = row.status
      }
    })
    return map
  }

  function prepareDataForPacking(orders: OrderWithItems[], qcStatusMap: Record<string, 'pass' | 'fail' | 'skip'>) {
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
          needsCashBill: false,
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
    if (nextIndex !== -1) {
      setCurrentIndex(nextIndex)
      startInactivityTimer()
    } else {
      const firstNotShipped = aggregated.findIndex((group) => !group[0].isOrderComplete)
      setCurrentIndex(firstNotShipped !== -1 ? firstNotShipped : aggregated.length - 1)
    }
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
        playErrorSound()
        setStatusMessage({ text: '❌ บันทึกไม่สำเร็จ: ' + itemError.message, type: 'error' })
        return
      }
      if (!updatedItems || updatedItems.length === 0) {
        console.error('RLS blocked update – packing_staff may lack UPDATE permission on or_order_items')
        playErrorSound()
        setStatusMessage({ text: '❌ ไม่สามารถบันทึกสถานะสแกนได้ (สิทธิ์ไม่พอ)', type: 'error' })
        return
      }
      const scannedBy = user?.username || user?.email || 'unknown'
      const itemId = updatedItems[0]?.id ?? null
      const { error: logError } = await supabase.from('pk_packing_logs').insert({
        order_id: itemToScan.order_id,
        item_id: itemId,
        packed_by: scannedBy,
        notes: 'item_scan'
      })
      if (logError) console.warn('Failed to log item scan:', logError)

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
        const needsBilling = updatedGroup[0].needsTaxInvoice || updatedGroup[0].needsCashBill
        if (needsBilling && !billingCheckConfirmed) {
          const billType = updatedGroup[0].needsTaxInvoice ? 'ใบกำกับภาษี' : 'บิลเงินสด'
          playErrorSound()
          setStatusMessage({ text: `⚠️ ยังไม่ได้ยืนยันว่าใส่${billType}แล้ว`, type: 'error' })
          openAlert(`สแกนครบแล้ว แต่ยังไม่ได้ติ๊กยืนยันว่าใส่${billType}ในกล่องแล้ว\nกรุณาติ๊กยืนยันก่อนจบการแพ็ค`, `⚠️ ลืมใส่${billType}`)
          return
        }
        setStatusMessage({ text: '✅ สแกนครบแล้ว!', type: 'success' })
        openConfirm(
          'สแกนสินค้าครบแล้ว แพ็คเสร็จเรียบร้อยใช่ไหม?',
          () => { stopRecordingAndAdvance() },
          'ยืนยันการแพ็คสินค้า',
          'ใช่ (หยุดบันทึก)',
          'ไม่ใช่ (ตรวจสอบอีกรอบ)'
        )
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

  async function shipAllAndFinalize() {
    if (!currentWorkOrderName) return
    setIsLoadingOrders(true)
    try {
      const ids: string[] = []
      completedIndices.forEach((index) => {
        const group = aggregatedData[index]
        if (group && !group[0].isOrderComplete) ids.push(group[0].order_id)
      })

      if (ids.length > 0) {
        const shippedBy = user?.username || user?.email || 'unknown'
        const { error } = await supabase
          .from('or_orders')
          .update({ status: 'จัดส่งแล้ว', shipped_by: shippedBy, shipped_time: new Date().toISOString() })
          .in('id', ids)
        if (error) throw error
      }

      await supabase.from('or_work_orders').update({ status: 'จัดส่งแล้ว' }).eq('work_order_name', currentWorkOrderName)
      await checkAndMarkPackEnd(currentWorkOrderName)
      playSuccessSound()
      openAlert(`จัดส่งสำเร็จทั้งหมด ${ids.length || aggregatedData.length} รายการ!`)
      await loadWorkOrdersForPacking()
    } catch (error: any) {
      openAlert(error.message)
    } finally {
      setIsLoadingOrders(false)
    }
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
    if (recordingState.status === 'recording') {
      openConfirm(
        'กำลังบันทึกวิดีโออยู่ ต้องการหยุดบันทึกและเปลี่ยนบิลหรือไม่?',
        () => {
          stopRecording()
          switchToOrder(index)
        },
        'หยุดบันทึกวิดีโอ',
        'ใช่ (หยุดบันทึก)',
        'ไม่ใช่ (บันทึกต่อ)'
      )
      return
    }
    await switchToOrder(index)
  }

  async function switchToOrder(index: number) {
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
    setBillingCheckConfirmed(false)
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
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
      const recorder = new MediaRecorder(streamRef.current, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 5_000_000,
      })
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
        const regAny = reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }
        if (regAny.sync?.register) {
          await regAny.sync.register('packing-upload')
        }
        regAny.active?.postMessage({ type: 'sync-now' })
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
    <div className="w-full flex flex-col min-h-0 h-full flex-1">

      {view === 'selection' ? (
        <>
        {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
        <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
          <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
            <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
              {([
                { key: 'new' as const, label: 'ใบงานใหม่', count: workOrders.length },
                { key: 'shipped' as const, label: 'จัดส่งแล้ว' },
                { key: 'queue' as const, label: 'คิวอัปโหลด' },
              ]).filter((tab) => hasAccess(`packing-${tab.key}`)).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setSelectionTab(tab.key)}
                  className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                    selectionTab === tab.key
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-blue-600'
                  }`}
                >
                  {tab.label}
                  {'count' in tab && tab.count !== undefined && (
                    <span className="ml-1.5 text-blue-600 font-semibold">({tab.count})</span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </div>

        <div className="pt-4">
          {selectionTab === 'new' ? (
            newWorkOrders.length === 0 ? (
              <div className="text-center py-12 text-gray-500">ไม่พบใบงานใหม่</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {newWorkOrders.map((wo) => {
                  const status = workOrderStatus[wo.work_order_name]
                  const hasTracking = status?.hasTracking ?? true
                  const isPartiallyPacked = status?.isPartiallyPacked ?? false
                  const qcCompleted = status?.qcCompleted ?? false
                  const qcSkipped = status?.qcSkipped ?? false
                  const qcReady = qcCompleted || qcSkipped
                  const canSelect = hasTracking && qcReady

                  // สีตามสถานะ — ให้ความสำคัญกับ QC ก่อน, แล้วดู tracking
                  let cardClass = ''
                  let borderLeftColor = ''
                  if (qcSkipped) {
                    cardClass = canSelect
                      ? 'bg-orange-50/80 border-orange-200 hover:bg-orange-100 hover:shadow-md'
                      : 'bg-orange-50/60 border-orange-200'
                    borderLeftColor = 'border-l-orange-500'
                  } else if (qcCompleted) {
                    cardClass = canSelect
                      ? 'bg-emerald-50/80 border-emerald-200 hover:bg-emerald-100 hover:shadow-md'
                      : 'bg-emerald-50/60 border-emerald-200'
                    borderLeftColor = 'border-l-emerald-500'
                  } else if (!hasTracking) {
                    cardClass = 'bg-amber-50/60 border-amber-200'
                    borderLeftColor = 'border-l-amber-400'
                  } else {
                    cardClass = 'bg-slate-50/80 border-slate-200'
                    borderLeftColor = 'border-l-red-400'
                  }
                  if (!canSelect) cardClass += ' opacity-70 cursor-not-allowed'

                  return (
                    <button
                      key={wo.id}
                      className={`p-4 border border-l-4 rounded-xl text-left transition-all duration-200 shadow-sm ${cardClass} ${borderLeftColor}`}
                      disabled={!canSelect}
                      onClick={() => {
                        handleSelectNewWorkOrder(wo.work_order_name, hasTracking, qcReady)
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-lg font-bold flex items-center gap-2 flex-wrap">
                            <span className="truncate">{wo.work_order_name}</span>
                            {/* ป้าย QC — แสดงเสมอ */}
                            {qcSkipped ? (
                              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-orange-500 text-white shadow-sm">
                                ⏭ ไม่ต้อง QC
                              </span>
                            ) : qcCompleted ? (
                              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-emerald-500 text-white shadow-sm">
                                ✓ Pass ครบ
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-red-500 text-white shadow-sm">
                                ✗ รอ QC
                              </span>
                            )}
                            {/* ป้ายเลขพัสดุ — แสดงแยกต่างหากเมื่อยังไม่มี */}
                            {!hasTracking && (
                              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-amber-500 text-white shadow-sm">
                                ⚠ รอเลขพัสดุ
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span>{wo.order_count} บิล{(status?.packedBills ?? 0) > 0 && <span className="text-emerald-600 font-medium"> (แพ็คแล้ว {status.packedBills}/{status.totalBills})</span>}</span>
                            <span className="text-gray-400">|</span>
                            <span>รวม {status?.totalItems ?? 0} รายการ</span>
                            {(status?.packedItems ?? 0) > 0 && (
                              <>
                                <span className="text-gray-400">|</span>
                                <span className="text-emerald-600 font-medium">แพ็คแล้ว {status?.packedItems ?? 0}</span>
                              </>
                            )}
                            {(status?.totalItems ?? 0) - (status?.packedItems ?? 0) > 0 && (status?.packedItems ?? 0) > 0 && (
                              <>
                                <span className="text-gray-400">|</span>
                                <span className="text-amber-600 font-medium">คงเหลือ {(status?.totalItems ?? 0) - (status?.packedItems ?? 0)}</span>
                              </>
                            )}
                            {isPartiallyPacked && <span className="ml-1 text-blue-600 font-medium">🔄 แพ็คค้าง</span>}
                            {planStartTimes[wo.work_order_name] && (
                              <>
                                <span className="text-gray-400">|</span>
                                <span className="text-indigo-600 font-medium">
                                  ⏱ เริ่ม {new Date(planStartTimes[wo.work_order_name]!).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {canSelect ? (
                          <span className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-semibold shadow-sm hover:bg-blue-700 transition-colors">
                            เริ่มจัดของ
                          </span>
                        ) : (
                          <span className="shrink-0 px-3 py-1.5 rounded-lg bg-gray-200 text-gray-400 text-sm font-medium">
                            ไม่พร้อม
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          ) : selectionTab === 'shipped' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">วันที่เริ่มต้น</label>
                  <input
                    type="date"
                    value={shippedDateFrom}
                    onChange={(e) => setShippedDateFrom(e.target.value)}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">วันที่สิ้นสุด</label>
                  <input
                    type="date"
                    value={shippedDateTo}
                    onChange={(e) => setShippedDateTo(e.target.value)}
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
                      className="p-4 border border-l-4 rounded-xl text-left transition-all duration-200 shadow-sm bg-orange-50/80 border-orange-200 border-l-orange-500 hover:bg-orange-100 hover:shadow-md"
                      onClick={() => {
                        loadPackingData(wo.work_order_name)
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-lg font-bold text-gray-800 truncate">{wo.work_order_name}</div>
                        <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-orange-500 text-white shadow-sm shrink-0">
                          ✓ จัดส่งแล้ว
                        </span>
                      </div>
                      <div className="text-sm text-gray-600 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span>{wo.order_count} บิล</span>
                        <span className="text-gray-300">|</span>
                        <span>{wo.shipped_time ? new Date(wo.shipped_time).toLocaleString('th-TH') : '-'}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span>ช่องทาง: {Array.from(wo.channels).join(', ') || '-'}</span>
                        <span className="text-gray-300">|</span>
                        <span>ผู้แพ็ค: {Array.from(wo.packers).join(', ') || '-'}</span>
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
                <>
                {queueItems.some((i) => i.status === 'success' && i.localDeleted) && (
                  <div className="flex justify-end">
                    <button
                      className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium shadow-sm"
                      onClick={async () => {
                        const toDelete = queueItems.filter((i) => i.status === 'success' && i.localDeleted)
                        for (const item of toDelete) {
                          await deleteQueueItem(item.id)
                        }
                        await refreshQueue()
                      }}
                    >
                      ลบรายการที่ลบไฟล์แล้วทั้งหมด ({queueItems.filter((i) => i.status === 'success' && i.localDeleted).length})
                    </button>
                  </div>
                )}
                <div className="space-y-2">
                  {queueItems.map((item) => {
                    const isSuccess = item.status === 'success'
                    const isFailed = item.status === 'failed'
                    const isUploading = item.status === 'uploading'
                    const cardClass = isSuccess
                      ? 'bg-blue-50 border-blue-200 text-blue-900'
                      : isFailed
                        ? 'bg-red-50 border-red-300 text-red-900'
                        : isUploading
                          ? 'bg-sky-50 border-sky-300 text-sky-900'
                          : 'bg-amber-50 border-amber-300 text-amber-900'
                    return (
                    <div key={item.id} className={`border rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 ${cardClass}`}>
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {item.workOrderName} • {item.trackingNumber}
                        </div>
                        <div className="text-xs opacity-70">
                          {item.createdAt ? new Date(item.createdAt).toLocaleString('th-TH') : item.filename} • {
                            isSuccess ? 'อัปโหลดสำเร็จ' : isFailed ? 'อัปโหลดไม่สำเร็จ' : isUploading ? 'กำลังอัปโหลด...' : 'รอคิว'
                          }
                          {item.localDeleted ? ' • ลบไฟล์แล้ว' : ''}
                        </div>
                        {item.lastError && (
                          <div className="text-xs truncate text-red-600">Error: {item.lastError}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isFailed && (
                          <button
                            className="px-3 py-1 text-sm bg-yellow-500 text-white rounded hover:bg-yellow-600 font-medium"
                            onClick={async () => {
                              await updateQueueItem(item.id, { status: 'pending', lastError: null })
                              await refreshQueue()
                              if ('serviceWorker' in navigator) {
                                const reg = await navigator.serviceWorker.ready
                                const regAny = reg as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }
                                if (regAny.sync?.register) {
                                  await regAny.sync.register('packing-upload')
                                }
                                regAny.active?.postMessage({ type: 'sync-now' })
                              }
                            }}
                          >
                            อัปโหลดใหม่
                          </button>
                        )}
                        {isSuccess && (
                          <button
                            className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 font-medium"
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
                    )
                  })}
                </div>
                </>
              )}
            </div>
          )}
        </div>
        </>
      ) : (
        <div className="space-y-4 flex-1 min-h-0 h-full">
          {isLoadingOrders && (
            <div className="flex justify-center items-center py-6">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          )}

          <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold">
                  จัดของ: {currentWorkOrderName || '-'}
                </h2>
                {packStartTime && !isViewOnly && (
                  <div className="inline-flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-1.5 mt-1">
                    <span className="text-sm text-indigo-500 font-medium">⏱ เวลาเริ่ม:</span>
                    <span className="text-lg font-bold text-indigo-700">
                      {packStartTime.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                )}
              </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                    onClick={loadWorkOrdersForPacking}
                  >
                    ❮ กลับไปเลือกใบงาน
                  </button>
                {!isViewOnly && allGroupsScanned && !allGroupsShipped && (
                  <button
                    className="px-5 py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-lg hover:from-green-700 hover:to-emerald-700 font-bold shadow-lg animate-pulse"
                    onClick={() => openConfirm(`ยืนยันจัดส่งทั้งหมด ${aggregatedData.length} ออเดอร์ แล้วย้ายไปจัดส่งแล้ว?`, shipAllAndFinalize)}
                  >
                    🚚 จัดส่งออเดอร์ทั้งหมด
                  </button>
                )}
                {!isViewOnly && hasPendingCompleted && !allGroupsScanned && (
                  <button
                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
                    onClick={shipAllScannedOrders}
                  >
                    จัดส่งออร์เดอร์ที่สำเร็จ
                  </button>
                )}
                {!isViewOnly && (
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
                )}
                {!isViewOnly && allGroupsShipped && (
                  <button
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                    onClick={finalizeWorkOrder}
                  >
                    ย้ายไป "จัดส่งแล้ว"
                  </button>
                )}
                {isViewOnly && (
                  <div className="text-sm text-gray-500 bg-gray-100 px-4 py-2 rounded-lg">
                    โหมดดูอย่างเดียว (superadmin/admin ไม่สามารถจัดของได้)
                  </div>
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
                            isQcPassGroup(group)
                              ? group.every((i) => i.qc_status === 'skip')
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {isQcPassGroup(group)
                            ? group.every((i) => i.qc_status === 'skip')
                              ? 'Not QC'
                              : 'QC Pass'
                            : 'ยังไม่ QC'}
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
                          disabled={isViewOnly || currentGroup[0].parcelScanned || currentGroup[0].isOrderComplete || !isQcPassGroup(currentGroup)}
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
                            isViewOnly ||
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
                          <label className={`flex items-center gap-4 rounded-lg p-4 cursor-pointer select-none border-2 transition-colors ${billingCheckConfirmed ? 'bg-green-50 border-green-400' : 'bg-red-50 border-red-300 animate-pulse'}`}>
                            <input
                              type="checkbox"
                              checked={billingCheckConfirmed}
                              onChange={(e) => setBillingCheckConfirmed(e.target.checked)}
                              className="w-8 h-8 rounded border-red-400 text-green-600 focus:ring-green-500 shrink-0"
                            />
                            <div>
                              <div className="font-bold text-base text-red-800">‼️ ใบกำกับภาษี</div>
                              <div className="text-sm text-red-700">กรุณาติ๊กยืนยันว่าใส่ใบกำกับภาษีในกล่องแล้ว</div>
                            </div>
                          </label>
                        )}
                        {!currentGroup[0].needsTaxInvoice && currentGroup[0].needsCashBill && (
                          <label className={`flex items-center gap-4 rounded-lg p-4 cursor-pointer select-none border-2 transition-colors ${billingCheckConfirmed ? 'bg-green-50 border-green-400' : 'bg-blue-50 border-blue-300 animate-pulse'}`}>
                            <input
                              type="checkbox"
                              checked={billingCheckConfirmed}
                              onChange={(e) => setBillingCheckConfirmed(e.target.checked)}
                              className="w-8 h-8 rounded border-blue-400 text-green-600 focus:ring-green-500 shrink-0"
                            />
                            <div>
                              <div className="font-bold text-base text-blue-800">‼️ บิลเงินสด</div>
                              <div className="text-sm text-blue-700">กรุณาติ๊กยืนยันว่าใส่บิลเงินสดในกล่องแล้ว</div>
                            </div>
                          </label>
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
                                    <div
                                      className="w-20 h-20 border rounded bg-white flex items-center justify-center cursor-pointer"
                                      onMouseEnter={(e) => {
                                        if (productImageUrl) setHoverImage({ url: productImageUrl, rect: e.currentTarget.getBoundingClientRect() })
                                      }}
                                      onMouseLeave={() => setHoverImage(null)}
                                    >
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
                                    <small className="mt-1">{item.item_uid}</small>
                                  </div>
                                </td>
                                <td className="p-2 border align-middle">
                                  <div className="flex flex-col items-center">
                                    <div
                                      className="w-20 h-20 border rounded bg-white flex items-center justify-center cursor-pointer"
                                      onMouseEnter={(e) => {
                                        if (patternImageUrl) setHoverImage({ url: patternImageUrl, rect: e.currentTarget.getBoundingClientRect() })
                                      }}
                                      onMouseLeave={() => setHoverImage(null)}
                                    >
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
                                    <small className="mt-1">{patternName || '-'}</small>
                                  </div>
                                </td>
                                <td className="p-2 border">
                                  <div className="flex flex-col gap-1">
                                    {item.qc_status === 'pass' ? (
                                      <span className="inline-flex items-center justify-center rounded-full bg-green-100 text-green-700 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        QC Pass
                                      </span>
                                    ) : item.qc_status === 'skip' ? (
                                      <span className="inline-flex items-center justify-center rounded-full bg-orange-100 text-orange-700 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        Not QC
                                      </span>
                                    ) : item.qc_status === 'fail' ? (
                                      <span className="inline-flex items-center justify-center rounded-full bg-red-100 text-red-700 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        QC Fail
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center justify-center rounded-full bg-gray-100 text-gray-500 text-[11px] font-semibold px-2 py-0.5 w-fit">
                                        ยังไม่ได้ QC
                                      </span>
                                    )}
                                    <span>{item.product_name}</span>
                                  </div>
                                </td>
                                <td className="p-2 border">
                                  {(item.shelf_location || '').trim() === 'ชั้น1' ? '' : (item.shelf_location || '')}
                                </td>
                                <td className="p-2 border">
                                  {item.ink_color ? (
                                    <div className="flex items-center gap-1.5">
                                      <span
                                        className="w-6 h-6 rounded-full border shrink-0"
                                        style={{ backgroundColor: getInkColor(item.ink_color) }}
                                      />
                                      <span
                                        className="font-semibold text-sm px-1.5 py-0.5 rounded"
                                        style={{
                                          backgroundColor: getInkColor(item.ink_color) + '30',
                                          color: getInkColor(item.ink_color) !== '#ddd' ? getInkColor(item.ink_color) : undefined,
                                        }}
                                      >
                                        {item.ink_color}
                                      </span>
                                      {item.ink_color.includes('กระดาษ') && (
                                        <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none">
                                          <path d="M5.625 1.5H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" fill="#DBEAFE" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                          <path d="M10.5 2.25H8.25m2.25 0v1.5a3.375 3.375 0 0 0 3.375 3.375h1.5A1.125 1.125 0 0 0 16.5 6V4.5" fill="#93C5FD" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                          <path d="M8.25 13.5h7.5M8.25 16.5H12" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      )}
                                      {item.ink_color.includes('ผ้า') && (
                                        <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none">
                                          <path d="M6.75 3 3 5.25v3h3l.75 1.5v8.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.75L18 8.25h3V5.25L17.25 3h-3a2.25 2.25 0 0 1-4.5 0h-3Z" fill="#FDE68A" stroke="#F59E0B" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      )}
                                      {item.ink_color.includes('พลาสติก') && (
                                        <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none">
                                          <path d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5m4.75-11.396c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082" fill="#D1FAE5" stroke="#10B981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                          <path d="M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" fill="#A7F3D0" stroke="#10B981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      )}
                                    </div>
                                  ) : (
                                    ''
                                  )}
                                </td>
                                <td className="p-2 border">{combinedPattern}</td>
                                <td className="p-2 border">{item.font || ''}</td>
                                <td className="p-2 border">{item.details || ''}</td>
                                <td className="p-2 border">{displayNotes}</td>
                                <td className="p-2 border text-center">
                                  {fileLink ? (
                                    <a
                                      href={fileLink}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-50 text-cyan-600 hover:bg-cyan-100 hover:text-cyan-700 transition-colors"
                                      title="เปิดไฟล์แนบ"
                                    >
                                      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                      </svg>
                                    </a>
                                  ) : item.file_attachment ? (
                                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 text-gray-400" title={item.file_attachment}>
                                      <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                                      </svg>
                                    </span>
                                  ) : (
                                    <span className="text-gray-300">-</span>
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

      {/* Fixed overlay for hover-zoomed product/pattern images — escapes all overflow clipping */}
      {hoverImage && (
        <div
          className="pointer-events-none fixed z-[999999]"
          style={{
            top: hoverImage.rect.top + hoverImage.rect.height / 2,
            left: hoverImage.rect.right + 12,
            transform: 'translateY(-50%)',
          }}
        >
          <img
            src={hoverImage.url}
            alt="preview"
            className="w-[280px] h-[280px] object-contain rounded-xl border-2 border-white bg-white"
            style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
          />
        </div>
      )}
    </div>
  )
}
