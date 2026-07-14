import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import Modal from '../ui/Modal'
import { DESKTOP_MENU_PATH_ORDER } from '../../config/accessPolicy'

/* ─── role ที่เลือกให้มองเห็นช่องทางได้ — เฉพาะ role ที่ขึ้นต้นด้วย "sales" เท่านั้น
   (อิงจากสิทธิ์เข้าเมนู "ออเดอร์"; QC/บัญชี ไม่นับ เพราะต้องเห็นงานทั้งหมด)
   หมายเหตุ: sales role ที่เพิ่มเข้าเมนู orders ในอนาคตจะโผล่ในลิสต์นี้อัตโนมัติ ─── */
const ROLE_LABELS: Record<string, string> = {
  'sales-tr': 'Sales TR',
  'sales-pump': 'Sales Pump',
}
function getPickableRoles(): string[] {
  const ordersMenu = DESKTOP_MENU_PATH_ORDER.find((m) => m.key === 'orders')
  return (ordersMenu?.roles || []).filter((r) => r.toLowerCase().startsWith('sales'))
}
function roleLabel(role: string): string {
  return ROLE_LABELS[role] || role
}

interface ManagedChannel {
  id: string
  channel_code: string
  channel_name: string
  receive_transfer: boolean
  is_active: boolean
  sort_order: number
  roles: string[] // role ที่มองเห็น (ว่าง = เห็นทุก role)
}

interface ChannelFormState {
  channel_code: string
  channel_name: string
  receive_transfer: boolean
  is_active: boolean
  roles: string[]
}

const EMPTY_FORM: ChannelFormState = {
  channel_code: '',
  channel_name: '',
  receive_transfer: true,
  is_active: true,
  roles: [],
}

export default function ChannelManagementPanel({ onChannelsChanged }: { onChannelsChanged?: () => void }) {
  const pickableRoles = useMemo(() => getPickableRoles(), [])

  const [channels, setChannels] = useState<ManagedChannel[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ManagedChannel | null>(null)
  const [form, setForm] = useState<ChannelFormState>(EMPTY_FORM)

  const [message, setMessage] = useState<{ title: string; body: string } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; onConfirm: () => void } | null>(null)

  const loadChannels = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('channels')
        .select('id, channel_code, channel_name, receive_transfer, is_active, sort_order, channel_role_visibility(role)')
        .order('sort_order', { ascending: true })
        .order('channel_code', { ascending: true })
      if (error) throw error
      const rows: ManagedChannel[] = (data || []).map((c: any) => ({
        id: c.id,
        channel_code: c.channel_code,
        channel_name: c.channel_name,
        receive_transfer: c.receive_transfer !== false,
        is_active: c.is_active !== false,
        sort_order: Number(c.sort_order || 0),
        roles: Array.isArray(c.channel_role_visibility)
          ? c.channel_role_visibility.map((r: any) => r.role).filter(Boolean)
          : [],
      }))
      setChannels(rows)
    } catch (e: any) {
      console.error('Error loading channels:', e)
      setMessage({ title: 'เกิดข้อผิดพลาด', body: e?.message || 'ไม่สามารถโหลดช่องทางได้ (อาจยังไม่ได้รัน migration 280)' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  function openAdd() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function openEdit(ch: ManagedChannel) {
    setEditing(ch)
    setForm({
      channel_code: ch.channel_code,
      channel_name: ch.channel_name,
      receive_transfer: ch.receive_transfer,
      is_active: ch.is_active,
      roles: [...ch.roles],
    })
    setShowForm(true)
  }

  function closeForm() {
    if (saving) return
    setShowForm(false)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  function toggleFormRole(role: string) {
    setForm((prev) => ({
      ...prev,
      roles: prev.roles.includes(role) ? prev.roles.filter((r) => r !== role) : [...prev.roles, role],
    }))
  }

  /** บันทึกแถวการมองเห็น: ลบของเดิมทั้งหมดแล้วใส่ใหม่ตามที่เลือก */
  async function syncVisibility(channelCode: string, roles: string[]) {
    const { error: delErr } = await supabase.from('channel_role_visibility').delete().eq('channel_code', channelCode)
    if (delErr) throw delErr
    if (roles.length > 0) {
      const payload = roles.map((role) => ({ channel_code: channelCode, role }))
      const { error: insErr } = await supabase.from('channel_role_visibility').insert(payload)
      if (insErr) throw insErr
    }
  }

  async function handleSave() {
    const code = form.channel_code.trim().toUpperCase()
    const name = form.channel_name.trim()
    if (!editing && !code) {
      setMessage({ title: 'แจ้งเตือน', body: 'กรุณากรอกรหัสช่องทาง' })
      return
    }
    if (!editing && /\s/.test(code)) {
      setMessage({ title: 'แจ้งเตือน', body: 'รหัสช่องทางต้องไม่มีช่องว่าง (เช่น FBTR, PUMP)' })
      return
    }
    if (!name) {
      setMessage({ title: 'แจ้งเตือน', body: 'กรุณากรอกชื่อช่องทาง' })
      return
    }
    setSaving(true)
    try {
      if (editing) {
        // แก้ไข — ไม่แก้ channel_code (ถูกอ้างอิงในบิล)
        const { error } = await supabase
          .from('channels')
          .update({
            channel_name: name,
            receive_transfer: form.receive_transfer,
            is_active: form.is_active,
          })
          .eq('channel_code', editing.channel_code)
        if (error) throw error
        await syncVisibility(editing.channel_code, form.roles)
      } else {
        // เพิ่มใหม่ — กันรหัสซ้ำ
        const { data: dup } = await supabase.from('channels').select('channel_code').eq('channel_code', code).limit(1)
        if (dup && dup.length > 0) {
          setSaving(false)
          setMessage({ title: 'แจ้งเตือน', body: `มีช่องทางรหัส "${code}" อยู่แล้ว` })
          return
        }
        const nextSort = channels.reduce((max, c) => Math.max(max, c.sort_order), 0) + 1
        const { error } = await supabase.from('channels').insert({
          channel_code: code,
          channel_name: name,
          receive_transfer: form.receive_transfer,
          is_active: form.is_active,
          sort_order: nextSort,
        })
        if (error) throw error
        await syncVisibility(code, form.roles)
      }
      setShowForm(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      await loadChannels()
      onChannelsChanged?.()
    } catch (e: any) {
      console.error('Error saving channel:', e)
      setMessage({ title: 'เกิดข้อผิดพลาด', body: e?.message || 'บันทึกไม่สำเร็จ (สิทธิ์เฉพาะ superadmin/admin)' })
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(ch: ManagedChannel) {
    try {
      const { error } = await supabase
        .from('channels')
        .update({ is_active: !ch.is_active })
        .eq('channel_code', ch.channel_code)
      if (error) throw error
      await loadChannels()
      onChannelsChanged?.()
    } catch (e: any) {
      console.error('Error toggling channel:', e)
      setMessage({ title: 'เกิดข้อผิดพลาด', body: e?.message || 'เปลี่ยนสถานะไม่สำเร็จ' })
    }
  }

  async function handleDelete(ch: ManagedChannel) {
    // ตรวจว่ามีบิลอ้างอิง channel_code นี้หรือไม่ — ถ้ามี ห้ามลบถาวร ให้ปิดใช้งานแทน
    try {
      const { count, error } = await supabase
        .from('or_orders')
        .select('id', { count: 'exact', head: true })
        .eq('channel_code', ch.channel_code)
      if (error) throw error
      if ((count || 0) > 0) {
        setConfirm({
          title: 'ลบถาวรไม่ได้',
          body: `ช่องทาง "${ch.channel_name}" มีบิลอ้างอิงอยู่ ${count} รายการ จึงลบถาวรไม่ได้\n\nต้องการ "ปิดใช้งาน" แทนหรือไม่? (ซ่อนจากการเปิดบิลใหม่ แต่บิลเก่ายังอยู่ครบ)`,
          onConfirm: async () => {
            setConfirm(null)
            if (ch.is_active) await toggleActive(ch)
          },
        })
        return
      }
      setConfirm({
        title: 'ลบช่องทาง',
        body: `ต้องการลบช่องทาง "${ch.channel_name}" (${ch.channel_code}) ถาวรหรือไม่?`,
        onConfirm: async () => {
          setConfirm(null)
          try {
            const { error: delErr } = await supabase.from('channels').delete().eq('channel_code', ch.channel_code)
            if (delErr) throw delErr
            await loadChannels()
            onChannelsChanged?.()
          } catch (e: any) {
            console.error('Error deleting channel:', e)
            setMessage({ title: 'เกิดข้อผิดพลาด', body: e?.message || 'ลบไม่สำเร็จ' })
          }
        },
      })
    } catch (e: any) {
      console.error('Error checking channel references:', e)
      setMessage({ title: 'เกิดข้อผิดพลาด', body: e?.message || 'ตรวจสอบการอ้างอิงไม่สำเร็จ' })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-bold">จัดการช่องทางการขาย</h2>
          <p className="text-sm text-gray-600 max-w-3xl">
            เพิ่ม/แก้ไขช่องทาง กำหนดประเภทการรับเงิน และเลือก role ที่มองเห็นช่องทางตอนเปิดบิล
            <span className="block text-xs text-gray-400 mt-0.5">
              ช่องทางที่ไม่เลือก role = ทุก role เห็น (superadmin/admin เห็นทุกช่องทางเสมอ)
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadChannels()}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-50 font-semibold text-sm disabled:opacity-50"
          >
            {loading ? 'กำลังโหลด...' : 'รีเฟรช'}
          </button>
          <button
            type="button"
            onClick={openAdd}
            className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold text-sm"
          >
            + เพิ่มช่องทาง
          </button>
        </div>
      </div>

      <div className="border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-left">
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap">รหัส</th>
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap">ชื่อช่องทาง</th>
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap">ประเภทการรับเงิน</th>
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap">role ที่มองเห็น</th>
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap">สถานะ</th>
              <th className="px-3 py-2.5 font-semibold text-gray-700 whitespace-nowrap text-right">การจัดการ</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-gray-400">กำลังโหลด...</td>
              </tr>
            ) : channels.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-gray-400">ยังไม่มีช่องทาง</td>
              </tr>
            ) : (
              channels.map((ch) => (
                <tr key={ch.channel_code} className={`border-b border-gray-100 ${ch.is_active ? '' : 'bg-gray-50/60'}`}>
                  <td className="px-3 py-2.5 font-semibold text-gray-800 tabular-nums">{ch.channel_code}</td>
                  <td className="px-3 py-2.5 text-gray-700">{ch.channel_name}</td>
                  <td className="px-3 py-2.5">
                    {ch.receive_transfer ? (
                      <span className="inline-flex px-2 py-0.5 rounded-lg text-xs font-medium bg-emerald-100 text-emerald-700">
                        โอนเข้าบัญชีตรง
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-600">
                        ไม่ต้องรับเงินโอน
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {ch.roles.length === 0 ? (
                      <span className="text-xs text-gray-400 italic">ทุก role</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {ch.roles.map((r) => (
                          <span key={r} className="inline-flex px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[11px] font-medium">
                            {roleLabel(r)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {ch.is_active ? (
                      <span className="inline-flex px-2 py-0.5 rounded-lg text-xs font-medium bg-emerald-100 text-emerald-700">ใช้งาน</span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 rounded-lg text-xs font-medium bg-red-100 text-red-600">ปิดใช้งาน</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => openEdit(ch)}
                        className="px-2.5 py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-xs font-medium"
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleActive(ch)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${ch.is_active ? 'border-amber-300 text-amber-700 hover:bg-amber-50' : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}
                      >
                        {ch.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(ch)}
                        className="px-2.5 py-1 bg-red-500 text-white rounded-lg hover:bg-red-600 text-xs font-medium"
                      >
                        ลบ
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal เพิ่ม/แก้ไขช่องทาง */}
      {showForm && (
        <Modal open onClose={closeForm} contentClassName="max-w-lg w-full mx-4">
          <div className="p-6 space-y-4">
            <h3 className="text-xl font-bold">{editing ? 'แก้ไขช่องทาง' : 'เพิ่มช่องทาง'}</h3>

            <div>
              <label className="block text-sm font-medium mb-1">
                รหัสช่องทาง <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.channel_code}
                onChange={(e) => setForm({ ...form, channel_code: e.target.value.toUpperCase() })}
                disabled={!!editing}
                className={`w-full px-3 py-2 border rounded-lg ${editing ? 'bg-gray-100 text-gray-500' : ''}`}
                placeholder="เช่น FBTR, PUMP (ตัวพิมพ์ใหญ่ ไม่มีช่องว่าง)"
              />
              {editing && <p className="text-xs text-gray-400 mt-1">รหัสช่องทางแก้ไขไม่ได้ เพราะถูกอ้างอิงในบิล</p>}
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                ชื่อช่องทาง <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.channel_name}
                onChange={(e) => setForm({ ...form, channel_name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="เช่น Facebook TR, Pump"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">ประเภทการรับเงิน</label>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="receive_transfer"
                    checked={form.receive_transfer}
                    onChange={() => setForm({ ...form, receive_transfer: true })}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium">โอนเงินเข้าบัญชีตรง</span>
                    <span className="block text-xs text-gray-500">ต้องผูกบัญชีธนาคาร + ตรวจสลิปผ่าน EasySlip ก่อนเปิดบิล</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="receive_transfer"
                    checked={!form.receive_transfer}
                    onChange={() => setForm({ ...form, receive_transfer: false })}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium">ไม่ต้องรับเงินโอน</span>
                    <span className="block text-xs text-gray-500">เช่น Marketplace/หน้าร้าน — ไม่ต้องผูกบัญชี ไม่บังคับสลิป</span>
                  </span>
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">role ที่มองเห็นช่องทางนี้</label>
              <p className="text-xs text-gray-500 mb-2">ไม่เลือกเลย = ทุก role เห็น (superadmin/admin เห็นเสมอ)</p>
              <div className="flex flex-wrap gap-2">
                {pickableRoles.map((role) => {
                  const checked = form.roles.includes(role)
                  return (
                    <label
                      key={role}
                      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border cursor-pointer text-sm ${checked ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleFormRole(role)} />
                      {roleLabel(role)}
                    </label>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                <span className="text-sm font-medium">เปิดใช้งาน (แสดงในการเปิดบิล)</span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeForm}
                disabled={saving}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-semibold text-sm disabled:opacity-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold text-sm disabled:opacity-50"
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal ข้อความ */}
      {message && (
        <Modal open onClose={() => setMessage(null)} contentClassName="max-w-md w-full mx-4">
          <div className="p-6">
            <h3 className="text-lg font-bold mb-2">{message.title}</h3>
            <p className="text-gray-700 whitespace-pre-line">{message.body}</p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setMessage(null)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold text-sm"
              >
                ตกลง
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal ยืนยัน */}
      {confirm && (
        <Modal open onClose={() => setConfirm(null)} contentClassName="max-w-md w-full mx-4">
          <div className="p-6">
            <h3 className="text-lg font-bold mb-2">{confirm.title}</h3>
            <p className="text-gray-700 whitespace-pre-line">{confirm.body}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 font-semibold text-sm"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void confirm.onConfirm()}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold text-sm"
              >
                ยืนยัน
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
