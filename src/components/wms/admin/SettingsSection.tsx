import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../lib/supabase'
import { useWmsModal } from '../useWmsModal'
import { useAuthContext } from '../../../contexts/AuthContext'

type Category4M = 'Man' | 'Machine' | 'Material' | 'Method' | '-'
type TopicRow = { id: string; topic_name: string; category_4m?: Category4M }
type NonPickerCategory = { id: string; category_name: string }
type StoreBackupUser = { id: string; email: string | null; username: string | null; role: string }
type StoreBackupAssignment = {
  id: string
  user_id: string
  starts_at: string
  ends_at: string
  is_active: boolean
  granted_by: string | null
  user: StoreBackupUser | null
}

const CATEGORY_4M_OPTIONS: Category4M[] = ['-', 'Man', 'Machine', 'Material', 'Method']
const CATEGORY_4M_LABELS: Record<Category4M, string> = {
  '-': '- (ไม่มี)',
  Man: 'Man',
  Machine: 'Machine',
  Material: 'Material',
  Method: 'Method',
}
const CATEGORY_4M_COLORS: Record<Category4M, string> = {
  '-': 'bg-gray-100 text-gray-500',
  Man: 'bg-blue-100 text-blue-700',
  Machine: 'bg-orange-100 text-orange-700',
  Material: 'bg-green-100 text-green-700',
  Method: 'bg-purple-100 text-purple-700',
}

type TopicSection = {
  table: string
  label: string
  has4m: boolean
}

const TOPIC_SECTIONS: TopicSection[] = [
  { table: 'wms_requisition_topics', label: 'หัวข้อการเบิก', has4m: true },
  { table: 'wms_return_topics', label: 'หัวข้อรายการคืน', has4m: true },
  { table: 'wms_borrow_topics', label: 'หัวข้อรายการยืม', has4m: true },
]

function bangkokDateInput(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function bangkokDayBoundary(date: string, endOfDay = false): string {
  return new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00'}+07:00`).toISOString()
}

function assignmentStatus(assignment: StoreBackupAssignment): { label: string; className: string } {
  const now = Date.now()
  if (!assignment.is_active) return { label: 'ปิดแล้ว', className: 'bg-gray-100 text-gray-600' }
  if (new Date(assignment.starts_at).getTime() > now) return { label: 'รอเริ่มใช้งาน', className: 'bg-blue-100 text-blue-700' }
  if (new Date(assignment.ends_at).getTime() < now) return { label: 'หมดอายุ', className: 'bg-amber-100 text-amber-700' }
  return { label: 'กำลังใช้งาน', className: 'bg-emerald-100 text-emerald-700' }
}

export default function SettingsSection() {
  const { user: currentUser } = useAuthContext()
  const [topics, setTopics] = useState<TopicRow[]>([])
  const [sectionTopics, setSectionTopics] = useState<Record<string, TopicRow[]>>({})
  const [newTopic, setNewTopic] = useState('')
  const [nonPickerCategories, setNonPickerCategories] = useState<NonPickerCategory[]>([])
  const [productCategories, setProductCategories] = useState<string[]>([])
  const [newNonPickerCategory, setNewNonPickerCategory] = useState('')
  const [newSectionInputs, setNewSectionInputs] = useState<Record<string, { name: string; category: Category4M }>>({})
  const [storeBackupUsers, setStoreBackupUsers] = useState<StoreBackupUser[]>([])
  const [storeBackupAssignments, setStoreBackupAssignments] = useState<StoreBackupAssignment[]>([])
  const [selectedStoreBackupUserId, setSelectedStoreBackupUserId] = useState('')
  const [storeBackupStartDate, setStoreBackupStartDate] = useState(() => bangkokDateInput())
  const [storeBackupEndDate, setStoreBackupEndDate] = useState(() => bangkokDateInput())
  const [storeBackupSaving, setStoreBackupSaving] = useState(false)
  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()
  const canManageStoreBackups = ['superadmin', 'admin', 'store'].includes(String(currentUser?.role || ''))

  const loadSettings = useCallback(async () => {
    const { data: topicsData } = await supabase
      .from('wms_notification_topics')
      .select('*')
      .order('topic_name')
    if (topicsData) setTopics(topicsData as TopicRow[])

    const [{ data: nonPickerData }, { data: productCategoryData }] = await Promise.all([
      supabase.from('wms_non_picker_categories').select('id, category_name').order('category_name'),
      supabase.from('pr_products').select('product_category').not('product_category', 'is', null),
    ])
    setNonPickerCategories((nonPickerData || []) as NonPickerCategory[])
    setProductCategories(Array.from(new Set((productCategoryData || [])
      .map((row) => String(row.product_category || '').trim()).filter(Boolean))).sort())

    const results: Record<string, TopicRow[]> = {}
    for (const sec of TOPIC_SECTIONS) {
      const { data } = await supabase.from(sec.table).select('*').order('topic_name')
      results[sec.table] = (data || []) as TopicRow[]
    }
    setSectionTopics(results)

    if (canManageStoreBackups) {
      const [usersResult, assignmentsResult] = await Promise.all([
        supabase
          .from('us_users')
          .select('id, email, username, role')
          .in('role', ['production', 'qc_staff', 'packing_staff'])
          .or('is_active.eq.true,is_active.is.null')
          .order('role')
          .order('username'),
        supabase
          .from('wms_store_backup_assignments')
          .select('id, user_id, starts_at, ends_at, is_active, granted_by, user:us_users!user_id(id, email, username, role)')
          .order('created_at', { ascending: false }),
      ])
      if (usersResult.error) {
        console.error('Load Store backup users error:', usersResult.error)
      } else {
        setStoreBackupUsers((usersResult.data || []) as StoreBackupUser[])
      }
      if (assignmentsResult.error) {
        console.error('Load Store backup assignments error:', assignmentsResult.error)
      } else {
        setStoreBackupAssignments((assignmentsResult.data || []).map((row: any) => ({
          ...row,
          user: Array.isArray(row.user) ? row.user[0] || null : row.user || null,
        })) as StoreBackupAssignment[])
      }
    }
  }, [canManageStoreBackups])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSettings() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadSettings])

  const addTopic = async () => {
    if (!newTopic) return
    await supabase.from('wms_notification_topics').insert([{ topic_name: newTopic }])
    setNewTopic('')
    loadSettings()
  }

  const deleteTopic = async (id: string) => {
    await supabase.from('wms_notification_topics').delete().eq('id', id)
    loadSettings()
  }

  const addNonPickerCategory = async () => {
    const categoryName = newNonPickerCategory.trim()
    if (!categoryName) return
    const { error } = await supabase.from('wms_non_picker_categories').insert([{
      category_name: categoryName,
    }])
    if (error) {
      showMessage({ message: error.code === '23505' ? 'หมวดสินค้านี้อยู่ในรายการแล้ว' : `เพิ่มหมวดสินค้าไม่สำเร็จ: ${error.message}` })
      return
    }
    setNewNonPickerCategory('')
    await loadSettings()
    window.dispatchEvent(new CustomEvent('wms-data-changed'))
  }

  const deleteNonPickerCategory = async (category: NonPickerCategory) => {
    const ok = await showConfirm({
      title: 'ยืนยันเปลี่ยนเป็นต้อง Picker',
      message: `เมื่อลบ “${category.category_name}” สินค้าในหมวดนี้จะเปลี่ยนเป็นต้องผ่าน Picker สำหรับใบงานใหม่ ยืนยันหรือไม่?`,
    })
    if (!ok) return
    const { error } = await supabase.from('wms_non_picker_categories').delete().eq('id', category.id)
    if (error) {
      showMessage({ message: `ลบหมวดสินค้าไม่สำเร็จ: ${error.message}` })
      return
    }
    await loadSettings()
    window.dispatchEvent(new CustomEvent('wms-data-changed'))
  }

  const getSectionInput = (table: string) => newSectionInputs[table] || { name: '', category: '-' as Category4M }

  const updateSectionInput = (table: string, field: 'name' | 'category', value: string) => {
    setNewSectionInputs((prev) => ({
      ...prev,
      [table]: { ...getSectionInput(table), [field]: value },
    }))
  }

  const addSectionTopic = async (table: string) => {
    const input = getSectionInput(table)
    if (!input.name) return
    await supabase.from(table).insert([{ topic_name: input.name, category_4m: input.category === '-' ? null : input.category }])
    setNewSectionInputs((prev) => ({ ...prev, [table]: { name: '', category: '-' } }))
    loadSettings()
  }

  const deleteSectionTopic = async (table: string, id: string) => {
    await supabase.from(table).delete().eq('id', id)
    loadSettings()
  }

  const updateSectionCategory = async (table: string, id: string, category: Category4M) => {
    await supabase.from(table).update({ category_4m: category === '-' ? null : category }).eq('id', id)
    loadSettings()
  }

  const saveStoreBackup = async () => {
    if (!selectedStoreBackupUserId) {
      showMessage({ message: 'กรุณาเลือกพนักงาน Store สำรอง' })
      return
    }
    if (!storeBackupStartDate || !storeBackupEndDate || storeBackupEndDate < storeBackupStartDate) {
      showMessage({ message: 'กรุณาตรวจสอบวันเริ่มต้นและวันสิ้นสุดให้ถูกต้อง' })
      return
    }
    setStoreBackupSaving(true)
    const { error } = await supabase.from('wms_store_backup_assignments').upsert({
      user_id: selectedStoreBackupUserId,
      starts_at: bangkokDayBoundary(storeBackupStartDate),
      ends_at: bangkokDayBoundary(storeBackupEndDate, true),
      is_active: true,
      granted_by: currentUser?.id || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    setStoreBackupSaving(false)
    if (error) {
      showMessage({ message: `บันทึกพนักงาน Store สำรองไม่สำเร็จ: ${error.message}` })
      return
    }
    setSelectedStoreBackupUserId('')
    showMessage({ message: 'บันทึกสิทธิ์ Store สำรองเรียบร้อยแล้ว' })
    await loadSettings()
  }

  const revokeStoreBackup = async (assignment: StoreBackupAssignment) => {
    const displayName = assignment.user?.username || assignment.user?.email || 'ผู้ใช้นี้'
    const ok = await showConfirm({
      title: 'ยกเลิกสิทธิ์ Store สำรอง',
      message: `ต้องการยกเลิกสิทธิ์ของ “${displayName}” ทันทีหรือไม่?`,
    })
    if (!ok) return
    const { error } = await supabase
      .from('wms_store_backup_assignments')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', assignment.id)
    if (error) {
      showMessage({ message: `ยกเลิกสิทธิ์ไม่สำเร็จ: ${error.message}` })
      return
    }
    await loadSettings()
  }

  return (
    <section className="h-full flex flex-col">
      <h2 className="text-3xl font-black mb-6 text-slate-800">ตั้งค่าระบบ</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0">
        {/* หัวข้อแจ้งเตือน */}
        <div className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
          <h3 className="font-bold text-gray-400 text-[16px] uppercase tracking-widest mb-4 border-b pb-2 text-slate-800">
            หัวข้อแจ้งเตือน
          </h3>
          <div className="flex gap-2 mb-4 shrink-0">
            <input
              type="text"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="เพิ่มหัวข้อใหม่..."
              className="flex-1 border p-2.5 rounded-lg text-sm"
              onKeyDown={(e) => e.key === 'Enter' && addTopic()}
            />
            <button onClick={addTopic} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">
              +
            </button>
          </div>
          <div className="divide-y flex-1 overflow-y-auto min-h-0">
            {topics.map((t) => (
              <div key={t.id} className="flex justify-between items-center py-2 text-sm">
                <div>{t.topic_name}</div>
                <button onClick={() => deleteTopic(t.id)} className="text-red-400 hover:text-red-600">
                  <i className="fas fa-trash-alt"></i>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* หัวข้อการเบิก / รายการคืน / รายการยืม */}
        {TOPIC_SECTIONS.map((sec) => {
          const items = sectionTopics[sec.table] || []
          const input = getSectionInput(sec.table)
          return (
            <div key={sec.table} className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
              <h3 className="font-bold text-gray-400 text-[16px] uppercase tracking-widest mb-4 border-b pb-2 text-slate-800">
                {sec.label}
              </h3>
              <div className="flex gap-2 mb-4 shrink-0">
                <input
                  type="text"
                  value={input.name}
                  onChange={(e) => updateSectionInput(sec.table, 'name', e.target.value)}
                  placeholder="เพิ่มหัวข้อใหม่..."
                  className="flex-1 border p-2.5 rounded-lg text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && addSectionTopic(sec.table)}
                />
                {sec.has4m && (
                  <select
                    value={input.category}
                    onChange={(e) => updateSectionInput(sec.table, 'category', e.target.value)}
                    className="border p-2.5 rounded-lg text-sm bg-white min-w-[110px]"
                  >
                    {CATEGORY_4M_OPTIONS.map((c) => (
                      <option key={c} value={c}>{CATEGORY_4M_LABELS[c]}</option>
                    ))}
                  </select>
                )}
                <button onClick={() => addSectionTopic(sec.table)} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">
                  +
                </button>
              </div>
              <div className="divide-y flex-1 overflow-y-auto min-h-0">
                {items.map((t) => (
                  <div key={t.id} className="flex justify-between items-center py-2 text-sm gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="truncate">{t.topic_name}</span>
                    </div>
                    {sec.has4m && (
                      <select
                        value={t.category_4m || '-'}
                        onChange={(e) => updateSectionCategory(sec.table, t.id, e.target.value as Category4M)}
                        className={`text-xs px-2 py-1 rounded-full font-semibold border-0 cursor-pointer ${CATEGORY_4M_COLORS[t.category_4m || '-']}`}
                      >
                        {CATEGORY_4M_OPTIONS.map((c) => (
                          <option key={c} value={c}>{CATEGORY_4M_LABELS[c]}</option>
                        ))}
                      </select>
                    )}
                    <button onClick={() => deleteSectionTopic(sec.table, t.id)} className="text-red-400 hover:text-red-600 shrink-0">
                      <i className="fas fa-trash-alt"></i>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}


        <div className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
          <h3 className="font-bold text-[16px] uppercase tracking-widest mb-2 border-b pb-2 text-slate-800">
            หมวดสินค้าไม่ต้อง Picker
          </h3>
          <p className="mb-4 text-xs text-slate-500">
            หมวดในรายการนี้จะสร้าง WMS แบบ system_complete และตัดสต๊อคหลักอัตโนมัติ ส่วนสินค้าที่ผูกกับคลังย่อยจะข้าม Picker แต่ยังตัดสต๊อคหลักและแสดงยอดผลิตใช้ไป หมวดใหม่ที่ยังไม่ได้เพิ่มจะต้องผ่าน Picker
          </p>
          <div className="flex gap-2 mb-4 shrink-0">
            <input
              type="text"
              list="wms-product-category-options"
              value={newNonPickerCategory}
              onChange={(e) => setNewNonPickerCategory(e.target.value)}
              placeholder="เช่น UV-FLATBED"
              className="flex-1 border p-2.5 rounded-lg text-sm"
              onKeyDown={(e) => e.key === 'Enter' && addNonPickerCategory()}
            />
            <datalist id="wms-product-category-options">
              {productCategories.map((category) => <option key={category} value={category} />)}
            </datalist>
            <button onClick={addNonPickerCategory} className="bg-slate-800 text-white px-5 rounded-lg font-bold hover:bg-black transition">+</button>
          </div>
          <div className="divide-y flex-1 overflow-y-auto min-h-0 max-h-80">
            {nonPickerCategories.map((category) => (
              <div key={category.id} className="flex justify-between items-center py-2 text-sm gap-2">
                <span className="font-semibold text-slate-700">{category.category_name}</span>
                <button onClick={() => deleteNonPickerCategory(category)} className="text-red-400 hover:text-red-600" title="เปลี่ยนกลับเป็นต้อง Picker"><i className="fas fa-trash-alt"></i></button>
              </div>
            ))}
          </div>
        </div>

        {canManageStoreBackups && (
          <div className="bg-white p-6 rounded-2xl border shadow-sm flex flex-col">
            <div className="mb-4 border-b pb-3">
              <h3 className="font-bold text-[16px] uppercase tracking-widest text-slate-800">
                พนักงาน Store สำรอง
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                เปิดสิทธิ์ชั่วคราวให้ production, qc_staff หรือ packing_staff เข้าถึงเฉพาะ “ใบงานใหม่” และ “ตรวจสินค้า” โดยไม่เปลี่ยน Role หลัก
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2 text-xs font-semibold text-slate-600">
                เลือกพนักงาน
                <select
                  value={selectedStoreBackupUserId}
                  onChange={(event) => setSelectedStoreBackupUserId(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm"
                >
                  <option value="">-- เลือก User --</option>
                  {storeBackupUsers.map((backupUser) => (
                    <option key={backupUser.id} value={backupUser.id}>
                      {backupUser.username || backupUser.email || backupUser.id} · {backupUser.role}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-600">
                วันที่เริ่มต้น
                <input
                  type="date"
                  value={storeBackupStartDate}
                  onChange={(event) => setStoreBackupStartDate(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                วันที่สิ้นสุด
                <input
                  type="date"
                  min={storeBackupStartDate}
                  value={storeBackupEndDate}
                  onChange={(event) => setStoreBackupEndDate(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                />
              </label>
              <button
                type="button"
                onClick={saveStoreBackup}
                disabled={storeBackupSaving || !selectedStoreBackupUserId}
                className="sm:col-span-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {storeBackupSaving ? 'กำลังบันทึก...' : 'เปิดสิทธิ์ Store สำรอง'}
              </button>
            </div>

            <div className="mt-5 divide-y overflow-y-auto border-t max-h-80">
              {storeBackupAssignments.length === 0 ? (
                <p className="py-5 text-center text-sm text-slate-400">ยังไม่มีพนักงาน Store สำรอง</p>
              ) : storeBackupAssignments.map((assignment) => {
                const status = assignmentStatus(assignment)
                return (
                  <div key={assignment.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-slate-800">
                          {assignment.user?.username || assignment.user?.email || assignment.user_id}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.className}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {assignment.user?.role || 'ไม่พบ Role'} · {new Date(assignment.starts_at).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })}
                        {' ถึง '}
                        {new Date(assignment.ends_at).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })}
                      </p>
                    </div>
                    {assignment.is_active && (
                      <button
                        type="button"
                        onClick={() => revokeStoreBackup(assignment)}
                        className="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                      >
                        ยกเลิก
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
      {MessageModal}
      {ConfirmModal}
    </section>
  )
}
