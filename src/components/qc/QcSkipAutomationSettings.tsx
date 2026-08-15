import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthContext } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { fetchQcProductCategories } from '../../lib/qcApi'

type SkipSettings = {
  id: number
  enabled: boolean
  production_enabled: boolean
  delay_threshold_minutes: number
  backlog_work_orders_threshold: number
  fallback_items_per_worker_hour: number
  default_pack_buffer_minutes: number
  require_production_reason: boolean
}

type MandatoryRule = { id: string; rule_type: 'claim' | 'category' | 'product'; rule_value: string; label: string; reason: string | null; is_active: boolean }
type PickupSchedule = { id: string; channel_code: string; day_of_week: number; pickup_time: string; pack_buffer_minutes: number; is_active: boolean }
type Channel = { channel_code: string; channel_name: string }
type Product = { id: string; product_code: string; product_name: string; product_category: string | null }

const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
const EVERY_DAY = 7
const inputClass = 'rounded-lg border border-slate-300 px-3 py-2 text-sm'

export default function QcSkipAutomationSettings() {
  const { user } = useAuthContext()
  const [settings, setSettings] = useState<SkipSettings | null>(null)
  const [rules, setRules] = useState<MandatoryRule[]>([])
  const [schedules, setSchedules] = useState<PickupSchedule[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [ruleType, setRuleType] = useState<'category' | 'product'>('category')
  const [ruleValue, setRuleValue] = useState('')
  const [ruleReason, setRuleReason] = useState('')
  const [channelCode, setChannelCode] = useState('')
  const [dayOfWeek, setDayOfWeek] = useState(1)
  const [pickupTime, setPickupTime] = useState('16:00')
  const [pickupBuffer, setPickupBuffer] = useState(45)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const [settingsRes, rulesRes, schedulesRes, channelsRes, productsRes, categoryRows] = await Promise.all([
      supabase.from('qc_skip_settings').select('*').eq('id', 1).single(),
      supabase.from('qc_mandatory_rules').select('*').order('rule_type').order('label'),
      supabase.from('qc_channel_pickup_schedules').select('*').order('channel_code').order('day_of_week').order('pickup_time'),
      supabase.from('channels').select('channel_code,channel_name').order('channel_code'),
      supabase.from('pr_products').select('id,product_code,product_name,product_category').eq('is_active', true).order('product_code').limit(1000),
      fetchQcProductCategories(),
    ])
    const error = settingsRes.error || rulesRes.error || schedulesRes.error || channelsRes.error || productsRes.error
    if (error) throw error
    setSettings(settingsRes.data as SkipSettings)
    setRules((rulesRes.data || []) as MandatoryRule[])
    setSchedules((schedulesRes.data || []) as PickupSchedule[])
    setChannels((channelsRes.data || []) as Channel[])
    setProducts((productsRes.data || []) as Product[])
    setCategories(categoryRows)
    if (!channelCode && channelsRes.data?.[0]) setChannelCode(channelsRes.data[0].channel_code)
  }, [channelCode])

  useEffect(() => { void load().catch((e) => setMessage(e.message)) }, [load])

  const selectedRuleLabel = useMemo(() => {
    if (ruleType === 'category') return ruleValue
    const product = products.find((item) => item.id === ruleValue)
    return product ? `${product.product_code} · ${product.product_name}` : ''
  }, [products, ruleType, ruleValue])

  async function saveSettings() {
    if (!settings) return
    setSaving(true); setMessage('')
    const { error } = await supabase.from('qc_skip_settings').update({ ...settings, updated_at: new Date().toISOString(), updated_by: user?.id }).eq('id', 1)
    setSaving(false)
    setMessage(error ? error.message : 'บันทึกเกณฑ์ความเร่งด่วนแล้ว')
  }

  async function addRule() {
    if (!ruleValue || !selectedRuleLabel) return
    setSaving(true); setMessage('')
    const { error } = await supabase.from('qc_mandatory_rules').insert({ rule_type: ruleType, rule_value: ruleValue, label: selectedRuleLabel, reason: ruleReason.trim() || null, created_by: user?.id })
    setSaving(false)
    if (error) setMessage(error.message)
    else { setRuleValue(''); setRuleReason(''); await load(); setMessage('เพิ่มกฎบังคับ QC แล้ว') }
  }

  async function toggleRule(rule: MandatoryRule) {
    await supabase.from('qc_mandatory_rules').update({ is_active: !rule.is_active }).eq('id', rule.id)
    await load()
  }

  async function deleteRule(id: string) {
    await supabase.from('qc_mandatory_rules').delete().eq('id', id)
    await load()
  }

  async function addSchedule() {
    if (!channelCode || !pickupTime) return
    setSaving(true); setMessage('')
    const selectedDays = dayOfWeek === EVERY_DAY ? DAYS.map((_, index) => index) : [dayOfWeek]
    const rows = selectedDays.map((day) => ({ channel_code: channelCode, day_of_week: day, pickup_time: pickupTime, pack_buffer_minutes: pickupBuffer, is_active: true }))
    const { error } = await supabase.from('qc_channel_pickup_schedules').upsert(rows, { onConflict: 'channel_code,day_of_week,pickup_time' })
    setSaving(false)
    if (error) setMessage(error.message)
    else { await load(); setMessage('เพิ่มรอบขนส่งแล้ว') }
  }

  async function deleteSchedule(id: string) {
    await supabase.from('qc_channel_pickup_schedules').delete().eq('id', id)
    await load()
  }

  if (!settings) return <div className="py-8 text-center text-slate-500">กำลังโหลดการตั้งค่า...</div>

  return <div className="space-y-6">
    {message && <div className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">{message}</div>}

    <section className="rounded-xl border border-slate-200 p-5">
      <h3 className="text-lg font-bold text-slate-800">1. เกณฑ์ความเร่งด่วน</h3>
      <p className="mt-1 text-sm text-slate-500">ฝ่ายผลิตจะเห็นปุ่มเมื่อเข้าอย่างน้อยหนึ่งเกณฑ์ และใบงานไม่ติดกฎบังคับตรวจคุณภาพ</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm">ช้ากว่าแผน (นาที)<input type="number" min="0" className={`${inputClass} mt-1 w-full`} value={settings.delay_threshold_minutes} onChange={(e) => setSettings({ ...settings, delay_threshold_minutes: Number(e.target.value) })} /></label>
        <label className="text-sm">ใบงานค้างขั้นต่ำ<input type="number" min="1" className={`${inputClass} mt-1 w-full`} value={settings.backlog_work_orders_threshold} onChange={(e) => setSettings({ ...settings, backlog_work_orders_threshold: Number(e.target.value) })} /></label>
        <label className="text-sm">กำลังตรวจคุณภาพ (ชิ้น/คน/ชม.)<input type="number" min="1" className={`${inputClass} mt-1 w-full`} value={settings.fallback_items_per_worker_hour} onChange={(e) => setSettings({ ...settings, fallback_items_per_worker_hour: Number(e.target.value) })} /></label>
        <label className="text-sm">เวลาเผื่อแพ็ค (นาที)<input type="number" min="0" className={`${inputClass} mt-1 w-full`} value={settings.default_pack_buffer_minutes} onChange={(e) => setSettings({ ...settings, default_pack_buffer_minutes: Number(e.target.value) })} /></label>
      </div>
      <div className="mt-4 flex flex-wrap gap-5 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /> เปิดระบบประเมิน</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.production_enabled} onChange={(e) => setSettings({ ...settings, production_enabled: e.target.checked })} /> อนุญาตฝ่ายผลิต</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={settings.require_production_reason} onChange={(e) => setSettings({ ...settings, require_production_reason: e.target.checked })} /> บังคับระบุเหตุผล</label>
      </div>
      <button type="button" disabled={saving} onClick={saveSettings} className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">บันทึกเกณฑ์</button>
    </section>

    <section className="rounded-xl border border-slate-200 p-5">
      <h3 className="text-lg font-bold text-slate-800">2. กลุ่มสินค้าบังคับตรวจคุณภาพ</h3>
      <p className="mt-1 text-sm text-slate-500">บิลเคลมถูกบังคับตรวจคุณภาพเป็นค่าเริ่มต้น และเพิ่มได้ทั้งหมวดหมู่หรือสินค้ารายการเฉพาะ</p>
      <div className="mt-4 grid gap-3 md:grid-cols-[160px_1fr_1fr_auto]">
        <select className={inputClass} value={ruleType} onChange={(e) => { setRuleType(e.target.value as 'category' | 'product'); setRuleValue('') }}><option value="category">หมวดหมู่</option><option value="product">สินค้า</option></select>
        <select className={inputClass} value={ruleValue} onChange={(e) => setRuleValue(e.target.value)}><option value="">-- เลือก --</option>{ruleType === 'category' ? categories.map((item) => <option key={item} value={item}>{item}</option>) : products.map((item) => <option key={item.id} value={item.id}>{item.product_code} · {item.product_name}</option>)}</select>
        <input className={inputClass} placeholder="เหตุผล (ไม่บังคับ)" value={ruleReason} onChange={(e) => setRuleReason(e.target.value)} />
        <button type="button" disabled={saving || !ruleValue} onClick={addRule} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">เพิ่มกฎ</button>
      </div>
      <div className="mt-4 divide-y rounded-lg border">{rules.map((rule) => <div key={rule.id} className="flex items-center gap-3 px-4 py-3 text-sm"><span className={`rounded-full px-2 py-1 text-xs ${rule.is_active ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-500'}`}>{rule.rule_type === 'claim' ? 'เคลม' : rule.rule_type === 'category' ? 'หมวด' : 'สินค้า'}</span><div className="min-w-0 flex-1"><b>{rule.label}</b>{rule.reason && <p className="truncate text-xs text-slate-500">{rule.reason}</p>}</div><button type="button" onClick={() => toggleRule(rule)} className="text-blue-600">{rule.is_active ? 'ปิด' : 'เปิด'}</button>{rule.rule_type !== 'claim' && <button type="button" onClick={() => deleteRule(rule.id)} className="text-red-600">ลบ</button>}</div>)}</div>
    </section>

    <section className="rounded-xl border border-slate-200 p-5">
      <h3 className="text-lg font-bold text-slate-800">3. รอบขนส่งเข้ารับ</h3>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_140px_140px_160px_auto]">
        <select className={inputClass} value={channelCode} onChange={(e) => setChannelCode(e.target.value)}>{channels.map((item) => <option key={item.channel_code} value={item.channel_code}>{item.channel_code} · {item.channel_name}</option>)}</select>
        <select className={inputClass} value={dayOfWeek} onChange={(e) => setDayOfWeek(Number(e.target.value))}><option value={EVERY_DAY}>ทุกวัน</option>{DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select>
        <input type="time" className={inputClass} value={pickupTime} onChange={(e) => setPickupTime(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">เผื่อแพ็ค<input type="number" min="0" className={`${inputClass} w-20`} value={pickupBuffer} onChange={(e) => setPickupBuffer(Number(e.target.value))} /></label>
        <button type="button" disabled={saving || !channelCode} onClick={addSchedule} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">เพิ่มรอบ</button>
      </div>
      <div className="mt-4 divide-y rounded-lg border">{schedules.map((item) => <div key={item.id} className="flex items-center gap-3 px-4 py-3 text-sm"><b className="w-24">{item.channel_code}</b><span className="w-20">{DAYS[item.day_of_week]}</span><span className="font-mono">{item.pickup_time.slice(0, 5)}</span><span className="flex-1 text-slate-500">เผื่อแพ็ค {item.pack_buffer_minutes} นาที</span><button type="button" onClick={() => deleteSchedule(item.id)} className="text-red-600">ลบ</button></div>)}</div>
    </section>
  </div>
}
