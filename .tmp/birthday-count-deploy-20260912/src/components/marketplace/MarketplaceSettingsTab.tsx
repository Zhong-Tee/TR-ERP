import { useEffect, useMemo, useRef, useState } from 'react'
import { FiMenu, FiTrash2 } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { useWmsModal } from '../wms/useWmsModal'
import {
  MP_FIELD_GROUPS,
  MP_FIELD_LABELS,
  MP_ASSIGN_FORM_FIELDS,
  SHOPEE_DEFAULT_MAP,
  buildMpColIndex,
  parseMarketplaceWorkbook,
  type MpFieldKey,
  type MpMapRow,
  type MpParseResult,
} from '../../lib/marketplaceImport'
import { DEFAULT_DUE_RULE, type DueRule } from '../../lib/shipDueBadge'
import type { User } from '../../types'
import type { MpChannelConfig, MpShippingRule } from '../../types/marketplace'

interface ChannelOption {
  channel_code: string
  channel_name: string
}

interface MarketplaceAssignerUser {
  id: string
  username?: string | null
  email: string
  role: string
}

const SOURCE_TYPE_LABELS: Record<MpMapRow['source_type'], string> = {
  header_exact: 'หัวคอลัมน์ตรงกัน',
  header_contains: 'หัวคอลัมน์มีคำว่า',
  excel_column_letter: 'ตัวอักษรคอลัมน์ (A, B, ...)',
}

interface EditorState {
  id: string | null
  name: string
  channel_code: string
  sheet_name: string
  header_row: number
  column_map: MpMapRow[]
  due_rule: DueRule
  shipping_rules: MpShippingRule[]
  is_active: boolean
}

const emptyEditor = (): EditorState => ({
  id: null,
  name: '',
  channel_code: '',
  sheet_name: 'orders',
  header_row: 0,
  column_map: SHOPEE_DEFAULT_MAP.map((r) => ({ ...r })),
  due_rule: { ...DEFAULT_DUE_RULE },
  shipping_rules: [],
  is_active: true,
})

export default function MarketplaceSettingsTab({
  user,
  configs,
  onConfigsChanged,
  onAssignersChanged,
}: {
  user: User
  configs: MpChannelConfig[]
  onConfigsChanged: () => void
  onAssignersChanged: () => void
}) {
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const [channels, setChannels] = useState<ChannelOption[]>([])
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  // ไฟล์ตัวอย่างสำหรับช่วยจับคู่คอลัมน์ (ไม่มีการนำเข้าข้อมูล — อ่านหัวตารางอย่างเดียว)
  const sampleInputRef = useRef<HTMLInputElement>(null)
  const [sampleFile, setSampleFile] = useState<File | null>(null)
  const [sampleSheets, setSampleSheets] = useState<Record<string, unknown[][]>>({})
  const [testResult, setTestResult] = useState<MpParseResult | null>(null)
  const [draggedMapIndex, setDraggedMapIndex] = useState<number | null>(null)
  const [assignerUsers, setAssignerUsers] = useState<MarketplaceAssignerUser[]>([])
  const [assignerIds, setAssignerIds] = useState<Set<string>>(new Set())
  const [loadingAssigners, setLoadingAssigners] = useState(false)
  const [savingAssigners, setSavingAssigners] = useState(false)

  useEffect(() => {
    if (user.role !== 'superadmin') return
    let cancelled = false

    async function loadAssigners() {
      setLoadingAssigners(true)
      try {
        const [usersResult, permissionsResult] = await Promise.all([
          supabase
            .from('us_users')
            .select('id, username, email, role')
            .eq('is_active', true)
            .in('role', ['admin', 'sales-tr'])
            .order('username', { ascending: true }),
          supabase
            .from('mp_assigner_permissions')
            .select('user_id, can_assign')
            .eq('can_assign', true),
        ])
        if (usersResult.error) throw usersResult.error
        if (permissionsResult.error) throw permissionsResult.error
        if (cancelled) return
        setAssignerUsers((usersResult.data || []) as MarketplaceAssignerUser[])
        setAssignerIds(
          new Set((permissionsResult.data || []).map((row: { user_id: string }) => row.user_id)),
        )
      } catch (err) {
        console.error('Error loading Marketplace assigners:', err)
      } finally {
        if (!cancelled) setLoadingAssigners(false)
      }
    }

    loadAssigners()
    return () => {
      cancelled = true
    }
  }, [user.role])

  function toggleAssigner(userId: string) {
    setAssignerIds((current) => {
      const next = new Set(current)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  async function saveAssigners() {
    if (user.role !== 'superadmin') return
    setSavingAssigners(true)
    try {
      const now = new Date().toISOString()
      const rows = assignerUsers.map((assigner) => ({
        user_id: assigner.id,
        can_assign: assignerIds.has(assigner.id),
        granted_by: user.id,
        updated_at: now,
      }))
      if (rows.length > 0) {
        const { error } = await supabase.from('mp_assigner_permissions').upsert(rows, { onConflict: 'user_id' })
        if (error) throw error
      }
      await onAssignersChanged()
      showMessage({ title: 'บันทึกสำเร็จ', message: 'อัปเดตรายชื่อผู้มีสิทธิ์ Assign งานแล้ว' })
    } catch (err) {
      showMessage({ title: 'บันทึกสิทธิ์ไม่สำเร็จ', message: (err as Error).message })
    } finally {
      setSavingAssigners(false)
    }
  }

  /** หัวตารางจาก sheet + แถวหัวตารางที่เลือกอยู่ในฟอร์ม */
  const sampleHeaders = useMemo(() => {
    if (!editor) return []
    const sheetNames = Object.keys(sampleSheets)
    if (sheetNames.length === 0) return []
    const wanted = (editor.sheet_name || '').trim()
    const rows = sampleSheets[wanted] || sampleSheets[sheetNames[0]]
    const headerRow = (rows || [])[Math.max(0, editor.header_row || 0)] || []
    return headerRow.map((h) => String(h ?? '').trim()).filter(Boolean)
  }, [editor, sampleSheets])

  async function handleSampleFile(file: File) {
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
      const sheets: Record<string, unknown[][]> = {}
      wb.SheetNames.forEach((name) => {
        const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null })
        sheets[name] = rows.slice(0, 12) // เก็บเฉพาะแถวต้นไฟล์ พอสำหรับหาหัวตาราง
      })
      setSampleFile(file)
      setSampleSheets(sheets)
      setTestResult(null)
      // ถ้าชื่อ sheet ในฟอร์มไม่มีในไฟล์ → เลือก sheet แรกของไฟล์ให้
      setEditor((prev) => {
        if (!prev) return prev
        const wanted = (prev.sheet_name || '').trim()
        if (wanted && wb.SheetNames.includes(wanted)) return prev
        return { ...prev, sheet_name: wb.SheetNames[0] || '' }
      })
    } catch (err) {
      showMessage({ title: 'อ่านไฟล์ไม่สำเร็จ', message: (err as Error).message })
    } finally {
      if (sampleInputRef.current) sampleInputRef.current.value = ''
    }
  }

  /** แถวจับคู่นี้เจอคอลัมน์ในไฟล์ตัวอย่างไหม (null = ยังไม่มีไฟล์ตัวอย่าง) */
  function mapRowMatched(row: MpMapRow): boolean | null {
    if (!editor) return null
    const sheetNames = Object.keys(sampleSheets)
    if (sheetNames.length === 0) return null
    if (!row.source_value.trim()) return false
    const wanted = (editor.sheet_name || '').trim()
    const rows = sampleSheets[wanted] || sampleSheets[sheetNames[0]]
    const headerRow = (rows || [])[Math.max(0, editor.header_row || 0)] || []
    const idx = buildMpColIndex([row], headerRow)[row.field_key]
    return idx != null
  }

  async function handleTestMapping() {
    if (!editor || !sampleFile) return
    try {
      const result = await parseMarketplaceWorkbook(sampleFile, {
        sheet_name: editor.sheet_name,
        header_row: editor.header_row,
        column_map: editor.column_map.filter((r) => r.source_value.trim() !== ''),
        due_rule: editor.due_rule,
        channel_code: editor.channel_code,
        shipping_rules: editor.shipping_rules,
      })
      setTestResult(result)
    } catch (err) {
      setTestResult(null)
      showMessage({ title: 'ทดสอบไม่ผ่าน', message: (err as Error).message })
    }
  }

  useEffect(() => {
    supabase
      .from('channels')
      .select('channel_code, channel_name, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .then(({ data }) => {
        if (data) setChannels(data as ChannelOption[])
      })
  }, [])

  function resetSample() {
    setSampleFile(null)
    setSampleSheets({})
    setTestResult(null)
  }

  function openCreate() {
    resetSample()
    setEditor(emptyEditor())
  }

  function openEdit(cfg: MpChannelConfig) {
    resetSample()
    setEditor({
      id: cfg.id,
      name: cfg.name,
      channel_code: cfg.channel_code,
      sheet_name: cfg.sheet_name || '',
      header_row: cfg.header_row ?? 0,
      column_map: Array.isArray(cfg.column_map) ? cfg.column_map.map((r) => ({ ...r })) : [],
      due_rule: { ...DEFAULT_DUE_RULE, ...(cfg.due_rule || {}) },
      shipping_rules: Array.isArray(cfg.shipping_rules) ? cfg.shipping_rules.map((r) => ({ ...r })) : [],
      is_active: cfg.is_active,
    })
  }

  async function handleSave() {
    if (!editor) return
    if (!editor.name.trim()) {
      showMessage({ message: 'กรุณากรอกชื่อช่องทางนำเข้า' })
      return
    }
    if (!editor.channel_code) {
      showMessage({ message: 'กรุณาเลือกช่องทางขาย (กำหนด prefix เลขบิล)' })
      return
    }
    const validMap = editor.column_map.filter((r) => r.source_value.trim() !== '')
    const validShippingRules = editor.shipping_rules.filter((r) => r.source_value.trim() && r.match_value.trim())
    if (!validMap.some((r) => r.field_key === 'order_no')) {
      showMessage({ message: 'ต้องมีการจับคู่คอลัมน์ "เลขคำสั่งซื้อ" อย่างน้อย 1 รายการ' })
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: editor.name.trim(),
        channel_code: editor.channel_code,
        sheet_name: editor.sheet_name.trim() || null,
        header_row: Math.max(0, Number(editor.header_row) || 0),
        column_map: validMap,
        due_rule: {
          cutoff_time: editor.due_rule.cutoff_time || DEFAULT_DUE_RULE.cutoff_time,
          due_time: editor.due_rule.due_time || DEFAULT_DUE_RULE.due_time,
          due_day_offset_after_cutoff: Math.max(0, Number(editor.due_rule.due_day_offset_after_cutoff) || 1),
          overdue_after_hours: Math.max(1, Number(editor.due_rule.overdue_after_hours) || 24),
        },
        shipping_rules: validShippingRules.map((r) => ({
          ...r,
          source_value: r.source_value.trim(),
          match_value: r.match_value.trim(),
          label: r.label.trim(),
          color: r.color || 'orange',
          requires_express_receipt_number: !!r.requires_express_receipt_number,
        })),
        is_active: editor.is_active,
      }
      if (editor.id) {
        const { error } = await supabase.from('mp_channel_configs').update(payload).eq('id', editor.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('mp_channel_configs').insert(payload)
        if (error) throw error
      }
      showMessage({ title: 'สำเร็จ', message: 'บันทึกการตั้งค่าแล้ว' })
      setEditor(null)
      onConfigsChanged()
    } catch (err) {
      showMessage({ title: 'ผิดพลาด', message: (err as Error).message || 'บันทึกไม่สำเร็จ' })
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(cfg: MpChannelConfig) {
    const { error } = await supabase
      .from('mp_channel_configs')
      .update({ is_active: !cfg.is_active })
      .eq('id', cfg.id)
    if (error) {
      showMessage({ title: 'ผิดพลาด', message: error.message })
      return
    }
    onConfigsChanged()
  }

  async function handleDelete(cfg: MpChannelConfig) {
    const ok = await showConfirm({
      message: `ลบการตั้งค่า "${cfg.name}" ?\n(ลบไม่ได้ถ้ามีการอัปโหลดไฟล์ด้วยการตั้งค่านี้แล้ว — แนะนำให้ปิดใช้งานแทน)`,
    })
    if (!ok) return
    const { error } = await supabase.from('mp_channel_configs').delete().eq('id', cfg.id)
    if (error) {
      showMessage({
        title: 'ลบไม่ได้',
        message: 'การตั้งค่านี้ถูกใช้อัปโหลดไฟล์ไปแล้ว — ใช้ปุ่ม "ปิดใช้งาน" แทน',
      })
      return
    }
    onConfigsChanged()
  }

  function updateMapRow(idx: number, patch: Partial<MpMapRow>) {
    if (!editor) return
    const next = editor.column_map.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    setEditor({ ...editor, column_map: next })
  }

  function moveMapRow(from: number, to: number) {
    if (!editor || from === to) return
    const next = [...editor.column_map]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setEditor({ ...editor, column_map: next })
  }

  return (
    <div className="space-y-6">
      {user.role === 'superadmin' && (
        <section className="bg-white rounded-xl border border-surface-200 shadow-soft p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-slate-800">สิทธิ์มอบหมายงาน</h2>
              <p className="text-sm text-slate-500 mt-1">
                กำหนดเป็นราย User ว่าใครสามารถกดมอบหมายหรือเปลี่ยนผู้รับผิดชอบได้
                เมื่อเปิดสิทธิ์แล้ว ระบบจะแสดงเมนูงานใหม่ให้ User โดยอัตโนมัติ
                ทั้งนี้ผู้ใช้ยังต้องมีสิทธิ์เข้าเมนู Marketplace หลักจากหน้าตั้งค่า Role
              </p>
            </div>
            <button
              type="button"
              disabled={savingAssigners || loadingAssigners}
              onClick={saveAssigners}
              className="px-4 py-2 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700 disabled:opacity-50"
            >
              {savingAssigners ? 'กำลังบันทึก...' : 'บันทึกสิทธิ์'}
            </button>
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            superadmin มีสิทธิ์ Assign เสมอ ไม่จำเป็นต้องเลือกในรายการ
          </div>

          {loadingAssigners ? (
            <div className="py-6 text-center text-gray-400">กำลังโหลดรายชื่อ...</div>
          ) : assignerUsers.length === 0 ? (
            <div className="py-6 text-center text-gray-400">ไม่พบผู้ใช้ admin หรือ sales-tr ที่เปิดใช้งาน</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {assignerUsers.map((assigner) => {
                const checked = assignerIds.has(assigner.id)
                return (
                  <label
                    key={assigner.id}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors ${
                      checked ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAssigner(assigner.id)}
                      className="h-4 w-4 accent-green-600"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-800 truncate">
                        {assigner.username || assigner.email}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">
                        {assigner.email} · {assigner.role}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </section>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">ตั้งค่าช่องทางนำเข้า</h2>
          <p className="text-sm text-slate-500">
            จับคู่คอลัมน์ไฟล์ Excel ของแต่ละแพลตฟอร์มกับข้อมูลในระบบ และตั้งกติกาวันกำหนดส่ง
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700"
        >
          + สร้างการตั้งค่าใหม่
        </button>
      </div>

      {/* รายการ config */}
      <div className="bg-white rounded-xl border border-surface-200 shadow-soft overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-4 py-3">ชื่อ</th>
              <th className="text-left px-4 py-3">ช่องทางขาย (prefix บิล)</th>
              <th className="text-left px-4 py-3">กติกากำหนดส่ง</th>
              <th className="text-left px-4 py-3">สถานะ</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  ยังไม่มีการตั้งค่า — กด "สร้างการตั้งค่าใหม่"
                </td>
              </tr>
            )}
            {configs.map((cfg) => {
              const rule = { ...DEFAULT_DUE_RULE, ...(cfg.due_rule || {}) }
              return (
                <tr key={cfg.id} className="border-t border-surface-100">
                  <td className="px-4 py-3 font-semibold text-slate-800">{cfg.name}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">
                      {cfg.channel_code}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    ก่อน {rule.cutoff_time} ส่งภายในวัน · หลัง {rule.cutoff_time} +{rule.due_day_offset_after_cutoff} วัน · เกิน{' '}
                    {rule.overdue_after_hours} ชม. = ล่าช้า
                  </td>
                  <td className="px-4 py-3">
                    {cfg.is_active ? (
                      <span className="text-green-600 font-semibold">ใช้งาน</span>
                    ) : (
                      <span className="text-gray-400">ปิดใช้งาน</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openEdit(cfg)}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 mr-2"
                    >
                      แก้ไข
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleActive(cfg)}
                      className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 mr-2"
                    >
                      {cfg.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(cfg)}
                      title="ลบการตั้งค่า"
                      aria-label={`ลบการตั้งค่า ${cfg.name}`}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                    >
                      <FiTrash2 aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ฟอร์มสร้าง/แก้ไข */}
      {editor && (
        <div className="bg-white rounded-xl border border-surface-200 shadow-soft p-6 space-y-6">
          <h3 className="text-lg font-bold text-slate-800">
            {editor.id ? `แก้ไข: ${editor.name}` : 'สร้างการตั้งค่าใหม่'}
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">ชื่อช่องทางนำเข้า</label>
              <input
                type="text"
                value={editor.name}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="เช่น Shopee, TikTok"
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                ช่องทางขาย (prefix เลขบิล)
              </label>
              <select
                value={editor.channel_code}
                onChange={(e) => setEditor({ ...editor, channel_code: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">— เลือกช่องทาง —</option>
                {channels.map((ch) => (
                  <option key={ch.channel_code} value={ch.channel_code}>
                    {ch.channel_code} — {ch.channel_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">ชื่อ Sheet ในไฟล์</label>
              <input
                type="text"
                list="mp-sample-sheet-list"
                value={editor.sheet_name}
                onChange={(e) => {
                  setEditor({ ...editor, sheet_name: e.target.value })
                  setTestResult(null)
                }}
                placeholder="orders (ว่าง = sheet แรก)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
              <datalist id="mp-sample-sheet-list">
                {Object.keys(sampleSheets).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                แถวหัวตาราง (เริ่มนับ 0)
              </label>
              <input
                type="number"
                min={0}
                max={10}
                value={editor.header_row}
                onChange={(e) => {
                  setEditor({ ...editor, header_row: Number(e.target.value) })
                  setTestResult(null)
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
          </div>

          {/* กติกาวันกำหนดส่ง */}
          <div className="border border-orange-200 bg-orange-50/50 rounded-xl p-4 space-y-3">
            <h4 className="font-bold text-slate-800">กติกาวันกำหนดส่ง (ป้าย ส่งวันนี้ / ล่าช้า)</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">เวลาตัดรอบ</label>
                <input
                  type="time"
                  value={editor.due_rule.cutoff_time}
                  onChange={(e) =>
                    setEditor({ ...editor, due_rule: { ...editor.due_rule, cutoff_time: e.target.value } })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">เวลากำหนดส่งของวัน</label>
                <input
                  type="time"
                  value={editor.due_rule.due_time}
                  onChange={(e) =>
                    setEditor({ ...editor, due_rule: { ...editor.due_rule, due_time: e.target.value } })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  หลังเวลาตัดรอบ เลื่อนไป (วัน)
                </label>
                <input
                  type="number"
                  min={0}
                  value={editor.due_rule.due_day_offset_after_cutoff}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      due_rule: { ...editor.due_rule, due_day_offset_after_cutoff: Number(e.target.value) },
                    })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  ล่าช้าเมื่อเกิน (ชั่วโมงหลังชำระ)
                </label>
                <input
                  type="number"
                  min={1}
                  value={editor.due_rule.overdue_after_hours}
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      due_rule: { ...editor.due_rule, overdue_after_hours: Number(e.target.value) },
                    })
                  }
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
            </div>
            <p className="text-xs text-slate-500">
              ตัวอย่าง (ค่าปัจจุบัน): ชำระก่อน {editor.due_rule.cutoff_time} → ส่งภายในวันเดียวกันก่อน{' '}
              {editor.due_rule.due_time} · ชำระหลัง {editor.due_rule.cutoff_time} → ส่งวันถัดไป · ยังไม่ส่งเกิน{' '}
              {editor.due_rule.overdue_after_hours} ชม. หลังชำระ = ป้าย "ล่าช้า"
              <br />
              หมายเหตุ: การแก้กติกามีผลเฉพาะไฟล์ที่อัปโหลดครั้งถัดไป (งานที่นำเข้าแล้วใช้ค่าเดิม)
            </p>
          </div>

          {/* กฎตัวเลือกการจัดส่ง */}
          <div className="border border-blue-200 bg-blue-50/40 rounded-xl p-4 space-y-3">
            <div>
              <h4 className="font-bold text-slate-800">จับคู่ตัวเลือกการจัดส่ง</h4>
              <p className="text-xs text-slate-500 mt-1">
                ระบบตรวจจากบนลงล่างและใช้กฎแรกที่ตรง เพื่อเปลี่ยนช่องทางขายและชื่อป้ายอัตโนมัติ
              </p>
            </div>
            {editor.shipping_rules.map((rule, idx) => (
              <div key={idx} className="grid grid-cols-1 md:grid-cols-8 gap-3 rounded-lg border border-blue-100 bg-white p-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">หัวคอลัมน์</label>
                  {sampleHeaders.length > 0 ? (
                    <select
                      value={rule.source_value}
                      onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, source_value: e.target.value, source_type: 'header_exact' } : r) })}
                      className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm"
                    >
                      <option value="">— เลือก —</option>
                      {rule.source_value && !sampleHeaders.includes(rule.source_value) && <option value={rule.source_value}>{rule.source_value}</option>}
                      {sampleHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  ) : (
                    <input value={rule.source_value} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, source_value: e.target.value } : r) })} placeholder="ตัวเลือกการจัดส่ง" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">วิธีเทียบ</label>
                  <select value={rule.match_type} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, match_type: e.target.value as MpShippingRule['match_type'] } : r) })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm">
                    <option value="exact">ตรงกัน</option>
                    <option value="contains">มีคำว่า</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">ค่าตัวเลือกการจัดส่ง</label>
                  <input value={rule.match_value} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, match_value: e.target.value } : r) })} placeholder="เช่น Express Delivery" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">ช่องทางขาย</label>
                  <select value={rule.channel_code} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, channel_code: e.target.value } : r) })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm">
                    {channels.map((ch) => <option key={ch.channel_code} value={ch.channel_code}>{ch.channel_code}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">ชื่อป้าย</label>
                  <input value={rule.label} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, label: e.target.value } : r) })} placeholder="เช่น ส่งด่วน SPX" className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">สีป้าย</label>
                  <select value={rule.color || 'orange'} onChange={(e) => setEditor({ ...editor, shipping_rules: editor.shipping_rules.map((r, i) => i === idx ? { ...r, color: e.target.value as MpShippingRule['color'] } : r) })} className="w-full border border-gray-300 rounded-lg px-2 py-2 text-sm">
                    <option value="orange">ส้ม</option>
                    <option value="blue">น้ำเงิน</option>
                    <option value="green">เขียว</option>
                    <option value="purple">ม่วง</option>
                    <option value="pink">ชมพู</option>
                    <option value="slate">เทา</option>
                  </select>
                </div>
                <div className="flex flex-col items-center justify-end gap-1">
                  <label className="text-center text-xs font-semibold text-gray-600">เลขรับพัสดุด่วน</label>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!rule.requires_express_receipt_number}
                    onClick={() => setEditor({
                      ...editor,
                      shipping_rules: editor.shipping_rules.map((r, i) => i === idx
                        ? { ...r, requires_express_receipt_number: !r.requires_express_receipt_number }
                        : r),
                    })}
                    className={`relative h-8 w-14 rounded-full transition-colors ${
                      rule.requires_express_receipt_number ? 'bg-blue-600' : 'bg-gray-300'
                    }`}
                    title="เปิดเพื่อแสดงช่องเลขรับพัสดุด่วนในหน้า Assign"
                  >
                    <span className={`absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                      rule.requires_express_receipt_number ? 'translate-x-6' : 'translate-x-0'
                    }`} />
                  </button>
                </div>
                <div className="flex items-end justify-center">
                  <button
                    type="button"
                    onClick={() => setEditor({ ...editor, shipping_rules: editor.shipping_rules.filter((_, i) => i !== idx) })}
                    title="ลบกฎตัวเลือกการจัดส่ง"
                    aria-label={`ลบกฎตัวเลือกการจัดส่งรายการที่ ${idx + 1}`}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                  >
                    <FiTrash2 aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setEditor({ ...editor, shipping_rules: [...editor.shipping_rules, { source_type: 'header_exact', source_value: sampleHeaders.find((h) => h.includes('ตัวเลือกการจัดส่ง')) || 'ตัวเลือกการจัดส่ง', match_type: 'contains', match_value: '', channel_code: editor.channel_code || channels[0]?.channel_code || '', label: '', color: 'orange', requires_express_receipt_number: false }] })}
              className="px-3 py-1.5 rounded-lg border border-blue-300 text-blue-700 hover:bg-blue-50 text-sm font-semibold"
            >
              + เพิ่มตัวเลือกการจัดส่ง
            </button>
          </div>

          {/* จับคู่คอลัมน์ */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-bold text-slate-800 mr-auto">จับคู่คอลัมน์ Excel</h4>
              <span className="text-xs font-semibold text-red-600">
                ตัวหนังสือสีแดง = แสดงโดยตรงในหน้ากรอกข้อมูลบิล Assign
              </span>
              <input
                ref={sampleInputRef}
                type="file"
                accept=".xls,.xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleSampleFile(f)
                }}
              />
              <button
                type="button"
                onClick={() => sampleInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-semibold"
              >
                📄 อัปโหลดไฟล์ตัวอย่าง
              </button>
              <button
                type="button"
                onClick={() => setEditor({ ...editor, column_map: SHOPEE_DEFAULT_MAP.map((r) => ({ ...r })) })}
                className="px-3 py-1.5 rounded-lg border border-blue-300 text-blue-600 hover:bg-blue-50 text-sm font-semibold"
              >
                โหลดค่าเริ่มต้น Shopee
              </button>
            </div>

            {sampleFile ? (
              <div className="text-sm bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-slate-700">
                ไฟล์ตัวอย่าง: <span className="font-semibold">{sampleFile.name}</span> · พบ{' '}
                {Object.keys(sampleSheets).length} sheet · หัวตาราง {sampleHeaders.length} คอลัมน์ —
                ช่อง "ค่าที่ใช้จับคู่" เลือกจากหัวตารางจริงได้เลย และมีเครื่องหมาย ✓/✗ บอกว่าจับคู่เจอหรือไม่
              </div>
            ) : (
              <div className="text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-500">
                แนะนำ: อัปโหลดไฟล์ Order ตัวอย่างของแพลตฟอร์มนี้ เพื่อดึงหัวคอลัมน์จริงมาให้เลือกจับคู่ และทดสอบก่อนบันทึก
                (อ่านหัวตารางอย่างเดียว ไม่มีการนำเข้าข้อมูล)
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="w-10 px-2 py-2" aria-label="จัดลำดับ" />
                    <th className="text-left px-3 py-2">ข้อมูลในระบบ</th>
                    <th className="text-left px-3 py-2">วิธีจับคู่</th>
                    <th className="text-left px-3 py-2">ค่าที่ใช้จับคู่ (หัวคอลัมน์ / ตัวอักษร)</th>
                    {sampleFile && <th className="px-3 py-2 text-center">พบในไฟล์</th>}
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {editor.column_map.map((row, idx) => {
                    const matched = mapRowMatched(row)
                    return (
                    <tr
                      key={idx}
                      onDragOver={(e) => {
                        if (draggedMapIndex != null) e.preventDefault()
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        if (draggedMapIndex != null) moveMapRow(draggedMapIndex, idx)
                        setDraggedMapIndex(null)
                      }}
                      className={`border-t border-surface-100 transition-colors ${
                        draggedMapIndex === idx ? 'bg-blue-50 opacity-60' : 'hover:bg-slate-50/60'
                      }`}
                    >
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          draggable
                          onDragStart={(e) => {
                            setDraggedMapIndex(idx)
                            e.dataTransfer.effectAllowed = 'move'
                            e.dataTransfer.setData('text/plain', String(idx))
                          }}
                          onDragEnd={() => setDraggedMapIndex(null)}
                          title="ลากเพื่อจัดลำดับ"
                          aria-label={`ลากแถวที่ ${idx + 1} เพื่อจัดลำดับ`}
                          className="inline-flex p-1.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 cursor-grab active:cursor-grabbing"
                        >
                          <FiMenu className="w-5 h-5" />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={row.field_key}
                          onChange={(e) => updateMapRow(idx, { field_key: e.target.value as MpFieldKey })}
                          className={`w-full border border-gray-300 rounded-lg px-2 py-1.5 ${
                            MP_ASSIGN_FORM_FIELDS.has(row.field_key) ? 'text-red-600 font-semibold' : ''
                          }`}
                        >
                          {MP_FIELD_GROUPS.map((group) => (
                            <optgroup key={group.label} label={group.label}>
                              {group.keys.map((k) => (
                                <option
                                  key={k}
                                  value={k}
                                  className={MP_ASSIGN_FORM_FIELDS.has(k) ? 'text-red-600 font-semibold' : 'text-slate-800'}
                                >
                                  {MP_FIELD_LABELS[k]}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={row.source_type}
                          onChange={(e) =>
                            updateMapRow(idx, { source_type: e.target.value as MpMapRow['source_type'] })
                          }
                          className="w-full border border-gray-300 rounded-lg px-2 py-1.5"
                        >
                          {(Object.keys(SOURCE_TYPE_LABELS) as MpMapRow['source_type'][]).map((t) => (
                            <option key={t} value={t}>
                              {SOURCE_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {sampleHeaders.length > 0 && row.source_type !== 'excel_column_letter' ? (
                          <select
                            value={row.source_value}
                            onChange={(e) => updateMapRow(idx, { source_value: e.target.value })}
                            className={`w-full border rounded-lg px-2 py-1.5 ${
                              matched === false ? 'border-red-300 bg-red-50/40 text-red-700' : 'border-gray-300'
                            }`}
                          >
                            <option value="">— เลือกหัวคอลัมน์จากไฟล์ —</option>
                            {row.source_value && !sampleHeaders.includes(row.source_value) && (
                              <option value={row.source_value}>{row.source_value} (ค่าเดิม — ไม่พบในไฟล์)</option>
                            )}
                            {sampleHeaders.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={row.source_value}
                            onChange={(e) => updateMapRow(idx, { source_value: e.target.value })}
                            className={`w-full border rounded-lg px-2 py-1.5 ${
                              matched === false ? 'border-red-300 bg-red-50/40' : 'border-gray-300'
                            }`}
                            autoComplete="off"
                          />
                        )}
                      </td>
                      {sampleFile && (
                        <td className="px-3 py-2 text-center">
                          {matched === true && <span className="text-green-600 font-bold">✓</span>}
                          {matched === false && (
                            <span className="text-red-500 font-bold" title="ไม่พบคอลัมน์นี้ในไฟล์ตัวอย่าง">✗</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setEditor({ ...editor, column_map: editor.column_map.filter((_, i) => i !== idx) })
                          }
                          title="ลบการจับคู่คอลัมน์"
                          aria-label={`ลบการจับคู่คอลัมน์รายการที่ ${idx + 1}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded text-red-500 hover:bg-red-50"
                        >
                          <FiTrash2 aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setEditor({
                    ...editor,
                    column_map: [
                      ...editor.column_map,
                      { field_key: 'order_no', source_type: 'header_exact', source_value: '', priority: 0 },
                    ],
                  })
                }
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm"
              >
                + เพิ่มแถวจับคู่
              </button>
              {sampleFile && (
                <button
                  type="button"
                  onClick={handleTestMapping}
                  className="px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 text-sm font-semibold"
                >
                  ▶ ทดสอบการจับคู่กับไฟล์ตัวอย่าง
                </button>
              )}
            </div>

            {testResult && (
              <div className="border border-green-200 bg-green-50/50 rounded-xl p-4 space-y-2 text-sm">
                <div className="font-bold text-slate-800">
                  ผลทดสอบ: อ่านได้ {testResult.orders.length} ออเดอร์ จาก {testResult.rowCount} แถว
                </div>
                {testResult.warnings.length > 0 && (
                  <div className="text-orange-700">
                    คำเตือน:
                    <ul className="list-disc ml-5">
                      {testResult.warnings.slice(0, 6).map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                      {testResult.warnings.length > 6 && <li>... อีก {testResult.warnings.length - 6} รายการ</li>}
                    </ul>
                  </div>
                )}
                {testResult.orders[0] && (
                  <div className="overflow-x-auto">
                    <div className="font-semibold text-slate-700 mb-1">ตัวอย่างออเดอร์แรกที่อ่านได้:</div>
                    <table className="text-xs min-w-[400px]">
                      <tbody>
                        {(
                          [
                            ['เลขคำสั่งซื้อ', testResult.orders[0].marketplace_order_no],
                            ['ผู้ซื้อ', testResult.orders[0].buyer_username],
                            ['เวลาชำระเงิน', testResult.orders[0].payment_time],
                            ['ยอดรวม', testResult.orders[0].order_total],
                            ['จำนวนรายการสินค้า', testResult.orders[0].items.length],
                            ['สินค้าแรก', testResult.orders[0].items[0]?.product_name_raw],
                            ['SKU แรก', testResult.orders[0].items[0]?.sku_ref],
                          ] as [string, unknown][]
                        ).map(([k, v]) => (
                          <tr key={k}>
                            <td className="pr-4 py-0.5 text-gray-500 whitespace-nowrap">{k}</td>
                            <td className="py-0.5 text-slate-800">{v == null ? '—' : String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-surface-100">
            <button
              type="button"
              onClick={() => setEditor(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
            </button>
          </div>
        </div>
      )}

      {MessageModal}
      {ConfirmModal}
    </div>
  )
}
