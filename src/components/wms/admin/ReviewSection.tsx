import { useState, useEffect } from 'react'
import { supabase } from '../../../lib/supabase'
import { getProductImageUrl, sortOrderItems, WMS_STATUS_LABELS } from '../wmsUtils'
import { useWmsModal } from '../useWmsModal'

export default function ReviewSection() {
  const [reviewDate, setReviewDate] = useState('')
  const [reviewOrderSelect, setReviewOrderSelect] = useState('')
  const [orderOptions, setOrderOptions] = useState<{ value: string; label: string; hasUnchecked?: boolean }[]>([])
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
  }

  const loadReviewDropdown = async (skipReset = true) => {
    if (!skipReset) resetReviewUI()
    if (!reviewDate) return

    const { data } = await supabase
      .from('wms_orders')
      .select('order_id, status')
      .gte('created_at', reviewDate + 'T00:00:00')
      .lte('created_at', reviewDate + 'T23:59:59')

    if (!data) return

    const grouped = (data as any[]).reduce((acc: Record<string, any>, obj) => {
      if (!acc[obj.order_id]) {
        acc[obj.order_id] = { id: obj.order_id, picked: 0, oos: 0, total: 0, finished_count: 0 }
      }
      acc[obj.order_id].total++
      if (['picked'].includes(obj.status)) acc[obj.order_id].picked++
      if (obj.status === 'out_of_stock') acc[obj.order_id].oos++
      const isFinished = ['picked', 'correct', 'wrong', 'not_find', 'out_of_stock'].includes(obj.status)
      if (isFinished) acc[obj.order_id].finished_count++
      return acc
    }, {})

    const completed = Object.values(grouped).filter((o: any) => o.finished_count === o.total)
    const currentSelected = reviewOrderSelect

    setOrderOptions(
      completed.length
        ? [
            { value: '', label: '-- เลือกใบงานที่จัดเสร็จแล้ว --' },
            ...completed.map((o: any) => ({
              value: o.id,
              label: `${o.id} (${o.total} รายการ) [ยังไม่ได้ตรวจ ${o.picked} รายการ]`,
              hasUnchecked: o.picked > 0,
            })),
          ]
        : [{ value: '', label: 'ไม่มีใบงานที่พร้อมตรวจ' }]
    )

    if (currentSelected) {
      setReviewOrderSelect(currentSelected)
    }
  }

  const startInspection = async () => {
    if (!reviewOrderSelect) {
      showMessage({ message: 'โปรดเลือกใบงานที่ต้องการตรวจ!' })
      return
    }

    const { data, error } = await supabase.from('wms_orders').select('*').eq('order_id', reviewOrderSelect)

    if (error || !data || data.length === 0) {
      showMessage({ message: 'ไม่พบข้อมูลรายการในใบงานนี้' })
      return
    }

    const hasUnfinishedItems = data.some((item) => item.status === 'pending')
    if (hasUnfinishedItems) {
      showMessage({ message: 'ไม่อนุญาตให้ตรวจเนื่องจากใบงานนี้ยังจัดไม่เสร็จสิ้น (มีรายการค้างจัด)' })
      return
    }

    const sortedData = sortOrderItems(data)
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

    const { data } = await supabase.from('wms_orders').select('*').eq('order_id', reviewOrderSelect)

    if (data) {
      const sortedData = sortOrderItems(data)
      setInspectItems(sortedData)

      const isFullyChecked = sortedData.every((i) =>
        ['correct', 'wrong', 'not_find', 'out_of_stock'].includes(i.status)
      )
      if (isFullyChecked) {
        await supabase
          .from('wms_orders')
          .update({ end_time: new Date().toISOString() })
          .eq('order_id', reviewOrderSelect)

        await saveFirstCheckSummary(reviewOrderSelect, sortedData)
      }
    }
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
  }

  const checkedCount = inspectItems.filter((i) =>
    ['correct', 'wrong', 'not_find', 'out_of_stock'].includes(i.status)
  ).length

  let filtered = inspectItems
  if (currentTab === 'picked') filtered = inspectItems.filter((i) => i.status === 'picked')
  if (currentTab === 'correct') filtered = inspectItems.filter((i) => i.status === 'correct')
  if (currentTab === 'wrong') filtered = inspectItems.filter((i) => i.status === 'wrong')
  if (currentTab === 'not_find') filtered = inspectItems.filter((i) => i.status === 'not_find')

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
              onClick={startInspection}
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

              return (
                <div key={item.id} className="p-4 flex items-center justify-between hover:bg-gray-50 transition">
                  <div className="flex items-center gap-6 w-1/3">
                    <div className="text-xl font-black text-gray-300 w-8 text-center">{idx + 1}</div>
                    <img
                      src={item.product_code === 'SPARE_PART' ? 'https://placehold.co/200x200?text=SPARE' : getProductImageUrl(item.product_code)}
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
                        จุดจัดเก็บ: {item.location || '-'} | จำนวน: {item.qty}
                      </div>
                    </div>
                  </div>
                  <div className="flex-1 text-center px-4">
                    {['correct', 'wrong', 'not_find'].includes(item.status) && (
                      <div className={`border-2 ${statusBoxClass} font-black px-6 py-2 rounded-xl text-lg uppercase tracking-wider`}>
                        สถานะ: {WMS_STATUS_LABELS[item.status] || item.status}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 w-1/3 justify-end">
                    <button
                      onClick={() => setInspectStatus(item.id, 'not_find')}
                      className="h-14 px-4 rounded-2xl font-black border-2 border-orange-200 text-orange-500 hover:bg-orange-50 transition"
                    >
                      ไม่เจอ
                    </button>
                    <button
                      onClick={() => setInspectStatus(item.id, 'wrong')}
                      className={`h-14 px-4 rounded-2xl font-black border-2 border-red-200 transition ${
                        item.status === 'wrong' ? 'bg-red-600 text-white' : 'text-red-500 hover:bg-red-50'
                      }`}
                    >
                      หยิบผิด
                    </button>
                    <button
                      onClick={() => setInspectStatus(item.id, 'correct')}
                      className="h-14 px-4 rounded-2xl font-black bg-green-500 text-white hover:bg-green-600 shadow-md transition"
                    >
                      หยิบถูก
                    </button>
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
