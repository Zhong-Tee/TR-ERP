import { useState, useEffect, useCallback, useRef } from 'react'
import { FiMapPin, FiCrosshair, FiPlus, FiCheck } from 'react-icons/fi'
import { fetchClockLocations, upsertClockLocation } from '../../../lib/hrApi'
import type { HRClockLocation } from '../../../types'

type GpsReading = { lat: number; lng: number; accuracy: number; at: Date }

/**
 * จุดพิกัดออฟฟิศ (สำหรับ superadmin บนมือถือ)
 * ดึงค่า GPS จากมือถือ แล้วบันทึกลงจุดพิกัดเดิม หรือสร้างจุดใหม่ได้ทันที
 * — เวอร์ชันเต็มอยู่ที่ ตั้งค่า → จุดบันทึกเวลา (GPS)
 */
export default function AdminClockLocationsMobile() {
  const [locations, setLocations] = useState<HRClockLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [reading, setReading] = useState<GpsReading | null>(null)
  const [gettingGps, setGettingGps] = useState(false)

  const [applyTarget, setApplyTarget] = useState<HRClockLocation | null>(null)
  const [saving, setSaving] = useState(false)

  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRadius, setNewRadius] = useState('100')

  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(t)
  }, [message])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      setLocations(await fetchClockLocations())
    } catch (e: any) {
      setMessage({ type: 'error', text: 'โหลดข้อมูลไม่สำเร็จ: ' + e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const watchIdRef = useRef<number | null>(null)
  const watchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopWatching = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    if (watchTimerRef.current != null) {
      clearTimeout(watchTimerRef.current)
      watchTimerRef.current = null
    }
    setGettingGps(false)
  }, [])

  useEffect(() => stopWatching, [stopWatching])

  /**
   * เฝ้าอ่านตำแหน่งต่อเนื่องสูงสุด 25 วิ เก็บค่าที่แม่นที่สุด — การอ่านครั้งแรกมักได้
   * network location ค้างเก่า (คลาดได้เป็นกิโล) ต้องรอชิป GPS fix จริงสักพัก
   */
  function readGps() {
    if (!navigator.geolocation) {
      setMessage({ type: 'error', text: 'อุปกรณ์นี้ไม่รองรับ GPS' })
      return
    }
    stopWatching()
    setGettingGps(true)
    let best: number = Infinity
    let gotAny = false
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        gotAny = true
        if (pos.coords.accuracy < best) {
          best = pos.coords.accuracy
          setReading({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            at: new Date(),
          })
        }
        // แม่นพอแล้ว (≤15 ม.) หยุดอ่านได้
        if (pos.coords.accuracy <= 15) stopWatching()
      },
      (err) => {
        stopWatching()
        setMessage({
          type: 'error',
          text: 'อ่านพิกัดไม่สำเร็จ: ' + err.message + ' (ต้องเปิดผ่าน HTTPS และอนุญาตให้เข้าถึงตำแหน่งแบบแม่นยำ)',
        })
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    )
    watchTimerRef.current = setTimeout(() => {
      stopWatching()
      if (!gotAny) setMessage({ type: 'error', text: 'อ่านพิกัดไม่สำเร็จ — ไม่ได้รับสัญญาณ GPS ภายในเวลาที่กำหนด' })
    }, 25000)
  }

  async function applyToLocation(loc: HRClockLocation) {
    if (!reading || saving) return
    setSaving(true)
    try {
      await upsertClockLocation({ id: loc.id, lat: reading.lat, lng: reading.lng })
      setMessage({ type: 'success', text: `อัปเดตพิกัด "${loc.name}" เป็นตำแหน่งปัจจุบันแล้ว` })
      setApplyTarget(null)
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  async function createLocation() {
    if (!reading || saving) return
    const radius = parseInt(newRadius, 10)
    if (!newName.trim()) return setMessage({ type: 'error', text: 'กรุณาตั้งชื่อออฟฟิศ' })
    if (isNaN(radius) || radius < 10) return setMessage({ type: 'error', text: 'รัศมีต้องอย่างน้อย 10 เมตร' })
    setSaving(true)
    try {
      await upsertClockLocation({ name: newName.trim(), lat: reading.lat, lng: reading.lng, radius_m: radius })
      setMessage({ type: 'success', text: `เพิ่มจุดพิกัด "${newName.trim()}" จากตำแหน่งปัจจุบันแล้ว` })
      setShowNewForm(false)
      setNewName('')
      setNewRadius('100')
      loadData()
    } catch (e: any) {
      setMessage({ type: 'error', text: 'บันทึกไม่สำเร็จ: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
          <FiMapPin className="text-emerald-600" /> จุดพิกัดออฟฟิศ
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">
          ยืนอยู่ที่จุดที่ต้องการ แล้วกดอ่านพิกัด GPS จากมือถือ — ตั้งค่าเพิ่มเติมได้ที่ ตั้งค่า → จุดบันทึกเวลา (GPS)
        </p>
      </div>

      {message && (
        <div
          className={`p-3 rounded-xl text-sm font-medium ${
            message.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* อ่านพิกัดปัจจุบัน */}
      <div className="bg-white rounded-2xl shadow p-4 space-y-3">
        <button
          type="button"
          onClick={readGps}
          disabled={gettingGps}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 disabled:opacity-50"
        >
          <FiCrosshair className={gettingGps ? 'animate-spin' : ''} />
          {gettingGps ? 'กำลังอ่านพิกัด GPS...' : reading ? 'อ่านพิกัด GPS อีกครั้ง' : 'อ่านพิกัด GPS จากมือถือ'}
        </button>

        {reading && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-gray-500">พิกัดปัจจุบัน</span>
              <a
                href={`https://www.google.com/maps?q=${reading.lat},${reading.lng}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-semibold text-emerald-700 underline"
              >
                {reading.lat.toFixed(6)}, {reading.lng.toFixed(6)}
              </a>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">ความแม่นยำ</span>
              <span className={`font-semibold ${reading.accuracy <= 30 ? 'text-emerald-700' : 'text-amber-600'}`}>
                ±{Math.round(reading.accuracy)} ม.{reading.accuracy > 30 ? ' (ควรอ่านซ้ำกลางแจ้ง)' : ''}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">อ่านเมื่อ</span>
              <span className="font-medium text-gray-700">
                {reading.at.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} น.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* รายการจุดพิกัด — เลือกจุดเพื่อบันทึกพิกัดปัจจุบันลงไป */}
      <div className="bg-white rounded-2xl shadow p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-700">บันทึกพิกัดลงจุดเดิม</h3>
          <button
            type="button"
            onClick={() => setShowNewForm((v) => !v)}
            disabled={!reading}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40"
            title={reading ? '' : 'อ่านพิกัด GPS ก่อน'}
          >
            <FiPlus /> เพิ่มจุดใหม่
          </button>
        </div>

        {showNewForm && reading && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 space-y-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="ชื่อออฟฟิศ เช่น โกดัง 2"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                value={newRadius}
                onChange={(e) => setNewRadius(e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <span className="text-sm text-gray-500">รัศมี (เมตร)</span>
              <button
                type="button"
                onClick={createLocation}
                disabled={saving}
                className="ml-auto px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        )}

        {locations.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">ยังไม่มีจุดพิกัด — อ่าน GPS แล้วกด "เพิ่มจุดใหม่"</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {locations.map((loc) => (
              <div key={loc.id} className={`py-3 ${!loc.is_active ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-800 truncate">
                      {loc.name}
                      {!loc.is_active && <span className="ml-2 text-xs text-gray-400">(ปิดใช้งาน)</span>}
                    </div>
                    <div className="text-xs text-gray-500 font-mono">
                      {loc.lat.toFixed(6)}, {loc.lng.toFixed(6)} • รัศมี {loc.radius_m} ม.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setApplyTarget(loc)}
                    disabled={!reading || saving}
                    className="shrink-0 flex items-center gap-1 px-3 py-2 bg-emerald-50 border border-emerald-300 text-emerald-700 rounded-lg text-xs font-bold hover:bg-emerald-100 disabled:opacity-40"
                    title={reading ? '' : 'อ่านพิกัด GPS ก่อน'}
                  >
                    <FiCrosshair /> ใช้พิกัดมือถือ
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ยืนยันการทับพิกัดเดิม */}
      {applyTarget && reading && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={() => !saving && setApplyTarget(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-gray-800">ยืนยันอัปเดตพิกัด</h3>
            <div className="text-sm text-gray-600 space-y-1.5">
              <div>
                จุด: <span className="font-semibold text-gray-800">{applyTarget.name}</span>
              </div>
              <div className="font-mono text-xs text-gray-500">
                เดิม: {applyTarget.lat.toFixed(6)}, {applyTarget.lng.toFixed(6)}
              </div>
              <div className="font-mono text-xs text-emerald-700 font-semibold">
                ใหม่: {reading.lat.toFixed(6)}, {reading.lng.toFixed(6)} (±{Math.round(reading.accuracy)} ม.)
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setApplyTarget(null)}
                disabled={saving}
                className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => applyToLocation(applyTarget)}
                disabled={saving}
                className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                <FiCheck /> {saving ? 'กำลังบันทึก...' : 'ยืนยัน'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
