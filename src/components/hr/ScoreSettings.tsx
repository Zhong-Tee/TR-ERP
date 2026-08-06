import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchScoreCategories,
  fetchScoreRules,
  fetchScoreSettings,
  saveScoreSettings,
  upsertScoreCategory,
  upsertScoreRule,
  deleteScoreRule,
} from '../../lib/hrApi'
import { useWmsModal } from '../wms/useWmsModal'
import type { ScoreCategory, ScoreRule, RuleScope } from '../../lib/workScore'
import type { HRScoreSettings } from '../../types'

const GROUP_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'attendance', label: 'การมาทำงาน', hint: 'ขั้นความสาย (event_code ขึ้นต้นด้วย late_) และกลับก่อนเวลา — ช่วงนาที = นาทีที่สาย' },
  { value: 'time_entry', label: 'การลงเวลา', hint: 'ไม่มีเวลาเข้า/ออก — ช่วงนาทีของ missing_in_unproven = นาทีขั้นต่ำที่ต้องอยู่ถึงจะเชื่อว่ามาทำงาน' },
  { value: 'leave', label: 'การลา', hint: 'ลาถูกระเบียบ แจ้งช้า ขาดงาน' },
  { value: 'ot', label: 'OT', hint: 'ลืมขอ OT ก่อนทำ / ทำโดยไม่ได้อนุมัติ' },
  { value: 'attendance_cumulative', label: 'สะสม', hint: 'ทำผิดซ้ำ ๆ — ช่วงนาที (ต่ำสุด) = จำนวนครั้งที่ยอมให้ต่อเดือน · ต้องกรอก "นับ event_code ที่ขึ้นต้นด้วย"' },
]

const SCOPE_LABELS: Record<RuleScope, string> = {
  all: 'ทุกวัน',
  onsite: 'เฉพาะวันเข้าออฟฟิศ',
  remote: 'เฉพาะวัน WFH',
}

const groupLabel = (code: string) => GROUP_OPTIONS.find((g) => g.value === code)?.label ?? code

const emptyRuleForm = {
  id: '',
  group_code: 'attendance',
  event_code: '',
  name: '',
  points: '',
  threshold_min: '',
  threshold_max: '',
  cap_per_month: '',
  applies_to: 'all' as RuleScope,
  counts_event_prefix: '',
  sort_order: '',
  is_active: true,
}

const inputClass = 'mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 text-sm'

export default function ScoreSettings() {
  const { showConfirm, ConfirmModal } = useWmsModal()
  const [categories, setCategories] = useState<ScoreCategory[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [rules, setRules] = useState<ScoreRule[]>([])
  const [settings, setSettings] = useState<HRScoreSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [ruleForm, setRuleForm] = useState(emptyRuleForm)

  const category = useMemo(() => categories.find((c) => c.id === categoryId) ?? null, [categories, categoryId])

  const [catForm, setCatForm] = useState({ base_points: '', min_points: '', weight: '' })

  const loadRules = useCallback(async (id: string) => {
    if (!id) return
    try {
      setRules(await fetchScoreRules(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'โหลดกติกาไม่สำเร็จ')
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchScoreCategories(), fetchScoreSettings()])
      .then(([cats, s]) => {
        setCategories(cats)
        setSettings(s)
        setCategoryId((prev) => prev || cats[0]?.id || '')
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void loadRules(categoryId)
    if (category) {
      setCatForm({
        base_points: String(category.base_points),
        min_points: String(category.min_points),
        weight: String(category.weight),
      })
    }
  }, [categoryId, category, loadRules])

  const flash = (text: string) => {
    setMessage(text)
    setError('')
    setTimeout(() => setMessage(''), 3000)
  }

  const saveSettings = async () => {
    if (!settings) return
    setSaving(true)
    try {
      setSettings(await saveScoreSettings(settings))
      flash('บันทึกค่ากลางรอบคะแนนแล้ว')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const saveCategory = async () => {
    if (!category) return
    setSaving(true)
    try {
      const saved = await upsertScoreCategory({
        id: category.id,
        base_points: Number(catForm.base_points),
        min_points: Number(catForm.min_points),
        weight: Number(catForm.weight),
      })
      setCategories((prev) => prev.map((c) => (c.id === saved.id ? saved : c)))
      flash('บันทึกหมวดคะแนนแล้ว')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const editRule = (r: ScoreRule) => {
    setRuleForm({
      id: r.id,
      group_code: r.group_code,
      event_code: r.event_code,
      name: r.name,
      points: String(r.points),
      threshold_min: r.threshold_min === null ? '' : String(r.threshold_min),
      threshold_max: r.threshold_max === null ? '' : String(r.threshold_max),
      cap_per_month: r.cap_per_month === null ? '' : String(r.cap_per_month),
      applies_to: r.applies_to,
      counts_event_prefix: r.counts_event_prefix ?? '',
      sort_order: String(r.sort_order),
      is_active: r.is_active,
    })
  }

  const saveRule = async () => {
    if (!categoryId) return
    const code = ruleForm.event_code.trim()
    if (!code || !ruleForm.name.trim()) {
      setError('ต้องกรอกรหัสเหตุการณ์และชื่อกติกา')
      return
    }
    setSaving(true)
    try {
      await upsertScoreRule({
        ...(ruleForm.id ? { id: ruleForm.id } : {}),
        category_id: categoryId,
        group_code: ruleForm.group_code,
        event_code: code,
        name: ruleForm.name.trim(),
        points: Number(ruleForm.points || 0),
        threshold_min: ruleForm.threshold_min === '' ? null : Number(ruleForm.threshold_min),
        threshold_max: ruleForm.threshold_max === '' ? null : Number(ruleForm.threshold_max),
        cap_per_month: ruleForm.cap_per_month === '' ? null : Number(ruleForm.cap_per_month),
        applies_to: ruleForm.applies_to,
        counts_event_prefix: ruleForm.counts_event_prefix.trim() || null,
        sort_order: Number(ruleForm.sort_order || 0),
        is_active: ruleForm.is_active,
      })
      setRuleForm(emptyRuleForm)
      await loadRules(categoryId)
      flash('บันทึกกติกาแล้ว')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกกติกาไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const removeRule = async (r: ScoreRule) => {
    const ok = await showConfirm({
      title: 'ลบกติกา',
      message: `ลบกติกา "${r.name}"?\n\nเหตุการณ์ที่บันทึกไว้แล้วจะยังอยู่ แต่จะไม่ถูกคิดใหม่อีก`,
      confirmText: 'ลบ',
    })
    if (!ok) return
    setSaving(true)
    try {
      await deleteScoreRule(r.id)
      await loadRules(categoryId)
      flash('ลบกติกาแล้ว')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบไม่สำเร็จ')
    } finally {
      setSaving(false)
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, ScoreRule[]>()
    rules.forEach((r) => {
      const list = map.get(r.group_code) ?? []
      list.push(r)
      map.set(r.group_code, list)
    })
    return [...map.entries()]
  }, [rules])

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">{error}</div>}
      {message && <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 text-sm">{message}</div>}

      {/* ค่ากลางของรอบคะแนน */}
      {settings && (
        <div className="rounded-xl border border-surface-200 bg-white p-4">
          <h3 className="font-medium text-gray-900 mb-3">รอบคะแนน</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="block text-sm">
              <span className="text-gray-600">ปิดรอบวันที่ (ของเดือนถัดไป)</span>
              <input type="number" min={1} max={28} value={settings.lock_day_of_month}
                onChange={(e) => setSettings({ ...settings, lock_day_of_month: Number(e.target.value) })}
                className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">รับรองเวลาย้อนหลังได้ (วัน)</span>
              <input type="number" min={0} value={settings.certify_back_days}
                onChange={(e) => setSettings({ ...settings, certify_back_days: Number(e.target.value) })}
                className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ทักท้วงได้ภายใน (วัน)</span>
              <input type="number" min={0} value={settings.appeal_days}
                onChange={(e) => setSettings({ ...settings, appeal_days: Number(e.target.value) })}
                className={inputClass} />
            </label>
            <label className="flex items-end gap-2 text-sm pb-2">
              <input type="checkbox" checked={settings.auto_lock}
                onChange={(e) => setSettings({ ...settings, auto_lock: e.target.checked })}
                className="w-4 h-4 accent-emerald-600" />
              <span className="text-gray-600">ปิดรอบอัตโนมัติเมื่อถึงกำหนด</span>
            </label>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            หัวหน้ารับรองเวลาเกินกำหนดจะถูกปฏิเสธที่ระดับฐานข้อมูล (HR/admin ข้ามได้) · รอบที่ปิดแล้วแก้คะแนนไม่ได้อีก
          </p>
          <div className="flex justify-end mt-3">
            <button type="button" onClick={saveSettings} disabled={saving}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      )}

      {/* หมวดคะแนน */}
      <div className="rounded-xl border border-surface-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="text-gray-600">หมวดคะแนน</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">คะแนนตั้งต้น/เดือน</span>
            <input type="number" value={catForm.base_points}
              onChange={(e) => setCatForm({ ...catForm, base_points: e.target.value })} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">คะแนนต่ำสุด (พื้น)</span>
            <input type="number" value={catForm.min_points}
              onChange={(e) => setCatForm({ ...catForm, min_points: e.target.value })} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">น้ำหนัก</span>
            <input type="number" step="0.1" value={catForm.weight}
              onChange={(e) => setCatForm({ ...catForm, weight: e.target.value })} className={inputClass} />
          </label>
          <button type="button" onClick={saveCategory} disabled={saving || !category}
            className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
            บันทึกหมวด
          </button>
        </div>
      </div>

      {/* กติกา */}
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-xl shadow-soft border border-surface-200 bg-surface-50 p-4 space-y-4">
          {grouped.map(([group, list]) => (
            <div key={group}>
              <div className="text-sm font-medium text-gray-700 mb-1">{groupLabel(group)}</div>
              <table className="w-full text-sm">
                <thead className="bg-surface-100 border-b border-surface-200">
                  <tr>
                    <th className="text-left py-2 px-3">กติกา</th>
                    <th className="text-center py-2 px-3">คะแนน</th>
                    <th className="text-center py-2 px-3">ช่วง</th>
                    <th className="text-center py-2 px-3">ใช้กับ</th>
                    <th className="text-right py-2 px-3">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className={`border-b border-surface-100 ${r.is_active ? '' : 'opacity-50'}`}>
                      <td className="py-2 px-3">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-gray-400">
                          {r.event_code}
                          {r.counts_event_prefix && ` · นับ ${r.counts_event_prefix}*`}
                          {r.cap_per_month !== null && ` · เพดาน ${r.cap_per_month}/เดือน`}
                        </div>
                      </td>
                      <td className={`py-2 px-3 text-center tabular-nums font-medium ${r.points < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {r.points}
                      </td>
                      <td className="py-2 px-3 text-center text-xs text-gray-500">
                        {r.threshold_min === null && r.threshold_max === null
                          ? '-'
                          : `${r.threshold_min ?? '0'}–${r.threshold_max ?? '∞'}`}
                      </td>
                      <td className="py-2 px-3 text-center text-xs text-gray-500">{SCOPE_LABELS[r.applies_to]}</td>
                      <td className="py-2 px-3 text-right space-x-2 whitespace-nowrap">
                        <button type="button" onClick={() => editRule(r)}
                          className="px-2 py-1 rounded-lg bg-surface-100 hover:bg-surface-200 text-xs">แก้ไข</button>
                        <button type="button" onClick={() => removeRule(r)} disabled={saving}
                          className="px-2 py-1 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs">ลบ</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {rules.length === 0 && <div className="py-6 text-center text-gray-400">ยังไม่มีกติกาในหมวดนี้</div>}
        </div>

        <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3">
          <h3 className="font-medium text-gray-900">{ruleForm.id ? 'แก้ไขกติกา' : 'เพิ่มกติกา'}</h3>
          <label className="block text-sm">
            <span className="text-gray-600">หัวข้อย่อย</span>
            <select value={ruleForm.group_code} onChange={(e) => setRuleForm({ ...ruleForm, group_code: e.target.value })} className={inputClass}>
              {GROUP_OPTIONS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </label>
          <p className="text-xs text-gray-400 -mt-1">{GROUP_OPTIONS.find((g) => g.value === ruleForm.group_code)?.hint}</p>
          <label className="block text-sm">
            <span className="text-gray-600">รหัสเหตุการณ์ (event_code)</span>
            <input type="text" value={ruleForm.event_code} disabled={!!ruleForm.id}
              onChange={(e) => setRuleForm({ ...ruleForm, event_code: e.target.value })}
              placeholder="เช่น late_31_60" className={`${inputClass} disabled:bg-surface-100`} />
          </label>
          {!ruleForm.id && (
            <p className="text-xs text-amber-600 -mt-1">
              ขั้นความสายต้องขึ้นต้นด้วย <code>late_</code> · เปลี่ยนรหัสหลังใช้งานจริงไม่ได้
            </p>
          )}
          <label className="block text-sm">
            <span className="text-gray-600">ชื่อกติกา</span>
            <input type="text" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">คะแนน (ติดลบ = หัก)</span>
            <input type="number" step="0.5" value={ruleForm.points}
              onChange={(e) => setRuleForm({ ...ruleForm, points: e.target.value })} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="text-gray-600">ช่วงต่ำสุด</span>
              <input type="number" value={ruleForm.threshold_min}
                onChange={(e) => setRuleForm({ ...ruleForm, threshold_min: e.target.value })} className={inputClass} />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ช่วงสูงสุด</span>
              <input type="number" value={ruleForm.threshold_max}
                onChange={(e) => setRuleForm({ ...ruleForm, threshold_max: e.target.value })} className={inputClass} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-gray-600">ใช้กับวันแบบไหน</span>
            <select value={ruleForm.applies_to}
              onChange={(e) => setRuleForm({ ...ruleForm, applies_to: e.target.value as RuleScope })} className={inputClass}>
              {(Object.keys(SCOPE_LABELS) as RuleScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-gray-600">เพดานหักต่อเดือน (ว่าง = ไม่จำกัด)</span>
            <input type="number" min={0} value={ruleForm.cap_per_month}
              onChange={(e) => setRuleForm({ ...ruleForm, cap_per_month: e.target.value })} className={inputClass} />
          </label>
          {ruleForm.group_code === 'attendance_cumulative' && (
            <label className="block text-sm">
              <span className="text-gray-600">นับ event_code ที่ขึ้นต้นด้วย</span>
              <input type="text" value={ruleForm.counts_event_prefix}
                onChange={(e) => setRuleForm({ ...ruleForm, counts_event_prefix: e.target.value })}
                placeholder="เช่น late_" className={inputClass} />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ruleForm.is_active}
              onChange={(e) => setRuleForm({ ...ruleForm, is_active: e.target.checked })}
              className="w-4 h-4 accent-emerald-600" />
            <span className="text-gray-600">เปิดใช้งาน</span>
          </label>
          <div className="flex justify-end gap-2">
            {ruleForm.id && (
              <button type="button" onClick={() => setRuleForm(emptyRuleForm)}
                className="px-4 py-2 rounded-xl bg-surface-100 hover:bg-surface-200 text-sm">ยกเลิก</button>
            )}
            <button type="button" onClick={saveRule} disabled={saving}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
        </div>
      </div>

      {ConfirmModal}
    </div>
  )
}
