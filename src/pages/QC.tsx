import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import type { QCItem, QCRecord, QCSession, SettingsReason, InkType, WorkOrder } from '../types'
import {
  fetchWorkOrders,
  fetchItemsByWorkOrder,
  fetchSettingsReasons,
  fetchInkTypes,
  fetchRejectItems,
  fetchReports,
  fetchSessionRecords,
  searchHistoryByUid,
  fetchReportUsers,
  addReason,
  deleteReason,
  updateInkHex,
  getPublicUrl,
  getSavedWorkOrderName,
  saveWorkOrderName,
  getSessionBackup,
  setSessionBackup,
  clearSessionBackup,
} from '../lib/qcApi'
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

export default function QC() {
  const { user } = useAuthContext()
  const isAdmin = user?.role === 'superadmin' || user?.role === 'admin'

  const [currentView, setCurrentView] = useState<QCView>('qc')
  const [loading, setLoading] = useState(false)

  // QC Operation
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([])
  const [selectedWoName, setSelectedWoName] = useState<string>('')
  const [qcState, setQcState] = useState<{ step: QCStep; startTime: Date | null; filename: string }>({ step: 'select', startTime: null, filename: '' })
  const [qcData, setQcData] = useState<{ items: QCItem[] }>({ items: [] })
  const [currentItem, setCurrentItem] = useState<QCItem | null>(null)
  const [barcodeQuery, setBarcodeQuery] = useState('')
  const [hasSavedSession, setHasSavedSession] = useState(false)
  const [savedSessionInfo, setSavedSessionInfo] = useState<{ filename: string } | null>(null)
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
  const [sessionItems, setSessionItems] = useState<QCRecord[]>([])

  // History
  const [historySearch, setHistorySearch] = useState('')
  const [historyResults, setHistoryResults] = useState<QCRecord[]>([])
  const [historySearched, setHistorySearched] = useState(false)

  // Settings
  const [reasons, setReasons] = useState<SettingsReason[]>([])
  const [inkTypes, setInkTypes] = useState<InkType[]>([])
  const [settingsTab, setSettingsTab] = useState<'reasons' | 'ink'>('reasons')
  const [newReason, setNewReason] = useState('')

  const filteredMenus = MENUS.filter((m) => !m.adminOnly || isAdmin)

  const qcUsername = user?.username || user?.email || 'unknown'

  const totalItems = qcData.items.reduce((a, i) => a + (i.qty || 1), 0)
  const passedItems = qcData.items.filter((i) => i.status === 'pass').reduce((a, i) => a + (i.qty || 1), 0)
  const failedItems = qcData.items.filter((i) => i.status === 'fail').reduce((a, i) => a + (i.qty || 1), 0)
  const remainingItems = totalItems - passedItems - failedItems

  const productImageUrl = currentItem ? getPublicUrl('product-images', currentItem.product_code, productExt) : ''
  const cartoonImageUrl = currentItem ? getPublicUrl('cartoon-patterns', currentItem.cartoon_name, cartoonExt) : ''
  const rejectProductImageUrl = currentRejectItem ? getPublicUrl('product-images', currentRejectItem.product_code, '.jpg') : ''
  const rejectCartoonImageUrl = currentRejectItem ? getPublicUrl('cartoon-patterns', currentRejectItem.cartoon_name, '.jpg') : ''

  function getInkColor(inkName: string | null | undefined): string {
    if (!inkName) return '#ddd'
    const ink = inkTypes.find((i) => i.ink_name === inkName)
    return ink?.hex_code || '#ddd'
  }

  const loadWorkOrders = useCallback(async () => {
    try {
      const list = await fetchWorkOrders()
      setWorkOrders(list)
      const saved = getSavedWorkOrderName()
      if (saved && list.some((w) => w.work_order_name === saved)) setSelectedWoName(saved)
      else if (list.length && !selectedWoName) setSelectedWoName(list[0].work_order_name)
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

  useEffect(() => {
    loadWorkOrders()
    loadSettings()
    const backup = getSessionBackup()
    if (backup?.qcState?.filename) {
      setHasSavedSession(true)
      setSavedSessionInfo({ filename: backup.qcState.filename })
    }
    const t = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(t)
  }, [loadWorkOrders, loadSettings])

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
  }, [qcState.step, qcState.startTime, qcState.filename, qcData.items])

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

  async function handleLoadWo() {
    if (!selectedWoName) return
    setLoading(true)
    try {
      const items = await fetchItemsByWorkOrder(selectedWoName)
      if (items.length === 0) {
        alert('ไม่พบรายการในใบงานนี้')
        setLoading(false)
        return
      }
      saveWorkOrderName(selectedWoName)
      setQcData({ items })
      setQcState({ step: 'working', startTime: new Date(), filename: `WO-${selectedWoName}` })
      setHasSavedSession(false)
      setSavedSessionInfo(null)
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
      if (!window.confirm('มีการตรวจแล้ว บันทึกเซสชันปัจจุบันไว้หรือทิ้ง แล้วสลับใบงาน?')) return
    }
    setQcState({ step: 'select', startTime: null, filename: '' })
    setQcData({ items: [] })
    setCurrentItem(null)
    clearSessionBackup()
    setHasSavedSession(false)
    setSavedSessionInfo(null)
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

  async function markStatus(status: 'pass' | 'fail') {
    if (!currentItem) return
    let reason: string | null = null
    if (status === 'fail') {
      if (reasons.length === 0) {
        const r = window.prompt('เหตุผล Fail (ถ้าไม่มีรายการใน Settings ให้กรอกตรงนี้):')
        if (r == null) return
        reason = r.trim() || null
      } else {
        const value = window.prompt(
          'เลือกเหตุผล Fail (พิมพ์เลข):\n' + reasons.map((r, i) => `${i + 1}. ${r.reason_text}`).join('\n')
        )
        if (value == null) return
        const num = parseInt(value, 10)
        if (num >= 1 && num <= reasons.length) reason = reasons[num - 1].reason_text
        else reason = value.trim() || null
      }
    }
    setQcData((prev) => ({
      items: prev.items.map((i) =>
        i.uid === currentItem.uid
          ? { ...i, status, fail_reason: reason ?? undefined, check_time: new Date() }
          : i
      ),
    }))
    const nextIdx = qcData.items.indexOf(currentItem) + 1
    if (qcData.items[nextIdx]) setCurrentItem(qcData.items[nextIdx])
    setBarcodeQuery('')
  }

  async function finishSession() {
    if (!window.confirm('บันทึกและจบงาน QC ใช่หรือไม่?')) return
    setLoading(true)
    try {
      const endTime = new Date()
      const durationSeconds = (endTime.getTime() - (qcState.startTime?.getTime() || endTime.getTime())) / 1000
      const kpi = totalItems > 0 ? durationSeconds / totalItems : 0
      const { data: session, error: sessErr } = await supabase
        .from('qc_sessions')
        .insert({
          username: qcUsername,
          filename: qcState.filename,
          start_time: qcState.startTime?.toISOString(),
          end_time: endTime.toISOString(),
          total_items: totalItems,
          pass_count: passedItems,
          fail_count: failedItems,
          kpi_score: kpi,
        })
        .select()
        .single()
      if (sessErr) throw sessErr
      const records = qcData.items.map((i) => ({
        session_id: session.id,
        item_uid: i.uid,
        qc_by: qcUsername,
        status: i.status,
        fail_reason: i.fail_reason ?? null,
        is_rejected: i.status === 'fail',
        retry_count: 1,
        product_code: i.product_code,
        product_name: i.product_name,
        bill_no: i.bill_no,
        ink_color: i.ink_color,
        font: i.font,
        floor: i.floor,
        cartoon_name: i.cartoon_name,
        line1: i.line1,
        line2: i.line2,
        line3: i.line3,
        qty: i.qty,
        remark: i.remark,
        created_at: (i.check_time || endTime).toISOString(),
      }))
      await supabase.from('qc_records').insert(records)
      clearSessionBackup()
      setQcState({ step: 'select', startTime: null, filename: '' })
      setQcData({ items: [] })
      setCurrentItem(null)
      setHasSavedSession(false)
      setSavedSessionInfo(null)
      alert('บันทึกเรียบร้อยแล้ว')
      loadRejectItems()
    } catch (e: any) {
      alert('บันทึกไม่สำเร็จ: ' + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  function restoreSession() {
    const backup = getSessionBackup()
    if (!backup) return
    setQcState({
      step: (backup.qcState.step as QCStep) || 'working',
      startTime: backup.qcState.startTime ? new Date(backup.qcState.startTime) : null,
      filename: backup.qcState.filename || '',
    })
    setQcData({ items: backup.qcData.items || [] })
    const first = (backup.qcData.items || []).find((i: QCItem) => i.status === 'pending') || backup.qcData.items?.[0]
    setCurrentItem(first || null)
    setHasSavedSession(false)
    setSavedSessionInfo(null)
    alert('กู้คืนข้อมูลสำเร็จ')
  }

  function clearBackup() {
    if (!window.confirm('ล้างข้อมูลที่ค้างไว้และเริ่มใหม่?')) return
    clearSessionBackup()
    setHasSavedSession(false)
    setSavedSessionInfo(null)
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
    const durationSec = Math.floor((new Date().getTime() - new Date(currentRejectItem.created_at).getTime()) / 1000)
    const updates: Partial<QCRecord> = {
      status,
      qc_by: qcUsername,
      created_at: new Date().toISOString(),
      reject_duration: durationSec,
    }
    if (status === 'pass') {
      updates.is_rejected = false
    } else {
      let reason: string | null = null
      if (reasons.length > 0) {
        const value = window.prompt(
          'เหตุผล Fail ใหม่ (พิมพ์เลข):\n' + reasons.map((r, i) => `${i + 1}. ${r.reason_text}`).join('\n')
        )
        if (value == null) return
        const num = parseInt(value, 10)
        if (num >= 1 && num <= reasons.length) reason = reasons[num - 1].reason_text
        else reason = value.trim() || null
      } else {
        reason = window.prompt('เหตุผล Fail:')?.trim() || null
      }
      if (reason == null) return
      updates.fail_reason = reason
      updates.retry_count = Math.min((currentRejectItem.retry_count || 1) + 1, 4)
    }
    setLoading(true)
    try {
      await supabase.from('qc_records').update(updates).eq('id', currentRejectItem.id)
      const updatedList = await fetchRejectItems()
      setRejectData(updatedList)
      const next = updatedList.find((r) => r.id !== currentRejectItem.id && r.retry_count === (updates.retry_count ?? currentRejectItem.retry_count))
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
    try {
      const data = await searchHistoryByUid(historySearch.trim())
      setHistoryResults(data)
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
      await addReason(newReason.trim())
      setNewReason('')
      await loadSettings()
    } catch (e: any) {
      alert('เพิ่มไม่สำเร็จ: ' + (e?.message || e))
    }
  }

  async function handleDeleteReason(id: string) {
    if (!window.confirm('ลบเหตุผลนี้?')) return
    try {
      await deleteReason(id)
      await loadSettings()
    } catch (e: any) {
      alert('ลบไม่สำเร็จ: ' + (e?.message || e))
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

  function handleKeydown(e: React.KeyboardEvent) {
    if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
    if (currentView === 'qc' && qcState.step === 'working') {
      if (e.key === 'ArrowLeft') navigateItem(-1)
      if (e.key === 'ArrowRight') navigateItem(1)
    }
    if (currentView === 'reject' && currentRejectItem && activeRejectTab !== 'queue') {
      if (e.key === 'ArrowLeft') navigateRejectItem(-1)
      if (e.key === 'ArrowRight') navigateRejectItem(1)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col" onKeyDown={handleKeydown} tabIndex={0}>
      {/* Tabs */}
      <div className="bg-white border-b px-4 flex gap-2 flex-wrap">
        {filteredMenus.map((m) => (
          <button
            key={m.id}
            onClick={() => setCurrentView(m.id)}
            className={`px-4 py-3 font-medium border-b-2 transition-colors ${
              currentView === m.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'
            }`}
          >
            {m.label}
            {m.id === 'reject' && rejectData.length > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{rejectData.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* QC Operation */}
        {currentView === 'qc' && (
          <div className="space-y-4">
            {qcState.step === 'select' && (
              <>
                <div className="bg-white p-6 rounded-xl shadow-sm">
                  <h2 className="text-xl font-bold mb-4">โหลดจากระบบ (Work Order)</h2>
                  <div className="flex flex-wrap gap-4 items-end">
                    <div className="min-w-[200px]">
                      <label className="block text-sm font-medium text-gray-700 mb-1">เลือกใบงาน</label>
                      <select
                        value={selectedWoName}
                        onChange={(e) => {
                          setSelectedWoName(e.target.value)
                          saveWorkOrderName(e.target.value || null)
                        }}
                        className="w-full border rounded-lg px-3 py-2"
                      >
                        <option value="">-- เลือก Work Order --</option>
                        {workOrders.map((wo) => (
                          <option key={wo.id} value={wo.work_order_name}>
                            {wo.work_order_name} ({wo.order_count} บิล)
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={handleLoadWo}
                      disabled={loading || !selectedWoName}
                      className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
                    >
                      {loading ? 'กำลังโหลด...' : 'โหลดรายการ'}
                    </button>
                  </div>
                </div>
                {hasSavedSession && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex flex-wrap items-center gap-4">
                    <span className="font-bold text-blue-900">พบข้อมูลการทำงานที่ค้างอยู่: {savedSessionInfo?.filename}</span>
                    <button onClick={restoreSession} className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
                      กู้คืน
                    </button>
                    <button onClick={clearBackup} className="px-4 py-2 text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                      ทิ้ง
                    </button>
                  </div>
                )}
              </>
            )}

            {qcState.step === 'working' && (
              <>
                <div className="bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center justify-between gap-4">
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
                      <div className="text-xs text-amber-600 uppercase">Left</div>
                      <div className="text-2xl font-bold text-amber-600">{remainingItems}</div>
                    </div>
                  </div>
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
                    {remainingItems === 0 && (
                      <button onClick={finishSession} className="px-6 py-1.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-bold">
                        FINISH JOB
                      </button>
                    )}
                    <button onClick={handleSwitchJob} className="px-4 py-1.5 border border-amber-500 text-amber-600 rounded-lg hover:bg-amber-50">
                      สลับใบงาน
                    </button>
                  </div>
                </div>

                <div className="flex gap-4 flex-1 min-h-0">
                  <div className="w-64 bg-white rounded-xl shadow-sm flex flex-col overflow-hidden">
                    <div className="p-2 border-b text-xs font-bold text-gray-600 uppercase">Items List</div>
                    <div className="flex-1 overflow-y-auto p-1 space-y-1">
                      {qcData.items.map((item, index) => (
                        <div
                          key={item.uid}
                          id={'item-' + item.uid}
                          onClick={() => selectItem(item)}
                          className={`p-2 rounded border cursor-pointer flex justify-between items-center text-xs ${
                            item === currentItem ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-100 hover:bg-gray-50'
                          }`}
                        >
                          <div className="truncate">
                            <span className="text-gray-400 font-bold">{index + 1}. </span>
                            <span className="font-medium uppercase">{item.uid}</span>
                            <br />
                            <span className="text-gray-500 text-[10px]">{item.product_name}</span>
                          </div>
                          {item.status === 'pass' && <span className="text-green-500">✓</span>}
                          {item.status === 'fail' && <span className="text-red-500">✗</span>}
                          {item.status === 'pending' && <span className="text-gray-300">○</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="w-[420px] shrink-0 flex flex-col gap-2">
                    <div className="h-48 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                      {currentItem && !imgErrors.product && currentItem.product_code !== '0' ? (
                        <img
                          src={productImageUrl}
                          alt="Product"
                          className="object-contain max-h-full p-2"
                          onError={() => setImgErrors((e) => ({ ...e, product: true }))}
                        />
                      ) : (
                        <div className="text-gray-400 text-sm">No Image (Product: {currentItem?.product_code || '-'})</div>
                      )}
                    </div>
                    <div className="h-48 bg-white rounded-xl border flex items-center justify-center overflow-hidden">
                      {currentItem && !imgErrors.cartoon && currentItem.cartoon_name !== '0' ? (
                        <img
                          src={cartoonImageUrl}
                          alt="Pattern"
                          className="object-contain max-h-full p-2"
                          onError={() => setImgErrors((e) => ({ ...e, cartoon: true }))}
                        />
                      ) : (
                        <div className="text-gray-400 text-sm">No Pattern ({currentItem?.cartoon_name || '-'})</div>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 bg-white rounded-xl shadow-sm p-4 overflow-auto min-w-0">
                    {currentItem ? (
                      <>
                        <div className="border-b pb-3 mb-3 flex justify-between items-start">
                          <div>
                            <h2 className="text-xl font-bold text-gray-800 uppercase">{currentItem.product_name}</h2>
                            <p className="text-xs text-gray-500">Bill: {currentItem.bill_no}</p>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-gray-400 uppercase">UID</div>
                            <div className="text-xl font-bold text-amber-600 uppercase">{currentItem.uid}</div>
                          </div>
                        </div>
                        <div className="bg-gray-50 p-4 rounded-lg border mb-4">
                          <div className="text-[10px] text-gray-400 uppercase mb-2">Text Details</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentItem.line1 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800 border-b border-gray-200 pb-2">{currentItem.line2 || '-'}</div>
                          <div className="text-lg font-bold text-gray-800">{currentItem.line3 || '-'}</div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Ink Color</div>
                            <div className="flex items-center gap-2">
                              <span className="w-8 h-8 rounded-full border shrink-0" style={{ backgroundColor: getInkColor(currentItem.ink_color) }} />
                              <span className="font-bold truncate">{currentItem.ink_color || '-'}</span>
                            </div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Font</div>
                            <div className="font-bold">{currentItem.font || '-'}</div>
                          </div>
                          <div className="bg-white p-2 rounded border">
                            <div className="text-xs text-gray-400 uppercase">Qty</div>
                            <div className="text-2xl font-bold">{currentItem.qty || 1} pcs</div>
                          </div>
                        </div>
                        <div className="mb-2 text-sm">
                          <span className="text-gray-500">Floor: </span>
                          <span className="font-bold">{currentItem.floor || '-'}</span>
                          {currentItem.remark && (
                            <>
                              <span className="text-gray-500 ml-2">Remark: </span>
                              <span className="font-medium">{currentItem.remark}</span>
                            </>
                          )}
                        </div>
                        <div className="flex gap-4 pt-3 border-t">
                          <button
                            onClick={() => markStatus('fail')}
                            className="flex-1 py-3 border-2 border-red-500 text-red-500 rounded-xl font-bold hover:bg-red-50"
                          >
                            FAIL
                          </button>
                          <button onClick={() => markStatus('pass')} className="flex-1 py-3 bg-green-500 text-white rounded-xl font-bold hover:bg-green-600">
                            PASS
                          </button>
                        </div>
                        <div className="flex gap-4 pt-2">
                          <button onClick={() => navigateItem(-1)} className="flex-1 py-2 bg-gray-100 rounded-xl hover:bg-gray-200 font-bold">
                            Prev
                          </button>
                          <button onClick={() => navigateItem(1)} className="flex-1 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 font-bold">
                            Next
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <p className="text-lg">สแกน Barcode เพื่อเริ่ม</p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Reject */}
        {currentView === 'reject' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl shadow-sm p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="flex gap-2 flex-wrap">
                <span className="bg-red-50 px-4 py-2 rounded-lg border border-red-100 text-red-600 font-bold">
                  Reject Pending: {rejectData.length}
                </span>
                {(['queue', 1, 2, 3, 4] as const).map((tab) => (
                  <button
                    key={String(tab)}
                    onClick={() => setActiveRejectTab(tab)}
                    className={`px-4 py-2 rounded-lg font-bold text-sm ${
                      activeRejectTab === tab ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
                  className="border-2 border-amber-400 rounded-full pl-4 pr-4 py-2 w-64"
                />
                <button onClick={handleRejectScan} className="px-4 py-2 bg-amber-500 text-white rounded-full font-bold">
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
                        className="border-b hover:bg-amber-50 cursor-pointer"
                      >
                        <td className="px-3 py-3 font-bold text-gray-400">{idx + 1}</td>
                        <td className="px-3 py-3 font-bold text-amber-600">{item.qc_by}</td>
                        <td className="px-3 py-3">
                          <div className="font-bold">{item.product_name || '-'}</div>
                          <div className="text-gray-500 text-xs">Bill: {item.bill_no || '-'}</div>
                          <div className="text-amber-600 font-mono text-xs">{item.item_uid}</div>
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
              <div className="flex gap-4">
                <div className="w-64 bg-white rounded-xl shadow-sm flex flex-col overflow-hidden">
                  <div className="p-2 border-b text-xs font-bold text-gray-600 uppercase">Reject List (Step {activeRejectTab})</div>
                  <div className="flex-1 overflow-y-auto p-1 space-y-1">
                    {filteredRejectItems.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => setCurrentRejectItem(item)}
                        className={`p-2 rounded border cursor-pointer text-xs ${
                          item === currentRejectItem ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500' : 'border-gray-100 hover:bg-gray-50'
                        }`}
                      >
                        <div className="font-medium uppercase">{item.item_uid}</div>
                        <div className="text-gray-500 text-[10px]">{item.product_name}</div>
                      </div>
                    ))}
                    {filteredRejectItems.length === 0 && <div className="text-center py-8 text-gray-400 text-xs">No items</div>}
                  </div>
                </div>
                <div className="w-[420px] shrink-0 flex flex-col gap-2">
                  <div className="h-48 bg-white rounded-xl border flex items-center justify-center">
                    {currentRejectItem?.product_code && currentRejectItem.product_code !== '0' ? (
                      <img src={rejectProductImageUrl} alt="Product" className="object-contain max-h-full p-2" />
                    ) : (
                      <span className="text-gray-400 text-sm">No Image</span>
                    )}
                  </div>
                  <div className="h-48 bg-white rounded-xl border flex items-center justify-center">
                    {currentRejectItem?.cartoon_name && currentRejectItem.cartoon_name !== '0' ? (
                      <img src={rejectCartoonImageUrl} alt="Pattern" className="object-contain max-h-full p-2" />
                    ) : (
                      <span className="text-gray-400 text-sm">No Pattern</span>
                    )}
                  </div>
                </div>
                <div className="flex-1 bg-white rounded-xl shadow-sm p-4 overflow-auto">
                  {currentRejectItem ? (
                    <>
                      <div className="bg-red-50 p-3 rounded-lg border border-red-100 mb-3">
                        <span className="text-xs font-bold text-red-500 uppercase">Previous Fail Reason</span>
                        <p className="text-lg font-bold text-red-600">{currentRejectItem.fail_reason || '-'}</p>
                      </div>
                      <div className="border-b pb-3 mb-3">
                        <h2 className="text-xl font-bold">{currentRejectItem.product_name}</h2>
                        <p className="text-xs text-gray-500">Bill: {currentRejectItem.bill_no} | UID: {currentRejectItem.item_uid}</p>
                      </div>
                      <div className="bg-gray-50 p-3 rounded-lg mb-3">
                        <div className="text-lg font-bold">{currentRejectItem.line1 || '-'}</div>
                        <div className="text-lg font-bold">{currentRejectItem.line2 || '-'}</div>
                        <div className="text-lg font-bold">{currentRejectItem.line3 || '-'}</div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-3 text-sm">
                        <div>
                          <span className="text-gray-500">Ink: </span>
                          <span className="font-bold" style={{ color: getInkColor(currentRejectItem.ink_color) }}>
                            ■
                          </span>{' '}
                          {currentRejectItem.ink_color || '-'}
                        </div>
                        <div>
                          <span className="text-gray-500">Font: </span>
                          <span className="font-bold">{currentRejectItem.font || '-'}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Qty: </span>
                          <span className="font-bold">{currentRejectItem.qty || 1} pcs</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Floor: </span>
                          <span className="font-bold">{currentRejectItem.floor || '-'}</span>
                        </div>
                      </div>
                      <div className="flex gap-4 pt-3 border-t">
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
                      <div className="flex gap-4 pt-2">
                        <button onClick={() => navigateRejectItem(-1)} className="flex-1 py-2 bg-gray-100 rounded-xl hover:bg-gray-200 font-bold">
                          Prev
                        </button>
                        <button onClick={() => navigateRejectItem(1)} className="flex-1 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 font-bold">
                          Next
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-400">Select item to process</div>
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
                    <th className="px-4 py-3 text-center">KPI (วินาที/ชิ้น)</th>
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
                      <td className="px-4 py-3 text-center font-bold text-amber-600">{formatDate(s.end_time)}</td>
                      <td className="px-4 py-3 font-bold">{s.username}</td>
                      <td className="px-4 py-3 truncate max-w-[200px] italic">{s.filename}</td>
                      <td className="px-4 py-3 text-center font-bold">{s.total_items}</td>
                      <td className="px-4 py-3 text-center font-bold text-green-600">{s.pass_count}</td>
                      <td className="px-4 py-3 text-center font-bold text-red-600">{s.fail_count}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="bg-gray-100 px-2 py-1 rounded font-mono font-bold">{(s.kpi_score ?? 0).toFixed(2)}</span>
                      </td>
                      <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => downloadReportCsv(s)}
                          className="text-amber-600 hover:text-amber-800 font-bold uppercase text-xs"
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

        {/* History Check */}
        {currentView === 'history' && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-2xl font-bold mb-4">Item History Check</h2>
            <div className="flex flex-wrap gap-2 mb-6">
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && searchHistory()}
                placeholder="สแกน Barcode หรือพิมพ์ UID"
                className="border-2 border-amber-400 rounded-full pl-4 pr-4 py-2 flex-1 min-w-[200px]"
              />
              <button onClick={searchHistory} className="px-5 py-2 bg-amber-500 text-white rounded-full font-bold">
                Search
              </button>
              <button
                onClick={() => {
                  setHistorySearch('')
                  setHistoryResults([])
                  setHistorySearched(false)
                }}
                className="px-5 py-2 bg-gray-200 rounded-full font-bold"
              >
                Clear
              </button>
            </div>
            {historySearched && historyResults.length > 0 && (
              <div className="space-y-6">
                {historyResults.map((rec, idx) => (
                  <div key={rec.id} className="bg-gray-50 rounded-2xl p-6 border-2 border-gray-100">
                    <div className="flex flex-wrap justify-between items-start gap-4 border-b pb-4 mb-4">
                      <div>
                        <span className="text-gray-400 font-bold mr-2">#{idx + 1}</span>
                        <span className="text-2xl font-black text-amber-600 font-mono">{rec.item_uid}</span>
                        <div className="text-sm text-gray-400 mt-1">
                          ตรวจเมื่อ: {formatDate(rec.created_at)} | โดย: {rec.qc_by}
                        </div>
                      </div>
                      <div className="flex gap-2 items-center">
                        <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-lg text-sm font-bold">RETRY: {rec.retry_count || 1}</span>
                        <span
                          className={`px-6 py-2 rounded-xl font-bold text-xl ${
                            rec.status === 'pass' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                          }`}
                        >
                          {rec.status.toUpperCase()}
                        </span>
                      </div>
                    </div>
                    {rec.status === 'fail' && (
                      <div className="text-red-600 font-bold text-lg italic mb-4">Reason: {rec.fail_reason || '-'}</div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase">Product Name</label>
                        <div className="font-bold">{rec.product_name || '-'}</div>
                        <div className="text-gray-500">Code: {rec.product_code || '-'} | Bill: {rec.bill_no || '-'}</div>
                      </div>
                      <div className="bg-white p-4 rounded border">
                        <label className="text-xs font-bold text-amber-600 uppercase">Text details</label>
                        <div className="font-bold mt-1">
                          {rec.line1 && <div>1: {rec.line1}</div>}
                          {rec.line2 && <div>2: {rec.line2}</div>}
                          {rec.line3 && <div>3: {rec.line3}</div>}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase">Ink Color</label>
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 rounded-full border" style={{ backgroundColor: getInkColor(rec.ink_color) }} />
                          {rec.ink_color || '-'}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-bold text-gray-500 uppercase">Font / Floor</label>
                        <div>{rec.font || '-'} / {rec.floor || '-'}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {historySearched && historyResults.length === 0 && (
              <div className="text-center py-12 text-gray-500">ไม่พบประวัติการตรวจสำหรับ UID นี้</div>
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
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'reasons' ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500'}`}
              >
                Reasons
              </button>
              <button
                onClick={() => setSettingsTab('ink')}
                className={`px-6 py-3 font-bold border-b-2 ${settingsTab === 'ink' ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500'}`}
              >
                Ink
              </button>
            </div>
            {settingsTab === 'reasons' && (
              <div>
                <div className="flex gap-2 mb-4">
                  <input
                    type="text"
                    value={newReason}
                    onChange={(e) => setNewReason(e.target.value)}
                    placeholder="เหตุผล Fail ใหม่"
                    className="border rounded px-3 py-2 flex-1"
                  />
                  <button onClick={handleAddReason} className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-bold">
                    ADD
                  </button>
                </div>
                <ul className="divide-y border rounded-xl overflow-hidden">
                  {reasons.map((r) => (
                    <li key={r.id} className="py-3 px-4 flex justify-between items-center bg-white hover:bg-gray-50">
                      <span className="font-bold">{r.reason_text}</span>
                      <button onClick={() => handleDeleteReason(r.id)} className="text-red-500 hover:text-red-700">
                        ลบ
                      </button>
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
          </div>
        )}
      </div>

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
                  <td className="px-3 py-2 font-mono font-bold text-amber-600">{item.item_uid}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${item.status === 'pass' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center font-bold">{item.retry_count || 1}</td>
                  <td className="px-3 py-2">
                    <div className="font-bold">{item.product_name || '-'}</div>
                    <div className="text-xs text-amber-600">Bill: {item.bill_no || '-'}</div>
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
