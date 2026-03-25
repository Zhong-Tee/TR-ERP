import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems, WMS_STATUS_LABELS, WMS_FULFILLMENT_PICK_OR_LEGACY } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

const normalizeOrderId = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, '')
    .trim()
    .toUpperCase()

/** บันทึกเวลาเสร็จแผนก "เบิก" ใน plan_jobs.tracks (atomic merge) */
const ensurePlanDeptEnd = async (workOrderName: string) => {
  if (!workOrderName) return
  const now = new Date().toISOString()
  const patch: Record<string, Record<string, string>> = {}
  const procNames = ['หยิบของ', 'เสร็จแล้ว']
  procNames.forEach((p) => {
    patch[p] = { start_if_null: now, end: now }
  })
  const { error } = await supabase.rpc('merge_plan_tracks_by_name', {
    p_job_name: workOrderName,
    p_dept: 'เบิก',
    p_patch: patch,
  })
  if (error) console.error('ensurePlanDeptEnd error:', error.message)
}

export default function ReviewSection() {
  const [reviewDate, setReviewDate] = useState('')
  const [reviewOrderSelect, setReviewOrderSelect] = useState('')
  const [reviewOrderActualId, setReviewOrderActualId] = useState('')
  const [orderOptions, setOrderOptions] = useState<Array<{ value: string; normKey?: string; label: string; hasUnchecked?: boolean }>>([])
  const [rowsByOrderRaw, setRowsByOrderRaw] = useState<Record<string, any[]>>({})
  const [rowsByOrderNorm, setRowsByOrderNorm] = useState<Record<string, any[]>>({})
  const [reviewPendingOrders, setReviewPendingOrders] = useState<Array<{ id: string; total: number; unchecked: number }>>([])
  const [inspectItems, setInspectItems] = useState<any[]>([])
  const [currentTab, setCurrentTab] = useState('all')
  const [showCounter, setShowCounter] = useState(false)
  const [showTabs, setShowTabs] = useState(false)
  const { showMessage, MessageModal } = useWmsModal()

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

  const loadReviewDropdown = async (skipReset = true) => {
    if (!skipReset) resetReviewUI()
    if (!reviewDate) return

    const { data } = await supabase
      .from('wms_orders')
      .select(
        'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
      )
      .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
      .neq('status', 'cancelled')
      .gte('created_at', reviewDate + 'T00:00:00')
      .lte('created_at', reviewDate + 'T23:59:59')

    if (!data) return
    const enrichedRows = await enrichReleasedSourceOrders(data as any[])

    const groupedRowsByNorm: Record<string, any[]> = {}
    const groupedRowsByRaw: Record<string, any[]> = {}
    ;(enrichedRows as any[]).forEach((obj) => {
      const norm = normalizeOrderId(obj.order_id)
      if (!groupedRowsByNorm[norm]) groupedRowsByNorm[norm] = []
      groupedRowsByNorm[norm].push(obj)
      const raw = String(obj.order_id || '')
      if (!groupedRowsByRaw[raw]) groupedRowsByRaw[raw] = []
      groupedRowsByRaw[raw].push(obj)
    })

    setRowsByOrderRaw(groupedRowsByRaw)
    setRowsByOrderNorm(groupedRowsByNorm)

    const grouped = Object.entries(groupedRowsByRaw).map(([rawId, rows]) => {
      const first = rows[0] || {}
      const total = rows.length
      const picked = rows.filter((r) => r.status === 'picked').length
      const pending = rows.filter((r) => r.status === 'pending').length
      return {
        key: rawId,
        normKey: normalizeOrderId(rawId),
        id: String(first.order_id || rawId),
        total,
        picked,
        pending,
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
              normKey: o.normKey,
              label:
                o.picked > 0
                  ? `${o.id} (${o.total} รายการ) [ยังไม่ได้ตรวจ ${o.picked} รายการ]`
                  : `${o.id} (${o.total} รายการ) [ตรวจเสร็จแล้ว]`,
              hasUnchecked: o.picked > 0,
            })),
          ]
        : [{ value: '', label: 'ไม่มีใบงานที่พร้อมตรวจ' }]
    )
    setReviewPendingOrders(
      completed
        .filter((o) => o.picked > 0)
        .sort((a, b) => b.picked - a.picked)
        .map((o) => ({ id: o.id, total: o.total, unchecked: o.picked }))
    )

    if (currentSelected && completed.some((o) => o.id === currentSelected)) {
      setReviewOrderSelect(currentSelected)
    } else if (currentSelected) {
      setReviewOrderSelect('')
    }
  }

  const startInspection = async (selectedOrderId?: string) => {
    const selectedRawId = String(selectedOrderId || reviewOrderSelect || '')
    if (!selectedRawId) {
      showMessage({ message: 'โปรดเลือกใบงานที่ต้องการตรวจ!' })
      return
    }

    const rawTarget = selectedRawId
    const trimmedTarget = rawTarget.trim()
    const normalizedTarget = normalizeOrderId(rawTarget)
    let rows: any[] = rowsByOrderRaw[rawTarget]
      ? [...rowsByOrderRaw[rawTarget]]
      : (rowsByOrderNorm[normalizedTarget] ? [...rowsByOrderNorm[normalizedTarget]] : [])

    let error: any = null
    if (rows.length === 0) {
      const { data, error: firstErr } = await supabase
        .from('wms_orders')
        .select(
          'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
        )
        .eq('order_id', rawTarget)
        .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        .neq('status', 'cancelled')
      error = firstErr
      if (!firstErr && data && data.length > 0) rows = data
    }

    // fallback 1: ลองเทียบด้วยค่าที่ trim แล้ว (กันเคสช่องว่างหัว/ท้าย)
    if (rows.length === 0 && trimmedTarget !== rawTarget) {
      const { data: trimData, error: trimErr } = await supabase
        .from('wms_orders')
        .select(
          'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
        )
        .eq('order_id', trimmedTarget)
        .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        .neq('status', 'cancelled')
      if (!trimErr && trimData && trimData.length > 0) {
        rows = trimData
      }
    }

    // fallback 2: ค้นหาแบบ ilike เมื่อรูปแบบรหัสมีความต่างเล็กน้อย
    if (rows.length === 0 && trimmedTarget) {
      const likeTarget = trimmedTarget.replace(/\s+/g, '%')
      const { data: fuzzyData, error: fuzzyErr } = await supabase
        .from('wms_orders')
        .select(
          'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
        )
        .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        .neq('status', 'cancelled')
        .ilike('order_id', `%${likeTarget}%`)
      if (!fuzzyErr && fuzzyData && fuzzyData.length > 0) {
        rows = fuzzyData.filter((r: any) => normalizeOrderId(r.order_id) === normalizedTarget)
      }
    }

    // fallback สำหรับเคส order_id มีช่องว่าง/รูปแบบต่างกันเล็กน้อย
    if (rows.length === 0 && reviewDate) {
      const { data: dayRows, error: dayErr } = await supabase
        .from('wms_orders')
        .select(
          'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
        )
        .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        .neq('status', 'cancelled')
        .gte('created_at', reviewDate + 'T00:00:00')
        .lte('created_at', reviewDate + 'T23:59:59')

      if (!dayErr && dayRows) {
        rows = dayRows.filter((r: any) => normalizeOrderId(r.order_id) === normalizedTarget)
      }
    }

    // fallback สุดท้าย: ดึงข้อมูลช่วงล่าสุดเผื่อเคสวันที่คลาดจาก timezone แต่รหัสตรงจริง
    if (rows.length === 0) {
      const start = new Date(reviewDate || new Date().toISOString().split('T')[0])
      start.setDate(start.getDate() - 7)
      const startDate = start.toISOString().split('T')[0]
      const { data: recentRows, error: recentErr } = await supabase
        .from('wms_orders')
        .select(
          'id, order_id, product_code, product_name, location, qty, assigned_to, status, error_count, not_find_count, created_at, source_order_id, plan_line_released'
        )
        .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
        .neq('status', 'cancelled')
        .gte('created_at', `${startDate}T00:00:00`)
        .lte('created_at', `${reviewDate || new Date().toISOString().split('T')[0]}T23:59:59`)

      if (!recentErr && recentRows) {
        rows = recentRows.filter((r: any) => normalizeOrderId(r.order_id) === normalizedTarget)
      }
    }

    if ((error && rows.length === 0) || rows.length === 0) {
      const debugEnabled = typeof window !== 'undefined' && window.localStorage.getItem('debug_wms_review') === '1'
      if (debugEnabled) {
        console.warn('[WMS Review] startInspection not found', {
          selectedRawId: rawTarget,
          normalizedTarget,
          rawKeys: Object.keys(rowsByOrderRaw).length,
          normKeys: Object.keys(rowsByOrderNorm).length,
          sampleRawKeys: Object.keys(rowsByOrderRaw).slice(0, 10),
        })
      }
      showMessage({ message: 'ไม่พบข้อมูลรายการในใบงานนี้' })
      return
    }

    const canonicalOrderId = String(rows[0]?.order_id || rawTarget)
    const hasUnfinishedItems = rows.some((item) => item.status === 'pending')
    if (hasUnfinishedItems) {
      showMessage({ message: 'ไม่อนุญาตให้ตรวจเนื่องจากใบงานนี้ยังจัดไม่เสร็จสิ้น (มีรายการค้างจัด)' })
      return
    }

    const sortedData = sortOrderItems(await enrichReleasedSourceOrders(rows))
    setReviewOrderSelect(canonicalOrderId)
    setReviewOrderActualId(canonicalOrderId)
    setInspectItems(sortedData)
    setShowCounter(true)
    setShowTabs(true)
    setCurrentTab('all')
  }

  const switchInspectTab = (tab: string) => {
    setCurrentTab(tab)
  }

  const setInspectStatus = async (id: string, newStatus: string) => {
    const item = inspectItems.find((i) => i.id === id)
    let updateData: Record<string, any> = { status: newStatus }

    if (newStatus === 'wrong') updateData.error_count = (item?.error_count || 0) + 1
    if (newStatus === 'not_find') updateData.not_find_count = (item?.not_find_count || 0) + 1

    await supabase.from('wms_orders').update(updateData).eq('id', id)

    const currentOrderId = reviewOrderActualId || reviewOrderSelect
    const { data } = await supabase
      .from('wms_orders')
      .select('*')
      .eq('order_id', currentOrderId)
      .or(WMS_FULFILLMENT_PICK_OR_LEGACY)
      .neq('status', 'cancelled')

    if (data) {
      const sortedData = sortOrderItems(await enrichReleasedSourceOrders(data as any[]))
      setInspectItems(sortedData)

      const isFullyChecked = sortedData.every((i) =>
        ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
      )
      if (isFullyChecked) {
        await supabase
          .from('wms_orders')
          .update({ end_time: new Date().toISOString() })
          .eq('order_id', currentOrderId)
          .or(WMS_FULFILLMENT_PICK_OR_LEGACY)

        try {
          await saveFirstCheckSummary(currentOrderId, sortedData)
        } catch (e) {
          console.error('saveFirstCheckSummary error:', e)
        }
      }

      const allCorrect = sortedData.length > 0 && sortedData.every((i) => i.status === 'correct')
      if (allCorrect) {
        await ensurePlanDeptEnd(currentOrderId)
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

    const total = items.length
    const correct = items.filter((i) => i.status === 'correct').length
    const wrong = items.filter((i) => i.status === 'wrong').length
    const notFind = items.filter((i) => i.status === 'not_find').length
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
    returned: inspectItems.filter((i) => i.status === 'returned').length,
  }

  const checkedCount = inspectItems.filter((i) =>
    ['correct', 'wrong', 'not_find', 'out_of_stock', 'returned'].includes(i.status)
  ).length

  let filtered = inspectItems
  if (currentTab === 'picked') filtered = inspectItems.filter((i) => i.status === 'picked')
  if (currentTab === 'correct') filtered = inspectItems.filter((i) => i.status === 'correct')
  if (currentTab === 'wrong') filtered = inspectItems.filter((i) => i.status === 'wrong')
  if (currentTab === 'not_find') filtered = inspectItems.filter((i) => i.status === 'not_find')
  if (currentTab === 'returned') filtered = inspectItems.filter((i) => i.status === 'returned')

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
          </div>
        </div>
        {showCounter && (
          <div className="bg-white p-6 rounded-3xl shadow-xl border-t-4 border-blue-600 text-center min-w-[200px]">
            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">Checked / Total</div>
            <div className="text-6xl font-black text-blue-600">
              {checkedCount} / {inspectItems.length}
            </div>
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
                {o.id} → ตรวจเพิ่ม ({o.unchecked}/{o.total})
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

              const isMovedFromPlan = !!(item.plan_line_released || item.source_order_released)
              const needsReleaseReturn =
                isMovedFromPlan && ['picked', 'correct', 'system_complete'].includes(item.status)

              return (
                <div key={item.id} className="p-4 flex items-center justify-between hover:bg-gray-50 transition">
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
                        จุดจัดเก็บ: {item.location || '-'} | จำนวน: {item.qty} {item.unit_name || 'ชิ้น'}
                      </div>
                      {isMovedFromPlan && (
                        <div className="text-xs font-bold text-amber-800 mt-1">
                          บิลถูกย้ายออกจากใบงาน — กดคืนเข้าคลังเมื่อตรวจแล้ว
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 text-center px-4">
                    {['correct', 'wrong', 'not_find', 'returned'].includes(item.status) && (
                      <div className={`border-2 ${statusBoxClass} font-black px-6 py-2 rounded-xl text-lg uppercase tracking-wider`}>
                        สถานะ: {WMS_STATUS_LABELS[item.status] || item.status}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 w-1/3 justify-end">
                    {needsReleaseReturn ? (
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
