import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import type { QCItem, QCRecord, QCSession, SettingsReason, InkType, QCChecklistTopic, QCChecklistItem, QCChecklistTopicProduct } from '../types'
import {
  fetchWorkOrdersWithProgress,
  fetchItemsByWorkOrder,
  fetchOpenSessionForWo,
  fetchRecordsForSession,
  saveQcRecord,
  fetchSettingsReasons,
  fetchInkTypes,
  fetchRejectItems,
  fetchReports,
  fetchSessionRecords,
  searchHistoryByUid,
  fetchReportUsers,
  addReason,
  addSubReason,
  deleteReason,
  updateReasonType,
  updateInkHex,
  getPublicUrl,
  saveWorkOrderName,
  setSessionBackup,
  clearSessionBackup,
  fetchChecklistTopics,
  createChecklistTopic,
  updateChecklistTopic,
  deleteChecklistTopic,
  fetchChecklistItems,
  createChecklistItem,
  deleteChecklistItem,
  fetchChecklistTopicProducts,
  addChecklistTopicProduct,
  removeChecklistTopicProduct,
  uploadChecklistFile,
  searchProducts,
  fetchChecklistForProduct,
  generateChecklistTemplate,
  importChecklistFromExcel,
} from '../lib/qcApi'
import type { BulkImportResult } from '../lib/qcApi'
import type { WorkOrderWithProgress } from '../lib/qcApi'
import { supabase } from '../lib/supabase'
import Modal from '../components/ui/Modal'
import Papa from 'papaparse'

type QCView = 'qc' | 'reject' | 'report' | 'history' | 'settings'
type QCStep = 'select' | 'working'

const MENUS: { id: QCView; label: string; adminOnly?: boolean }[] = [
  { id: 'qc', label: 'QC Operation' },
  { id: 'reject', label: 'Reject' },
  { id: 'report', label: 'Reports & KPI', adminOnly: true },
  { id: 'history', label: 'History Check' },
  { id: 'settings', label: 'Settings', adminOnly: true },
]

function formatDate(d: string | Date | null): string {
  if (!d) return '-'
  const date = new Date(d)
  if (isNaN(date.getTime())) return '-'
  return date.toLocaleDateString('th-TH', { year: '2-digit', month: '2-digit', day: '2-digit' }) + ' ' + date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
}

function formatTime(d: string | Date | null): string {
  if (!d) return '-'
  const date = new Date(d)
  if (isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString('th-TH')
}

function formatDuration(s: number | null | undefined): string {
  if (s == null || s < 0) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h > 0 ? h + 'h ' : ''}${m > 0 ? m + 'm ' : ''}${sec}s`
}

const QC_MENU_KEY_MAP: Record<string, string> = {
  qc: 'qc-operation',
  reject: 'qc-reject',
  report: 'qc-report',
  history: 'qc-history',
  settings: 'qc-settings',
}

export default function QC() {
  const { user } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const isAdmin = user?.role === 'superadmin' || user?.role === 'admin-tr'
  const canSkipQc = user?.role === 'superadmin' || user?.role === 'admin'
  const isViewOnly = user?.role === 'superadmin' || user?.role === 'admin'

  const [currentView, setCurrentView] = useState<QCView>('qc')
  const [loading, setLoading] = useState(false)

  // QC Operation
  const [workOrdersWithProgress, setWorkOrdersWithProgress] = useState<WorkOrderWithProgress[]>([])
  const [qcState, setQcState] = useState<{ step: QCStep; startTime: Date | null; filename: string; sessionId: string | null }>({ step: 'select', startTime: null, filename: '', sessionId: null })
  const [qcData, setQcData] = useState<{ items: QCItem[] }>({ items: [] })
  const [currentItem, setCurrentItem] = useState<QCItem | null>(null)
  const [barcodeQuery, setBarcodeQuery] = useState('')
  const [qcCategoryFilter, setQcCategoryFilter] = useState<string>('')
  const [productExt, setProductExt] = useState('.jpg')
  const [cartoonExt, setCartoonExt] = useState('.jpg')
  const [imgErrors, setImgErrors] = useState({ product: false, cartoon: false })
  const barcodeInputRef = useRef<HTMLInputElement>(null)

  // Reject
  const [rejectData, setRejectData] = useState<QCRecord[]>([])
  const [activeRejectTab, setActiveRejectTab] = useState<'queue' | 1 | 2 | 3 | 4>('queue')
  const [currentRejectItem, setCurrentRejectItem] = useState<QCRecord | null>(null)
  const [rejectSearchQuery, setRejectSearchQuery] = useState('')
  const [currentTime, setCurrentTime] = useState(() => new Date())

  // Reports
  const [reports, setReports] = useState<QCSession[]>([])
  const [reportUsers, setReportUsers] = useState<{ id: string; username: string | null }[]>([])
  const [reportFilter, setReportFilter] = useState({
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    user: '',
  })
  const [showSessionModal, setShowSessionModal] = useState(false)
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false)

  const ensurePlanDeptStart = useCallback(async (workOrderName: string) => {
    if (!workOrderName) return
    const now = new Date().toISOString()
    const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
      p_job_name: workOrderName,
      p_dept: 'QC',
      p_patch: { 'เริ่มQC': { start_if_null: now } },
    })
    if (error) console.error('QC ensurePlanDeptStart error:', error.message)
  }, [])

  const ensurePlanDeptEnd = useCallback(async (workOrderName: string) => {
    if (!workOrderName) return
    const now = new Date().toISOString()
    const procNames = ['เริ่มQC', 'เสร็จแล้ว']
    const patch: Record<string, Record<string, string>> = {}
    procNames.forEach((p) => {
      patch[p] = { start_if_null: now, end: now }
    })
    const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
      p_job_name: workOrderName,
      p_dept: 'QC',
      p_patch: patch,
    })
    if (error) console.error('QC ensurePlanDeptEnd error:', error.message)
  }, [])
  const [switchJobConfirmOpen, setSwitchJobConfirmOpen] = useState(false)
  const [sessionItems, setSessionItems] = useState<QCRecord[]>([])

  // History
  const [historySearch, setHistorySearch] = useState('')
  const [historyResults, setHistoryResults] = useState<QCRecord[]>([])
  const [historySearched, setHistorySearched] = useState(false)
  const [currentHistoryRecord, setCurrentHistoryRecord] = useState<QCRecord | null>(null)

  // Settings
  const [reasons, setReasons] = useState<SettingsReason[]>([])
  const [inkTypes, setInkTypes] = useState<InkType[]>([])
  const [settingsTab, setSettingsTab] = useState<'reasons' | 'ink' | 'skip_logs' | 'checklist_topics'>('reasons')
  const [newReason, setNewReason] = useState('')
  const [newReasonType, setNewReasonType] = useState<'Man' | 'Machine' | 'Material' | 'Method'>('Man')

  // Skip QC (ไม่ต้อง QC)
  const [skipQcLoading, setSkipQcLoading] = useState<string | null>(null)
  const [skipQcConfirmWo, setSkipQcConfirmWo] = useState<string | null>(null)
  const [skipLogs, setSkipLogs] = useState<any[]>([])

  // Sub-reason management (Settings)
  const [addSubReasonParentId, setAddSubReasonParentId] = useState<string | null>(null)
  const [newSubReason, setNewSubReason] = useState('')

  // Checklist Topics (Settings)
  const [clTopics, setClTopics] = useState<QCChecklistTopic[]>([])
  const [clNewTopicName, setClNewTopicName] = useState('')
  const [clSelectedTopic, setClSelectedTopic] = useState<QCChecklistTopic | null>(null)
  const [clItems, setClItems] = useState<QCChecklistItem[]>([])
  const [clProducts, setClProducts] = useState<QCChecklistTopicProduct[]>([])
  const [clNewItemTitle, setClNewItemTitle] = useState('')
  const [clNewItemFile, setClNewItemFile] = useState<File | null>(null)
  const [clProductSearch, setClProductSearch] = useState('')
  const [clProductResults, setClProductResults] = useState<{ product_code: string; product_name: string }[]>([])
  const [clEditTopicId, setClEditTopicId] = useState<string | null>(null)
  const [clEditTopicName, setClEditTopicName] = useState('')
  const [clUploading, setClUploading] = useState(false)
  const [clImporting, setClImporting] = useState(false)
  const [clImportResult, setClImportResult] = useState<BulkImportResult | null>(null)
  const clFileInputRef = useRef<HTMLInputElement>(null)

  // Checklist for QC Operation (in-memory checkbox state)
  const [checklistItems, setChecklistItems] = useState<(QCChecklistItem & { topic_name: string })[]>([])
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set())

  // Delete reason confirm modal
  const [deleteReasonModalOpen, setDeleteReasonModalOpen] = useState(false)
  const [deleteReasonTarget, setDeleteReasonTarget] = useState<{ id: string; name: string } | null>(null)

  // Fail reason Modal (แทน window.prompt)
  const [failReasonModalOpen, setFailReasonModalOpen] = useState(false)
  const [failReasonContext, setFailReasonContext] = useState<'qc' | 'reject'>('qc')
  const [failReasonSelected, setFailReasonSelected] = useState<string | null>(null)
  const [failReasonStep, setFailReasonStep] = useState<1 | 2>(1)
  const [selectedParentReason, setSelectedParentReason] = useState<SettingsReason | null>(null)

  const filteredMenus = MENUS.filter((m) => (!m.adminOnly || isAdmin) && hasAccess(QC_MENU_KEY_MAP[m.id] || m.id))

  const qcUsername = user?.username || user?.email || 'unknown'

  const totalItems = qcData.items.reduce((a, i) => a + (i.qty || 1), 0)
  const passedItems = qcData.items.filter((i) => i.status === 'pass').reduce((a, i) => a + (i.qty || 1), 0)
  const failedItems = qcData.items.filter((i) => i.status === 'fail').reduce((a, i) => a + (i.qty || 1), 0)
  const remainingItems = totalItems - passedItems - failedItems

  const qcCategoryOptions = useMemo(() => {
    const set = new Set<string>()
    qcData.items.forEach((i) => {
      const c = i.product_category?.trim() || ''
      if (c) set.add(c)
    })
    return Array.from(set).sort()
  }, [qcData.items])

  const itemsToShow = useMemo(() => {
    if (!qcCategoryFilter) return qcData.items
    return qcData.items.filter((i) => (i.product_category?.trim() || '') === qcCategoryFilter)
  }, [qcData.items, qcCategoryFilter])

  const productImageUrl = currentItem ? getPublicUrl('product-images', currentItem.product_code, productExt) : ''
  const cartoonImageUrl = currentItem ? getPublicUrl('cartoon-patterns', currentItem.cartoon_name, cartoonExt) : ''
  const rejectProductImageUrl = currentRejectItem ? getPublicUrl('product-images', currentRejectItem.product_code, '.jpg') : ''
  const rejectCartoonImageUrl = currentRejectItem ? getPublicUrl('cartoon-patterns', currentRejectItem.cartoon_name, '.jpg') : ''

  function getInkColor(inkName: string | null | undefined): string {
    if (!inkName) return '#ddd'
    const ink = inkTypes.find((i) => i.ink_name === inkName)
    return ink?.hex_code || '#ddd'
  }

  const [planStartTimes, setPlanStartTimes] = useState<Record<string, string | null>>({})

  const loadWorkOrders = useCallback(async () => {
    try {
      const list = await fetchWorkOrdersWithProgress(true)
      setWorkOrdersWithProgress(list)
      if (list.length > 0) {
        const names = list.map((w) => w.work_order_name)
        const { data: planJobs } = await supabase
          .from('plan_jobs')
          .select('name, tracks')
          .in('name', names)
        const map: Record<string, string | null> = {}
        ;(planJobs || []).forEach((pj: any) => {
          const start = pj.tracks?.QC?.['เริ่มQC']?.start ?? null
          if (start) map[pj.name] = start
        })
        setPlanStartTimes(map)
      }
    } catch (e) {
      console.error(e)
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const [r, i] = await Promise.all([fetchSettingsReasons(), fetchInkTypes()])
      setReasons(r)
      setInkTypes(i)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const loadRejectItems = useCallback(async () => {
    try {
      const data = await fetchRejectItems()
      setRejectData(data)
    } catch (e) {
      console.error(e)
    }
  }, [])

  // จำนวนรายการรอ QC (จำนวน work orders ที่ยังเหลือ)
  const qcOperationCount = workOrdersWithProgress.length
  // จำนวน reject items
  const rejectCount = rejectData.length

  // ส่งจำนวนรวมไปให้ Sidebar แสดงเรียลไทม์
  useEffect(() => {
    const total = qcOperationCount + rejectCount
    window.dispatchEvent(new CustomEvent('sidebar-qc-counts', { detail: { total, qcOperation: qcOperationCount, reject: rejectCount } }))
  }, [qcOperationCount, rejectCount])

  useEffect(() => {
    loadWorkOrders()
    loadRejectItems()
    loadSettings()
    clearSessionBackup()
    const t = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [loadWorkOrders, loadRejectItems, loadSettings])

  // Realtime: อัปเดตจำนวน QC Operation + Reject เมื่อข้อมูลเปลี่ยน
  useEffect(() => {
    const channel = supabase
      .channel('qc-page-realtime-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_records' }, () => {
        loadRejectItems()
        loadWorkOrders()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qc_sessions' }, () => {
        loadWorkOrders()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_work_orders' }, () => {
        loadWorkOrders()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadRejectItems, loadWorkOrders])

  useEffect(() => {
    if (currentView === 'reject') loadRejectItems()
  }, [currentView, loadRejectItems])

  useEffect(() => {
    if (currentView === 'report') {
      fetchReportUsers().then(setReportUsers).catch(console.error)
    }
  }, [currentView])

  useEffect(() => {
    if (currentView === 'settings') loadSettings()
  }, [currentView, loadSettings])

  useEffect(() => {
    if (qcState.step === 'working' && qcData.items.length > 0) {
      setSessionBackup(qcState, qcData)
    }
  }, [qcState.step, qcState.startTime, qcState.filename, qcState.sessionId, qcData.items])

  useEffect(() => {
    setImgErrors({ product: false, cartoon: false })
    setProductExt('.jpg')
    setCartoonExt('.jpg')
    if (currentItem) {
      setTimeout(() => {
        const el = document.getElementById('item-' + currentItem.uid)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 0)
    }
  }, [currentItem])

  useEffect(() => {
    setCheckedIds(new Set())
    if (currentItem?.product_code) {
      fetchChecklistForProduct(currentItem.product_code)
        .then(setChecklistItems)
        .catch(() => setChecklistItems([]))
    } else {
      setChecklistItems([])
    }
  }, [currentItem?.product_code])

  const allChecklistChecked = checklistItems.length === 0 || checklistItems.every((item) => checkedIds.has(item.id))

  async function handleLoadWo(woName: string) {
    if (!woName) return
    setLoading(true)
    setQcCategoryFilter('')
    try {
      const skipTrack = user?.role === 'superadmin' || user?.role === 'admin'
      if (!skipTrack) await ensurePlanDeptStart(woName)
      const items = await fetchItemsByWorkOrder(woName)
      if (items.length === 0) {
        alert('ไม่พบรายการในใบงานนี้')
        setLoading(false)
        return
      }
      saveWorkOrderName(woName)
      const filename = `WO-${woName}`
      let sessionId: string | null = null
      let startTime: Date = new Date()

      const openSession = await fetchOpenSessionForWo(woName)
      if (openSession) {
        sessionId = openSession.id
        startTime = new Date(openSession.start_time)
        const records = await fetchRecordsForSession(openSession.id)
        const recordByUid: Record<string, (typeof records)[0]> = {}
        records.forEach((r) => { recordByUid[r.item_uid] = r })
        items.forEach((it) => {
          const rec = recordByUid[it.uid]
          if (rec) {
            it.status = rec.status as 'pass' | 'fail' | 'pending'
            it.fail_reason = rec.fail_reason ?? undefined
            it.check_time = rec.created_at ? new Date(rec.created_at) : undefined
          }
        })
      } else {
        const { data: newSession, error: sessErr } = await supabase
          .from('qc_sessions')
          .insert({
            username: qcUsername,
            filename,
            start_time: startTime.toISOString(),
            end_time: null,
            total_items: 0,
            pass_count: 0,
            fail_count: 0,
          })
          .select('id')
          .single()
        if (sessErr) throw sessErr
        sessionId = newSession?.id ?? null
      }

      const { data: planJob } = await supabase
        .from('plan_jobs')
        .select('tracks')
        .eq('name', woName)
        .order('date', { ascending: false })
        .limit(1)
        .single()
      const planStart = planJob?.tracks?.QC?.['เริ่มQC']?.start
      if (planStart) startTime = new Date(planStart)

      setQcData({ items })
      setQcState({ step: 'working', startTime, filename, sessionId })
      const first = items.find((i) => i.status === 'pending') || items[0]
      setCurrentItem(first)
    } catch (e: any) {
      alert('โหลดไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  function handleSwitchJob() {
    if (qcData.items.some((i) => i.status !== 'pending')) {
      setSwitchJobConfirmOpen(true)
      return
    }
    proceedSwitchJob()
  }

  function proceedSwitchJob() {
    setQcState({ step: 'select', startTime: null, filename: '', sessionId: null })
    setQcData({ items: [] })
    setCurrentItem(null)
    setQcCategoryFilter('')
    clearSessionBackup()
    loadWorkOrders()
  }

  function handleScan() {
    const q = barcodeQuery.trim().toUpperCase()
    const found = qcData.items.find((i) => i.uid === q)
    if (found) {
      setCurrentItem(found)
      setBarcodeQuery('')
    } else if (q) {
      alert('ไม่พบ UID นี้')
    }
    barcodeInputRef.current?.focus()
  }

  function selectItem(item: QCItem) {
    setCurrentItem(item)
  }

  function navigateItem(delta: number) {
    const idx = qcData.items.indexOf(currentItem!)
    const next = qcData.items[idx + delta]
    if (next) setCurrentItem(next)
  }

  function openFailReasonModal(context: 'qc' | 'reject') {
    setFailReasonContext(context)
    setFailReasonSelected(null)
    setFailReasonStep(1)
    setSelectedParentReason(null)
    setFailReasonModalOpen(true)
  }

  function closeFailReasonModal() {
    setFailReasonModalOpen(false)
    setFailReasonSelected(null)
    setFailReasonStep(1)
    setSelectedParentReason(null)
  }

  function confirmFailReason() {
    const reason = failReasonSelected || null
    if (!reason) return
    closeFailReasonModal()
    if (failReasonContext === 'qc') {
      applyFailReasonQc(reason)
    } else {
      if (reason) applyFailReasonReject(reason)
    }
  }

  async function applyFailReasonQc(reason: string | null) {
    if (!currentItem || !qcState.sessionId) return
    const updated = { ...currentItem, status: 'fail' as const, fail_reason: reason ?? undefined, check_time: new Date() }
    try {
      await saveQcRecord(qcState.sessionId, updated, qcUsername)
    } catch (e: any) {
      alert('บันทึกไม่สำเร็จ: ' + (e?.message || e))
      return
    }
    setQcData((prev) => ({
      items: prev.items.map((i) =>
        i.uid === currentItem.uid ? { ...i, status: 'fail' as const, fail_reason: reason ?? undefined, check_time: new Date() } : i
      ),
    }))
    const nextIdx = qcData.items.indexOf(currentItem) + 1
    if (qcData.items[nextIdx]) setCurrentItem(qcData.items[nextIdx])
    setBarcodeQuery('')
  }

  async function applyFailReasonReject(reason: string) {
    if (!currentRejectItem) return
    const durationSec = Math.floor((new Date().getTime() - new Date(currentRejectItem.created_at).getTime()) / 1000)
    const updates: Partial<QCRecord> = {
      status: 'fail',
      qc_by: qcUsername,
      created_at: new Date().toISOString(),
      reject_duration: durationSec,
      fail_reason: reason,
      retry_count: Math.min((currentRejectItem.retry_count || 1) + 1, 4),
    }
    setLoading(true)
    try {
      await supabase.from('qc_records').update(updates).eq('id', currentRejectItem.id)
      const updatedList = await fetchRejectItems()
      setRejectData(updatedList)
      const next = updatedList.find((r) => r.id !== currentRejectItem.id && r.retry_count === updates.retry_count)
      const nextAny = updatedList.find((r) => r.id !== currentRejectItem.id)
      setCurrentRejectItem(next || nextAny || null)
      if (next) setActiveRejectTab((next.retry_count || 1) as 1 | 2 | 3 | 4)
      else if (nextAny) setActiveRejectTab((nextAny.retry_count || 1) as 1 | 2 | 3 | 4)
      else setActiveRejectTab('queue')
    } catch (e: any) {
      alert('อัปเดตไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function markStatus(status: 'pass' | 'fail') {
    if (isViewOnly) { alert('บัญชี superadmin/admin ไม่อนุญาตให้ทำงาน QC สามารถดูข้อมูลได้อย่างเดียว'); return }
    if (!currentItem) return
    if (status === 'pass' && !allChecklistChecked) {
      alert('กรุณาตรวจเช็คเช็คลิสให้ครบทุกหัวข้อก่อนกด ผ่าน')
      return
    }
    if (status === 'pass') {
      if (qcState.sessionId) {
        try {
          await saveQcRecord(qcState.sessionId, { ...currentItem, status: 'pass' }, qcUsername)
        } catch (e: any) {
          alert('บันทึกไม่สำเร็จ: ' + (e?.message || e))
          return
        }
      }
      setQcData((prev) => ({
        items: prev.items.map((i) =>
          i.uid === currentItem.uid ? { ...i, status: 'pass', check_time: new Date() } : i
        ),
      }))
      const nextIdx = qcData.items.indexOf(currentItem) + 1
      if (qcData.items[nextIdx]) setCurrentItem(qcData.items[nextIdx])
      setBarcodeQuery('')
    } else {
      openFailReasonModal('qc')
    }
  }

  async function finishSession() {
    if (isViewOnly) { alert('บัญชี superadmin/admin ไม่อนุญาตให้ทำงาน QC สามารถดูข้อมูลได้อย่างเดียว'); return }
    if (!qcState.sessionId) {
      alert('ไม่พบ session')
      return
    }
    setLoading(true)
    try {
      const endTime = new Date()
      const durationSeconds = (endTime.getTime() - (qcState.startTime?.getTime() || endTime.getTime())) / 1000
      const kpi = totalItems > 0 ? durationSeconds / totalItems : 0
      const { error: updateErr } = await supabase
        .from('qc_sessions')
        .update({
          end_time: endTime.toISOString(),
          total_items: totalItems,
          pass_count: passedItems,
          fail_count: failedItems,
          kpi_score: kpi,
        })
        .eq('id', qcState.sessionId)
      if (updateErr) throw updateErr
      if (totalItems > 0 && passedItems === totalItems && failedItems === 0) {
        const woName = qcState.filename?.startsWith('WO-') ? qcState.filename.slice(3) : ''
        if (woName) {
          await ensurePlanDeptEnd(woName)
        }
      }
      clearSessionBackup()
      setQcState({ step: 'select', startTime: null, filename: '', sessionId: null })
      setQcData({ items: [] })
      setCurrentItem(null)
      setQcCategoryFilter('')
      loadRejectItems()
      loadWorkOrders()
    } catch (e: any) {
      alert('บันทึกไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmFinishSession() {
    setFinishConfirmOpen(false)
    await finishSession()
  }

  const filteredRejectItems =
    activeRejectTab === 'queue'
      ? []
      : rejectData.filter((i) => i.retry_count === activeRejectTab).filter((i) => !rejectSearchQuery.trim() || i.item_uid.toUpperCase().includes(rejectSearchQuery.trim().toUpperCase()))

  const sortedRejectQueue = [...rejectData].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  function getRejectDuration(createdAt: string) {
    return formatDuration(Math.floor((currentTime.getTime() - new Date(createdAt).getTime()) / 1000))
  }

  function handleRejectScan() {
    const q = rejectSearchQuery.trim().toUpperCase()
    const found = rejectData.find((i) => i.item_uid === q)
    if (found) {
      setActiveRejectTab((found.retry_count || 1) as 1 | 2 | 3 | 4)
      setCurrentRejectItem(found)
      setRejectSearchQuery('')
    } else if (q) alert('ไม่พบใน Reject')
  }

  function navigateRejectItem(delta: number) {
    if (filteredRejectItems.length === 0) return
    const idx = filteredRejectItems.indexOf(currentRejectItem!)
    const next = filteredRejectItems[idx + delta]
    if (next) setCurrentRejectItem(next)
  }

  async function markRejectStatus(status: 'pass' | 'fail') {
    if (!currentRejectItem) return
    if (status === 'pass') {
      const durationSec = Math.floor((new Date().getTime() - new Date(currentRejectItem.created_at).getTime()) / 1000)
      const updates: Partial<QCRecord> = {
        status: 'pass',
        is_rejected: false,
        qc_by: qcUsername,
        created_at: new Date().toISOString(),
        reject_duration: durationSec,
      }
      setLoading(true)
      try {
        await supabase.from('qc_records').update(updates).eq('id', currentRejectItem.id)

        // Sync สถานะกลับไปที่ qcData.items เพื่อให้ QC Operation แสดงผลถูกต้อง
        setQcData((prev) => ({
          ...prev,
          items: prev.items.map((i) =>
            i.uid === currentRejectItem.item_uid
              ? { ...i, status: 'pass' as const, fail_reason: undefined, check_time: new Date() }
              : i
          ),
        }))

        const updatedList = await fetchRejectItems()
        setRejectData(updatedList)
        const next = updatedList.find((r) => r.id !== currentRejectItem.id && r.retry_count === (currentRejectItem.retry_count || 1))
        const nextAny = updatedList.find((r) => r.id !== currentRejectItem.id)
        setCurrentRejectItem(next || nextAny || null)
        if (next) setActiveRejectTab((next.retry_count || 1) as 1 | 2 | 3 | 4)
        else if (nextAny) setActiveRejectTab((nextAny.retry_count || 1) as 1 | 2 | 3 | 4)
        else setActiveRejectTab('queue')
      } catch (e: any) {
        alert('อัปเดตไม่สำเร็จ: ' + (e?.message || e))
      } finally {
        setLoading(false)
      }
    } else {
      openFailReasonModal('reject')
    }
  }

  async function loadReports() {
    setLoading(true)
    try {
      const data = await fetchReports(reportFilter)
      setReports(data)
    } catch (e: any) {
      alert('โหลดรายงานไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function showSessionDetails(session: QCSession) {
    setLoading(true)
    try {
      const data = await fetchSessionRecords(session.id)
      setSessionItems(data)
      setShowSessionModal(true)
    } catch (e: any) {
      alert('โหลดไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function downloadReportCsv(session: QCSession) {
    setLoading(true)
    try {
      const data = await fetchSessionRecords(session.id)
      if (!data.length) {
        alert('ไม่มีรายการ')
        return
      }
      const rows = data.map((r) => ({
        Date: new Date(r.created_at).toLocaleDateString('th-TH'),
        Time: new Date(r.created_at).toLocaleTimeString('th-TH'),
        Reject_Duration: r.reject_duration ? formatDuration(r.reject_duration) : '0s',
        Item_UID: r.item_uid,
        Status: r.status,
        Retry: r.retry_count || 1,
        Fail_Reason: r.fail_reason || '-',
        QC_By: r.qc_by,
        product_name: r.product_name || '-',
        product_code: r.product_code || '-',
        Bill_No: r.bill_no || '-',
        cartoon_name: r.cartoon_name || '-',
        ink_color: r.ink_color || '-',
        font: r.font || '-',
        floor: r.floor || '-',
        line1: r.line1 || '-',
        line2: r.line2 || '-',
        line3: r.line3 || '-',
        remark: r.remark || '-',
      }))
      const csv = '\uFEFF' + Papa.unparse(rows)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `Report_${session.filename}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (e: any) {
      alert('ดาวน์โหลดไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function searchHistory() {
    if (!historySearch.trim()) return
    setLoading(true)
    setHistorySearched(true)
    setCurrentHistoryRecord(null)
    try {
      const data = await searchHistoryByUid(historySearch.trim())
      setHistoryResults(data)
      if (data.length > 0) setCurrentHistoryRecord(data[0])
      if (data.length === 0) alert('ไม่พบประวัติการตรวจสำหรับ UID นี้')
    } catch (e: any) {
      alert('ค้นหาไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  async function handleAddReason() {
    if (!newReason.trim()) return
    try {
      await addReason(newReason.trim(), newReasonType)
      setNewReason('')
      setNewReasonType('Man')
      await loadSettings()
    } catch (e: any) {
      alert('เพิ่มไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleAddSubReason(parentId: string, parentFailType: string) {
    if (!newSubReason.trim()) return
    try {
      await addSubReason(parentId, newSubReason.trim(), parentFailType)
      setNewSubReason('')
      setAddSubReasonParentId(null)
      await loadSettings()
    } catch (e: any) {
      alert('เพิ่มหัวข้อย่อยไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  function handleDeleteReason(id: string, name?: string) {
    setDeleteReasonTarget({ id, name: name || '' })
    setDeleteReasonModalOpen(true)
  }

  async function confirmDeleteReason() {
    if (!deleteReasonTarget) return
    try {
      await deleteReason(deleteReasonTarget.id)
      await loadSettings()
    } catch (e: any) {
      alert('ลบไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setDeleteReasonModalOpen(false)
      setDeleteReasonTarget(null)
    }
  }

  async function handleUpdateReasonType(id: string, failType: 'Man' | 'Machine' | 'Material' | 'Method') {
    try {
      await updateReasonType(id, failType)
      await loadSettings()
    } catch (e: any) {
      alert('อัปเดตไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleUpdateInkHex(id: number, hexCode: string) {
    try {
      await updateInkHex(id, hexCode)
      await loadSettings()
    } catch (e: any) {
      alert('อัปเดตไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleSkipQcConfirm() {
    const woName = skipQcConfirmWo
    setSkipQcConfirmWo(null)
    if (!woName) return
    setSkipQcLoading(woName)
    try {
      const items = await fetchItemsByWorkOrder(woName)
      if (items.length === 0) { alert('ไม่พบรายการ'); return }

      const now = new Date()
      const filename = `WO-${woName}`

      // สร้าง session ที่จบแล้ว
      const { data: session, error: sessErr } = await supabase
        .from('qc_sessions')
        .insert({
          username: qcUsername,
          filename,
          start_time: now.toISOString(),
          end_time: now.toISOString(),
          total_items: items.length,
          pass_count: items.length,
          fail_count: 0,
          kpi_score: 0,
        })
        .select('id')
        .single()
      if (sessErr) throw sessErr

      // บันทึก QC records ทุกรายการเป็น pass
      const records = items.map((item) => ({
        session_id: session.id,
        item_uid: item.uid,
        status: 'pass',
        qc_by: qcUsername,
        product_name: item.product_name,
        product_code: item.product_code,
        bill_no: item.bill_no,
        cartoon_name: item.cartoon_name,
        ink_color: item.ink_color,
        font: item.font,
        floor: item.floor,
        line1: item.line1,
        line2: item.line2,
        line3: item.line3,
        qty: item.qty,
        remark: 'ข้ามการ QC',
      }))
      const { error: recErr } = await supabase.from('qc_records').insert(records)
      if (recErr) throw recErr

      // ปิด session ที่ยังค้างของใบงานนี้ทั้งหมด เพื่อไม่ให้ยังโชว์ใน QC Operation
      await supabase
        .from('qc_sessions')
        .update({ end_time: now.toISOString() })
        .eq('filename', filename)
        .is('end_time', null)

      // อัปเดต plan — superadmin/admin ไม่บันทึกเวลาเริ่ม
      const skipTrackEnd = user?.role === 'superadmin' || user?.role === 'admin'
      if (!skipTrackEnd) await ensurePlanDeptStart(woName)
      await ensurePlanDeptEnd(woName)

      // บันทึก log
      await supabase.from('qc_skip_logs').insert({
        work_order_name: woName,
        skipped_by: qcUsername,
        total_items: items.length,
        item_details: items.map((i) => ({
          uid: i.uid,
          product_name: i.product_name,
          product_code: i.product_code,
          bill_no: i.bill_no,
          ink_color: i.ink_color,
          qty: i.qty,
        })),
      })

      // เอารายการใบงานออกจากหน้าให้ทันทีหลังข้าม QC สำเร็จ
      setWorkOrdersWithProgress((prev) => prev.filter((wo) => wo.work_order_name !== woName))
      await loadWorkOrders()
      loadRejectItems()
    } catch (e: any) {
      alert('เกิดข้อผิดพลาด: ' + (e?.message || e))
    } finally {
      setSkipQcLoading(null)
    }
  }

  async function loadSkipLogs() {
    try {
      const { data, error } = await supabase
        .from('qc_skip_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      setSkipLogs(data || [])
    } catch (e) {
      console.error('Error loading skip logs:', e)
    }
  }

  // --- Checklist Settings handlers ---
  async function loadChecklistTopics() {
    try {
      const data = await fetchChecklistTopics()
      setClTopics(data)
    } catch (e: any) {
      console.error('loadChecklistTopics error:', e)
    }
  }

  async function handleCreateTopic() {
    const name = clNewTopicName.trim()
    if (!name) return
    try {
      await createChecklistTopic(name)
      setClNewTopicName('')
      await loadChecklistTopics()
    } catch (e: any) {
      alert('เพิ่มหัวข้อไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleDeleteTopic(id: string) {
    if (!confirm('ลบหัวข้อนี้ รวมถึงหัวข้อย่อยและสินค้าที่เชื่อม?')) return
    try {
      await deleteChecklistTopic(id)
      if (clSelectedTopic?.id === id) { setClSelectedTopic(null); setClItems([]); setClProducts([]) }
      await loadChecklistTopics()
    } catch (e: any) {
      alert('ลบไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleSaveEditTopic() {
    if (!clEditTopicId || !clEditTopicName.trim()) return
    try {
      await updateChecklistTopic(clEditTopicId, clEditTopicName.trim())
      setClEditTopicId(null)
      setClEditTopicName('')
      await loadChecklistTopics()
      if (clSelectedTopic?.id === clEditTopicId) {
        setClSelectedTopic((prev) => prev ? { ...prev, name: clEditTopicName.trim() } : null)
      }
    } catch (e: any) {
      alert('แก้ไขไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleSelectTopic(topic: QCChecklistTopic) {
    setClSelectedTopic(topic)
    try {
      const [items, products] = await Promise.all([
        fetchChecklistItems(topic.id),
        fetchChecklistTopicProducts(topic.id),
      ])
      setClItems(items)
      setClProducts(products)
    } catch (e: any) {
      console.error('loadTopicDetail error:', e)
    }
  }

  async function handleAddChecklistItem() {
    if (!clSelectedTopic || !clNewItemTitle.trim()) return
    setClUploading(true)
    try {
      let fileUrl: string | null = null
      let fileType: 'image' | 'pdf' | null = null
      if (clNewItemFile) {
        fileUrl = await uploadChecklistFile(clNewItemFile)
        fileType = clNewItemFile.type === 'application/pdf' ? 'pdf' : 'image'
      }
      await createChecklistItem(clSelectedTopic.id, clNewItemTitle.trim(), fileUrl, fileType)
      setClNewItemTitle('')
      setClNewItemFile(null)
      const items = await fetchChecklistItems(clSelectedTopic.id)
      setClItems(items)
      await loadChecklistTopics()
    } catch (e: any) {
      alert('เพิ่มหัวข้อย่อยไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setClUploading(false)
    }
  }

  async function handleDeleteChecklistItem(id: string) {
    if (!clSelectedTopic) return
    try {
      await deleteChecklistItem(id)
      const items = await fetchChecklistItems(clSelectedTopic.id)
      setClItems(items)
      await loadChecklistTopics()
    } catch (e: any) {
      alert('ลบไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleSearchProducts() {
    const q = clProductSearch.trim()
    if (!q) { setClProductResults([]); return }
    try {
      const results = await searchProducts(q)
      setClProductResults(results)
    } catch (e: any) {
      console.error('searchProducts error:', e)
    }
  }

  async function handleAddProduct(product: { product_code: string; product_name: string }) {
    if (!clSelectedTopic) return
    try {
      await addChecklistTopicProduct(clSelectedTopic.id, product.product_code, product.product_name)
      const products = await fetchChecklistTopicProducts(clSelectedTopic.id)
      setClProducts(products)
      await loadChecklistTopics()
    } catch (e: any) {
      if (e?.message?.includes('duplicate') || e?.code === '23505') {
        alert('สินค้านี้มีอยู่ในหัวข้อนี้แล้ว')
      } else {
        alert('เพิ่มสินค้าไม่สำเร็จ: ' + (e?.message || e))
      }
    }
  }

  async function handleRemoveProduct(id: string) {
    if (!clSelectedTopic) return
    try {
      await removeChecklistTopicProduct(id)
      const products = await fetchChecklistTopicProducts(clSelectedTopic.id)
      setClProducts(products)
      await loadChecklistTopics()
    } catch (e: any) {
      alert('ลบสินค้าไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleImportExcel(file: File) {
    setClImporting(true)
    setClImportResult(null)
    try {
      const result = await importChecklistFromExcel(file)
      setClImportResult(result)
      await loadChecklistTopics()
    } catch (e: any) {
      alert('นำเข้าไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setClImporting(false)
    }
  }

  function navigateItemInList(delta: number) {
    if (!currentItem || itemsToShow.length === 0) return
    const idx = itemsToShow.indexOf(currentItem)
    const nextIdx = idx === -1 ? 0 : idx + delta
    const next = itemsToShow[nextIdx]
    if (next) setCurrentItem(next)
  }

  function handleKeydown(e: React.KeyboardEvent) {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
    if (currentView === 'qc' && qcState.step === 'working') {
      if (e.key === 'ArrowLeft') navigateItem(-1)
      if (e.key === 'ArrowRight') navigateItem(1)
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateItemInList(-1) }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateItemInList(1) }
    }
    if (currentView === 'reject' && currentRejectItem && activeRejectTab !== 'queue') {
      if (e.key === 'ArrowLeft') navigateRejectItem(-1)
      if (e.key === 'ArrowRight') navigateRejectItem(1)
    }
  }

  return (
    <div className="w-full flex-1 min-h-0 flex flex-col outline-none" onKeyDown={handleKeydown} tabIndex={0}>
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="shrink-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full flex items-center gap-4">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3 flex-1" aria-label="Tabs">
            {filteredMenus.map((m) => (
              <button
                key={m.id}
                onClick={() => setCurrentView(m.id)}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                  currentView === m.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'
                }`}
              >
                {m.label}
                {m.id === 'qc' && qcOperationCount > 0 && (
                  <span className="ml-1.5 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded-full">{qcOperationCount}</span>
                )}
                {m.id === 'reject' && rejectCount > 0 && (
                  <span className="ml-1.5 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{rejectCount}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="pt-4 flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden overflow-hidden">
        {/* QC Operation */}
        {currentView === 'qc' && (
          <div className={qcState.step === 'working' ? 'flex flex-col flex-1 min-h-0' : 'space-y-4'}>
            {qcState.step === 'select' && (
              workOrdersWithProgress.length === 0 ? (
                <div className="text-center py-12 text-gray-500">ไม่มีใบงานที่ยังมีรายการรอ QC ในขณะนี้</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {workOrdersWithProgress.map((wo) => {
                    const isAllDone = wo.remaining === 0
                    const hasProgress = wo.pass_items > 0 || wo.fail_items > 0

                    let cardClass = ''
                    let borderLeftColor = ''
                    if (isAllDone) {
                      cardClass = 'bg-emerald-50/80 border-emerald-200 hover:bg-emerald-100 hover:shadow-md'
                      borderLeftColor = 'border-l-emerald-500'
                    } else if (hasProgress) {
                      cardClass = 'bg-blue-50/80 border-blue-200 hover:bg-blue-100 hover:shadow-md'
                      borderLeftColor = 'border-l-blue-500'
                    } else {
                      cardClass = 'bg-white border-gray-200 hover:bg-gray-50 hover:shadow-md'
                      borderLeftColor = 'border-l-gray-400'
                    }

                    return (
                      <button
                        key={wo.id}
                        className={`p-4 border border-l-4 rounded-xl text-left transition-all duration-200 shadow-sm ${cardClass} ${borderLeftColor}`}
                        onClick={() => handleLoadWo(wo.work_order_name)}
                        disabled={loading || skipQcLoading === wo.work_order_name}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-lg font-bold flex items-center gap-2 flex-wrap">
                              <span className="truncate">{wo.work_order_name}</span>
                              {hasProgress && !isAllDone && (
                                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-blue-500 text-white shadow-sm">
                                  🔄 กำลัง QC
                                </span>
                              )}
                              {isAllDone && (
                                <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-emerald-500 text-white shadow-sm">
                                  ✓ QC ครบ
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                              <span className="text-blue-600 font-medium">คงเหลือ {wo.remaining}</span>
                              <span className="text-gray-400">/</span>
                              <span className="text-gray-600">ทั้งหมด {wo.total_items} ({wo.total_bills} บิล)</span>
                              <span className="text-green-600 font-medium">Pass {wo.pass_items}</span>
                              <span className="text-red-500 font-medium">Fail {wo.fail_items}</span>
                              {planStartTimes[wo.work_order_name] && (
                                <span className="text-indigo-600 font-medium">
                                  ⏱ เริ่ม {new Date(planStartTimes[wo.work_order_name]!).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <span className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold shadow-sm hover:bg-blue-700 transition-colors">
                              {loading ? 'กำลังโหลด...' : 'โหลดรายการ'}
                            </span>
                            {canSkipQc && (
                              <span
                                role="button"
                                onClick={(e) => { e.stopPropagation(); setSkipQcConfirmWo(wo.work_order_name) }}
                                className="px-3 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold shadow-sm hover:bg-amber-600 transition-colors"
                              >
                                {skipQcLoading === wo.work_order_name ? 'กำลังข้าม...' : 'ไม่ต้อง QC'}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            )}

            {qcState.step === 'working' && (
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                <div className="shrink-0 bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex gap-8">
                    <div className="text-center">
                      <div className="text-xs text-gray-500 uppercase">Total</div>
                      <div className="text-2xl font-bold">{totalItems}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs text-green-600 uppercase">Pass</div>
                      <div className="text-2xl font-bold text-green-600">{passedItems}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs text-red-600 uppercase">Fail</div>
                      <div className="text-2xl font-bold text-red-600">{failedItems}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-xs text-blue-600 uppercase">Left</div>
                      <div className="text-2xl font-bold text-blue-600">{remainingItems}</div>
                    </div>
                  </div>
                  {qcState.startTime && !isViewOnly && (
                    <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-2">
                      <span className="text-sm text-indigo-500 font-medium">⏱ เวลาเริ่ม:</span>
                      <span className="text-lg font-bold text-indigo-700">
                        {qcState.startTime.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  )}
                  <div className="flex gap-2 items-center">
                    <input
                      ref={barcodeInputRef}
                      type="text"
                      value={barcodeQuery}
                      onChange={(e) => setBarcodeQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                      placeholder="สแกน UID"
                      className="border rounded-lg px-3 py-1.5 w-48 uppercase"
                    />
                    <button onClick={handleScan} className="px-4 py-1.5 bg-gray-100 rounded-lg hover:bg-gray-200">
                      ค้นหา
                    </button>
                    {remainingItems === 0 && passedItems === totalItems && totalItems > 0 && !isViewOnly && (
                      <button onClick={() => setFinishConfirmOpen(true)} className="px-6 py-1.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-bold">
                        FINISH JOB
                      </button>
                    )}
                    {remainingItems === 0 && failedItems > 0 && (
                      <span className="text-sm text-red-500 font-medium bg-red-50 px-3 py-1.5 rounded-lg">
                        มีรายการไม่ผ่าน {failedItems} รายการ — ต้อง Pass ทุกรายการจึงจะจบงานได้
                      </span>
                    )}
                    <button onClick={handleSwitchJob} className="px-4 py-1.5 border border-blue-500 text-blue-600 rounded-lg hover:bg-blue-50">
                      สลับใบงาน
                    </button>
                  </div>
                </div>

                <div className="flex gap-4 flex-1 min-h-0 mt-4 min-w-0 overflow-hidden">
                  <div className="w-56 shrink-0 bg-white rounded-xl shadow-sm border flex flex-col overflow-hidden min-w-0 sm:w-64">
                    <div className="p-2 border-b space-y-2">
                      <div className="text-xs font-bold text-gray-600 uppercase">รายการ</div>
                      {qcCategoryOptions.length > 0 && (
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-gray-500 whitespace-nowrap">หมวดหมู่สินค้า</label>
                          <select
                            value={qcCategoryFilter}
                            onChange={(e) => setQcCategoryFilter(e.target.value)}
                            className="flex-1 min-w-0 rounded border border-gray-200 px-2 py-1 text-xs"
                          >
                            <option value="">ทั้งหมด</option>
                            {qcCategoryOptions.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto p-1 space-y-1">
                      {itemsToShow.map((item, index) => (
                        <div
                          key={item.uid}
                          id={'item-' + item.uid}
                          onClick={() => selectItem(item)}
                          className={`p-2 rounded border cursor-pointer flex justify-between items-center text-xs ${
                            item === currentItem ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-100 hover:bg-gray-50'
                          }`}
                        >
                          <div className="truncate min-w-0">
                            <span className="text-gray-400 font-bold">{index + 1}. </span>
                            <span className="font-medium uppercase">{item.uid}</span>
                            <br />
                            <span className="text-gray-500 text-[10px]">{item.product_name}</span>
                          </div>
                          {item.status === 'pass' && <span className="text-green-500 shrink-0">✓</span>}
                          {item.status === 'fail' && <span className="text-red-500 shrink-0">✗</span>}
                          {item.status === 'pending' && <span className="text-gray-300 shrink-0">○</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 min-w-[180px] max-w-[380px] flex flex-col gap-2 min-h-0 overflow-hidden">
                    <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                      {currentItem && !imgErrors.product && currentItem.product_code !== '0' ? (
                        <a
                          href={productImageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full h-full flex items-center justify-center cursor-pointer"
                          title="คลิกเปิดรูปในแท็บใหม่"
                        >
                          <img
                            src={productImageUrl}
                            alt="Product"
                            className="w-full h-full object-contain p-2"
                            onError={() => setImgErrors((e) => ({ ...e, product: true }))}
                          />
                        </a>
                      ) : (
                        <div className="text-gray-400 text-sm">No Image (Product: {currentItem?.product_code || '-'})</div>
                      )}
                    </div>
                    <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                      {currentItem && !imgErrors.cartoon && currentItem.cartoon_name !== '0' ? (
                        <a
                          href={cartoonImageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full h-full flex items-center justify-center cursor-pointer"
                          title="คลิกเปิดรูปลายการ์ตูนในแท็บใหม่"
                        >
                          <img
                            src={cartoonImageUrl}
                            alt="Pattern"
                            className="w-full h-full object-contain p-2"
                            onError={() => setImgErrors((e) => ({ ...e, cartoon: true }))}
                          />
                        </a>
                      ) : (
                        <div className="text-gray-400 text-sm">No Pattern ({currentItem?.cartoon_name || '-'})</div>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 bg-white rounded-xl shadow-sm border flex flex-col min-w-0 min-h-0 basis-0 overflow-hidden">
                    {currentItem ? (
                      <>
                        <div className="flex-1 min-h-0 overflow-auto p-4">
                          <div className="border-b pb-3 mb-3 flex justify-between items-start">
                          <div>
                            <h2 className="text-xl font-bold text-gray-800 uppercase">{currentItem.product_name}</h2>
                            <p className="text-xs text-gray-500">เลขบิล: {currentItem.bill_no}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-gray-400 uppercase">UID</div>
                            <div className="text-xl font-bold text-blue-600 uppercase">{currentItem.uid}</div>
                          </div>
                        </div>
                        {(currentItem.line1 || currentItem.line2 || currentItem.line3) && (
                        <div className="bg-gray-50 p-4 rounded-lg border mb-4">
                          <div className="text-xs text-gray-400 font-semibold mb-2">ข้อความ</div>
                          {currentItem.line1 && (
                            <div className="text-xl font-bold text-gray-800 border-b border-gray-200 pb-2 flex items-baseline gap-2">
                              <span className="text-xs text-gray-400 font-normal shrink-0">บรรทัด1</span>
                              <span>{currentItem.line1}</span>
                            </div>
                          )}
                          {currentItem.line2 && (
                            <div className="text-xl font-bold text-gray-800 border-b border-gray-200 pb-2 pt-2 flex items-baseline gap-2">
                              <span className="text-xs text-gray-400 font-normal shrink-0">บรรทัด2</span>
                              <span>{currentItem.line2}</span>
                            </div>
                          )}
                          {currentItem.line3 && (
                            <div className="text-xl font-bold text-gray-800 pt-2 flex items-baseline gap-2">
                              <span className="text-xs text-gray-400 font-normal shrink-0">บรรทัด3</span>
                              <span>{currentItem.line3}</span>
                            </div>
                          )}
                        </div>
                        )}
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400">สีหมึก</div>
                            <div className="flex items-center gap-2">
                              <span className="w-8 h-8 rounded-full border shrink-0" style={{ backgroundColor: getInkColor(currentItem.ink_color) }} />
                              <span className="font-bold truncate flex-1">{currentItem.ink_color || '-'}</span>
                              {currentItem.ink_color && currentItem.ink_color.includes('กระดาษ') && (
                                <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24" fill="none">
                                  <path d="M5.625 1.5H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" fill="#DBEAFE" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M10.5 2.25H8.25m2.25 0v1.5a3.375 3.375 0 0 0 3.375 3.375h1.5A1.125 1.125 0 0 0 16.5 6V4.5" fill="#93C5FD" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M8.25 13.5h7.5M8.25 16.5H12" stroke="#3B82F6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                              {currentItem.ink_color && currentItem.ink_color.includes('ผ้า') && (
                                <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24" fill="none">
                                  <path d="M6.75 3 3 5.25v3h3l.75 1.5v8.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V9.75L18 8.25h3V5.25L17.25 3h-3a2.25 2.25 0 0 1-4.5 0h-3Z" fill="#FDE68A" stroke="#F59E0B" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                              {currentItem.ink_color && currentItem.ink_color.includes('พลาสติก') && (
                                <svg className="w-6 h-6 shrink-0" viewBox="0 0 24 24" fill="none">
                                  <path d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5m4.75-11.396c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082" fill="#D1FAE5" stroke="#10B981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                  <path d="M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" fill="#A7F3D0" stroke="#10B981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400">ฟอนต์</div>
                            <div className="font-bold">{currentItem.font || '-'}</div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400">จำนวน</div>
                            <div className="text-2xl font-bold">{currentItem.qty || 1} pcs</div>
                          </div>
                        </div>
                        {currentItem.file_attachment && currentItem.file_attachment.trim() !== '' && (
                          <div className="bg-white p-2 rounded border mb-4">
                            <div className="text-xs text-gray-400 mb-1">ไฟล์แนบ</div>
                            <a
                              href={currentItem.file_attachment.startsWith('http') ? currentItem.file_attachment : `https://${currentItem.file_attachment}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 font-medium text-sm"
                            >
                              <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                              เปิดไฟล์แนบ
                            </a>
                          </div>
                        )}
                        {currentItem.remark && (
                          <div className="mb-2 text-sm">
                            <span className="text-gray-500">Remark: </span>
                            <span className="font-medium">{currentItem.remark}</span>
                          </div>
                        )}
                        </div>
                        <div className="shrink-0 p-4 pt-2 border-t bg-gray-50/50 space-y-2">
                          {isViewOnly ? (
                            <div className="text-center py-3 text-sm text-gray-500 bg-gray-100 rounded-xl">
                              โหมดดูอย่างเดียว (superadmin/admin ไม่สามารถทำ QC ได้)
                            </div>
                          ) : (
                          <div className="flex gap-4">
                            <button
                              onClick={() => markStatus('fail')}
                              className="flex-1 py-3 bg-red-500 text-white rounded-xl font-bold hover:bg-red-600"
                            >
                              ไม่ผ่าน
                            </button>
                            <button
                              onClick={() => markStatus('pass')}
                              disabled={!allChecklistChecked}
                              title={!allChecklistChecked ? 'กรุณาตรวจเช็คเช็คลิสให้ครบทุกหัวข้อก่อน' : ''}
                              className={`flex-1 py-3 rounded-xl font-bold ${
                                allChecklistChecked
                                  ? 'bg-green-500 text-white hover:bg-green-600'
                                  : 'bg-green-300 text-white cursor-not-allowed opacity-60'
                              }`}
                            >
                              ผ่าน
                            </button>
                          </div>
                          )}
                          <div className="flex gap-4">
                            <button onClick={() => navigateItem(-1)} className="flex-1 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold">
                              ก่อนหน้า
                            </button>
                            <button onClick={() => navigateItem(1)} className="flex-1 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold">
                              ถัดไป
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                        <p className="text-lg">สแกน Barcode เพื่อเริ่ม</p>
                      </div>
                    )}
                  </div>

                  {/* Checklist Card (4th column) */}
                  <div className="w-72 shrink-0 bg-white rounded-xl shadow-sm border flex flex-col min-h-0 overflow-hidden">
                    <div className="p-3 border-b bg-green-50">
                      <h3 className="font-bold text-green-800 text-sm flex items-center gap-2">
                        <i className="fas fa-clipboard-check"></i>
                        เช็คลิส หัวข้อการตรวจเช็ค
                      </h3>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                      {!currentItem ? (
                        <div className="py-8 text-center text-gray-400 text-sm">เลือกรายการเพื่อดูเช็คลิส</div>
                      ) : checklistItems.length === 0 ? (
                        <div className="py-8 text-center text-gray-400 text-sm">ไม่มีรายการเช็คลิสสำหรับสินค้านี้</div>
                      ) : (
                        (() => {
                          const grouped: Record<string, (QCChecklistItem & { topic_name: string })[]> = {}
                          checklistItems.forEach((item) => {
                            if (!grouped[item.topic_name]) grouped[item.topic_name] = []
                            grouped[item.topic_name].push(item)
                          })
                          return Object.entries(grouped).map(([topicName, items]) => (
                            <div key={topicName} className="mb-2">
                              <div className="text-xs font-bold text-gray-500 uppercase px-1 py-1 border-b border-gray-100">{topicName}</div>
                              {items.map((item) => (
                                <label
                                  key={item.id}
                                  className={`flex items-center gap-2 px-2 py-2 rounded cursor-pointer hover:bg-gray-50 ${
                                    checkedIds.has(item.id) ? 'bg-green-50' : ''
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checkedIds.has(item.id)}
                                    onChange={() => {
                                      setCheckedIds((prev) => {
                                        const next = new Set(prev)
                                        if (next.has(item.id)) next.delete(item.id)
                                        else next.add(item.id)
                                        return next
                                      })
                                    }}
                                    disabled={isViewOnly}
                                    className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500 shrink-0"
                                  />
                                  <span className={`flex-1 text-sm ${checkedIds.has(item.id) ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                                    {item.title}
                                  </span>
                                  {item.file_url && (
                                    <a
                                      href={item.file_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center hover:bg-blue-200"
                                      title="ดูคู่มือตรวจ QC"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <i className="fas fa-info text-[10px]"></i>
                                    </a>
                                  )}
                                </label>
                              ))}
                            </div>
                          ))
                        })()
                      )}
                    </div>
                    {checklistItems.length > 0 && !isViewOnly && (
                      <div className="shrink-0 p-2 border-t bg-gray-50">
                        <button
                          onClick={() => {
                            if (checkedIds.size === checklistItems.length) {
                              setCheckedIds(new Set())
                            } else {
                              setCheckedIds(new Set(checklistItems.map((i) => i.id)))
                            }
                          }}
                          className={`w-full py-2 rounded-lg font-bold text-sm ${
                            checkedIds.size === checklistItems.length
                              ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                              : 'bg-green-500 text-white hover:bg-green-600'
                          }`}
                        >
                          {checkedIds.size === checklistItems.length ? 'ยกเลิกทั้งหมด' : 'ผ่านทั้งหมด'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reject */}
        {currentView === 'reject' && (
          <div className={activeRejectTab === 'queue' ? 'space-y-4' : 'flex flex-col flex-1 min-h-0 overflow-hidden'}>
            <div className="shrink-0 bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex gap-2 flex-wrap">
                <span className="bg-red-50 px-4 py-2 rounded-lg border border-red-100 text-red-600 font-bold">
                  Reject Pending: {rejectData.length}
                </span>
                {(['queue', 1, 2, 3, 4] as const).map((tab) => (
                  <button
                    key={String(tab)}
                    onClick={() => setActiveRejectTab(tab)}
                    className={`px-4 py-2 rounded-lg font-bold text-sm ${
                      activeRejectTab === tab ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {tab === 'queue' ? 'QUEUE' : `REJECT ${tab}`}
                    {tab !== 'queue' && (
                      <span className="ml-1 opacity-80">({rejectData.filter((i) => i.retry_count === tab).length})</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={rejectSearchQuery}
                  onChange={(e) => setRejectSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRejectScan()}
                  placeholder="สแกนหรือพิมพ์ UID"
                  className="border-2 border-blue-400 rounded-full pl-4 pr-4 py-2 w-64 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                />
                <button onClick={handleRejectScan} className="px-4 py-2 bg-blue-600 text-white rounded-full font-bold hover:bg-blue-700">
                  Search
                </button>
                <button onClick={() => setRejectSearchQuery('')} className="px-4 py-2 bg-gray-200 rounded-full font-bold">
                  Clear
                </button>
              </div>
            </div>

            {activeRejectTab === 'queue' ? (
              <div className="bg-white rounded-xl shadow-sm overflow-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-xs sticky top-0">
                    <tr>
                      <th className="px-3 py-3">#</th>
                      <th className="px-3 py-3">User</th>
                      <th className="px-3 py-3">Product / Bill / UID</th>
                      <th className="px-3 py-3">Text (1/2/3)</th>
                      <th className="px-3 py-3">Ink/Font/Floor</th>
                      <th className="px-3 py-3">Fail Reason</th>
                      <th className="px-3 py-3 text-center">RETRY</th>
                      <th className="px-3 py-3 text-center">Reject Time</th>
                      <th className="px-3 py-3 text-right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRejectQueue.map((item, idx) => (
                      <tr
                        key={item.id}
                        onClick={() => {
                          setActiveRejectTab((item.retry_count || 1) as 1 | 2 | 3 | 4)
                          setCurrentRejectItem(item)
                        }}
                        className="border-b hover:bg-blue-50 cursor-pointer"
                      >
                        <td className="px-3 py-3 font-bold text-gray-400">{idx + 1}</td>
                        <td className="px-3 py-3 font-bold text-blue-600">{item.qc_by}</td>
                        <td className="px-3 py-3">
                          <div className="font-bold">{item.product_name || '-'}</div>
                          <div className="text-gray-500 text-xs">Bill: {item.bill_no || '-'}</div>
                          <div className="text-blue-600 font-mono text-xs">{item.item_uid}</div>
                        </td>
                        <td className="px-3 py-3 text-xs">
                          {item.line1 && <div>1: {item.line1}</div>}
                          {item.line2 && <div>2: {item.line2}</div>}
                          {item.line3 && <div>3: {item.line3}</div>}
                        </td>
                        <td className="px-3 py-3 text-xs">
                          Ink: {item.ink_color || '-'} / Font: {item.font || '-'} / Floor: {item.floor || '-'}
                        </td>
                        <td className="px-3 py-3 italic text-red-500 font-bold">{item.fail_reason || '-'}</td>
                        <td className="px-3 py-3 text-center">
                          <span className="bg-gray-100 px-2 py-1 rounded font-bold">STEP {item.retry_count || 1}</span>
                        </td>
                        <td className="px-3 py-3 text-center whitespace-nowrap">{formatTime(item.created_at)}</td>
                        <td className="px-3 py-3 text-right font-mono font-bold">{getRejectDuration(item.created_at)}</td>
                      </tr>
                    ))}
                    {sortedRejectQueue.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-12 text-center text-gray-400">
                          Queue is empty
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex gap-4 flex-1 min-h-0 mt-4 min-w-0 overflow-hidden">
                <div className="w-56 shrink-0 bg-white rounded-xl shadow-sm border flex flex-col overflow-hidden min-w-0 sm:w-64">
                  <div className="p-2 border-b text-xs font-bold text-gray-600 uppercase">Reject List (Step {activeRejectTab})</div>
                  <div className="flex-1 overflow-y-auto p-1 space-y-1">
                    {filteredRejectItems.map((item, index) => (
                      <div
                        key={item.id}
                        onClick={() => setCurrentRejectItem(item)}
                        className={`p-2 rounded border cursor-pointer flex justify-between items-center text-xs ${
                          item === currentRejectItem ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-100 hover:bg-gray-50'
                        }`}
                      >
                        <div className="truncate min-w-0">
                          <span className="text-gray-400 font-bold">{index + 1}. </span>
                          <span className="font-medium uppercase">{item.item_uid}</span>
                          <br />
                          <span className="text-gray-500 text-[10px]">{item.product_name}</span>
                        </div>
                      </div>
                    ))}
                    {filteredRejectItems.length === 0 && <div className="text-center py-8 text-gray-400 text-xs">No items</div>}
                  </div>
                </div>
                <div className="flex-1 min-w-[180px] max-w-[380px] flex flex-col gap-2 min-h-0 overflow-hidden">
                  <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                    {currentRejectItem?.product_code && currentRejectItem.product_code !== '0' ? (
                      <a
                        href={rejectProductImageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                        title="คลิกเปิดรูปในแท็บใหม่"
                      >
                        <img src={rejectProductImageUrl} alt="Product" className="w-full h-full object-contain p-2" />
                      </a>
                    ) : (
                      <span className="text-gray-400 text-sm">No Image (Product: {currentRejectItem?.product_code || '-'})</span>
                    )}
                  </div>
                  <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                    {currentRejectItem?.cartoon_name && currentRejectItem.cartoon_name !== '0' ? (
                      <a
                        href={rejectCartoonImageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                        title="คลิกเปิดรูปลายการ์ตูนในแท็บใหม่"
                      >
                        <img src={rejectCartoonImageUrl} alt="Pattern" className="w-full h-full object-contain p-2" />
                      </a>
                    ) : (
                      <span className="text-gray-400 text-sm">No Pattern ({currentRejectItem?.cartoon_name || '-'})</span>
                    )}
                  </div>
                </div>
                <div className="flex-1 bg-white rounded-xl shadow-sm border flex flex-col min-w-0 min-h-0 basis-0 overflow-hidden">
                  {currentRejectItem ? (
                    <>
                      <div className="flex-1 min-h-0 overflow-auto p-4">
                        <div className="bg-red-50 p-3 rounded-lg border border-red-100 mb-3">
                          <span className="text-xs font-bold text-red-500 uppercase">Previous Fail Reason</span>
                          <p className="text-lg font-bold text-red-600">{currentRejectItem.fail_reason || '-'}</p>
                        </div>
                        <div className="border-b pb-3 mb-3 flex justify-between items-start">
                          <div>
                            <h2 className="text-xl font-bold text-gray-800 uppercase">{currentRejectItem.product_name}</h2>
                            <p className="text-xs text-gray-500">Bill: {currentRejectItem.bill_no}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-gray-400 uppercase">UID</div>
                            <div className="text-xl font-bold text-blue-600 uppercase">{currentRejectItem.item_uid}</div>
                          </div>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-lg border mb-4">
                          <div className="text-[10px] text-gray-400 uppercase mb-2">Text Details</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentRejectItem.line1 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentRejectItem.line2 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800">{currentRejectItem.line3 || '-'}</div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Ink Color</div>
                            <div className="flex items-center gap-2">
                              <span className="w-8 h-8 rounded-full border shrink-0" style={{ backgroundColor: getInkColor(currentRejectItem.ink_color) }} />
                              <span className="font-bold truncate">{currentRejectItem.ink_color || '-'}</span>
                            </div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Font</div>
                            <div className="font-bold">{currentRejectItem.font || '-'}</div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Qty</div>
                            <div className="text-2xl font-bold">{currentRejectItem.qty || 1} pcs</div>
                          </div>
                        </div>
                        <div className="mb-2 text-sm">
                          <span className="text-gray-500">Floor: </span>
                          <span className="font-bold">{currentRejectItem.floor || '-'}</span>
                        </div>
                      </div>
                      <div className="shrink-0 p-4 pt-2 border-t bg-gray-50/50 space-y-2">
                        <div className="flex gap-4">
                          <button
                            onClick={() => markRejectStatus('fail')}
                            className="flex-1 py-3 border-2 border-red-500 text-red-500 rounded-xl font-bold hover:bg-red-50"
                          >
                            FAIL (NEXT REJECT)
                          </button>
                          <button onClick={() => markRejectStatus('pass')} className="flex-1 py-3 bg-green-500 text-white rounded-xl font-bold hover:bg-green-600">
                            QC PASS
                          </button>
                        </div>
                        <div className="flex gap-4">
                          <button onClick={() => navigateRejectItem(-1)} className="flex-1 py-2 bg-gray-100 rounded-xl hover:bg-gray-200 font-bold">
                            Prev
                          </button>
                          <button onClick={() => navigateRejectItem(1)} className="flex-1 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold">
                            Next
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                      <p className="text-lg">Select item to process</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reports & KPI */}
        {currentView === 'report' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-2xl font-bold mb-4">Performance Reports</h2>
            <div className="flex flex-wrap gap-4 mb-6">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase">Start Date</label>
                <input
                  type="date"
                  value={reportFilter.startDate}
                  onChange={(e) => setReportFilter((f) => ({ ...f, startDate: e.target.value }))}
                  className="border rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase">End Date</label>
                <input
                  type="date"
                  value={reportFilter.endDate}
                  onChange={(e) => setReportFilter((f) => ({ ...f, endDate: e.target.value }))}
                  className="border rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase">QC User</label>
                <select
                  value={reportFilter.user}
                  onChange={(e) => setReportFilter((f) => ({ ...f, user: e.target.value }))}
                  className="border rounded px-2 py-1"
                >
                  <option value="">ALL USERS</option>
                  {reportUsers.map((u) => (
                    <option key={u.id} value={u.username || ''}>
                      {u.username || u.id}
                    </option>
                  ))}
                </select>
              </div>
              <button onClick={loadReports} className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-bold self-end">
                Filter
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-700 font-bold uppercase text-xs">
                  <tr>
                    <th className="px-4 py-3 text-center">เริ่ม QC</th>
                    <th className="px-4 py-3 text-center">เสร็จสิ้น</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">File</th>
                    <th className="px-4 py-3 text-center">Total</th>
                    <th className="px-4 py-3 text-center text-green-600">Pass</th>
                    <th className="px-4 py-3 text-center text-red-600">Fail</th>
                    <th className="px-4 py-3 text-center">KPI (ชม:นาที:วินาที)</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => showSessionDetails(s)}
                      className="border-b hover:bg-blue-50 cursor-pointer"
                    >
                      <td className="px-4 py-3 text-center">{formatDate(s.start_time)}</td>
                      <td className="px-4 py-3 text-center font-bold text-blue-600">{formatDate(s.end_time)}</td>
                      <td className="px-4 py-3 font-bold">{s.username}</td>
                      <td className="px-4 py-3 truncate max-w-[200px] italic">{s.filename}</td>
                      <td className="px-4 py-3 text-center font-bold">{s.total_items}</td>
                      <td className="px-4 py-3 text-center font-bold text-green-600">{s.pass_count}</td>
                      <td className="px-4 py-3 text-center font-bold text-red-600">{s.fail_count}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="bg-gray-100 px-2 py-1 rounded font-mono font-bold">{(() => {
                          const totalSec = Math.round((s.kpi_score ?? 0) * (s.total_items || 1))
                          const h = Math.floor(totalSec / 3600)
                          const m = Math.floor((totalSec % 3600) / 60)
                          const sec = totalSec % 60
                          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
                        })()}</span>
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => downloadReportCsv(s)}
                          className="text-blue-600 hover:text-blue-800 font-bold uppercase text-xs"
                        >
                          CSV
                        </button>
                      </td>
                    </tr>
                  ))}
                  {reports.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-8 text-center text-gray-400 italic">
                        No records. Click Filter to load.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* History Check — layout เหมือน QC Operation */}
        {currentView === 'history' && (
          <div className={historySearched && historyResults.length > 0 ? 'flex flex-col flex-1 min-h-0 overflow-hidden' : 'space-y-4'}>
            <div className="bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center gap-4">
              <h2 className="text-xl font-bold">Item History Check</h2>
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchHistory()}
                placeholder="สแกน Barcode หรือพิมพ์ UID"
                className="border-2 border-blue-400 rounded-lg px-4 py-2 flex-1 min-w-[200px]"
              />
              <button onClick={searchHistory} disabled={loading} className="px-5 py-2 bg-blue-600 text-white rounded-lg font-bold disabled:opacity-50">
                Search
              </button>
              <button
                onClick={() => {
                  setHistorySearch('')
                  setHistoryResults([])
                  setHistorySearched(false)
                  setCurrentHistoryRecord(null)
                }}
                className="px-5 py-2 bg-gray-200 rounded-lg font-bold hover:bg-gray-300"
              >
                Clear
              </button>
            </div>
            {historySearched && historyResults.length > 0 && (
              <div className="flex gap-4 flex-1 min-h-0 mt-4 overflow-hidden">
                <div className="w-56 shrink-0 bg-white rounded-xl shadow-sm border flex flex-col overflow-hidden min-w-0 sm:w-64">
                  <div className="p-2 border-b text-xs font-bold text-gray-600 uppercase">History List</div>
                  <div className="flex-1 overflow-y-auto p-1 space-y-1">
                    {historyResults.map((rec, index) => (
                      <div
                        key={rec.id}
                        id={'history-item-' + rec.id}
                        onClick={() => setCurrentHistoryRecord(rec)}
                        className={`p-2 rounded border cursor-pointer flex justify-between items-center text-xs ${
                          currentHistoryRecord?.id === rec.id ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-100 hover:bg-gray-50'
                        }`}
                      >
                        <div className="truncate min-w-0">
                          <span className="text-gray-400 font-bold">{index + 1}. </span>
                          <span className="font-medium uppercase">{rec.item_uid}</span>
                          <br />
                          <span className="text-gray-500 text-[10px]">{rec.product_name || '-'}</span>
                        </div>
                        {rec.status === 'pass' && <span className="text-green-500 shrink-0">✓</span>}
                        {rec.status === 'fail' && <span className="text-red-500 shrink-0">✗</span>}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex-1 min-w-[180px] max-w-[380px] flex flex-col gap-2 min-h-0 overflow-hidden">
                  <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                    {currentHistoryRecord && currentHistoryRecord.product_code && currentHistoryRecord.product_code !== '0' ? (
                      <a
                        href={getPublicUrl('product-images', currentHistoryRecord.product_code, '.jpg')}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                      >
                        <img
                          src={getPublicUrl('product-images', currentHistoryRecord.product_code, '.jpg')}
                          alt="Product"
                          className="w-full h-full object-contain p-2"
                        />
                      </a>
                    ) : (
                      <div className="text-gray-400 text-sm">No Image (Product: {currentHistoryRecord?.product_code || '-'})</div>
                    )}
                  </div>
                  <div className="flex-1 min-h-0 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                    {currentHistoryRecord && currentHistoryRecord.cartoon_name && currentHistoryRecord.cartoon_name !== '0' ? (
                      <a
                        href={getPublicUrl('cartoon-patterns', currentHistoryRecord.cartoon_name, '.jpg')}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full h-full flex items-center justify-center cursor-pointer"
                      >
                        <img
                          src={getPublicUrl('cartoon-patterns', currentHistoryRecord.cartoon_name, '.jpg')}
                          alt="Pattern"
                          className="w-full h-full object-contain p-2"
                        />
                      </a>
                    ) : (
                      <div className="text-gray-400 text-sm">No Pattern ({currentHistoryRecord?.cartoon_name || '-'})</div>
                    )}
                  </div>
                </div>

                <div className="flex-1 bg-white rounded-xl shadow-sm border flex flex-col min-w-0 min-h-0 basis-0 overflow-hidden">
                  {currentHistoryRecord ? (
                    <>
                      <div className="flex-1 min-h-0 overflow-auto p-4">
                        <div className="border-b pb-3 mb-3 flex justify-between items-start">
                          <div>
                            <h2 className="text-xl font-bold text-gray-800 uppercase">{currentHistoryRecord.product_name || '-'}</h2>
                            <p className="text-xs text-gray-500">Bill: {currentHistoryRecord.bill_no || '-'}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-gray-400 uppercase">UID</div>
                            <div className="text-xl font-bold text-blue-600 uppercase">{currentHistoryRecord.item_uid}</div>
                          </div>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-lg border mb-4">
                          <div className="text-[10px] text-gray-400 uppercase mb-2">Text Details</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentHistoryRecord.line1 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentHistoryRecord.line2 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800">{currentHistoryRecord.line3 || '-'}</div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Ink Color</div>
                            <div className="flex items-center gap-2">
                              <span className="w-8 h-8 rounded-full border shrink-0" style={{ backgroundColor: getInkColor(currentHistoryRecord.ink_color) }} />
                              <span className="font-bold truncate">{currentHistoryRecord.ink_color || '-'}</span>
                            </div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Font</div>
                            <div className="font-bold">{currentHistoryRecord.font || '-'}</div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Qty</div>
                            <div className="text-2xl font-bold">{currentHistoryRecord.qty || 1} pcs</div>
                          </div>
                        </div>
                        <div className="mb-2 text-sm">
                          <span className="text-gray-500">Floor: </span>
                          <span className="font-bold">{currentHistoryRecord.floor || '-'}</span>
                          {currentHistoryRecord.remark && (
                            <>
                              <span className="text-gray-500 ml-2">Remark: </span>
                              <span className="font-medium">{currentHistoryRecord.remark}</span>
                            </>
                          )}
                        </div>
                        <div className="mt-4 pt-4 border-t space-y-2">
                          <div className="text-xs text-gray-500">
                            ตรวจเมื่อ: {formatDate(currentHistoryRecord.created_at)} | โดย: {currentHistoryRecord.qc_by}
                            {currentHistoryRecord.retry_count != null && currentHistoryRecord.retry_count > 1 && (
                              <span className="ml-2">RETRY: {currentHistoryRecord.retry_count}</span>
                            )}
                          </div>
                          <div className="flex gap-2 items-center">
                            <span
                              className={`px-4 py-2 rounded-xl font-bold ${
                                currentHistoryRecord.status === 'pass' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                              }`}
                            >
                              {currentHistoryRecord.status.toUpperCase()}
                            </span>
                            {currentHistoryRecord.status === 'fail' && currentHistoryRecord.fail_reason && (
                              <span className="text-red-600 font-medium">Reason: {currentHistoryRecord.fail_reason}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 p-4 pt-2 border-t bg-gray-50/50 flex gap-4">
                        <button
                          type="button"
                          onClick={() => {
                            const idx = historyResults.indexOf(currentHistoryRecord)
                            if (idx > 0) setCurrentHistoryRecord(historyResults[idx - 1])
                          }}
                          className="flex-1 py-2 bg-gray-100 rounded-xl hover:bg-gray-200 font-bold"
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const idx = historyResults.indexOf(currentHistoryRecord)
                            if (idx >= 0 && idx < historyResults.length - 1) setCurrentHistoryRecord(historyResults[idx + 1])
                          }}
                          className="flex-1 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-bold"
                        >
                          Next
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center flex-1 text-gray-400">
                      <p className="text-lg">เลือกรายการจากรายการด้านซ้าย</p>
                    </div>
                  )}
                </div>
              </div>
            )}
            {historySearched && historyResults.length === 0 && (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-500">ไม่พบประวัติการตรวจสำหรับ UID นี้</div>
            )}
          </div>
        )}

        {/* Settings */}
        {currentView === 'settings' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-2xl font-bold mb-6">System Settings</h2>
            <div className="flex border-b mb-6">
              <button
                onClick={() => setSettingsTab('reasons')}
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'reasons' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                Reasons
              </button>
              <button
                onClick={() => setSettingsTab('ink')}
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'ink' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500'}`}
              >
                Ink
              </button>
              <button
                onClick={() => { setSettingsTab('skip_logs'); loadSkipLogs() }}
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'skip_logs' ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500'}`}
              >
                รายการไม่ QC
              </button>
              <button
                onClick={() => { setSettingsTab('checklist_topics'); loadChecklistTopics() }}
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'checklist_topics' ? 'border-green-500 text-green-600' : 'border-transparent text-gray-500'}`}
              >
                หัวข้อQC
              </button>
            </div>
            {settingsTab === 'reasons' && (
              <div>
                <div className="flex gap-2 mb-4 flex-wrap">
                  <input
                    type="text"
                    value={newReason}
                    onChange={(e) => setNewReason(e.target.value)}
                    placeholder="เหตุผล Fail ใหม่"
                    className="border rounded px-3 py-2 flex-1"
                  />
                  <select
                    value={newReasonType}
                    onChange={(e) => setNewReasonType(e.target.value as 'Man' | 'Machine' | 'Material' | 'Method')}
                    className="border rounded px-3 py-2 bg-white"
                  >
                    <option value="Man">Man</option>
                    <option value="Machine">Machine</option>
                    <option value="Material">Material</option>
                    <option value="Method">Method</option>
                  </select>
                  <button onClick={handleAddReason} className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-bold">
                    ADD
                  </button>
                </div>
                <ul className="divide-y border rounded-xl overflow-hidden">
                  {reasons.map((r) => (
                    <li key={r.id} className="bg-white">
                      <div className="py-3 px-4 flex justify-between items-center hover:bg-gray-50 gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <span className="font-bold truncate">{r.reason_text}</span>
                          {r.children && r.children.length > 0 && (
                            <span className="text-xs text-gray-400">({r.children.length} หัวข้อย่อย)</span>
                          )}
                        </div>
                        <select
                          value={r.fail_type || 'Man'}
                          onChange={(e) => handleUpdateReasonType(r.id, e.target.value as 'Man' | 'Machine' | 'Material' | 'Method')}
                          className={`text-xs px-2 py-1 rounded-full border-0 cursor-pointer font-semibold shrink-0 ${
                            r.fail_type === 'Machine' ? 'bg-orange-100 text-orange-700' :
                            r.fail_type === 'Material' ? 'bg-green-100 text-green-700' :
                            r.fail_type === 'Method' ? 'bg-purple-100 text-purple-700' :
                            'bg-blue-100 text-blue-700'
                          }`}
                        >
                          <option value="Man">Man</option>
                          <option value="Machine">Machine</option>
                          <option value="Material">Material</option>
                          <option value="Method">Method</option>
                        </select>
                        <button
                          onClick={() => { setAddSubReasonParentId(addSubReasonParentId === r.id ? null : r.id); setNewSubReason('') }}
                          className="text-blue-400 hover:text-blue-600 shrink-0" title="เพิ่มหัวข้อย่อย"
                        >
                          <i className="fas fa-plus-circle"></i>
                        </button>
                        <button onClick={() => handleDeleteReason(r.id, r.reason_text)} className="text-red-400 hover:text-red-600 shrink-0">
                          <i className="fas fa-trash-alt"></i>
                        </button>
                      </div>
                      {/* Sub-reasons */}
                      {r.children && r.children.length > 0 && (
                        <ul className="ml-8 mr-4 mb-2 border-l-2 border-blue-200">
                          {r.children.map((sub) => (
                            <li key={sub.id} className="py-2 px-4 flex items-center gap-2 text-sm hover:bg-blue-50 rounded-r">
                              <span className="text-blue-400">↳</span>
                              <span className="flex-1 truncate">{sub.reason_text}</span>
                              <button onClick={() => handleDeleteReason(sub.id, sub.reason_text)} className="text-red-300 hover:text-red-500 shrink-0">
                                <i className="fas fa-trash-alt text-xs"></i>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Inline add sub-reason form */}
                      {addSubReasonParentId === r.id && (
                        <div className="ml-8 mr-4 mb-3 flex gap-2 items-center">
                          <span className="text-blue-400">↳</span>
                          <input
                            type="text"
                            value={newSubReason}
                            onChange={(e) => setNewSubReason(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleAddSubReason(r.id, r.fail_type || 'Man') }}
                            placeholder="หัวข้อย่อยใหม่..."
                            className="border rounded px-3 py-1.5 text-sm flex-1"
                            autoFocus
                          />
                          <button
                            onClick={() => handleAddSubReason(r.id, r.fail_type || 'Man')}
                            className="px-3 py-1.5 bg-blue-500 text-white rounded text-sm hover:bg-blue-600 font-bold"
                          >
                            เพิ่ม
                          </button>
                          <button
                            onClick={() => { setAddSubReasonParentId(null); setNewSubReason('') }}
                            className="px-3 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-100"
                          >
                            ยกเลิก
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                  {reasons.length === 0 && <li className="py-8 text-center text-gray-400">ยังไม่มีเหตุผล — เพิ่มในช่องด้านบน</li>}
                </ul>
              </div>
            )}
            {settingsTab === 'ink' && (
              <div>
                <p className="text-gray-600 mb-4">แก้ไขสีหมึก (hex) สำหรับแสดงใน QC / Reject / History</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {inkTypes.map((ink) => (
                    <div key={ink.id} className="p-4 border rounded-xl flex flex-wrap items-center justify-between gap-2 bg-white">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={ink.hex_code || '#cccccc'}
                          onChange={(e) => handleUpdateInkHex(ink.id, e.target.value)}
                          className="w-8 h-8 rounded border cursor-pointer p-0"
                        />
                        <span className="font-bold">{ink.ink_name}</span>
                      </div>
                      <input
                        type="text"
                        value={ink.hex_code || '#cccccc'}
                        onChange={(e) => handleUpdateInkHex(ink.id, e.target.value)}
                        className="w-20 border rounded px-2 py-1 text-sm font-mono"
                      />
                    </div>
                  ))}
                  {inkTypes.length === 0 && <div className="col-span-2 py-8 text-center text-gray-400">ไม่มีข้อมูล ink_types</div>}
                </div>
              </div>
            )}
            {settingsTab === 'skip_logs' && (
              <div>
                <p className="text-gray-600 mb-4">รายการใบงานที่ข้ามการ QC ทั้งหมด (ล่าสุด 100 รายการ)</p>
                {skipLogs.length === 0 ? (
                  <div className="py-8 text-center text-gray-400">ไม่มีรายการ</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="bg-gray-100">
                          <th className="text-left px-4 py-3 font-semibold border-b">#</th>
                          <th className="text-left px-4 py-3 font-semibold border-b">ใบงาน</th>
                          <th className="text-left px-4 py-3 font-semibold border-b">ผู้ดำเนินการ</th>
                          <th className="text-left px-4 py-3 font-semibold border-b">จำนวนรายการ</th>
                          <th className="text-left px-4 py-3 font-semibold border-b">วันที่</th>
                          <th className="text-left px-4 py-3 font-semibold border-b">รายละเอียด</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skipLogs.map((log, idx) => (
                          <tr key={log.id} className="border-b hover:bg-gray-50">
                            <td className="px-4 py-3 text-gray-500">{idx + 1}</td>
                            <td className="px-4 py-3 font-bold text-amber-700">{log.work_order_name}</td>
                            <td className="px-4 py-3">{log.skipped_by}</td>
                            <td className="px-4 py-3 text-center">{log.total_items}</td>
                            <td className="px-4 py-3 text-gray-600">{new Date(log.created_at).toLocaleString('th-TH')}</td>
                            <td className="px-4 py-3">
                              {log.item_details && Array.isArray(log.item_details) && (
                                <details className="cursor-pointer">
                                  <summary className="text-blue-500 hover:text-blue-700 text-xs">ดูรายละเอียด ({log.item_details.length} รายการ)</summary>
                                  <div className="mt-2 p-2 bg-gray-50 rounded text-xs space-y-1 max-h-40 overflow-y-auto">
                                    {log.item_details.map((item: any, i: number) => (
                                      <div key={i} className="flex gap-3">
                                        <span className="text-gray-400">{i + 1}.</span>
                                        <span className="font-mono text-gray-700">{item.uid}</span>
                                        <span>{item.product_name}</span>
                                        <span className="text-gray-500">{item.bill_no}</span>
                                        {item.ink_color && <span className="text-purple-600">{item.ink_color}</span>}
                                        {item.qty && <span className="text-gray-500">x{item.qty}</span>}
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {settingsTab === 'checklist_topics' && (
              <div>
                {!clSelectedTopic ? (
                  <>
                    <div className="flex gap-2 mb-4 flex-wrap items-center">
                      <input
                        type="text"
                        value={clNewTopicName}
                        onChange={(e) => setClNewTopicName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateTopic()}
                        placeholder="ชื่อหัวข้อใหญ่ใหม่"
                        className="border rounded px-3 py-2 flex-1"
                      />
                      <button onClick={handleCreateTopic} className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-bold">
                        เพิ่มหัวข้อ
                      </button>
                      <div className="w-px h-8 bg-gray-200 mx-1"></div>
                      <button
                        onClick={generateChecklistTemplate}
                        className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-bold flex items-center gap-2"
                      >
                        <i className="fas fa-download text-sm"></i> ดาวน์โหลด Template
                      </button>
                      <button
                        onClick={() => clFileInputRef.current?.click()}
                        disabled={clImporting}
                        className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-bold flex items-center gap-2 disabled:opacity-50"
                      >
                        <i className="fas fa-upload text-sm"></i> {clImporting ? 'กำลังนำเข้า...' : 'อัพโหลดนำเข้า'}
                      </button>
                      <input
                        ref={clFileInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) handleImportExcel(f)
                          e.target.value = ''
                        }}
                      />
                    </div>
                    {clImportResult && (
                      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm">
                        <div className="font-bold text-blue-800 mb-2">ผลการนำเข้า</div>
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2">
                          <div className="bg-white rounded p-2 border text-center">
                            <div className="text-xs text-gray-500">หัวข้อใหม่</div>
                            <div className="text-lg font-bold text-green-600">{clImportResult.topicsCreated}</div>
                          </div>
                          <div className="bg-white rounded p-2 border text-center">
                            <div className="text-xs text-gray-500">หัวข้อมีอยู่แล้ว</div>
                            <div className="text-lg font-bold text-gray-500">{clImportResult.topicsExisting}</div>
                          </div>
                          <div className="bg-white rounded p-2 border text-center">
                            <div className="text-xs text-gray-500">หัวข้อย่อยใหม่</div>
                            <div className="text-lg font-bold text-blue-600">{clImportResult.itemsCreated}</div>
                          </div>
                          <div className="bg-white rounded p-2 border text-center">
                            <div className="text-xs text-gray-500">สินค้าเชื่อมใหม่</div>
                            <div className="text-lg font-bold text-green-600">{clImportResult.productsLinked}</div>
                          </div>
                          <div className="bg-white rounded p-2 border text-center">
                            <div className="text-xs text-gray-500">สินค้าข้าม (ซ้ำ)</div>
                            <div className="text-lg font-bold text-amber-600">{clImportResult.productsSkipped}</div>
                          </div>
                        </div>
                        {clImportResult.errors.length > 0 && (
                          <details className="mt-2">
                            <summary className="text-red-600 cursor-pointer font-medium">ข้อผิดพลาด ({clImportResult.errors.length} รายการ)</summary>
                            <ul className="mt-1 text-red-600 text-xs space-y-1 max-h-32 overflow-y-auto">
                              {clImportResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                            </ul>
                          </details>
                        )}
                        <button onClick={() => setClImportResult(null)} className="mt-2 text-xs text-gray-400 hover:text-gray-600">ปิด</button>
                      </div>
                    )}
                    {clTopics.length === 0 ? (
                      <div className="py-8 text-center text-gray-400">ยังไม่มีหัวข้อ QC — เพิ่มในช่องด้านบน</div>
                    ) : (
                      <div className="border rounded-xl overflow-hidden divide-y">
                        {clTopics.map((topic) => (
                          <div key={topic.id} className="py-3 px-4 flex items-center gap-3 hover:bg-gray-50">
                            {clEditTopicId === topic.id ? (
                              <div className="flex-1 flex gap-2 items-center">
                                <input
                                  type="text"
                                  value={clEditTopicName}
                                  onChange={(e) => setClEditTopicName(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && handleSaveEditTopic()}
                                  className="border rounded px-3 py-1 flex-1"
                                  autoFocus
                                />
                                <button onClick={handleSaveEditTopic} className="px-3 py-1 bg-blue-500 text-white rounded text-sm font-bold">บันทึก</button>
                                <button onClick={() => setClEditTopicId(null)} className="px-3 py-1 border rounded text-sm">ยกเลิก</button>
                              </div>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleSelectTopic(topic)}
                                  className="flex-1 text-left min-w-0"
                                >
                                  <span className="font-bold text-gray-800">{topic.name}</span>
                                  <span className="ml-3 text-xs text-gray-400">
                                    {topic.items_count || 0} หัวข้อย่อย / {topic.products_count || 0} สินค้า
                                  </span>
                                </button>
                                <button
                                  onClick={() => { setClEditTopicId(topic.id); setClEditTopicName(topic.name) }}
                                  className="text-blue-400 hover:text-blue-600 shrink-0" title="แก้ไข"
                                >
                                  <i className="fas fa-pen text-sm"></i>
                                </button>
                                <button
                                  onClick={() => handleDeleteTopic(topic.id)}
                                  className="text-red-400 hover:text-red-600 shrink-0" title="ลบ"
                                >
                                  <i className="fas fa-trash-alt text-sm"></i>
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    <button
                      onClick={() => { setClSelectedTopic(null); setClItems([]); setClProducts([]); setClProductSearch(''); setClProductResults([]) }}
                      className="mb-4 text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"
                    >
                      <i className="fas fa-arrow-left text-sm"></i> กลับหน้ารายการหัวข้อ
                    </button>
                    <h3 className="text-xl font-bold text-gray-800 mb-4">{clSelectedTopic.name}</h3>

                    {/* Sub-items */}
                    <div className="mb-6">
                      <h4 className="font-bold text-gray-700 mb-3 flex items-center gap-2">
                        <i className="fas fa-list-check text-green-500"></i> หัวข้อย่อย ({clItems.length})
                      </h4>
                      <div className="flex gap-2 mb-3 flex-wrap">
                        <input
                          type="text"
                          value={clNewItemTitle}
                          onChange={(e) => setClNewItemTitle(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleAddChecklistItem()}
                          placeholder="ชื่อหัวข้อย่อยใหม่"
                          className="border rounded px-3 py-2 flex-1"
                        />
                        <label className="flex items-center gap-2 px-3 py-2 border rounded cursor-pointer hover:bg-gray-50 text-sm">
                          <i className="fas fa-paperclip text-gray-400"></i>
                          <span className="text-gray-600 truncate max-w-[120px]">{clNewItemFile ? clNewItemFile.name : 'แนบไฟล์'}</span>
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            className="hidden"
                            onChange={(e) => setClNewItemFile(e.target.files?.[0] || null)}
                          />
                        </label>
                        <button
                          onClick={handleAddChecklistItem}
                          disabled={clUploading}
                          className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-bold disabled:opacity-50"
                        >
                          {clUploading ? 'กำลังอัพโหลด...' : 'เพิ่ม'}
                        </button>
                      </div>
                      {clItems.length === 0 ? (
                        <div className="py-4 text-center text-gray-400 text-sm">ยังไม่มีหัวข้อย่อย</div>
                      ) : (
                        <ul className="border rounded-xl overflow-hidden divide-y">
                          {clItems.map((item, idx) => (
                            <li key={item.id} className="py-2.5 px-4 flex items-center gap-3 hover:bg-gray-50">
                              <span className="text-gray-400 text-sm w-6 text-right">{idx + 1}.</span>
                              <span className="flex-1 font-medium truncate">{item.title}</span>
                              {item.file_url && (
                                <a
                                  href={item.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-600 shrink-0"
                                  title={item.file_type === 'pdf' ? 'ดูไฟล์ PDF' : 'ดูรูปภาพ'}
                                >
                                  <i className={`fas ${item.file_type === 'pdf' ? 'fa-file-pdf text-red-400' : 'fa-image text-green-400'}`}></i>
                                </a>
                              )}
                              <button onClick={() => handleDeleteChecklistItem(item.id)} className="text-red-400 hover:text-red-600 shrink-0">
                                <i className="fas fa-trash-alt text-xs"></i>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {/* Linked products */}
                    <div>
                      <h4 className="font-bold text-gray-700 mb-3 flex items-center gap-2">
                        <i className="fas fa-box text-blue-500"></i> สินค้าที่เชื่อม ({clProducts.length})
                      </h4>
                      <div className="flex gap-2 mb-3">
                        <input
                          type="text"
                          value={clProductSearch}
                          onChange={(e) => setClProductSearch(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSearchProducts()}
                          placeholder="ค้นหารหัสสินค้า / ชื่อสินค้า"
                          className="border rounded px-3 py-2 flex-1"
                        />
                        <button onClick={handleSearchProducts} className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-bold">
                          ค้นหา
                        </button>
                      </div>
                      {clProductResults.length > 0 && (
                        <div className="mb-3 border rounded-lg max-h-48 overflow-y-auto divide-y">
                          {clProductResults.map((p) => (
                            <div key={p.product_code} className="py-2 px-3 flex items-center justify-between hover:bg-blue-50 text-sm">
                              <div className="min-w-0">
                                <span className="font-mono font-bold text-blue-700">{p.product_code}</span>
                                <span className="ml-2 text-gray-600 truncate">{p.product_name}</span>
                              </div>
                              <button
                                onClick={() => handleAddProduct(p)}
                                className="shrink-0 px-3 py-1 bg-green-500 text-white rounded text-xs font-bold hover:bg-green-600"
                              >
                                เพิ่ม
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {clProducts.length === 0 ? (
                        <div className="py-4 text-center text-gray-400 text-sm">ยังไม่มีสินค้าเชื่อม — ค้นหาด้านบนเพื่อเพิ่ม</div>
                      ) : (
                        <div className="border rounded-xl overflow-hidden divide-y">
                          {clProducts.map((p, idx) => (
                            <div key={p.id} className="py-2.5 px-4 flex items-center gap-3 hover:bg-gray-50">
                              <span className="text-gray-400 text-sm w-6 text-right">{idx + 1}.</span>
                              <span className="font-mono font-bold text-blue-700">{p.product_code}</span>
                              <span className="flex-1 truncate text-gray-600">{p.product_name}</span>
                              <button onClick={() => handleRemoveProduct(p.id)} className="text-red-400 hover:text-red-600 shrink-0">
                                <i className="fas fa-times"></i>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Finish confirm Modal */}
      <Modal
        open={finishConfirmOpen}
        onClose={() => setFinishConfirmOpen(false)}
        contentClassName="max-w-md"
      >
        <div className="p-4 border-b bg-gray-50 font-bold text-gray-800">
          บันทึกและจบงาน QC
        </div>
        <div className="p-4 text-sm text-gray-700">
          ยืนยันการบันทึกผลและจบงาน QC ใช่หรือไม่?
        </div>
        <div className="p-4 border-t bg-gray-50 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => setFinishConfirmOpen(false)}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 font-medium"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={handleConfirmFinishSession}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium"
          >
            ตกลง
          </button>
        </div>
      </Modal>

      {/* Skip QC confirm Modal */}
      <Modal
        open={!!skipQcConfirmWo}
        onClose={() => setSkipQcConfirmWo(null)}
        contentClassName="max-w-md"
      >
        <div className="p-4 border-b bg-amber-50 font-bold text-amber-800">
          ยืนยัน ไม่ต้อง QC
        </div>
        <div className="p-4 text-sm text-gray-700">
          <p>ต้องการข้ามการ QC ใบงาน <strong className="text-amber-700">{skipQcConfirmWo}</strong> ทั้งหมดใช่หรือไม่?</p>
          <p className="mt-2 text-red-500 text-xs">* ระบบจะบันทึกทุกรายการเป็น "ผ่าน" และจบงานอัตโนมัติ</p>
        </div>
        <div className="p-4 border-t bg-gray-50 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => setSkipQcConfirmWo(null)}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 font-medium"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={handleSkipQcConfirm}
            className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium"
          >
            ยืนยัน ข้าม QC
          </button>
        </div>
      </Modal>

      {/* Switch job confirm Modal */}
      <Modal
        open={switchJobConfirmOpen}
        onClose={() => setSwitchJobConfirmOpen(false)}
        contentClassName="max-w-md"
      >
        <div className="p-4 border-b bg-gray-50 font-bold text-gray-800">
          สลับใบงาน
        </div>
        <div className="p-4 text-sm text-gray-700">
          มีการตรวจแล้ว บันทึกเซสชันปัจจุบันไว้หรือทิ้ง แล้วสลับใบงาน?
        </div>
        <div className="p-4 border-t bg-gray-50 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => setSwitchJobConfirmOpen(false)}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 font-medium"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={() => {
              setSwitchJobConfirmOpen(false)
              proceedSwitchJob()
            }}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium"
          >
            ตกลง
          </button>
        </div>
      </Modal>

      {/* Fail reason Modal — 2-step: เลือกเหตุผลหลัก → เลือกหัวข้อย่อย (ถ้ามี) */}
      <Modal
        open={failReasonModalOpen}
        onClose={closeFailReasonModal}
        closeOnBackdropClick
        contentClassName="max-w-md"
      >
        <div className="p-4 border-b bg-gray-50 font-bold text-gray-800 flex items-center gap-2">
          {failReasonStep === 2 && (
            <button
              type="button"
              onClick={() => { setFailReasonStep(1); setSelectedParentReason(null); setFailReasonSelected(null) }}
              className="text-blue-500 hover:text-blue-700"
            >
              <i className="fas fa-arrow-left"></i>
            </button>
          )}
          <span>{failReasonStep === 1 ? 'เลือกเหตุผล Fail' : `${selectedParentReason?.reason_text} — เลือกหัวข้อย่อย`}</span>
        </div>
        <div className="p-4 space-y-3">
          {failReasonStep === 1 && (
            <>
              {reasons.length > 0 ? (
                <>
                  <p className="text-sm text-gray-600 mb-2">เลือกเหตุผลจากรายการด้านล่าง</p>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {reasons.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          if (r.children && r.children.length > 0) {
                            setSelectedParentReason(r)
                            setFailReasonStep(2)
                            setFailReasonSelected(null)
                          } else {
                            setFailReasonSelected(r.reason_text)
                          }
                        }}
                        className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors flex items-center justify-between ${
                          failReasonSelected === r.reason_text
                            ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <span>{r.reason_text}</span>
                        {r.children && r.children.length > 0 && (
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            {r.children.length} ย่อย <i className="fas fa-chevron-right text-[10px]"></i>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-gray-600">ยังไม่มีเหตุผลใน Settings กรุณาเพิ่มก่อนใช้งาน</p>
              )}
            </>
          )}
          {failReasonStep === 2 && selectedParentReason && (
            <>
              <p className="text-sm text-gray-600 mb-2">เลือกหัวข้อย่อยของ <strong>{selectedParentReason.reason_text}</strong></p>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {/* ตัวเลือก: เลือก parent โดยไม่ระบุย่อย */}
                <button
                  type="button"
                  onClick={() => setFailReasonSelected(selectedParentReason.reason_text)}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                    failReasonSelected === selectedParentReason.reason_text
                      ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                      : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {selectedParentReason.reason_text} (ไม่ระบุรายละเอียด)
                </button>
                {selectedParentReason.children?.map((sub) => {
                  const combined = `${selectedParentReason.reason_text} > ${sub.reason_text}`
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => setFailReasonSelected(combined)}
                      className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                        failReasonSelected === combined
                          ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-blue-400 mr-1">↳</span> {sub.reason_text}
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <div className="p-4 border-t bg-gray-50 flex gap-3 justify-end">
          <button
            type="button"
            onClick={closeFailReasonModal}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 font-medium"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={confirmFailReason}
            disabled={!failReasonSelected}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            ตกลง
          </button>
        </div>
      </Modal>

      {/* Delete reason confirm Modal */}
      <Modal
        open={deleteReasonModalOpen}
        onClose={() => { setDeleteReasonModalOpen(false); setDeleteReasonTarget(null) }}
        closeOnBackdropClick
        contentClassName="max-w-sm"
      >
        <div className="p-4 border-b bg-gray-50 font-bold text-gray-800 flex items-center gap-2">
          <i className="fas fa-exclamation-triangle text-red-500"></i>
          <span>ยืนยันการลบ</span>
        </div>
        <div className="p-5 text-sm text-gray-700">
          <p>ต้องการลบเหตุผล <strong className="text-red-600">"{deleteReasonTarget?.name}"</strong> หรือไม่?</p>
          <p className="text-xs text-gray-400 mt-2">หากเป็นหัวข้อหลักที่มีหัวข้อย่อย หัวข้อย่อยจะถูกลบทั้งหมด</p>
        </div>
        <div className="p-4 border-t bg-gray-50 flex gap-3 justify-end">
          <button
            type="button"
            onClick={() => { setDeleteReasonModalOpen(false); setDeleteReasonTarget(null) }}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100 font-medium"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={confirmDeleteReason}
            className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
          >
            ลบ
          </button>
        </div>
      </Modal>

      {/* Session detail modal */}
      <Modal open={showSessionModal} onClose={() => setShowSessionModal(false)} contentClassName="max-w-6xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex justify-between items-center bg-gray-50 font-bold">
          <h3 className="text-xl">รายการตรวจสอบในเซสชัน</h3>
          <button onClick={() => setShowSessionModal(false)} className="text-gray-500 hover:text-red-500 text-2xl">
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-xs sticky top-0">
              <tr>
                <th className="px-3 py-2 text-center">#</th>
                <th className="px-3 py-2 text-center">เวลาตรวจ</th>
                <th className="px-3 py-2">Reject Duration</th>
                <th className="px-3 py-2">Item UID</th>
                <th className="px-3 py-2 text-center">Result</th>
                <th className="px-3 py-2 text-center">RETRY</th>
                <th className="px-3 py-2">Product / Bill</th>
                <th className="px-3 py-2">Text (1/2/3)</th>
                <th className="px-3 py-2">Ink/Font/Floor</th>
                <th className="px-3 py-2">Fail Reason</th>
              </tr>
            </thead>
            <tbody>
              {sessionItems.map((item, idx) => (
                <tr key={item.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2 text-center font-bold text-gray-400">{idx + 1}</td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">{formatTime(item.created_at)}</td>
                  <td className="px-3 py-2 text-center font-bold">{item.reject_duration ? formatDuration(item.reject_duration) : '-'}</td>
                  <td className="px-3 py-2 font-mono font-bold text-blue-600">{item.item_uid}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${item.status === 'pass' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center font-bold">{item.retry_count || 1}</td>
                  <td className="px-3 py-2">
                    <div className="font-bold">{item.product_name || '-'}</div>
                    <div className="text-xs text-blue-600">Bill: {item.bill_no || '-'}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {item.line1 && <div>1: {item.line1}</div>}
                    {item.line2 && <div>2: {item.line2}</div>}
                    {item.line3 && <div>3: {item.line3}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    Ink: {item.ink_color || '-'} / Font: {item.font || '-'} / Floor: {item.floor || '-'}
                  </td>
                  <td className="px-3 py-2 italic font-bold text-red-500">{item.fail_reason || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  )
}
