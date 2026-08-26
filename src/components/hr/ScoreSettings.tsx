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
import {
  SITUATIONS,
  COUNT_SOURCES,
  LATE_KEY,
  groupLabel,
  situationByKey,
  situationOfRule,
  lateCode,
  cumulativeCode,
} from '../../lib/scoreSituations'
import type { Situation } from '../../lib/scoreSituations'

const SCOPE_LABELS: Record<RuleScope, string> = {
  all: 'ทุกวัน',
  onsite: 'เฉพาะวันเข้าออฟฟิศ',
  remote: 'เฉพาะวัน WFH',
}

const emptyRuleForm = {
  id: '',
  situation: LATE_KEY,
  event_code: '',
  name: '',
  points: '',
  points_step: '',
  threshold_min: '',
  threshold_max: '',
  cap_per_month: '',
  applies_to: 'all' as RuleScope,
  counts_event_prefix: COUNT_SOURCES[0].prefix,
  sort_order: '',
  is_active: true,
}

const inputClass = 'mt-1 w-full rounded-xl border border-surface-200 px-3 py-2 text-sm'

export default function ScoreSettings() {
  const { showConfirm, ConfirmModal } = useWmsModal({ showCancelButton: false })
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
    setError('')
    setRuleForm({
      id: r.id,
      situation: situationOfRule(r)?.key ?? '',
      event_code: r.event_code,
      name: r.name,
      points: String(r.points),
      points_step: !r.points_step ? '' : String(r.points_step),
      threshold_min: r.threshold_min === null ? '' : String(r.threshold_min),
      threshold_max: r.threshold_max === null ? '' : String(r.threshold_max),
      cap_per_month: r.cap_per_month === null ? '' : String(r.cap_per_month),
      applies_to: r.applies_to,
      counts_event_prefix: r.counts_event_prefix ?? COUNT_SOURCES[0].prefix,
      sort_order: String(r.sort_order),
      is_active: r.is_active,
    })
  }

  /** เลือกสถานการณ์ใหม่ → เติมชื่อและล้างช่องที่สถานการณ์นั้นไม่ใช้ */
  const pickSituation = (key: string) => {
    const s = situationByKey(key)
    setRuleForm((prev) => ({
      ...prev,
      situation: key,
      name: prev.name.trim() === '' || SITUATIONS.some((o) => o.defaultName === prev.name.trim())
        ? s.defaultName
        : prev.name,
      threshold_min: s.kind === 'fixed' && !s.minLabel ? '' : prev.threshold_min,
      threshold_max: s.kind === 'late' ? prev.threshold_max : '',
      points_step: s.kind === 'cumulative' ? prev.points_step : '',
    }))
  }

  const saveRule = async () => {
    if (!categoryId) return
    const situation = ruleForm.situation ? situationByKey(ruleForm.situation) : null
    if (!ruleForm.id && !situation) {
      setError('เลือกสถานการณ์ก่อน')
      return
    }
    if (!ruleForm.name.trim()) {
      setError('ต้องตั้งชื่อกติกา')
      return
    }

    // รหัสของกติกาที่แก้ไขอยู่ห้ามเปลี่ยน (เหตุการณ์เก่าอ้างถึงอยู่) · ของใหม่สร้างจากสถานการณ์
    const taken = new Set(rules.map((r) => r.event_code))
    let code = ruleForm.event_code
    if (!ruleForm.id && situation) {
      if (situation.kind === 'late') {
        if (ruleForm.threshold_min.trim() === '') {
          setError('กรอก "สายตั้งแต่ (นาที)" ของขั้นนี้')
          return
        }
        code = lateCode(ruleForm.threshold_min, ruleForm.threshold_max)
        if (taken.has(code)) {
          setError(`มีขั้นความสายช่วงนี้อยู่แล้ว (${code}) — แก้ไขขั้นเดิม หรือเปลี่ยนช่วงนาที`)
          return
        }
      } else if (situation.kind === 'cumulative') {
        if (ruleForm.threshold_min.trim() === '') {
          setError('กรอก "ยอมให้กี่ครั้งต่อเดือน"')
          return
        }
        code = cumulativeCode(ruleForm.counts_event_prefix, taken)
      } else {
        code = situation.code as string
        if (taken.has(code)) {
          setError(`ตั้งกติกาของสถานการณ์นี้ไว้แล้ว — กด "แก้ไข" ที่รายการเดิมแทน`)
          return
        }
      }
    }

    const isCumulative = situation?.kind === 'cumulative'
    // กติกาที่ระบบไม่รู้จัก (situation = null) ต้องไม่ถูกย้ายหัวข้อย่อยตอนกดบันทึก
    const groupCode = situation?.group
      ?? rules.find((r) => r.id === ruleForm.id)?.group_code
      ?? 'attendance'
    setSaving(true)
    try {
      await upsertScoreRule({
        ...(ruleForm.id ? { id: ruleForm.id } : {}),
        category_id: categoryId,
        group_code: groupCode,
        event_code: code,
        name: ruleForm.name.trim(),
        points: Number(ruleForm.points || 0),
        points_step: isCumulative ? Number(ruleForm.points_step || 0) : 0,
        threshold_min: ruleForm.threshold_min === '' ? null : Number(ruleForm.threshold_min),
        threshold_max: ruleForm.threshold_max === '' ? null : Number(ruleForm.threshold_max),
        cap_per_month: ruleForm.cap_per_month === '' ? null : Number(ruleForm.cap_per_month),
        applies_to: ruleForm.applies_to,
        counts_event_prefix: isCumulative ? ruleForm.counts_event_prefix : null,
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

  /** กติกาที่ตัวคิดคะแนนไม่รู้จัก — บันทึกอยู่ในตารางแต่ไม่มีผลกับคะแนนเลย */
  const brokenRules = useMemo(
    () => rules.filter((r) => r.is_active && situationOfRule(r) === null),
    [rules],
  )

  const situation = ruleForm.situation ? situationByKey(ruleForm.situation) : null
  const isLate = situation?.kind === 'late'
  const isCumulative = situation?.kind === 'cumulative'
  /** สถานการณ์ตายตัวที่ตั้งไว้แล้ว — ซ่อนจากรายการ เพราะ event_code ตั้งซ้ำไม่ได้ */
  const usedFixedCodes = useMemo(
    () => new Set(rules.filter((r) => !r.counts_event_prefix).map((r) => r.event_code)),
    [rules],
  )
  const situationOptions = useMemo(
    () => SITUATIONS.filter((s) => !!ruleForm.id || s.code === null || !usedFixedCodes.has(s.code)),
    [usedFixedCodes, ruleForm.id],
  )
  const situationGroups = useMemo(() => {
    const map = new Map<string, Situation[]>()
    situationOptions.forEach((s) => {
      const list = map.get(s.group) ?? []
      list.push(s)
      map.set(s.group, list)
    })
    return [...map.entries()]
  }, [situationOptions])

  /** รหัสที่จะถูกบันทึก — โชว์ให้เห็นว่าระบบตั้งอะไรให้ */
  const previewCode = ruleForm.id
    ? ruleForm.event_code
    : isLate
      ? (ruleForm.threshold_min.trim() === '' ? '—' : lateCode(ruleForm.threshold_min, ruleForm.threshold_max))
      : isCumulative
        ? cumulativeCode(ruleForm.counts_event_prefix, new Set(rules.map((r) => r.event_code)))
        : situation?.code ?? '—'

  /** ตัวอย่างการหักของกติกาสะสมตามค่าที่กรอกอยู่ */
  const cumulativePreview = useMemo(() => {
    if (!isCumulative) return null
    const allowance = Number(ruleForm.threshold_min || 0)
    const base = Number(ruleForm.points || 0)
    const step = Number(ruleForm.points_step || 0)
    if (!Number.isFinite(allowance) || base === 0) return null
    const amounts = Array.from({ length: 4 }, (_, n) => {
      const v = base + step * n
      return base < 0 ? Math.min(v, 0) : Math.max(v, 0)
    })
    const total = amounts.reduce((a, b) => a + b, 0)
    return { allowance, amounts, total, occurrences: allowance + 4 }
  }, [isCumulative, ruleForm.threshold_min, ruleForm.points, ruleForm.points_step])

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
            <span className="text-xs text-amber-600">ยังไม่มีผล — ใช้เมื่อมีหลายหมวดคะแนน</span>
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
          {brokenRules.length > 0 && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
              <div className="font-medium">มี {brokenRules.length} กติกาที่ระบบไม่รู้จัก จึงไม่ถูกนำไปคิดคะแนน</div>
              <div className="text-xs mt-1">
                {brokenRules.map((r) => `${r.name} (${r.event_code})`).join(' · ')}
              </div>
              <div className="text-xs mt-1 text-red-600">
                เกิดจากรหัสเหตุการณ์ที่ตั้งไว้ตอนเก่าไม่ตรงกับสถานการณ์ที่ระบบรองรับ — ลบแล้วสร้างใหม่จากรายการสถานการณ์
              </div>
            </div>
          )}
          {grouped.map(([group, list]) => (
            <div key={group}>
              <div className="text-sm font-medium text-gray-700 mb-1">{groupLabel(group)}</div>
              <table className="w-full text-sm">
                <thead className="bg-surface-100 border-b border-surface-200">
                  <tr>
                    <th className="text-left py-2 px-3">กติกา</th>
                    <th className="text-center py-2 px-3">คะแนน</th>
                    <th className="text-center py-2 px-3">{group === 'attendance_cumulative' ? 'โควตา/เดือน' : 'ช่วง'}</th>
                    <th className="text-center py-2 px-3">ใช้กับ</th>
                    <th className="text-right py-2 px-3">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className={`border-b border-surface-100 ${r.is_active ? '' : 'opacity-50'}`}>
                      <td className="py-2 px-3">
                        <div className="font-medium">
                          {r.name}
                          {situationOfRule(r) === null && (
                            <span className="ml-2 text-xs text-red-600 font-normal">ระบบไม่รู้จัก — ไม่ถูกคิดคะแนน</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400">
                          {r.event_code}
                          {r.counts_event_prefix && ` · นับจาก ${
                            COUNT_SOURCES.find((s) => s.prefix === r.counts_event_prefix)?.label ?? r.counts_event_prefix
                          }`}
                          {r.cap_per_month !== null && ` · เพดาน ${r.cap_per_month}/เดือน`}
                        </div>
                      </td>
                      <td className={`py-2 px-3 text-center tabular-nums font-medium ${r.points < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {r.points}
                        {!!r.points_step && (
                          <div className="text-xs font-normal text-amber-600">
                            เพิ่มครั้งละ {r.points_step}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center text-xs text-gray-500">
                        {r.counts_event_prefix
                          ? `เกิน ${r.threshold_min ?? 0} ครั้ง`
                          : r.threshold_min === null && r.threshold_max === null
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
            <span className="text-gray-600">สถานการณ์ที่จะให้คะแนน/หักคะแนน</span>
            <select value={ruleForm.situation} disabled={!!ruleForm.id}
              onChange={(e) => pickSituation(e.target.value)}
              className={`${inputClass} disabled:bg-surface-100`}>
              {!ruleForm.situation && <option value="">— ระบบไม่รู้จักรหัสนี้ —</option>}
              {situationGroups.map(([group, list]) => (
                <optgroup key={group} label={groupLabel(group)}>
                  {list.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {situation ? (
            <p className="text-xs text-gray-400 -mt-1">{situation.hint}</p>
          ) : (
            <p className="text-xs text-red-600 -mt-1">
              รหัส <code>{ruleForm.event_code}</code> ไม่ตรงกับสถานการณ์ใดที่ระบบรู้จัก — กติกานี้จะไม่ถูกนำไปคิดคะแนน แนะนำให้ลบแล้วสร้างใหม่
            </p>
          )}
          {ruleForm.id && (
            <p className="text-xs text-gray-400 -mt-1">
              เปลี่ยนสถานการณ์ของกติกาที่บันทึกแล้วไม่ได้ (เหตุการณ์เก่าอ้างถึงอยู่) — ถ้าต้องเปลี่ยน ให้ลบแล้วสร้างใหม่
            </p>
          )}

          {/* ขั้นความสาย — ช่วงนาทีคือตัวกำหนดว่าขั้นนี้ใช้เมื่อไหร่ */}
          {isLate && (
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface-50 border border-surface-200 p-3">
              <label className="block text-sm">
                <span className="text-gray-600">สายตั้งแต่ (นาที)</span>
                <input type="number" min={1} value={ruleForm.threshold_min}
                  onChange={(e) => setRuleForm({ ...ruleForm, threshold_min: e.target.value })}
                  placeholder="16" className={inputClass} />
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">ถึง (นาที)</span>
                <input type="number" min={1} value={ruleForm.threshold_max}
                  onChange={(e) => setRuleForm({ ...ruleForm, threshold_max: e.target.value })}
                  placeholder="ว่าง = ไม่จำกัด" className={inputClass} />
              </label>
              <p className="col-span-2 text-xs text-gray-400">
                นับหลังหักเวลาผ่อนผันของกะแล้ว · สายเกินทุกขั้นที่ตั้งไว้จะไม่ถูกหัก จึงควรมีขั้นสุดท้ายที่เว้น "ถึง" ว่าง
              </p>
            </div>
          )}

          {/* กติกาสะสม */}
          {isCumulative && (
            <div className="space-y-3 rounded-xl bg-surface-50 border border-surface-200 p-3">
              <label className="block text-sm">
                <span className="text-gray-600">นับจาก</span>
                <select value={ruleForm.counts_event_prefix} disabled={!!ruleForm.id}
                  onChange={(e) => setRuleForm({ ...ruleForm, counts_event_prefix: e.target.value })}
                  className={`${inputClass} disabled:bg-surface-100`}>
                  {COUNT_SOURCES.map((s) => <option key={s.prefix} value={s.prefix}>{s.label}</option>)}
                  {!COUNT_SOURCES.some((s) => s.prefix === ruleForm.counts_event_prefix) && (
                    <option value={ruleForm.counts_event_prefix}>{ruleForm.counts_event_prefix} (ค่าเดิม)</option>
                  )}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-gray-600">ยอมให้กี่ครั้งต่อเดือน</span>
                <input type="number" min={0} value={ruleForm.threshold_min}
                  onChange={(e) => setRuleForm({ ...ruleForm, threshold_min: e.target.value })}
                  placeholder="5" className={inputClass} />
                <span className="text-xs text-gray-400">ครั้งที่เกินจากนี้จึงเริ่มหักเพิ่ม</span>
              </label>
            </div>
          )}

          <label className="block text-sm">
            <span className="text-gray-600">ชื่อกติกา</span>
            <input type="text" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })}
              placeholder={situation?.defaultName || 'เช่น สายเกิน 5 ครั้ง/เดือน'} className={inputClass} />
            <span className="text-xs text-gray-400">ชื่อนี้คือสิ่งที่พนักงานเห็นในรายการคะแนนของตัวเอง</span>
          </label>

          <label className="block text-sm">
            <span className="text-gray-600">{isCumulative ? 'หักครั้งแรกที่เกิน (ติดลบ = หัก)' : 'คะแนน (ติดลบ = หัก)'}</span>
            <input type="number" step="0.5" value={ruleForm.points}
              onChange={(e) => setRuleForm({ ...ruleForm, points: e.target.value })} className={inputClass} />
          </label>

          {/* หัวใจของกติกาสะสมแบบไล่ระดับ */}
          {isCumulative && (
            <label className="block text-sm">
              <span className="text-gray-600">เพิ่มขึ้นครั้งละ (ติดลบ = หักหนักขึ้น)</span>
              <input type="number" step="0.5" value={ruleForm.points_step}
                onChange={(e) => setRuleForm({ ...ruleForm, points_step: e.target.value })}
                placeholder="0 = หักเท่ากันทุกครั้ง" className={inputClass} />
            </label>
          )}
          {cumulativePreview && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900 space-y-0.5">
              <div className="font-medium">ผลที่จะได้</div>
              <div>ทำผิด {cumulativePreview.allowance} ครั้ง → ไม่หักเพิ่ม</div>
              {cumulativePreview.amounts.map((_, i) => (
                <div key={i}>
                  ทำผิด {cumulativePreview.allowance + i + 1} ครั้ง → หักเพิ่ม{' '}
                  <span className="tabular-nums">{cumulativePreview.amounts.slice(0, i + 1).join(', ')}</span>
                  {' '}(รวม <span className="tabular-nums">
                    {cumulativePreview.amounts.slice(0, i + 1).reduce((a, b) => a + b, 0)}
                  </span>)
                </div>
              ))}
              <div className="text-emerald-700 pt-1">ยังไม่รวมคะแนนที่ถูกหักจากกติการายวันของแต่ละครั้ง</div>
            </div>
          )}

          {/* threshold_min ของสถานการณ์ตายตัวที่ใช้ช่องนี้ — ป้ายเปลี่ยนตามความหมายจริง */}
          {situation?.kind === 'fixed' && situation.minLabel && (
            <label className="block text-sm">
              <span className="text-gray-600">{situation.minLabel}</span>
              <input type="number" min={0} value={ruleForm.threshold_min}
                onChange={(e) => setRuleForm({ ...ruleForm, threshold_min: e.target.value })} className={inputClass} />
              {situation.minHint && <span className="text-xs text-gray-400">{situation.minHint}</span>}
            </label>
          )}

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
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ruleForm.is_active}
              onChange={(e) => setRuleForm({ ...ruleForm, is_active: e.target.checked })}
              className="w-4 h-4 accent-emerald-600" />
            <span className="text-gray-600">เปิดใช้งาน</span>
          </label>
          <div className="border-t border-surface-200 pt-2 text-xs text-gray-400">
            รหัสอ้างอิงในระบบ: <code className="text-gray-500">{previewCode}</code>
            {!ruleForm.id && ' (ระบบตั้งให้อัตโนมัติ)'}
          </div>
          <div className="flex justify-end gap-2">
            {ruleForm.id && (
              <button type="button" onClick={() => { setRuleForm(emptyRuleForm); setError('') }}
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
