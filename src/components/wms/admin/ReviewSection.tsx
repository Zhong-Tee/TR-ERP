import { useState, useEffect, useRef, useCallback } from 'react'
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
  const [planBackfillLoading, setPlanBackfillLoading] = useState(false)
  const [reviewDeptFilter, setReviewDeptFilter] = useState('')
  const [reviewPlanSettings, setReviewPlanSettings] = useState<PlanDeptSettings | null>(null)
  const { showMessage, MessageModal } = useWmsModal()
  const inspectResyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  useEffect(() => {
    return () => {
      if (inspectResyncTimerRef.current) clearTimeout(inspectResyncTimerRef.current)
    }
  }, [])

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

  const fetchInspectRows = useCallback(async (workOrderId: string): Promise<any[]> => {
    if (!workOrderId) return []
    const { data, error } = await supabase
      .from('wms_orders')
      .select('*')
      .eq('work_order_id', workOrderId)
      .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    if (error) {
      console.error('fetchInspectRows error:', error)
      return []
    }
    const sorted = sortOrderItems(await enrichReleasedSourceOrders((data || []) as any[]))
    const plan = await fetchPlanDeptSettings()
    setReviewPlanSettings(plan)
    const enriched = await enrichWmsRowsWithPickingDepartment(sorted, plan)
    return consolidateCondoStampWmsDisplayRows(enriched as any[])
  }, [])

  const scheduleInspectResync = useCallback((workOrderId: string) => {
    if (!workOrderId) return
    if (inspectResyncTimerRef.current) clearTimeout(inspectResyncTimerRef.current)
    inspectResyncTimerRef.current = setTimeout(async () => {
      const currentWorkOrderId = reviewOrderActualId || reviewOrderSelect
      if (!currentWorkOrderId || currentWorkOrderId !== workOrderId) return
      const fresh = await fetchInspectRows(workOrderId)
      if (fresh.length > 0) setInspectItems(fresh)
    }, 1200)
  }, [fetchInspectRows, reviewOrderActualId, reviewOrderSelect])

  const loadReviewDropdown = async (skipReset = true) => {
    if (!skipReset) resetReviewUI()
    if (!reviewDate) return

    const { data } = await supabase
      .from('wms_orders')
      .select(
        'id, work_order_id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released, stock_action'
      )
      .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
      .gte('created_at', reviewDate + 'T00:00:00')
      .lte('created_at', reviewDate + 'T23:59:59')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })

    if (!data) return
    const enrichedRows = await enrichReleasedSourceOrders(data as any[])

    const groupedByWo: Record<string, any[]> = {}
    ;(enrichedRows as any[]).forEach((obj) => {
      const wid = String(obj.work_order_id || '')
      if (!wid) return
      if (!groupedByWo[wid]) groupedByWo[wid] = []
      groupedByWo[wid].push(obj)
    })

    setRowsByWorkOrder(groupedByWo)

    const workOrderIds = Object.keys(groupedByWo)
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

    const grouped = Object.entries(groupedByWo).map(([woId, rows]) => {
      const first = rows[0] || {}
      const total = rows.length
      const picked = rows.filter((r) => r.status === 'picked').length
      const pending = rows.filter((r) => r.status === 'pending').length
      const shelfPending = rows.filter((r) => isWmsCancelledAwaitingPhysicalShelf(r)).length
      const uncheckedInspect = picked + shelfPending
      const nameFromWorkOrder = String(woNameById[woId] || '').trim()
      const nameFromRow = String(first.order_id || '').trim()
      const labelBase = nameFromWorkOrder || nameFromRow || 'ไม่ระบุชื่อใบงาน'
      return {
        id: woId,
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

    setOrderOptions(
      completed.length
        ? [
            { value: '', label: '-- เลือกใบงานที่จัดเสร็จแล้ว --' },
            ...completed.map((o) => ({
              value: o.id,
              label:
                o.uncheckedInspect > 0
                  ? `${o.label} (${o.total} รายการ) [ยังไม่ได้ตรวจ ${o.uncheckedInspect} รายการ]`
                  : `${o.label} (${o.total} รายการ) [ตรวจเสร็จแล้ว]`,
              hasUnchecked: o.uncheckedInspect > 0,
            })),
          ]
        : [{ value: '', label: 'ไม่มีใบงานที่พร้อมตรวจ' }]
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
  }

  const startInspection = async (selectedOrderId?: string) => {
    const selectedWoId = String(selectedOrderId || reviewOrderSelect || '')
    if (!selectedWoId) {
      showMessage({ message: 'โปรดเลือกใบงานที่ต้องการตรวจ!' })
      return
    }
    let rows: any[] = rowsByWorkOrder[selectedWoId] ? [...rowsByWorkOrder[selectedWoId]] : []
    if (rows.length === 0) {
      const { data, error } = await supabase
        .from('wms_orders')
        .select('*')
        .eq('work_order_id', selectedWoId)
        .or(WMS_REVIEW_INCLUDE_CANCELLED_RECALLED_OR)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
      if (error) console.error(error)
      rows = data || []
    }
    if (rows.length === 0) {
      showMessage({ message: 'ไม่พบข้อมูลรายการในใบงานนี้' })
      return
    }

    const canonicalWorkOrderId = String(rows[0]?.work_order_id || selectedWoId)
    const hasUnfinishedItems = rows.some((item) => item.status === 'pending')
    if (hasUnfinishedItems) {
      showMessage({ message: 'ไม่อนุญาตให้ตรวจเนื่องจากใบงานนี้ยังจัดไม่เสร็จสิ้น (มีรายการค้างจัด)' })
      return
    }

    const plan = await fetchPlanDeptSettings()
    const sortedData = sortOrderItems(await enrichReleasedSourceOrders(rows))
    const withDept = consolidateCondoStampWmsDisplayRows(
      await enrichWmsRowsWithPickingDepartment(sortedData, plan)
    )
    setReviewPlanSettings(plan)
    setReviewDeptFilter('')
    setReviewOrderSelect(canonicalWorkOrderId)
    setReviewOrderActualId(canonicalWorkOrderId)
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

    await supabase.from('wms_orders').update(updateData).in('id', targetIds)

    const currentWorkOrderId = reviewOrderActualId || reviewOrderSelect
    const optimisticRows = inspectItems.map((i) => (i.id === id ? { ...i, ...updateData } : i))
    const sortedData = sortOrderItems(await enrichReleasedSourceOrders(optimisticRows))
    setInspectItems(sortedData)
    scheduleInspectResync(currentWorkOrderId)

    if (sortedData.length > 0) {
      const isFullyChecked = sortedData.every((i) =>
        ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
      )
      if (isFullyChecked) {
        await supabase
          .from('wms_orders')
          .update({ end_time: new Date().toISOString() })
          .eq('work_order_id', currentWorkOrderId)
          .or(WMS_FULFILLMENT_PICK_OR_LEGACY)

        try {
          await saveFirstCheckSummary(String(sortedData[0]?.order_id || ''), sortedData)
        } catch (e) {
          console.error('saveFirstCheckSummary error:', e)
        }

        // Plan "เบิก" finish (⚡): ต้องสอดคล้องกับ isFullyChecked — รวมคืนคลัง/ไม่เจอ/หยิบผิด
        // เดิมเรียกเฉพาะเมื่อทุกแถว correct ทำให้กรณีย้ายบิลแล้วคืนเข้าคลังไม่ประทับเวลา
        await ensurePlanDeptEnd(currentWorkOrderId)
      }
    }

    // อัปเดต dropdown (เปลี่ยนสีเมื่อตรวจครบ) + แจ้ง AdminLayout ให้อัปเดตตัวเลข badge
    loadReviewDropdown()
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

  const inspectFullyChecked = inspectItems.length > 0 && checkedCount === inspectItems.length

  const deptViewItems = reviewDeptFilter
    ? inspectItems.filter((i) => String(i.picking_department || '') === reviewDeptFilter)
    : []
  const deptCheckedCount = deptViewItems.filter((i) =>
    ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
  ).length

  const backfillPlanPickEndForCurrentWorkOrder = async (force: boolean) => {
    const wid = reviewOrderActualId || reviewOrderSelect
    if (!wid || !inspectFullyChecked) return
    setPlanBackfillLoading(true)
    try {
      const { data, error } = await supabase.rpc('rpc_backfill_plan_pick_end_from_wms', {
        p_work_order_id: wid,
        p_force: force,
      })
      if (error) {
        showMessage({ message: 'ซิงค์ Plan ไม่สำเร็จ: ' + error.message })
        return
      }
      const row = data as { success?: boolean; error?: string; updated_count?: number; skipped?: unknown[] } | null
      if (!row?.success) {
        showMessage({ message: row?.error || 'ซิงค์ Plan ไม่สำเร็จ' })
        return
      }
      if ((row.updated_count || 0) > 0) {
        showMessage({ message: 'อัปเดตเวลาเสร็จเบิกใน Plan แล้ว' })
      } else {
        const sk = Array.isArray(row.skipped) ? row.skipped[0] : null
        const reason =
          sk && typeof sk === 'object' && sk !== null && 'reason' in sk
            ? String((sk as { reason?: string }).reason || '')
            : ''
        showMessage({
          message:
            reason === 'already_stamped'
              ? 'Plan มีเวลาเสร็จเบิกอยู่แล้ว — ใช้ "บังคับเขียนทับ" หากต้องการแก้'
              : reason === 'inspect_not_complete'
                ? 'ยังตรวจไม่ครบตามระบบ — ไม่ได้อัปเดต Plan'
                : 'ไม่มีการเปลี่ยนแปลง (ดูเหตุผลใน skipped)',
        })
      }
    } finally {
      setPlanBackfillLoading(false)
    }
  }

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
          <h2 className="text-3xl font-black text-slate-800">ตรวจสินค้า</h2>
          <div className="flex gap-2 mt-4 items-end flex-wrap">
            <div>
              <label className="text-sm font-bold text-gray-700 uppercase block mb-1">1. เลือกวันที่</label>
              <input
                type="date"
                value={reviewDate}
                onChange={(e) => {
                  setReviewDate(e.target.value)
                  setReviewOrderSelect('')
                  setReviewOrderActualId('')
                }}
                className="border px-2 rounded-lg text-sm shadow-sm outline-none h-[42px]"
              />
            </div>
            <div>
              <label className="text-sm font-bold text-gray-700 uppercase block mb-1">2. เลือกใบงาน</label>
              <select
                value={reviewOrderSelect}
                onChange={(e) => {
                  setReviewOrderSelect(e.target.value)
                  resetReviewUI()
                }}
                className="border px-2.5 rounded-lg w-96 text-sm shadow-sm outline-none h-[42px]"
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
              className="bg-blue-600 text-white px-6 h-[42px] rounded-lg font-bold shadow-md hover:bg-blue-700"
            >
              เริ่มเช็คสินค้า
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
          <div className="bg-white p-6 rounded-3xl shadow-xl border-t-4 border-blue-600 text-center min-w-[200px] flex flex-col items-center gap-3">
            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Checked / Total</div>
            <div className="text-6xl font-black text-blue-600">
              {checkedCount} / {inspectItems.length}
            </div>
            {reviewDeptFilter && deptViewItems.length > 0 && (
              <div className="text-xs font-bold text-slate-600 leading-snug">
                แผนก {displayPickingDepartmentLabel(reviewDeptFilter)}: {deptCheckedCount} / {deptViewItems.length} ในมุมมองนี้
                <div className="text-[10px] font-semibold text-slate-400 mt-0.5">การปิดงาน/ซิงค์ Plan ยังอิงทุกแถวด้านบน</div>
              </div>
            )}
            {inspectFullyChecked && (reviewOrderActualId || reviewOrderSelect) && (
              <div className="flex flex-col gap-2 w-full max-w-[220px]">
                <button
                  type="button"
                  disabled={planBackfillLoading}
                  onClick={() => backfillPlanPickEndForCurrentWorkOrder(false)}
                  className="text-xs font-bold bg-slate-700 text-white px-3 py-2 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  {planBackfillLoading ? 'กำลังซิงค์…' : 'ซิงค์เวลาเสร็จเบิก → Plan (ย้อนหลัง)'}
                </button>
                <button
                  type="button"
                  disabled={planBackfillLoading}
                  onClick={() => backfillPlanPickEndForCurrentWorkOrder(true)}
                  className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 underline disabled:opacity-50"
                >
                  บังคับเขียนทับเวลาใน Plan
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {reviewPendingOrders.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
          <h3 className="text-sm font-semibold text-red-800 mb-3 flex items-center gap-2">
            รายการใบงานที่ต้องตรวจเพิ่มเติม
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
              {inspectItems.length === 0 ? 'เลือกวันที่และใบงานเพื่อเริ่มการตรวจสอบ' : `ไม่มีรายการในหมวดหมู่ ${currentTab.toUpperCase()}`}
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
                      <div className="text-xs text-gray-400 mt-1">
                        UID: {item.item_uid || '-'} | WMS: {String(item.id || '').slice(0, 8)}
                      </div>
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
