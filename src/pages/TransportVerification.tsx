import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Order } from '../types'
import { useAuthContext } from '../contexts/AuthContext'
import Modal from '../components/ui/Modal'

type ChannelRow = { channel_code: string; channel_name: string; default_carrier?: string | null }
type MessageModal = { open: boolean; title: string; message: string }
type ConfirmModal = { open: boolean; title: string; message: string; onConfirm: () => void }

const PARCEL_TYPES = ['กล่อง', 'ซองกระดาษ', 'ซองบับเบิล', 'ถุงพัสดุ'] as const
type ParcelType = (typeof PARCEL_TYPES)[number]

function normalizeParcelType(value: string | null | undefined): ParcelType {
  const v = String(value || '').trim()
  if (v === 'ซองกระดาษ' || v === 'ซอง') return 'ซองกระดาษ'
  if (v === 'ซองบับเบิล' || v === 'บับเบิล') return 'ซองบับเบิล'
  if (v === 'ถุงพัสดุ' || v === 'ถุง') return 'ถุงพัสดุ'
  return 'กล่อง'
}

function formatTime(iso?: string | null) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

export default function TransportVerification() {
  const { user } = useAuthContext()
  const [dateFilter, setDateFilter] = useState(todayISO())
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [activeCarrier, setActiveCarrier] = useState<string | null>(null)
  const [activeParcelType, setActiveParcelType] = useState<(typeof PARCEL_TYPES)[number]>('กล่อง')
  const [scanValue, setScanValue] = useState('')
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: 'success' | 'error' | '' }>({ text: '', type: '' })
  const [loading, setLoading] = useState(false)
  const [exportingPng, setExportingPng] = useState(false)
  const [messageModal, setMessageModal] = useState<MessageModal>({ open: false, title: '', message: '' })
  const [confirmModal, setConfirmModal] = useState<ConfirmModal>({ open: false, title: '', message: '', onConfirm: () => {} })

  const scanInputRef = useRef<HTMLInputElement>(null)
  const summaryRef = useRef<HTMLDivElement>(null)
  const successSoundRef = useRef<HTMLAudioElement | null>(null)
  const errorSoundRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    successSoundRef.current = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg')
    errorSoundRef.current = new Audio('https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg')
  }, [])

  useEffect(() => {
    loadChannels().catch(() => null)
  }, [])

  useEffect(() => {
    loadOrders().catch(() => null)
  }, [dateFilter])

  useEffect(() => {
    if (activeCarrier) {
      setTimeout(() => scanInputRef.current?.focus(), 100)
    }
  }, [activeCarrier])

  async function loadChannels() {
    const { data, error } = await supabase
      .from('channels')
      .select('channel_code, channel_name, default_carrier')
    if (error) {
      console.error('loadChannels:', error)
      setChannels([])
      return
    }
    setChannels((data || []) as ChannelRow[])
  }

  function getCarrierName(channelCode: string) {
    const channel = channels.find((c) => c.channel_code === channelCode)
    return (channel?.default_carrier || 'OTHER').toUpperCase()
  }

  async function loadOrders() {
    setLoading(true)
    try {
      const start = `${dateFilter}T00:00:00`
      const end = `${dateFilter}T23:59:59.999`
      const baseSelect = 'id,bill_no,tracking_number,customer_name,channel_code,status,shipped_time,shipped_by,claim_type,claim_details,transport_meta'
      const shippedRes = await supabase
        .from('or_orders')
        .select(baseSelect)
        .gte('shipped_time', start)
        .lte('shipped_time', end)
      let verifiedData: Order[] = []
      const verifiedRes = await supabase
        .from('or_orders')
        .select(baseSelect)
        .filter('transport_meta->>verified_at', 'gte', start)
        .filter('transport_meta->>verified_at', 'lte', end)
      if (verifiedRes.error) {
        console.warn('transport_meta filter error:', verifiedRes.error)
        setMessageModal({
          open: true,
          title: 'แจ้งเตือน',
          message: 'ไม่สามารถโหลดรายการที่ทวนสอบในวันได้ครบถ้วน (ฟิลด์ transport_meta)',
        })
      } else {
        verifiedData = (verifiedRes.data || []) as Order[]
      }
      const merged = new Map<string, Order>()
      ;((shippedRes.data || []) as Order[]).forEach((o) => merged.set(o.id, o))
      verifiedData.forEach((o) => merged.set(o.id, o))
      setOrders(Array.from(merged.values()))
    } catch (err: any) {
      console.error('loadOrders:', err)
      setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: err?.message || String(err) })
    } finally {
      setLoading(false)
    }
  }

  const carriersList = useMemo(() => {
    const list = Array.from(
      new Set(channels.map((c) => (c.default_carrier || 'OTHER').toUpperCase()))
    ).sort()
    return list
  }, [channels])

  const relevantOrders = useMemo(() => {
    return orders.filter((o) => {
      const sDate = o.shipped_time?.substring(0, 10)
      const vDate = o.transport_meta?.verified_at?.substring(0, 10)
      return sDate === dateFilter || vDate === dateFilter
    })
  }, [orders, dateFilter])

  const summaryData = useMemo(() => {
    const nested: Record<string, Record<string, Record<string, number>>> = {}
    relevantOrders.forEach((o) => {
      const isTodayVer = o.transport_meta?.verified && o.transport_meta?.verified_at?.substring(0, 10) === dateFilter
      if (!isTodayVer) return
      const carrier = getCarrierName(o.channel_code)
      const ch = (o.channel_code || 'N/A').toUpperCase()
      const pType = normalizeParcelType(o.transport_meta?.parcel_type)
      if (!nested[carrier]) nested[carrier] = {}
      if (!nested[carrier][ch]) {
        nested[carrier][ch] = { กล่อง: 0, ซองกระดาษ: 0, ซองบับเบิล: 0, ถุงพัสดุ: 0, total: 0 }
      }
      nested[carrier][ch][pType] = (nested[carrier][ch][pType] || 0) + 1
      nested[carrier][ch].total = (nested[carrier][ch].total || 0) + 1
    })
    return nested
  }, [relevantOrders, dateFilter, channels])

  const stats = useMemo(() => {
    let gTotal = 0
    let gVer = 0
    let cTotal = 0
    let cVer = 0
    relevantOrders.forEach((o) => {
      if (o.status === 'จัดส่งแล้ว') gTotal += 1
      const isV = o.transport_meta?.verified && o.transport_meta?.verified_at?.substring(0, 10) === dateFilter
      if (isV) gVer += 1
      if (activeCarrier && getCarrierName(o.channel_code) === activeCarrier) {
        if (o.status === 'จัดส่งแล้ว') cTotal += 1
        if (isV) cVer += 1
      }
    })
    return { gTotal, gVer, cTotal, cVer }
  }, [relevantOrders, dateFilter, activeCarrier, channels])

  const displayOrders = useMemo(() => {
    if (!activeCarrier) return []
    return relevantOrders.filter(
      (o) => getCarrierName(o.channel_code) === activeCarrier && o.status === 'จัดส่งแล้ว'
    )
  }, [relevantOrders, activeCarrier, channels])

  function playSound(type: 'success' | 'error') {
    const sound = type === 'success' ? successSoundRef.current : errorSoundRef.current
    if (!sound) return
    sound.currentTime = 0
    sound.play().catch(() => null)
  }

  async function handleScan() {
    const trackingNo = scanValue.trim().toUpperCase()
    setScanValue('')
    if (!trackingNo) return
    if (!activeCarrier) {
      setStatusMsg({ text: 'ต้องเลือกขนส่งก่อน', type: 'error' })
      return
    }
    try {
      const orderIndex = orders.findIndex(
        (o) => String(o.tracking_number || '').toUpperCase() === trackingNo
      )
      const order = orders[orderIndex]
      if (!order) throw new Error('ไม่พบเลขพัสดุ!')
      if (order.status !== 'จัดส่งแล้ว') throw new Error('บิลยังแพ็คไม่เสร็จ')
      const carrier = getCarrierName(order.channel_code)
      if (carrier !== activeCarrier) throw new Error(`ผิด! ของเจ้า ${carrier}`)
      if (order.transport_meta?.verified) throw new Error('สแกนซ้ำ')

      const now = new Date().toISOString()
      const transport_meta = {
        verified: true,
        verified_at: now,
        verified_by: user?.username || user?.email || 'unknown',
        carrier,
        parcel_type: activeParcelType,
      }
      const { error } = await supabase.from('or_orders').update({ transport_meta }).eq('id', order.id)
      if (error) throw new Error('ไม่สามารถบันทึกลง Database ได้: ' + error.message)

      setOrders((prev) =>
        prev.map((o) => (o.id === order.id ? { ...o, transport_meta } : o))
      )
      setStatusMsg({ text: `✅ ${order.bill_no} ผ่าน [${activeParcelType}]`, type: 'success' })
      playSound('success')
    } catch (err: any) {
      setStatusMsg({ text: err?.message || String(err), type: 'error' })
      playSound('error')
    } finally {
      scanInputRef.current?.focus()
    }
  }

  async function exportSummaryPng() {
    if (!summaryRef.current) return
    setExportingPng(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const canvas = await html2canvas(summaryRef.current, { scale: 2, backgroundColor: '#ffffff' })
      const link = document.createElement('a')
      link.download = `สรุปยอดขนส่ง_${dateFilter}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (err: any) {
      setMessageModal({ open: true, title: 'สร้างภาพไม่ได้', message: err?.message || String(err) })
    } finally {
      setExportingPng(false)
    }
  }

  function exportCsv() {
    if (!activeCarrier) {
      setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกขนส่งก่อนดาวน์โหลด' })
      return
    }
    const rows = [['เวลาสแกน', 'เลขบิล', 'เลขพัสดุ', 'ประเภทพัสดุ', 'ชื่อลูกค้า', 'สถานะ']]
    displayOrders.forEach((o) => {
      const isV = o.transport_meta?.verified && o.transport_meta?.verified_at?.substring(0, 10) === dateFilter
      rows.push([
        isV ? formatTime(o.transport_meta?.verified_at) : '-',
        o.bill_no,
        o.tracking_number || '',
        o.transport_meta?.parcel_type || '-',
        o.customer_name || '',
        isV ? 'ตรวจแล้ว' : 'รอตรวจ',
      ])
    })
    const csvContent = '\uFEFF' + rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ขนส่ง_${activeCarrier}_${dateFilter}.csv`
    link.click()
  }

  function handleUndo(orderId: string) {
    setConfirmModal({
      open: true,
      title: 'ยกเลิกการทวนสอบ',
      message: 'ยกเลิกการทวนสอบบิลนี้?',
      onConfirm: async () => {
        setConfirmModal((prev) => ({ ...prev, open: false }))
        const { error } = await supabase.from('or_orders').update({ transport_meta: null }).eq('id', orderId)
        if (error) {
          setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: error.message })
          return
        }
        await loadOrders()
      },
    })
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="flex items-center justify-end py-3">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 font-semibold">วันที่:</span>
            <input
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="border border-gray-300 rounded-xl px-4 py-2 text-blue-600 font-semibold text-base focus:ring-2 focus:ring-blue-400 focus:border-blue-400 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="flex flex-wrap justify-center gap-2 mb-3">
            {PARCEL_TYPES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setActiveParcelType(p)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold border ${
                  activeParcelType === p ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {p === 'กล่อง' ? '📦' : p === 'ซองกระดาษ' ? '📄' : p === 'ซองบับเบิล' ? '🫧' : '🛍️'} {p === 'ซองกระดาษ' ? 'ซอง' : p === 'ซองบับเบิล' ? 'บับเบิล' : p}
              </button>
            ))}
          </div>
          <div className="mb-3">
            <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold ${
              activeCarrier ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-red-50 text-red-600 border border-red-200'
            }`}>
              {activeCarrier ? `ตรวจขนส่ง: ${activeCarrier}` : '⚠️ ต้องเลือกขนส่งก่อน!'}
            </span>
          </div>
          <input
            ref={scanInputRef}
            type="text"
            value={scanValue}
            onChange={(e) => setScanValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleScan()}
            onFocus={(e) => e.target.placeholder = ''}
            onBlur={(e) => e.target.placeholder = 'ยิงบาร์โค้ดเลขพัสดุ...'}
            disabled={!activeCarrier}
            placeholder="ยิงบาร์โค้ดเลขพัสดุ..."
            className="w-full text-center text-2xl font-semibold border-2 border-blue-500 rounded-xl px-3 py-4 disabled:bg-gray-100 disabled:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <p className={`mt-2 font-bold min-h-[20px] text-sm ${statusMsg.type === 'success' ? 'text-green-600' : statusMsg.type === 'error' ? 'text-red-600' : ''}`}>
            {statusMsg.text}
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white border border-gray-200 rounded-xl p-4 text-center">
              <div className="text-xs font-semibold text-gray-500">รวมทั้งหมด</div>
              <div className="text-3xl font-black text-gray-900">{stats.gVer} / {stats.gTotal}</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4 text-center">
              <div className="text-xs font-semibold text-gray-500">{activeCarrier || 'เลือกขนส่ง'}</div>
              <div className="text-3xl font-black text-blue-600">{activeCarrier ? `${stats.cVer} / ${stats.cTotal}` : '-'}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!activeCarrier}
            className="w-full px-4 py-4 rounded-xl font-bold text-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            📥 ดาวน์โหลดไฟล์สรุป (CSV)
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-3 flex flex-wrap gap-2">
        {carriersList.map((carrier) => {
          const cCount = relevantOrders.filter(
            (o) => getCarrierName(o.channel_code) === carrier && o.status === 'จัดส่งแล้ว'
          ).length
          return (
            <button
              key={carrier}
              type="button"
              onClick={() => setActiveCarrier(carrier)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold border ${
                activeCarrier === carrier ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {carrier} ({cCount})
            </button>
          )
        })}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-blue-600 text-white">
              <th className="p-3 text-left font-semibold w-[10%] rounded-tl-xl">เวลา</th>
              <th className="p-3 text-left font-semibold w-[15%]">เลขบิล</th>
              <th className="p-3 text-left font-semibold w-[20%]">เลขพัสดุ</th>
              <th className="p-3 text-left font-semibold w-[15%]">ประเภท</th>
              <th className="p-3 text-left font-semibold">ลูกค้า</th>
              <th className="p-3 text-center font-semibold w-[15%] rounded-tr-xl">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  กำลังโหลดข้อมูล...
                </td>
              </tr>
            ) : displayOrders.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-gray-400">
                  กรุณาเลือกขนส่ง
                </td>
              </tr>
            ) : (
              displayOrders.map((o) => {
                const isV = o.transport_meta?.verified && o.transport_meta?.verified_at?.substring(0, 10) === dateFilter
                return (
                  <tr key={o.id} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${isV ? 'bg-green-50' : ''}`}>
                    <td className="p-3 text-gray-500">{isV ? formatTime(o.transport_meta?.verified_at) : '-'}</td>
                    <td className="p-3 font-semibold">{o.bill_no}</td>
                    <td className="p-3 font-mono">{o.tracking_number}</td>
                    <td className="p-3">{o.transport_meta?.parcel_type || '-'}</td>
                    <td className="p-3">{o.customer_name}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-1 rounded-full text-xs font-bold ${isV ? 'bg-green-100 text-green-700 border border-green-500' : 'bg-red-100 text-red-600 border border-red-200'}`}>
                        {isV ? '✓ ตรวจแล้ว' : '🔴 รอตรวจ'}
                      </span>
                      {isV && (
                        <button
                          type="button"
                          onClick={() => handleUndo(o.id)}
                          className="ml-2 text-xs text-blue-600 underline"
                        >
                          ยกเลิก
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div ref={summaryRef} className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">📊 สรุปยอดตามช่องทาง (เฉพาะที่สแกนแล้ว)</h3>
          <button
            type="button"
            onClick={exportSummaryPng}
            disabled={exportingPng}
            className="inline-flex h-9 items-center justify-center gap-1 px-4 py-0 rounded-xl text-sm font-semibold leading-none bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <span className="inline-flex items-center leading-none">📸</span>
            <span className="inline-flex items-center leading-none">บันทึกเป็นภาพ (PNG)</span>
          </button>
        </div>
        <table className="w-full text-sm [&_th]:align-middle [&_td]:align-middle [&_th]:leading-tight [&_td]:leading-tight">
          <thead>
            <tr className="bg-blue-600 text-white">
              <th className="p-3 text-left font-semibold rounded-tl-xl">ช่องทาง</th>
              <th className="p-3 text-center font-semibold">📦 กล่อง</th>
              <th className="p-3 text-center font-semibold">📄 ซอง</th>
              <th className="p-3 text-center font-semibold">🫧 บับเบิล</th>
              <th className="p-3 text-center font-semibold">🛍️ ถุง</th>
              <th className="p-3 text-center font-bold rounded-tr-xl">รวม</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(summaryData).length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 text-gray-400">
                  กรุณาเลือกขนส่งเพื่อดูสรุป
                </td>
              </tr>
            ) : (
              (() => {
                const carriers = Object.keys(summaryData).sort()
                const grand = { กล่อง: 0, ซองกระดาษ: 0, ซองบับเบิล: 0, ถุงพัสดุ: 0, total: 0 }
                return (
                  <>
                    {carriers.map((carrier) => {
                      const channelsByCarrier = summaryData[carrier]
                      const channelKeys = Object.keys(channelsByCarrier).sort()
                      const subtotal = { กล่อง: 0, ซองกระดาษ: 0, ซองบับเบิล: 0, ถุงพัสดุ: 0, total: 0 }
                      channelKeys.forEach((ch) => {
                        const s = channelsByCarrier[ch]
                        subtotal.กล่อง += s.กล่อง || 0
                        subtotal.ซองกระดาษ += s['ซองกระดาษ'] || 0
                        subtotal.ซองบับเบิล += s['ซองบับเบิล'] || 0
                        subtotal.ถุงพัสดุ += s['ถุงพัสดุ'] || 0
                        subtotal.total += s.total || 0
                      })

                      grand.กล่อง += subtotal.กล่อง
                      grand.ซองกระดาษ += subtotal['ซองกระดาษ']
                      grand.ซองบับเบิล += subtotal['ซองบับเบิล']
                      grand.ถุงพัสดุ += subtotal['ถุงพัสดุ']
                      grand.total += subtotal.total

                      return (
                        <Fragment key={carrier}>
                          <tr className="bg-gray-50">
                            <td colSpan={6} className="p-2 font-semibold text-blue-600">
                              🚚 ขนส่ง: {carrier}
                            </td>
                          </tr>
                          {channelKeys.map((ch) => {
                            const s = channelsByCarrier[ch]
                            return (
                              <tr key={`${carrier}-${ch}`}>
                                <td className="p-2 text-left pl-6 text-gray-600">└ {ch}</td>
                                <td className="p-2 text-center">{s.กล่อง || 0}</td>
                                <td className="p-2 text-center">{s['ซองกระดาษ'] || 0}</td>
                                <td className="p-2 text-center">{s['ซองบับเบิล'] || 0}</td>
                                <td className="p-2 text-center">{s['ถุงพัสดุ'] || 0}</td>
                                <td className="p-2 text-center font-semibold">{s.total || 0}</td>
                              </tr>
                            )
                          })}
                          <tr className="bg-blue-50 font-semibold">
                            <td className="p-2 text-right align-middle">รวมยอด {carrier}</td>
                            <td className="p-2 text-center">{subtotal.กล่อง}</td>
                            <td className="p-2 text-center">{subtotal['ซองกระดาษ']}</td>
                            <td className="p-2 text-center">{subtotal['ซองบับเบิล']}</td>
                            <td className="p-2 text-center">{subtotal['ถุงพัสดุ']}</td>
                            <td className="p-2 text-center text-blue-600">{subtotal.total}</td>
                          </tr>
                        </Fragment>
                      )
                    })}
                    <tr className="bg-gray-900 text-white font-bold">
                      <td className="h-9 p-2 text-left align-middle">
                        <div className="flex h-full items-center">ยอดรวมทุกขนส่งสุทธิ</div>
                      </td>
                      <td className="h-9 p-2 text-center align-middle">
                        <div className="flex h-full items-center justify-center">{grand.กล่อง}</div>
                      </td>
                      <td className="h-9 p-2 text-center align-middle">
                        <div className="flex h-full items-center justify-center">{grand['ซองกระดาษ']}</div>
                      </td>
                      <td className="h-9 p-2 text-center align-middle">
                        <div className="flex h-full items-center justify-center">{grand['ซองบับเบิล']}</div>
                      </td>
                      <td className="h-9 p-2 text-center align-middle">
                        <div className="flex h-full items-center justify-center">{grand['ถุงพัสดุ']}</div>
                      </td>
                      <td className="h-9 p-2 text-center align-middle bg-blue-600">
                        <div className="flex h-full items-center justify-center">{grand.total}</div>
                      </td>
                    </tr>
                  </>
                )
              })()
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={messageModal.open}
        onClose={() => setMessageModal((prev) => ({ ...prev, open: false }))}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{messageModal.title}</h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">{messageModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setMessageModal((prev) => ({ ...prev, open: false }))}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmModal.open}
        onClose={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
        contentClassName="max-w-md"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{confirmModal.title}</h3>
          <p className="text-sm text-gray-700 whitespace-pre-line">{confirmModal.message}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-100"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={confirmModal.onConfirm}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              ยืนยัน
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
