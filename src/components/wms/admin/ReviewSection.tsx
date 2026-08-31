import { useState, useEffect, useRef } from 'react'
import { supabase } from '../../../lib/supabase'
import {
  getProductImageUrl,
  sortOrderItems,
  WMS_STATUS_LABELS,
  WMS_FULFILLMENT_PICK_OR_LEGACY,
  WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR,
  isWmsCancelledAwaitingPhysicalShelf,
  isWmsReviewVisibleRow,
} from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'
import { fetchPlanDeptSettings, type PlanDeptSettings } from '../../../lib/planPickingDepartments'
import { enrichWmsRowsWithPickingDepartment, getDepartmentOptionsForWmsRows } from '../../../lib/wmsPickingDepartmentEnrichment'
import {
  consolidateCondoStampWmsDisplayRows,
  getWmsConsolidatedRowIds,
  getCondoStampDisplayQty,
  getCondoStampLayersLabel,
} from '../../../lib/wmsCondoStampConsolidation'

const REQUISITION_SCOPE_PREFIX = 'req:'
const isRequisitionScope = (scopeId: string) => scopeId.startsWith(REQUISITION_SCOPE_PREFIX)
const requisitionNumberFromScope = (scopeId: string) => scopeId.slice(REQUISITION_SCOPE_PREFIX.length)
const reviewScopeFromRow = (row: any): string => {
  const workOrderId = String(row.work_order_id || '').trim()
  if (workOrderId) return workOrderId
  const orderId = String(row.order_id || '').trim()
  return orderId.startsWith('REQ-') ? `${REQUISITION_SCOPE_PREFIX}${orderId}` : ''
}

/** บันทึกเวลาเสร็จแผนก "เบิก" ใน plan_jobs.tracks (atomic merge) */
const ensurePlanDeptEnd = async (workOrderId: string) => {
  if (!workOrderId) return
  const now = new Date().toISOString()
  const patch: Record<string, Record<string, string>> = {}
  const procNames = ['หยิบของ', 'ส่งมอบ']
  procNames.forEach((p) => {
    patch[p] = { start_if_null: now, end: now }
  })
  const { error } = await supabase.rpc('merge_plan_tracks_by_work_order_id', {
    p_work_order_id: workOrderId,
    p_dept: 'เบิก',
    p_patch: patch,
  })
  if (error) console.error('ensurePlanDeptEnd error:', error.message)
}

const displayPickingDepartmentLabel = (dept: string): string => {
  if (dept === 'เบิก') return 'ETC'
  if (dept === 'ทั่วไป') return 'อะไหล่'
  return dept
}

export default function ReviewSection() {
  const [reviewDate, setReviewDate] = useState('')
  const [reviewOrderSelect, setReviewOrderSelect] = useState('') // work_order_id
  const [reviewOrderActualId, setReviewOrderActualId] = useState('') // work_order_id
  const [orderOptions, setOrderOptions] = useState<Array<{ value: string; label: string; hasUnchecked?: boolean }>>([])
  const [rowsByWorkOrder, setRowsByWorkOrder] = useState<Record<string, any[]>>({})
  const [reviewPendingOrders, setReviewPendingOrders] = useState<Array<{ id: string; label: string; total: number; unchecked: number }>>([])
  const [inspectItems, setInspectItems] = useState<any[]>([])
  const [currentTab, setCurrentTab] = useState('all')
  const [showCounter, setShowCounter] = useState(false)
  const [showTabs, setShowTabs] = useState(false)
  const [reviewDeptFilter, setReviewDeptFilter] = useState('')
  const [reviewPlanSettings, setReviewPlanSettings] = useState<PlanDeptSettings | null>(null)
  const [reviewDropdownLoading, setReviewDropdownLoading] = useState(false)
  const { showMessage, MessageModal } = useWmsModal({ showCancelButton: false })
  const reviewLoadRequestRef = useRef(0)
  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    setReviewDate(today)
  }, [])

  useEffect(() => {
    if (reviewDate) {
      loadReviewDropdown()
    } else {
      resetReviewUI()
    }
  }, [reviewDate])

  const resetReviewUI = () => {
    setShowCounter(false)
    setShowTabs(false)
    setInspectItems([])
    setCurrentTab('all')
    setReviewOrderActualId('')
    setReviewDeptFilter('')
    setReviewPlanSettings(null)
  }

  const enrichReleasedSourceOrders = async (rows: any[]): Promise<any[]> => {
    if (!rows || rows.length === 0) return rows
    const sourceIds = [...new Set(rows.map((r) => r.source_order_id).filter(Boolean))]
    if (sourceIds.length === 0) return rows

    const { data: releasedOrders } = await supabase
      .from('or_orders')
      .select('id, plan_released_from_work_order')
      .in('id', sourceIds as string[])

    const releasedMap = Object.fromEntries(
      (releasedOrders || []).map((o: any) => [o.id, !!o.plan_released_from_work_order])
    )

    return rows.map((r) => ({
      ...r,
      source_order_released: !!(r.source_order_id && releasedMap[r.source_order_id]),
    }))
  }

  const enrichRequisitionReviewRows = async (rows: any[]): Promise<any[]> => {
    if (!rows.length || rows.every((row) => row._requisition_meta_loaded)) return rows
    const requisitionNumbers = [...new Set(
      rows
        .filter((row) => reviewScopeFromRow(row).startsWith(REQUISITION_SCOPE_PREFIX))
        .map((row) => String(row.order_id || '').trim())
        .filter(Boolean)
    )]
    if (!requisitionNumbers.length) return rows

    const [requisitionsResult, itemsResult] = await Promise.all([
      supabase
        .from('wms_requisitions')
        .select('requisition_id, created_by, notes, requester:us_users!created_by(username)')
        .in('requisition_id', requisitionNumbers),
      supabase
        .from('wms_requisition_items')
        .select('requisition_id, product_code, requisition_topic, item_note')
        .in('requisition_id', requisitionNumbers),
    ])
    if (requisitionsResult.error || itemsResult.error) {
      console.error('enrichRequisitionReviewRows error:', requisitionsResult.error || itemsResult.error)
      return rows
    }

    const requisitionMap = new Map(
      (requisitionsResult.data || []).map((row: any) => [String(row.requisition_id), row])
    )
    const itemMap = new Map(
      (itemsResult.data || []).map((row: any) => [`${row.requisition_id}\u0000${row.product_code}`, row])
    )
    return rows.map((row) => {
      const requisitionNumber = String(row.order_id || '').trim()
      if (!requisitionNumbers.includes(requisitionNumber)) return row
      const requisition = requisitionMap.get(requisitionNumber) as any
      const requisitionItem = itemMap.get(`${requisitionNumber}\u0000${row.product_code}`) as any
      return {
        ...row,
        _requisition_meta_loaded: true,
        requisition_type: String(requisitionItem?.requisition_topic || '').trim() || '-',
        requisition_note: String(requisitionItem?.item_note || requisition?.notes || '').trim() || '-',
        requisition_requester: String(
          (Array.isArray(requisition?.requester) ? requisition.requester[0]?.username : requisition?.requester?.username) || '-'
        ),
      }
    })
  }

  const loadReviewDropdown = async (skipReset = true, showLoading = true) => {
    if (!skipReset) resetReviewUI()
    if (!reviewDate) return
    const requestId = ++reviewLoadRequestRef.current
    if (showLoading) setReviewDropdownLoading(true)

    const { data, error } = await supabase
      .from('wms_orders')
      .select(
        'id, work_order_id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released, stock_action'
      )
      .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
      .gte('created_at', reviewDate + 'T00:00:00')
      .lte('created_at', reviewDate + 'T23:59:59')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })

    if (error || !data) {
      if (requestId === reviewLoadRequestRef.current) {
        setRowsByWorkOrder({})
        setOrderOptions([{ value: '', label: 'โหลดรายการไม่สำเร็จ — กรุณาลองใหม่' }])
        setReviewPendingOrders([])
        setReviewDropdownLoading(false)
      }
      if (error) console.error('loadReviewDropdown error:', error)
      return
    }
    if (requestId !== reviewLoadRequestRef.current) return
    const [sourceEnrichedRows, requisitionEnrichedRows] = await Promise.all([
      enrichReleasedSourceOrders(data as any[]),
      enrichRequisitionReviewRows(data as any[]),
    ])
    const requisitionMetaById = new Map(
      requisitionEnrichedRows
        .filter((row) => row._requisition_meta_loaded)
        .map((row) => [row.id, row])
    )
    const enrichedRows = sourceEnrichedRows.map((row) => {
      const requisitionRow = requisitionMetaById.get(row.id)
      return requisitionRow ? { ...row, ...requisitionRow } : row
    })
    if (requestId !== reviewLoadRequestRef.current) return

    const groupedByWo: Record<string, any[]> = {}
    ;(enrichedRows as any[]).forEach((obj) => {
      const scopeId = reviewScopeFromRow(obj)
      if (!scopeId) return
      if (!groupedByWo[scopeId]) groupedByWo[scopeId] = []
      groupedByWo[scopeId].push(obj)
    })

    const workOrderIds = Object.keys(groupedByWo).filter((scopeId) => !isRequisitionScope(scopeId))
    const woNameById: Record<string, string> = {}
    if (workOrderIds.length > 0) {
      const { data: workOrders } = await supabase
        .from('or_work_orders')
        .select('id, work_order_name')
        .in('id', workOrderIds)
      ;(workOrders || []).forEach((wo: any) => {
        const id = String(wo.id || '')
        const name = String(wo.work_order_name || '').trim()
        if (id) woNameById[id] = name
      })
    }
    if (requestId !== reviewLoadRequestRef.current) return

    const grouped = Object.entries(groupedByWo).map(([scopeId, rows]) => {
      const first = rows[0] || {}
      const total = rows.length
      const picked = rows.filter((r) => r.status === 'picked').length
      const pending = rows.filter((r) => r.status === 'pending').length
      const shelfPending = rows.filter((r) => isWmsCancelledAwaitingPhysicalShelf(r)).length
      const uncheckedInspect = picked + shelfPending
      const requisitionScope = isRequisitionScope(scopeId)
      const nameFromWorkOrder = String(woNameById[scopeId] || '').trim()
      const nameFromRow = String(first.order_id || '').trim()
      const labelBase = requisitionScope
        ? `ใบเบิก ${nameFromRow}`
        : nameFromWorkOrder || nameFromRow || 'ไม่ระบุชื่อใบงาน'
      return {
        id: scopeId,
        label: labelBase,
        total,
        picked,
        pending,
        shelfPending,
        uncheckedInspect,
      }
    })

    // ใบงานที่พร้อมเข้าเมนูตรวจ: ต้องไม่มี pending
    // หมายเหตุ: รวมทั้งใบงานที่ "ตรวจเสร็จแล้ว" เพื่อให้เปิดมาเช็คซ้ำได้
    const completed = grouped.filter((o) => o.pending === 0)
    const currentSelected = reviewOrderSelect

    setRowsByWorkOrder(groupedByWo)
    setOrderOptions(
      completed.length
        ? [
            { value: '', label: '-- เลือกใบงานหรือใบเบิกที่จัดเสร็จแล้ว --' },
            ...completed.map((o) => ({
              value: o.id,
              label:
                o.uncheckedInspect > 0
                  ? `${o.label} (${o.total} รายการ) [ยังไม่ได้ตรวจ ${o.uncheckedInspect} รายการ]`
                  : `${o.label} (${o.total} รายการ) [ตรวจเสร็จแล้ว]`,
              hasUnchecked: o.uncheckedInspect > 0,
            })),
          ]
        : [{ value: '', label: 'ไม่มีใบงานหรือใบเบิกที่พร้อมตรวจ' }]
    )
    setReviewPendingOrders(
      completed
        .filter((o) => o.uncheckedInspect > 0)
        .sort((a, b) => b.uncheckedInspect - a.uncheckedInspect)
        .map((o) => ({ id: o.id, label: o.label, total: o.total, unchecked: o.uncheckedInspect }))
    )

    if (currentSelected && completed.some((o) => o.id === currentSelected)) {
      setReviewOrderSelect(currentSelected)
    } else if (currentSelected) {
      setReviewOrderSelect('')
    }
    if (requestId === reviewLoadRequestRef.current) setReviewDropdownLoading(false)
  }

  const startInspection = async (selectedOrderId?: string) => {
    const selectedScopeId = String(selectedOrderId || reviewOrderSelect || '')
    if (!selectedScopeId) {
      showMessage({ message: 'โปรดเลือกใบงานหรือใบเบิกที่ต้องการตรวจ!' })
      return
    }
    let rows: any[] = rowsByWorkOrder[selectedScopeId] ? [...rowsByWorkOrder[selectedScopeId]] : []
    if (rows.length === 0) {
      let query = supabase
        .from('wms_orders')
        .select('*')
        .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
      query = isRequisitionScope(selectedScopeId)
        ? query.eq('order_id', requisitionNumberFromScope(selectedScopeId))
        : query.eq('work_order_id', selectedScopeId)
      const { data, error } = await query
      if (error) console.error(error)
      rows = data || []
    }
    if (rows.length === 0) {
      showMessage({ message: 'ไม่พบข้อมูลรายการในใบงานนี้' })
      return
    }

    const canonicalScopeId = reviewScopeFromRow(rows[0]) || selectedScopeId
    const hasUnfinishedItems = rows.some((item) => item.status === 'pending')
    if (hasUnfinishedItems) {
      showMessage({ message: 'ไม่อนุญาตให้ตรวจเนื่องจากใบงานนี้ยังจัดไม่เสร็จสิ้น (มีรายการค้างจัด)' })
      return
    }

    const sourceEnrichedRows = await enrichReleasedSourceOrders(rows)
    const sortedData = sortOrderItems(await enrichRequisitionReviewRows(sourceEnrichedRows))
    let withDept: any[]
    if (isRequisitionScope(canonicalScopeId)) {
      withDept = consolidateCondoStampWmsDisplayRows(sortedData)
      setReviewPlanSettings(null)
    } else {
      const plan = await fetchPlanDeptSettings()
      withDept = consolidateCondoStampWmsDisplayRows(
        await enrichWmsRowsWithPickingDepartment(sortedData, plan)
      )
      setReviewPlanSettings(plan)
    }
    setReviewDeptFilter('')
    setReviewOrderSelect(canonicalScopeId)
    setReviewOrderActualId(canonicalScopeId)
    setInspectItems(withDept as any[])
    setShowCounter(true)
    setShowTabs(true)
    setCurrentTab('all')
  }

  const switchInspectTab = (tab: string) => {
    setCurrentTab(tab)
  }

  const setInspectStatus = async (id: string, newStatus: string) => {
    const item = inspectItems.find((i) => i.id === id)
    if (!item) return
    const targetIds = getWmsConsolidatedRowIds(item)
    let updateData: Record<string, any> = { status: newStatus }

    if (newStatus === 'wrong') updateData.error_count = (item?.error_count || 0) + 1
    if (newStatus === 'not_find') updateData.not_find_count = (item?.not_find_count || 0) + 1

    const currentWorkOrderId = reviewOrderActualId || reviewOrderSelect
    const previousRows = inspectItems
    const previousScopeRows = rowsByWorkOrder[currentWorkOrderId] || []
    const previousPendingOrders = reviewPendingOrders
    const previousOrderOptions = orderOptions
    const optimisticRows = inspectItems.map((i) => (i.id === id ? { ...i, ...updateData } : i))
    const sortedData = sortOrderItems(optimisticRows)
    const remainingUnchecked = sortedData.filter(
      (row) => row.status === 'picked' || isWmsCancelledAwaitingPhysicalShelf(row)
    ).length

    // แสดงผลทันที ไม่รอ trigger ตัดสต๊อก/FIFO และ query ประกอบอื่น ๆ ทำงานเสร็จ
    reviewLoadRequestRef.current += 1
    setReviewDropdownLoading(false)
    setInspectItems(sortedData)
    setRowsByWorkOrder((current) => ({
      ...current,
      [currentWorkOrderId]: (current[currentWorkOrderId] || []).map((row) =>
        targetIds.includes(row.id) ? { ...row, ...updateData } : row
      ),
    }))
    setReviewPendingOrders((current) => remainingUnchecked === 0
      ? current.filter((order) => order.id !== currentWorkOrderId)
      : current.map((order) => order.id === currentWorkOrderId ? { ...order, unchecked: remainingUnchecked } : order)
    )
    setOrderOptions((current) => current.map((option) => {
      if (option.value !== currentWorkOrderId) return option
      const statusLabel = remainingUnchecked > 0
        ? `[ยังไม่ได้ตรวจ ${remainingUnchecked} รายการ]`
        : '[ตรวจเสร็จแล้ว]'
      return {
        ...option,
        label: option.label.replace(/\[(?:ยังไม่ได้ตรวจ \d+ รายการ|ตรวจเสร็จแล้ว)\]/, statusLabel),
        hasUnchecked: remainingUnchecked > 0,
      }
    }))

    const { error: updateError } = await supabase.from('wms_orders').update(updateData).in('id', targetIds)
    if (updateError) {
      setInspectItems(previousRows)
      setRowsByWorkOrder((current) => ({ ...current, [currentWorkOrderId]: previousScopeRows }))
      setReviewPendingOrders(previousPendingOrders)
      setOrderOptions(previousOrderOptions)
      showMessage({ message: `อัปเดตผลตรวจไม่สำเร็จ: ${updateError.message}` })
      return
    }

    if (sortedData.length > 0) {
      const isFullyChecked = sortedData.every((i) =>
        ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
      )
      if (isFullyChecked) {
        const completionUpdate = supabase
          .from('wms_orders')
          .update({ end_time: new Date().toISOString() })
        if (isRequisitionScope(currentWorkOrderId)) {
          await completionUpdate
            .eq('order_id', requisitionNumberFromScope(currentWorkOrderId))
            .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        } else {
          await completionUpdate
            .eq('work_order_id', currentWorkOrderId)
            .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        }

        try {
          await saveFirstCheckSummary(String(sortedData[0]?.order_id || ''), sortedData)
        } catch (e) {
          console.error('saveFirstCheckSummary error:', e)
        }

        // Plan "เบิก" finish (⚡): ต้องสอดคล้องกับ isFullyChecked — รวมคืนคลัง/ไม่เจอ/หยิบผิด
        // เดิมเรียกเฉพาะเมื่อทุกแถว correct ทำให้กรณีย้ายบิลแล้วคืนเข้าคลังไม่ประทับเวลา
        if (!isRequisitionScope(currentWorkOrderId)) {
          await ensurePlanDeptEnd(currentWorkOrderId)
        }
      }
    }

    // อัปเดต dropdown (เปลี่ยนสีเมื่อตรวจครบ) + แจ้ง AdminLayout ให้อัปเดตตัวเลข badge
    loadReviewDropdown(true, false)
    window.dispatchEvent(new Event('wms-data-changed'))
  }

  const saveFirstCheckSummary = async (oid: string, items: any[]) => {
    const { data: existing } = await supabase
      .from('wms_order_summaries')
      .select('id')
      .eq('order_id', oid)
      .single()

    if (existing) return

    const lineCount = (i: any) => Number(i._consolidated_line_count || 1)
    const total = items.reduce((s, i) => s + lineCount(i), 0)
    const correct = items.reduce((s, i) => s + (i.status === 'correct' ? lineCount(i) : 0), 0)
    const wrong = items.reduce((s, i) => s + (i.status === 'wrong' ? lineCount(i) : 0), 0)
    const notFind = items.reduce((s, i) => s + (i.status === 'not_find' ? lineCount(i) : 0), 0)
    const accuracy = total > 0 ? ((correct / total) * 100).toFixed(2) : 0

    await supabase.from('wms_order_summaries').insert([
      {
        order_id: oid,
        picker_id: items[0]?.assigned_to || null,
        total_items: total,
        correct_at_first_check: correct,
        wrong_at_first_check: wrong,
        not_find_at_first_check: notFind,
        accuracy_percent: accuracy,
        checked_at: new Date().toISOString(),
      },
    ])
  }

  const counts = {
    all: inspectItems.length,
    picked: inspectItems.filter((i) => i.status === 'picked').length,
    correct: inspectItems.filter((i) => i.status === 'correct').length,
    wrong: inspectItems.filter((i) => i.status === 'wrong').length,
    not_find: inspectItems.filter((i) => i.status === 'not_find').length,
    returned: inspectItems.filter((i) => i.status === 'returned' || isWmsCancelledAwaitingPhysicalShelf(i)).length,
  }

  const checkedCount = inspectItems.filter((i) =>
    ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
  ).length

  const deptViewItems = reviewDeptFilter
    ? inspectItems.filter((i) => String(i.picking_department || '') === reviewDeptFilter)
    : []
  const deptCheckedCount = deptViewItems.filter((i) =>
    ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
  ).length

  let filtered = inspectItems
  if (currentTab === 'all') filtered = inspectItems.filter((i) => isWmsReviewVisibleRow(i))
  if (currentTab === 'picked') filtered = inspectItems.filter((i) => i.status === 'picked')
  if (currentTab === 'correct') filtered = inspectItems.filter((i) => i.status === 'correct')
  if (currentTab === 'wrong') filtered = inspectItems.filter((i) => i.status === 'wrong')
  if (currentTab === 'not_find') filtered = inspectItems.filter((i) => i.status === 'not_find')
  if (currentTab === 'returned')
    filtered = inspectItems.filter((i) => i.status === 'returned' || isWmsCancelledAwaitingPhysicalShelf(i))

  if (reviewDeptFilter) {
    filtered = filtered.filter((i) => String(i.picking_department || '') === reviewDeptFilter)
  }

  return (
    <section>
      <div className="flex justify-between items-end mb-6 flex-wrap gap-4">
        <div>
          <div className="flex gap-2 items-end flex-wrap">
            <div>
              <label className="text-sm font-bold text-gray-700 uppercase block mb-1">1. เลือกวันที่</label>
              <input
                type="date"
                value={reviewDate}
                onChange={(e) => {
                  // ยกเลิกผลโหลดของวันเดิมและล้างรายการที่กำลังแสดงทันที
                  reviewLoadRequestRef.current += 1
                  setReviewDate(e.target.value)
                  setReviewOrderSelect('')
                  setReviewDropdownLoading(true)
                  setRowsByWorkOrder({})
                  setOrderOptions([{ value: '', label: 'กำลังโหลดรายการ...' }])
                  setReviewPendingOrders([])
                  resetReviewUI()
                }}
                className="border px-2 rounded-lg text-sm shadow-sm outline-none h-[42px]"
              />
            </div>
            <div>
              <label className="text-sm font-bold text-gray-700 uppercase block mb-1">2. เลือกใบงาน / ใบเบิก</label>
              <select
                value={reviewOrderSelect}
                disabled={reviewDropdownLoading}
                onChange={(e) => {
                  setReviewOrderSelect(e.target.value)
                  resetReviewUI()
                }}
                className="border px-2.5 rounded-lg w-96 text-sm shadow-sm outline-none h-[42px] disabled:bg-gray-100 disabled:text-gray-400"
              >
                {orderOptions.map((opt, idx) => (
                  <option key={idx} value={opt.value} style={opt.hasUnchecked ? { color: 'red', fontWeight: 'bold' } : {}}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => startInspection()}
              disabled={reviewDropdownLoading || !reviewOrderSelect}
              className="bg-blue-600 text-white px-6 h-[42px] rounded-lg font-bold shadow-md hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reviewDropdownLoading ? 'กำลังโหลด...' : 'เริ่มเช็คสินค้า'}
            </button>
            {showTabs && inspectItems.length > 0 && reviewPlanSettings && (
              <div>
                <label className="text-sm font-bold text-gray-700 uppercase block mb-1">
                  3. มุมมองแผนก <span className="normal-case text-gray-500 font-semibold text-xs">(กรองแสดงอย่างเดียว)</span>
                </label>
                <select
                  value={reviewDeptFilter}
                  onChange={(e) => setReviewDeptFilter(e.target.value)}
                  className="border px-2.5 rounded-lg w-72 text-sm shadow-sm outline-none h-[42px]"
                >
                  <option value="">ทั้งหมด — ใบงาน</option>
                  {getDepartmentOptionsForWmsRows(reviewPlanSettings, inspectItems).map((d) => (
                    <option key={d} value={d}>
                      {displayPickingDepartmentLabel(d)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
        {showCounter && (
          <div className="bg-white px-4 py-3 rounded-2xl shadow-lg border-t-[3px] border-blue-600 text-center min-w-[180px] flex flex-col items-center gap-1.5">
            <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest">ตรวจแล้ว / ทั้งหมด</div>
            <div className="text-4xl leading-none font-black text-blue-600">
              {checkedCount} / {inspectItems.length}
            </div>
            {reviewDeptFilter && deptViewItems.length > 0 && (
              <div className="text-[11px] font-bold text-slate-600 leading-snug">
                แผนก {displayPickingDepartmentLabel(reviewDeptFilter)}: {deptCheckedCount} / {deptViewItems.length} ในมุมมองนี้
                <div className="text-[9px] font-semibold text-slate-400 mt-0.5">การปิดงาน/ซิงค์ Plan ยังอิงทุกแถวด้านบน</div>
              </div>
            )}
          </div>
        )}
      </div>
      {reviewPendingOrders.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <h3 className="text-sm font-semibold text-red-800 mb-3 flex items-center gap-2">
            รายการใบงานและใบเบิกที่ต้องตรวจเพิ่มเติม
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-600 text-white text-xs font-bold">
              {reviewPendingOrders.length}
            </span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {reviewPendingOrders.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => startInspection(o.id)}
                className="px-3 py-1.5 bg-white border border-red-300 rounded-lg text-sm text-red-700 hover:bg-red-100 font-medium transition-colors"
              >
                {o.label} → ตรวจเพิ่ม ({o.unchecked}/{o.total})
              </button>
            ))}
          </div>
        </div>
      )}
      {showTabs && (
        <div className="flex gap-4 border-b mb-4 px-4 overflow-x-auto">
          <div
            onClick={() => switchInspectTab('all')}
            className={`inspect-tab pb-2 text-sm font-bold whitespace-nowrap ${currentTab === 'all' ? 'inspect-tab-active' : ''}`}
          >
            ทั้งหมด <span>({counts.all})</span>
          </div>
          <div
            onClick={() => switchInspectTab('picked')}
            className={`inspect-tab pb-2 text-sm font-bold text-gray-500 whitespace-nowrap ${
              currentTab === 'picked' ? 'inspect-tab-active' : ''
            }`}
          >
            ยังไม่ได้ตรวจ <span>({counts.picked})</span>
          </div>
          <div
            onClick={() => switchInspectTab('correct')}
            className={`inspect-tab pb-2 text-sm font-bold text-green-600 whitespace-nowrap ${
              currentTab === 'correct' ? 'inspect-tab-correct-active' : ''
            }`}
          >
            หยิบถูก <span>({counts.correct})</span>
          </div>
          <div
            onClick={() => switchInspectTab('wrong')}
            className={`inspect-tab pb-2 text-sm font-bold text-red-600 whitespace-nowrap ${
              currentTab === 'wrong' ? 'inspect-tab-active' : ''
            }`}
          >
            หยิบผิด <span>({counts.wrong})</span>
          </div>
          <div
            onClick={() => switchInspectTab('not_find')}
            className={`inspect-tab pb-2 text-sm font-bold text-orange-500 whitespace-nowrap ${
              currentTab === 'not_find' ? 'inspect-tab-active' : ''
            }`}
          >
            ไม่มีสินค้า <span>({counts.not_find})</span>
          </div>
          <div
            onClick={() => switchInspectTab('returned')}
            className={`inspect-tab pb-2 text-sm font-bold text-slate-600 whitespace-nowrap ${
              currentTab === 'returned' ? 'inspect-tab-active' : ''
            }`}
          >
            คืนคลัง <span>({counts.returned})</span>
          </div>
        </div>
      )}
      <div className="bg-white rounded-3xl shadow-sm border overflow-hidden">
        <div className="divide-y">
          {filtered.length === 0 ? (
            <div className="p-20 text-center text-gray-300 italic">
              {inspectItems.length === 0 ? 'เลือกวันที่และใบงานหรือใบเบิกเพื่อเริ่มการตรวจสอบ' : `ไม่มีรายการในหมวดหมู่ ${currentTab.toUpperCase()}`}
            </div>
          ) : (
            filtered.map((item, idx) => {
              let statusBoxClass = ''
              if (item.status === 'correct') statusBoxClass = 'border-green-500 text-green-500'
              else if (item.status === 'wrong') statusBoxClass = 'border-red-500 text-red-500'
              else if (item.status === 'not_find') statusBoxClass = 'border-orange-500 text-orange-500'
              else if (item.status === 'returned') statusBoxClass = 'border-slate-500 text-slate-600'
              else if (isWmsCancelledAwaitingPhysicalShelf(item))
                statusBoxClass = 'border-slate-500 text-slate-600'

              const awaitingShelfAfterBillCancel = isWmsCancelledAwaitingPhysicalShelf(item)
              const isMovedFromPlan = !!(item.plan_line_released || item.source_order_released)
              const needsReleaseReturn =
                isMovedFromPlan && ['picked', 'correct', 'system_complete'].includes(item.status)

              return (
                <div
                  key={item._consolidated_wms_ids?.length ? item._consolidated_wms_ids.join('-') : item.id}
                  className="p-4 flex items-center justify-between hover:bg-gray-50 transition"
                >
                  <div className="flex items-center gap-6 w-1/3">
                    <div className="text-xl font-black text-gray-300 w-8 text-center">{idx + 1}</div>
                    <img
                      src={item.product_code === 'SPARE_PART' ? getProductImageUrl('spare_part') : getProductImageUrl(item.product_code)}
                      className="w-20 h-20 object-cover rounded-xl border shadow-sm"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement
                        target.src = 'https://placehold.co/200x200?text=NO+IMAGE'
                      }}
                      alt={item.product_name}
                    />
                    <div>
                      <div className="text-[18.66px] font-black text-slate-800 leading-tight mb-1">{item.product_name}</div>
                      <div className="text-[16px] font-bold text-gray-400">
                        จุดจัดเก็บ: {item.location || '-'} | จำนวน: {getCondoStampDisplayQty(item)}{' '}
                        {item.unit_name || 'ชิ้น'}
                        {getCondoStampLayersLabel(item) ? ` ${getCondoStampLayersLabel(item)}` : ''}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        รหัสสินค้า: <span className="font-semibold text-gray-600">{item.product_code || '-'}</span>
                        {item.item_uid ? (
                          <>
                            {' '}| รหัสรายการ: <span className="font-semibold text-gray-600">{item.item_uid}</span>
                          </>
                        ) : null}
                      </div>
                      {item._requisition_meta_loaded && (
                        <div className="mt-2 grid gap-x-4 gap-y-1 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-slate-700 sm:grid-cols-3">
                          <div>
                            <span className="font-bold text-blue-700">ประเภทใบเบิก:</span>{' '}
                            {item.requisition_type || '-'}
                          </div>
                          <div>
                            <span className="font-bold text-blue-700">หมายเหตุการเบิก:</span>{' '}
                            <span className="break-words">{item.requisition_note || '-'}</span>
                          </div>
                          <div>
                            <span className="font-bold text-blue-700">ผู้เบิก:</span>{' '}
                            {item.requisition_requester || '-'}
                          </div>
                        </div>
                      )}
                      {awaitingShelfAfterBillCancel && (
                        <div className="text-xs font-bold text-rose-800 mt-1">
                          บิลยกเลิกหลังหยิบ — ตัดจอง/คืนสต๊อคในระบบแล้ว กดคืนคลังเมื่อเก็บของกลับที่จัดเก็บ
                        </div>
                      )}
                      {isMovedFromPlan && (
                        <div className="text-xs font-bold text-amber-800 mt-1">
                          บิลถูกย้ายออกจากใบงาน — กดคืนเข้าคลังเมื่อตรวจแล้ว
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 text-center px-4">
                    {(['correct', 'wrong', 'not_find', 'returned'].includes(item.status) ||
                      awaitingShelfAfterBillCancel) && (
                      <div className={`border-2 ${statusBoxClass} font-black px-6 py-2 rounded-xl text-lg uppercase tracking-wider`}>
                        สถานะ:{' '}
                        {awaitingShelfAfterBillCancel
                          ? 'รอคืนคลัง (บิลยกเลิก)'
                          : WMS_STATUS_LABELS[item.status] || item.status}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 w-1/3 justify-end">
                    {awaitingShelfAfterBillCancel ? (
                      <button
                        type="button"
                        onClick={() => setInspectStatus(item.id, 'returned')}
                        className="h-14 px-6 rounded-2xl font-black bg-slate-700 text-white hover:bg-slate-800 shadow-md transition"
                      >
                        คืนคลัง
                      </button>
                    ) : needsReleaseReturn ? (
                      <button
                        type="button"
                        onClick={() => setInspectStatus(item.id, 'returned')}
                        className="h-14 px-6 rounded-2xl font-black bg-slate-700 text-white hover:bg-slate-800 shadow-md transition"
                      >
                        คืนเข้าคลัง
                      </button>
                    ) : item.status === 'returned' ? (
                      <span className="text-sm text-gray-400 font-semibold">ดำเนินการแล้ว</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setInspectStatus(item.id, 'not_find')}
                          className="h-14 px-4 rounded-2xl font-black border-2 border-orange-200 text-orange-500 hover:bg-orange-50 transition"
                        >
                          ไม่เจอ
                        </button>
                        <button
                          type="button"
                          onClick={() => setInspectStatus(item.id, 'wrong')}
                          className={`h-14 px-4 rounded-2xl font-black border-2 border-red-200 transition ${
                            item.status === 'wrong' ? 'bg-red-600 text-white' : 'text-red-500 hover:bg-red-50'
                          }`}
                        >
                          หยิบผิด
                        </button>
                        <button
                          type="button"
                          onClick={() => setInspectStatus(item.id, 'correct')}
                          className="h-14 px-4 rounded-2xl font-black bg-green-500 text-white hover:bg-green-600 shadow-md transition"
                        >
                          หยิบถูก
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
      {MessageModal}
    </section>
  )
}
