import { useCallback, useEffect, useMemo, useState } from 'react'
import { FiImage } from 'react-icons/fi'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { supabase } from '../lib/supabase'
import {
  MACHINERY_STATUS_LABELS,
  type MachineryMachine,
  type MachineryEvent,
  type MachineryProductOption,
  type PrMachineryStatus,
  fetchMachines,
  updateMachineSortOrders,
  upsertMachine,
  deleteMachine,
  changeMachineStatus,
  fetchEventsOverlappingRange,
  fetchEventsStartingRange,
  fetchMachineryProductOptions,
  fetchTodayWorkOrderQuantityByProduct,
  fetchWorkOrderQuantityByProductByDay,
  computeWorkingTimeInShiftMsToday,
  computeShiftDurationMsForDay,
  formatMsAsHms,
  summarizeDayForMachine,
  totalProductionCapacityPerShift,
  uploadMachineryPhoto,
  computeRepairRounds,
  computeEventDurationMs,
  formatDurationHoursMinutes,
  type DailySummaryRow,
  type WorkOrderQuantityByDay,
} from '../lib/machineryApi'
import { isSuperadmin } from '../config/accessPolicy'
import { getActiveMobileMode, hasDesktopOverride } from '../lib/mobileMode'
import {
  buildReadiness,
  copyMachineryChecklistSettings,
  fetchChecklistItems,
  fetchInspectionAccessMachineIds,
  fetchTodayInspections,
  type MachineReadiness,
} from '../lib/machineryOperationsApi'
import ModeSwitchButton from '../components/ModeSwitchButton'
import { MachineryPurchaseRequest, MachineryPurchaseSettings, MachineryStock } from '../components/MachineryPurchase'
import { ChecklistSettings, MachineryChecklist, MachineryMaintenance } from '../components/MachineryOperations'
import { useWmsModal } from '../components/wms/useWmsModal'

type TabKey = 'monitor' | 'inspection' | 'maintenance' | 'machineSettings' | 'checklistSettings' | 'history' | 'purchaseRequest' | 'stock' | 'purchaseSettings'

const PRODUCTION_HIDDEN_TABS = new Set<TabKey>([
  'machineSettings',
  'checklistSettings',
  'history',
  'purchaseRequest',
  'stock',
])

const STATUS_ORDER: PrMachineryStatus[] = [
  'working',
  'broken',
  'repairing',
  'idle',
  'decommissioned',
  'power_off',
]

const STATUS_SUMMARY_ORDER: PrMachineryStatus[] = ['working', 'broken', 'repairing', 'idle', 'decommissioned']

/** พื้นหลังการ์ดมอนิเตอร์ — เข้ม ตามสถานะ: เขียว / แดง / เหลือง / ฟ้า / เทา */
function monitorCardShellClass(status: PrMachineryStatus): string {
  const map: Record<PrMachineryStatus, string> = {
    working:
      'border-emerald-400/95 bg-gradient-to-br from-emerald-950 via-emerald-900 to-slate-950 ring-2 ring-emerald-500/70 shadow-xl shadow-emerald-950/50',
    broken:
      'border-red-400/95 bg-gradient-to-br from-red-950 via-red-900 to-slate-950 ring-2 ring-red-500/70 shadow-xl shadow-red-950/50',
    repairing:
      'border-yellow-400/95 bg-gradient-to-br from-yellow-950 via-amber-950 to-slate-950 ring-2 ring-yellow-500/70 shadow-xl shadow-amber-950/50',
    idle:
      'border-sky-400/95 bg-gradient-to-br from-sky-950 via-sky-900 to-slate-950 ring-2 ring-sky-500/70 shadow-xl shadow-sky-950/50',
    decommissioned:
      'border-zinc-500/95 bg-gradient-to-br from-zinc-900 via-zinc-950 to-slate-950 ring-2 ring-zinc-500/60 shadow-xl shadow-black/50',
    power_off:
      'border-white/95 bg-gradient-to-br from-slate-100 via-white to-slate-200 ring-2 ring-white/95 shadow-xl shadow-slate-300/60',
  }
  return `rounded-2xl border overflow-hidden flex flex-col min-h-[12rem] ${map[status]}`
}

function monitorStatusBarClass(status: PrMachineryStatus, mobile?: boolean): string {
  const map: Record<PrMachineryStatus, string> = {
    working: 'bg-emerald-700/95 text-white',
    broken: 'bg-red-700/95 text-white',
    repairing: 'bg-yellow-500/95 text-gray-900',
    idle: 'bg-sky-600/95 text-white',
    decommissioned: 'bg-zinc-600/95 text-white',
    power_off: 'bg-white text-slate-900',
  }
  const size = mobile ? 'py-2 text-sm' : 'py-1.5 text-xs'
  return `absolute bottom-0 left-0 right-0 px-2.5 ${size} font-bold backdrop-blur-sm ${map[status]}`
}

/** พื้นหลังปุ่มเลือกเครื่อง (มือถือ) — โทนตามสถานะ */
function monitorPickerButtonClass(status: PrMachineryStatus, selected: boolean): string {
  const byStatus: Record<PrMachineryStatus, string> = {
    working:
      'border-emerald-300 bg-gradient-to-br from-emerald-50 to-green-100 hover:from-emerald-100',
    broken:
      'border-red-300 bg-gradient-to-br from-red-50 to-rose-100 hover:from-red-100',
    repairing:
      'border-amber-300 bg-gradient-to-br from-amber-50 to-yellow-100 hover:from-amber-100',
    idle:
      'border-sky-300 bg-gradient-to-br from-sky-50 to-blue-100 hover:from-sky-100',
    decommissioned:
      'border-zinc-300 bg-gradient-to-br from-zinc-50 to-slate-100 hover:from-zinc-100',
    power_off:
      'border-slate-300 bg-gradient-to-br from-white to-slate-100 hover:from-slate-50',
  }
  const ring = selected
    ? 'ring-2 ring-emerald-400 shadow-md shadow-emerald-100'
    : ''
  return `rounded-xl border px-3 py-2.5 text-left transition-all active:scale-[0.98] ${byStatus[status]} ${ring}`
}

function machineAllocatedQuantity(
  machine: MachineryMachine,
  allMachines: MachineryMachine[],
  quantityByProduct: Map<string, number> | undefined,
): number {
  if (!quantityByProduct) return 0
  const machineType = machine.machine_type || 'ทั่วไป'
  return (machine.product_ids || []).reduce((total, productId) => {
    const eligibleMachineCount = allMachines.filter(
      (candidate) =>
        (candidate.machine_type || 'ทั่วไป') === machineType &&
        (candidate.product_ids || []).includes(productId),
    ).length
    if (eligibleMachineCount === 0) return total
    return total + (quantityByProduct.get(productId) || 0) / eligibleMachineCount
  }, 0)
}

export default function Machinery() {
  const { user, signOut } = useAuthContext()
  const { hasAccess } = useMenuAccess()
  const { showConfirm, ConfirmModal } = useWmsModal()
  const [tab, setTab] = useState<TabKey>('monitor')
  const [machines, setMachines] = useState<MachineryMachine[]>([])
  const [events, setEvents] = useState<MachineryEvent[]>([])
  const [readiness, setReadiness] = useState<MachineReadiness[]>([])
  const [productOptions, setProductOptions] = useState<MachineryProductOption[]>([])
  const [planLineSettings, setPlanLineSettings] = useState<{ departments: string[]; linesPerDept: Record<string, number> }>({ departments: [], linesPerDept: {} })
  const [todayQuantityByProduct, setTodayQuantityByProduct] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savingGroupType, setSavingGroupType] = useState<string | null>(null)
  const [myPendingPurchaseCount, setMyPendingPurchaseCount] = useState(0)
  const [grantedInspectionMachineIds, setGrantedInspectionMachineIds] = useState<string[]>([])

  const isProductionRole = user?.role === 'production'
  const canToggleMachinePower = ['superadmin', 'admin', 'technician'].includes(user?.role || '')

  const showMachineSettingsTab =
    !isProductionRole &&
    user?.role !== 'production_mb' &&
    user?.role !== 'manager' &&
    (user?.role === 'technician' || isSuperadmin(user?.role) || hasAccess('machinery-settings'))
  const showChecklistSettingsTab =
    !isProductionRole && (user?.role === 'technician' || showMachineSettingsTab)
  const showPurchaseSettingsTab = user?.role === 'superadmin' || user?.role === 'admin' || user?.role === 'technician'
  const showInspectionTab =
    user?.role === 'superadmin' ||
    user?.role === 'admin' ||
    user?.role === 'technician' ||
    grantedInspectionMachineIds.length > 0

  const inspectionMachines = ['superadmin', 'admin', 'technician'].includes(user?.role || '')
    ? machines
    : machines.filter((machine) => grantedInspectionMachineIds.includes(machine.id))

  useEffect(() => {
    if (!user?.id || ['superadmin', 'admin', 'technician'].includes(user.role)) {
      setGrantedInspectionMachineIds([])
      return
    }
    let active = true
    fetchInspectionAccessMachineIds(user.id)
      .then((machineIds) => { if (active) setGrantedInspectionMachineIds(machineIds) })
      .catch(() => { if (active) setGrantedInspectionMachineIds([]) })
    return () => { active = false }
  }, [user?.id, user?.role])

  useEffect(() => {
    if (
      (!showMachineSettingsTab && tab === 'machineSettings') ||
      (!showChecklistSettingsTab && tab === 'checklistSettings') ||
      (!showInspectionTab && tab === 'inspection') ||
      (!showPurchaseSettingsTab && tab === 'purchaseSettings') ||
      (isProductionRole && PRODUCTION_HIDDEN_TABS.has(tab))
    ) setTab('monitor')
  }, [showMachineSettingsTab, showChecklistSettingsTab, showInspectionTab, showPurchaseSettingsTab, isProductionRole, tab])

  const isTechnicianMobile =
    user?.role === 'technician' && window.innerWidth <= 768 && !hasDesktopOverride()
  const isMobileRole =
    user?.role === 'production_mb' || user?.role === 'manager' || isTechnicianMobile
  /** โหมดมือถือที่สวมอยู่ (superadmin/admin เลือกจากหน้า /mode) */
  const activeMobileMode = getActiveMobileMode(user)
  /** แสดงแบบมือถือเต็มจอ (ไม่มี desktop Layout) — role มือถือจริง หรือสวมโหมด machinery */
  const isStandaloneMobile =
    isMobileRole ||
    activeMobileMode === 'production_mb' ||
    activeMobileMode === 'manager' ||
    activeMobileMode === 'technician'
  /** มือถือช่างเทคนิค: หัวตารางประวัติช่วงสถานะต้องทึบ ไม่ให้แถวทะลุตอน scroll */
  const isTechnicianMobileMachinery = user?.role === 'technician' && isMobileRole

  const [histFrom, setHistFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [histTo, setHistTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [histMachineId, setHistMachineId] = useState<string>('')
  const [monitorMachineType, setMonitorMachineType] = useState('')
  /** กรองตารางช่วงสถานะ — ว่าง = ทั้งหมด */
  const [histStatus, setHistStatus] = useState<'' | PrMachineryStatus>('')
  /** อัปเดตทุกวินาที — จับเวลาในกะที่หน้ามอนิเตอร์ */
  const [monitorTick, setMonitorTick] = useState(() => Date.now())
  /** มือถือ: เลือกเครื่องแล้วค่อยแสดงรายละเอียด + เปลี่ยนสถานะ */
  const [selectedMonitorMachineId, setSelectedMonitorMachineId] = useState<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try {
      const currentDate = new Date()
      const inspectionDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`
      const [m, products, quantities, checklistItems, inspections] = await Promise.all([
        fetchMachines(),
        fetchMachineryProductOptions(),
        fetchTodayWorkOrderQuantityByProduct(),
        fetchChecklistItems(),
        fetchTodayInspections(inspectionDate),
      ])
      setMachines(m)
      setReadiness(buildReadiness(m.map((machine) => machine.id), checklistItems, inspections.inspections, inspections.results))
      setProductOptions(products)
      setTodayQuantityByProduct(quantities)
      const from = new Date()
      from.setDate(from.getDate() - 2)
      from.setHours(0, 0, 0, 0)
      const to = new Date()
      to.setDate(to.getDate() + 2)
      to.setHours(23, 59, 59, 999)
      const ev = await fetchEventsOverlappingRange(from.toISOString(), to.toISOString())
      setEvents(ev)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    supabase
      .from('plan_settings')
      .select('data')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active || error) return
        const settings = (data?.data || {}) as { departments?: unknown; linesPerDept?: unknown }
        const departments = Array.isArray(settings.departments)
          ? settings.departments.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : []
        const rawLines = settings.linesPerDept && typeof settings.linesPerDept === 'object'
          ? settings.linesPerDept as Record<string, unknown>
          : {}
        const linesPerDept = Object.fromEntries(departments.map((department) => [
          department,
          Math.max(1, Math.floor(Number(rawLines[department]) || 1)),
        ]))
        setPlanLineSettings({ departments, linesPerDept })
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const loadMyPendingPurchaseCount = async () => {
      if (!user?.id) return
      const { count } = await supabase
        .from('inv_pr')
        .select('*', { count: 'exact', head: true })
        .eq('pr_type', 'machinery')
        .eq('requested_by', user.id)
        .eq('status', 'pending')
      setMyPendingPurchaseCount(count || 0)
    }
    loadMyPendingPurchaseCount()
    const channel = supabase.channel('machinery-purchase-count').on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'inv_pr' },
      loadMyPendingPurchaseCount,
    ).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id])

  useEffect(() => {
    const ch = supabase
      .channel('machinery-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_machines' },
        () => {
          load()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'or_work_orders' },
        () => { load() },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'or_orders' },
        () => { load() },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_status_events' },
        () => {
          load()
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_inspections' },
        () => { load() },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pr_machinery_inspection_results' },
        () => { load() },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [load])

  useEffect(() => {
    if (tab !== 'monitor') return
    const id = window.setInterval(() => setMonitorTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [tab])

  useEffect(() => {
    if (!selectedMonitorMachineId) return
    if (!machines.some((m) => m.id === selectedMonitorMachineId)) {
      setSelectedMonitorMachineId(null)
    }
  }, [machines, selectedMonitorMachineId])

  useEffect(() => {
    if (tab !== 'monitor') setSelectedMonitorMachineId(null)
  }, [tab])

  const machineTypes = useMemo(
    () => [...new Set(machines.map((m) => m.machine_type || 'ทั่วไป'))].sort((a, b) => a.localeCompare(b, 'th')),
    [machines],
  )
  const monitorMachines = useMemo(
    () => machines.filter((m) => !monitorMachineType || (m.machine_type || 'ทั่วไป') === monitorMachineType),
    [machines, monitorMachineType],
  )
  const monitorCapacityUnits = useMemo(
    () => [...new Set(monitorMachines.map((m) => m.capacity_unit || 'หน่วย'))],
    [monitorMachines],
  )
  const monitorCapacityUnit = monitorCapacityUnits.length === 1 ? monitorCapacityUnits[0] : null
  const machineTypeStats = useMemo(() => {
    const result = new Map<string, {
      type: string
      machines: MachineryMachine[]
      productionToday: number
      maxCapacity: number
      capacityUnit: string | null
      utilizationPercent: number
      brokenCount: number
      repairingCount: number
      workingCount: number
    }>()
    for (const type of machineTypes) {
      const groupMachines = machines.filter((m) => (m.machine_type || 'ทั่วไป') === type)
      const productIds = new Set(groupMachines.flatMap((m) => m.product_ids || []))
      const productionToday = [...productIds].reduce(
        (sum, productId) => sum + (todayQuantityByProduct.get(productId) || 0),
        0,
      )
      const units = [...new Set(groupMachines.map((m) => m.capacity_unit || 'หน่วย'))]
      const capacityUnit = units.length === 1 ? units[0] : null
      const maxCapacity = capacityUnit
        ? groupMachines.reduce((sum, m) => sum + totalProductionCapacityPerShift(m), 0)
        : 0
      result.set(type, {
        type,
        machines: groupMachines,
        productionToday,
        maxCapacity,
        capacityUnit,
        utilizationPercent: maxCapacity > 0 ? (productionToday / maxCapacity) * 100 : 0,
        brokenCount: groupMachines.filter((m) => m.current_status === 'broken').length,
        repairingCount: groupMachines.filter((m) => m.current_status === 'repairing').length,
        workingCount: groupMachines.filter((m) => m.current_status === 'working').length,
      })
    }
    return result
  }, [machineTypes, machines, todayQuantityByProduct])
  const totalProductionToday = useMemo(() => {
    const productIds = new Set(monitorMachines.flatMap((m) => m.product_ids || []))
    return [...productIds].reduce((sum, productId) => sum + (todayQuantityByProduct.get(productId) || 0), 0)
  }, [monitorMachines, todayQuantityByProduct])
  const machineProductionToday = useMemo(() => {
    const result = new Map<string, number>()
    for (const machine of machines) {
      result.set(machine.id, machineAllocatedQuantity(machine, machines, todayQuantityByProduct))
    }
    return result
  }, [machines, todayQuantityByProduct])

  const statusCounts = useMemo(() => {
    const c: Record<PrMachineryStatus, number> = {
      working: 0,
      broken: 0,
      repairing: 0,
      idle: 0,
      decommissioned: 0,
      power_off: 0,
    }
    for (const m of monitorMachines) {
      c[m.current_status]++
    }
    return c
  }, [monitorMachines])

  /** ผลรวมกำลังผลิตรวม/วัน (ชม.กะ × หน่วย/ชม.) ของทุกเครื่อง */
  const totalMaxProductionPerDay = useMemo(() => {
    return monitorMachines.reduce((sum, m) => sum + totalProductionCapacityPerShift(m), 0)
  }, [monitorMachines])

  const onStatusChange = async (machineId: string, status: PrMachineryStatus) => {
    const currentStatus = machines.find((machine) => machine.id === machineId)?.current_status
    if ((status === 'power_off' || currentStatus === 'power_off') && !canToggleMachinePower) {
      setError('เฉพาะ superadmin, admin และ technician เท่านั้นที่เปิดหรือปิดเครื่องได้')
      return
    }
    setSavingId(machineId)
    setError(null)
    try {
      await changeMachineStatus(machineId, status)
      await load()
      window.dispatchEvent(new Event('sidebar-refresh-counts'))
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingId(null)
    }
  }

  const [form, setForm] = useState<Partial<MachineryMachine>>({
    name: '',
    ip_address: null,
    machine_type: 'ทั่วไป',
    capacity_unit: 'หน่วย',
    product_ids: [],
    location: '',
    work_start: '08:00',
    work_end: '17:00',
    capacity_units_per_hour: 0,
    department_name: null,
    line_index: null,
    is_primary_machine: true,
    can_substitute: false,
    sort_order: 0,
    image_url: null,
    incident_titles: [],
  })
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [incidentTitleDraft, setIncidentTitleDraft] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [showSelectedProducts, setShowSelectedProducts] = useState(false)
  const [photoRemove, setPhotoRemove] = useState(false)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [isMachineFormOpen, setIsMachineFormOpen] = useState(false)
  const [copySourceMachineId, setCopySourceMachineId] = useState<string | null>(null)
  const [draggedMachineId, setDraggedMachineId] = useState<string | null>(null)
  const [isReorderingMachines, setIsReorderingMachines] = useState(false)

  useEffect(() => {
    return () => {
      if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    }
  }, [photoPreview])

  const resetForm = () => {
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    setForm({
      name: '',
      ip_address: null,
      machine_type: 'ทั่วไป',
      capacity_unit: 'หน่วย',
      product_ids: [],
      location: '',
      work_start: '08:00',
      work_end: '17:00',
      capacity_units_per_hour: 0,
      department_name: null,
      line_index: null,
      is_primary_machine: true,
      can_substitute: false,
      sort_order: 0,
      image_url: null,
      incident_titles: [],
    })
    setPhotoFile(null)
    setIncidentTitleDraft('')
    setPhotoRemove(false)
    setPhotoPreview(null)
    setCopySourceMachineId(null)
  }

  const saveMachine = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name?.trim()) return
    setError(null)
    try {
      const base = {
        id: form.id,
        name: form.name.trim(),
        ip_address: form.ip_address?.trim() || null,
        machine_type: form.machine_type?.trim() || 'ทั่วไป',
        capacity_unit: form.capacity_unit?.trim() || 'หน่วย',
        product_ids: form.product_ids || [],
        location: form.location || null,
        work_start: normalizeTime(form.work_start || '08:00'),
        work_end: normalizeTime(form.work_end || '17:00'),
        capacity_units_per_hour: Number(form.capacity_units_per_hour) || 0,
        department_name: form.department_name || null,
        line_index: form.line_index ?? null,
        is_primary_machine: form.is_primary_machine ?? true,
        can_substitute: form.can_substitute ?? false,
        incident_titles: form.incident_titles || [],
        image_url: photoRemove ? null : form.image_url ?? null,
        sort_order: form.id
          ? Number(form.sort_order) || 0
          : machines.reduce((highest, machine) => Math.max(highest, Number(machine.sort_order) || 0), -1) + 1,
      }
      let savedMachine: MachineryMachine
      if (photoRemove && form.id) {
        savedMachine = await upsertMachine({ ...base, name: base.name, image_url: null })
      } else if (photoFile) {
        savedMachine = await upsertMachine({ ...base, name: base.name })
        const url = await uploadMachineryPhoto(savedMachine.id, photoFile)
        savedMachine = await upsertMachine({ ...base, id: savedMachine.id, name: savedMachine.name, image_url: url })
      } else {
        savedMachine = await upsertMachine({ ...base, name: base.name })
      }
      if (!form.id && copySourceMachineId) {
        await copyMachineryChecklistSettings(copySourceMachineId, savedMachine.id)
      }
      resetForm()
      setIsMachineFormOpen(false)
      await load()
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }

  const editMachine = (m: MachineryMachine) => {
    setIsMachineFormOpen(true)
    setCopySourceMachineId(null)
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    setPhotoFile(null)
    setIncidentTitleDraft('')
    setPhotoRemove(false)
    setPhotoPreview(m.image_url || null)
    const configuredLineCount = m.department_name ? planLineSettings.linesPerDept[m.department_name] : 0
    setForm({
      id: m.id,
      name: m.name,
      ip_address: m.ip_address || null,
      machine_type: m.machine_type || 'ทั่วไป',
      capacity_unit: m.capacity_unit || 'หน่วย',
      product_ids: m.product_ids || [],
      location: m.location || '',
      work_start: m.work_start.slice(0, 5),
      work_end: m.work_end.slice(0, 5),
      capacity_units_per_hour: m.capacity_units_per_hour,
      department_name: m.department_name,
      line_index: m.line_index == null
        ? null
        : configuredLineCount > 0
          ? Math.min(Math.max(0, m.line_index), configuredLineCount - 1)
          : m.line_index,
      is_primary_machine: m.is_primary_machine,
      can_substitute: m.can_substitute,
      sort_order: m.sort_order,
      image_url: m.image_url ?? null,
      incident_titles: m.incident_titles || [],
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const copyMachine = (m: MachineryMachine) => {
    setIsMachineFormOpen(true)
    setCopySourceMachineId(m.id)
    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
    setPhotoFile(null)
    setIncidentTitleDraft('')
    setPhotoRemove(false)
    setPhotoPreview(m.image_url || null)
    const configuredLineCount = m.department_name ? planLineSettings.linesPerDept[m.department_name] : 0
    const copyBaseName = `${m.name} (สำเนา)`
    const existingNames = new Set(machines.map((machine) => machine.name.trim()))
    let copyName = copyBaseName
    let copyNumber = 2
    while (existingNames.has(copyName)) {
      copyName = `${copyBaseName} ${copyNumber}`
      copyNumber += 1
    }
    setForm({
      name: copyName,
      ip_address: m.ip_address || null,
      machine_type: m.machine_type || 'ทั่วไป',
      capacity_unit: m.capacity_unit || 'หน่วย',
      product_ids: [...(m.product_ids || [])],
      location: m.location || '',
      work_start: m.work_start.slice(0, 5),
      work_end: m.work_end.slice(0, 5),
      capacity_units_per_hour: m.capacity_units_per_hour,
      department_name: m.department_name,
      line_index: m.line_index == null
        ? null
        : configuredLineCount > 0
          ? Math.min(Math.max(0, m.line_index), configuredLineCount - 1)
          : m.line_index,
      is_primary_machine: m.is_primary_machine,
      can_substitute: m.can_substitute,
      sort_order: 0,
      image_url: m.image_url ?? null,
      incident_titles: [...(m.incident_titles || [])],
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const removeMachine = async (id: string) => {
    const machine = machines.find((item) => item.id === id)
    const confirmed = await showConfirm({
      title: 'ยืนยันการลบเครื่องจักร',
      message: machine?.name
        ? `ต้องการลบเครื่องจักร “${machine.name}” หรือไม่?\nการลบนี้ไม่สามารถย้อนกลับได้`
        : 'ต้องการลบเครื่องจักรนี้หรือไม่?\nการลบนี้ไม่สามารถย้อนกลับได้',
      confirmText: 'ลบเครื่องจักร',
      cancelText: 'ยกเลิก',
    })
    if (!confirmed) return
    try {
      await deleteMachine(id)
      await load()
    } catch (err: any) {
      setError(err?.message || String(err))
    }
  }

  const reorderMachines = async (sourceMachineId: string, targetMachineId: string) => {
    if (!sourceMachineId || sourceMachineId === targetMachineId || isReorderingMachines) return
    const fromIndex = machines.findIndex((machine) => machine.id === sourceMachineId)
    const toIndex = machines.findIndex((machine) => machine.id === targetMachineId)
    if (fromIndex < 0 || toIndex < 0) return

    const previous = machines
    const reordered = [...machines]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    const normalized = reordered.map((machine, index) => ({ ...machine, sort_order: index }))

    setMachines(normalized)
    setDraggedMachineId(null)
    setIsReorderingMachines(true)
    setError(null)
    try {
      await updateMachineSortOrders(normalized.map(({ id, sort_order }) => ({ id, sort_order })))
    } catch (err: any) {
      setMachines(previous)
      setError(err?.message || String(err))
    } finally {
      setIsReorderingMachines(false)
    }
  }

  const onGroupPowerChange = async (machineType: string, turnOn: boolean) => {
    if (!canToggleMachinePower || savingGroupType) return
    const groupMachines = machines.filter((machine) => (machine.machine_type || 'ทั่วไป') === machineType)
    const targets = groupMachines.filter((machine) => turnOn
      ? machine.current_status === 'power_off'
      : machine.current_status === 'working' || machine.current_status === 'idle')
    if (targets.length === 0) return
    const protectedCount = groupMachines.length - groupMachines.filter((machine) =>
      machine.current_status === 'working' || machine.current_status === 'idle' || machine.current_status === 'power_off',
    ).length
    const actionLabel = turnOn ? 'เปิด' : 'ปิด'
    const confirmed = await showConfirm({
      title: `ยืนยัน${actionLabel}เครื่องทั้งกลุ่ม`,
      message: `${actionLabel}เครื่องในกลุ่ม “${machineType}” จำนวน ${targets.length} เครื่องหรือไม่?${protectedCount > 0 ? `\nเครื่องเสีย/กำลังซ่อม/หยุดใช้งาน ${protectedCount} เครื่องจะไม่ถูกเปลี่ยนสถานะ` : ''}`,
      confirmText: `${actionLabel}เครื่อง ${targets.length} เครื่อง`,
      cancelText: 'ยกเลิก',
    })
    if (!confirmed) return

    setSavingGroupType(machineType)
    setError(null)
    try {
      const results = await Promise.allSettled(targets.map((machine) => {
        const nextStatus: PrMachineryStatus = turnOn
          ? ((machineProductionToday.get(machine.id) || 0) > 0 ? 'working' : 'idle')
          : 'power_off'
        return changeMachineStatus(machine.id, nextStatus, `${actionLabel}เครื่องทั้งกลุ่ม: ${machineType}`)
      }))
      await load()
      window.dispatchEvent(new Event('sidebar-refresh-counts'))
      const failedCount = results.filter((result) => result.status === 'rejected').length
      if (failedCount > 0) {
        setError(`${actionLabel}เครื่องสำเร็จ ${targets.length - failedCount} เครื่อง และไม่สำเร็จ ${failedCount} เครื่อง`)
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingGroupType(null)
    }
  }

  const [histLoading, setHistLoading] = useState(false)
  const [histEvents, setHistEvents] = useState<MachineryEvent[]>([])
  const [histRepairEvents, setHistRepairEvents] = useState<MachineryEvent[]>([])
  const [histQuantityByDay, setHistQuantityByDay] = useState<WorkOrderQuantityByDay>(new Map())
  const [historyNow, setHistoryNow] = useState(() => new Date())

  useEffect(() => {
    if (tab !== 'history') return
    setHistoryNow(new Date())
    const timer = window.setInterval(() => setHistoryNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [tab])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (tab !== 'history') return
      setHistLoading(true)
      try {
        const [fy, fm, fd] = histFrom.split('-').map(Number)
        const [ty, tm, td] = histTo.split('-').map(Number)
        const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0).toISOString()
        const toEnd = new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString()
        const repairLookupEnd = new Date(Math.max(Date.now(), new Date(toEnd).getTime()) + 1).toISOString()
        const [ev, repairEv, quantities] = await Promise.all([
          fetchEventsOverlappingRange(from, toEnd, histMachineId || null),
          fetchEventsStartingRange(from, repairLookupEnd, histMachineId || null),
          fetchWorkOrderQuantityByProductByDay(new Date(from), new Date(toEnd)),
        ])
        if (!cancelled) {
          setHistEvents(ev)
          setHistRepairEvents(repairEv)
          setHistQuantityByDay(quantities)
        }
      } catch {
        if (!cancelled) {
          setHistEvents([])
          setHistRepairEvents([])
          setHistQuantityByDay(new Map())
        }
      } finally {
        if (!cancelled) setHistLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [histFrom, histTo, histMachineId, tab])

  const historyRowsComputed = useMemo(() => {
    const fromD = new Date(histFrom + 'T12:00:00')
    const toD = new Date(histTo + 'T12:00:00')
    const rows: DailySummaryRow[] = []
    for (let t = fromD.getTime(); t <= toD.getTime(); t += 86400000) {
      const day = new Date(t)
      const ms = machines.filter((m) => !histMachineId || m.id === histMachineId)
      for (const m of ms) {
        const row = summarizeDayForMachine(m, day, histEvents)
        const dayTotals = histQuantityByDay.get(row.date)
        row.production_units = machineAllocatedQuantity(m, machines, dayTotals)
        const dailyCapacity = totalProductionCapacityPerShift(m)
        row.utilization_percent = dailyCapacity > 0
          ? (row.production_units / dailyCapacity) * 100
          : 0
        rows.push(row)
      }
    }
    return rows
  }, [histFrom, histTo, histMachineId, machines, histEvents, histQuantityByDay])

  const repairRoundsFiltered = useMemo(() => {
    const ms = machines.filter((m) => !histMachineId || m.id === histMachineId)
    const [fy, fm, fd] = histFrom.split('-').map(Number)
    const [ty, tm, td] = histTo.split('-').map(Number)
    const rangeStart = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime()
    const rangeEnd = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime()
    return computeRepairRounds(ms, histRepairEvents, historyNow).filter((r) => {
      const bt = new Date(r.broken_at).getTime()
      return bt >= rangeStart && bt <= rangeEnd
    })
  }, [histFrom, histTo, histMachineId, machines, histRepairEvents, historyNow])

  const statusSegmentsSorted = useMemo(() => {
    let list = [...histEvents]
    if (histMachineId) {
      list = list.filter((e) => e.machine_id === histMachineId)
    }
    if (histStatus) {
      list = list.filter((e) => e.status === histStatus)
    }
    return list
  }, [histEvents, histMachineId, histStatus])

  const statusSegmentsDisplay = useMemo(() => {
    return [...statusSegmentsSorted]
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
      .map((ev) => ({
        ev,
        durationMs: computeEventDurationMs(ev, historyNow),
      }))
  }, [statusSegmentsSorted, historyNow])

  if (loading) {
    return (
      <div
        className={`flex justify-center items-center py-24 ${isStandaloneMobile ? 'min-h-screen w-full bg-gray-50' : ''}`}
      >
        <div
          className={`animate-spin rounded-full h-12 w-12 border-b-2 ${isMobileRole ? 'border-emerald-600' : 'border-emerald-600'}`}
        />
      </div>
    )
  }

  const renderMonitorMachineArticle = (m: MachineryMachine) => {
    const now = new Date(monitorTick)
    const workingMs = computeWorkingTimeInShiftMsToday(m, events, now)
    const shiftTotalMs = computeShiftDurationMsForDay(m, now)
    const groupStats = machineTypeStats.get(m.machine_type || 'ทั่วไป')
    const machineProduction = machineProductionToday.get(m.id) || 0
    const st = m.current_status
    const isReady = readiness.find((item) => item.machine_id === m.id)?.status === 'ready'
    const displayedStatusLabel = st === 'idle' && isReady
      ? 'พร้อมทำงาน'
      : MACHINERY_STATUS_LABELS[st]
    const isPowerOff = st === 'power_off'
    const canTogglePower = st === 'power_off' || st === 'working' || st === 'idle'
    const isPowerOn = st === 'working' || st === 'idle'
    const textColor = isPowerOff ? 'text-slate-900' : 'text-white'
    const subTextColor = isPowerOff ? 'text-slate-700' : 'text-white'
    return (
      <article
        key={m.id}
        className={`${monitorCardShellClass(st)} ${isMobileRole ? '!overflow-visible relative z-10' : ''}`}
      >
        <div className="relative aspect-video w-full shrink-0 bg-black/50 overflow-hidden rounded-t-2xl">
          {m.image_url ? (
            <img src={m.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-400">
              <FiImage className="h-12 w-12 opacity-60" aria-hidden />
              <span className="text-xs font-medium">ยังไม่มีรูป</span>
            </div>
          )}
          <div className={monitorStatusBarClass(st, isMobileRole)}>{displayedStatusLabel}</div>
        </div>
        <div className={`flex flex-1 flex-col gap-2.5 p-3 ${textColor}`}>
          <div>
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 text-base sm:text-lg font-bold leading-tight">{m.name}</h3>
              {canToggleMachinePower && <label
                className={`inline-flex shrink-0 items-center gap-1.5 ${canTogglePower ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                title={canTogglePower ? (isPowerOn ? 'ปิดเครื่อง' : 'เปิดเครื่อง') : 'สถานะนี้ต้องจัดการผ่านกระบวนการแจ้งซ่อม'}
              >
                <span className="text-[10px] font-bold uppercase">{isPowerOn ? 'เปิด' : 'ปิด'}</span>
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={isPowerOn}
                  disabled={!canTogglePower || savingId === m.id}
                  onChange={() => void onStatusChange(m.id, isPowerOn ? 'power_off' : (machineProduction > 0 ? 'working' : 'idle'))}
                  aria-label={`${isPowerOn ? 'ปิด' : 'เปิด'}เครื่อง ${m.name}`}
                />
                <span className="relative h-6 w-11 rounded-full bg-slate-400 transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-60 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
              </label>}
            </div>
            {m.ip_address?.trim() && (
              <p className={`mt-1 text-xs font-mono ${subTextColor}`}>IP {m.ip_address}</p>
            )}
            <p className={`mt-1 text-[11px] font-semibold uppercase tracking-wide ${subTextColor}`}>
              {m.machine_type || 'ทั่วไป'}
            </p>
            <p className={`mt-0.5 text-xs sm:text-sm ${subTextColor}`}>
              สถานที่ {m.location?.trim() ? m.location : '—'}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs sm:text-sm">
            <dt>เวลาในกะ (จับเวลา)</dt>
            <dd className="text-right font-mono tabular-nums font-semibold text-[11px] sm:text-sm">
              {formatMsAsHms(workingMs)} / {formatMsAsHms(shiftTotalMs)}
            </dd>
            <dt>กำลังผลิต/ชม.</dt>
            <dd className="text-right font-mono tabular-nums">{fmtInt(Number(m.capacity_units_per_hour))} {m.capacity_unit || 'หน่วย'}</dd>
            <dt>กำลังผลิตรวม/วัน</dt>
            <dd className="text-right font-mono tabular-nums">{fmtInt(totalProductionCapacityPerShift(m))} {m.capacity_unit || 'หน่วย'}</dd>
            <dt>ภาระงานของเครื่อง (เฉลี่ย)</dt>
            <dd className="text-right font-mono tabular-nums font-semibold">{fmtQuantity(machineProduction)} {groupStats?.capacityUnit || m.capacity_unit || 'หน่วย'}</dd>
            <dt>ใช้กำลังผลิตรวมของกลุ่ม</dt>
            <dd className="text-right font-mono tabular-nums font-semibold">{(groupStats?.utilizationPercent || 0).toFixed(1)}%</dd>
          </dl>
          <div className="mt-auto text-xs">
            <span className="mb-0.5 block font-medium">สถานะเครื่อง</span>
            <div className={`w-full rounded-lg border px-2.5 py-2 text-sm font-semibold ${
              isPowerOff
                ? 'border-slate-300 bg-white text-slate-900'
                : 'border-white/30 bg-white/95 text-gray-900'
            }`}>
              {displayedStatusLabel}
            </div>
          </div>
        </div>
      </article>
    )
  }

  const pageText = isMobileRole ? 'text-gray-900 text-sm sm:text-base' : 'text-gray-900 text-sm sm:text-base lg:text-lg'

  return (
    <div className={isStandaloneMobile ? 'min-h-screen w-full bg-gray-50 flex flex-col' : 'w-full max-w-none'}>
      {/* Topbar มือถือ — สไตล์เดียวกับเมนู Role มือถืออื่นๆ */}
      {isStandaloneMobile && (
        <header className="p-3 flex items-center justify-between gap-2 bg-emerald-600 text-white shadow-md sticky top-0 z-30">
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-emerald-100/80 font-bold uppercase truncate">Machinery</span>
            <span className="text-sm font-black leading-tight truncate">
              {user?.username || user?.email || '---'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <ModeSwitchButton />
            <button
              type="button"
              onClick={() => signOut()}
              className="bg-red-500 hover:bg-red-600 text-white text-xs font-bold px-3 py-1.5 rounded-lg whitespace-nowrap"
            >
              ออกจากระบบ
            </button>
          </div>
        </header>
      )}
      <div
        className={`w-full max-w-none mx-auto space-y-5 ${pageText} ${
          isStandaloneMobile ? 'px-3 pb-10 pt-3' : 'px-2 sm:px-4 lg:px-6 pb-8 pt-1'
        }`}
      >
      {error && (
        <div
          className={`rounded-lg px-4 py-3 text-sm sm:text-base border ${
            isMobileRole
              ? 'bg-red-50 text-red-800 border-red-200'
              : 'bg-red-50 text-red-800 border-red-200'
          }`}
        >
          {error}
        </div>
      )}

      <nav className={`flex gap-1 border-b border-gray-200 ${isStandaloneMobile ? 'flex-nowrap overflow-x-auto scrollbar-thin' : 'flex-wrap'}`}>
        {(['monitor', 'inspection', 'maintenance', 'machineSettings', 'checklistSettings', 'history', 'purchaseRequest', 'stock', 'purchaseSettings'] as TabKey[]).map((k) => {
          if (isProductionRole && PRODUCTION_HIDDEN_TABS.has(k)) return null
          if (k === 'inspection' && !showInspectionTab) return null
          if (k === 'machineSettings' && !showMachineSettingsTab) return null
          if (k === 'checklistSettings' && !showChecklistSettingsTab) return null
          if (k === 'purchaseSettings' && !showPurchaseSettingsTab) return null
          const labels: Record<TabKey, string> = {
            monitor: 'สถานะ / มอนิเตอร์',
            inspection: 'ตรวจความพร้อม',
            maintenance: 'แจ้งเสีย / ซ่อม',
            machineSettings: 'ตั้งค่าเครื่อง',
            checklistSettings: 'ตั้งค่า Checklist',
            history: 'ประวัติ / รายงาน',
            purchaseRequest: 'คำขอซื้อ',
            stock: 'สต๊อคคงเหลือ',
            purchaseSettings: 'ตั้งค่าสินค้า',
          }
          return (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`shrink-0 whitespace-nowrap py-2.5 text-sm sm:text-base font-semibold rounded-t-lg border-b-2 -mb-px ${
                isStandaloneMobile ? 'px-3' : 'px-4'
              } ${
                tab === k
                  ? 'border-emerald-600 text-emerald-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {labels[k]}
              {k === 'purchaseRequest' && myPendingPurchaseCount > 0 && (
                <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-orange-500 px-1.5 py-0.5 text-xs font-bold text-white">
                  {myPendingPurchaseCount > 99 ? '99+' : myPendingPurchaseCount}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {tab === 'inspection' && showInspectionTab && <MachineryChecklist machines={inspectionMachines} onChanged={load} />}
      {tab === 'maintenance' && <MachineryMaintenance machines={machines} onChanged={load} />}
      {tab === 'checklistSettings' && showChecklistSettingsTab && <ChecklistSettings machines={machines} />}

      {tab === 'monitor' && (
        <section className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {machineTypes.map((type) => {
              const stats = machineTypeStats.get(type)
              if (!stats) return null
              const abnormalCount = stats.brokenCount + stats.repairingCount
              const selected = monitorMachineType === type
              const switchableMachines = stats.machines.filter((machine) =>
                machine.current_status === 'working' || machine.current_status === 'idle' || machine.current_status === 'power_off')
              const allPoweredOn = switchableMachines.length > 0 && switchableMachines.every((machine) => machine.current_status !== 'power_off')
              const groupSaving = savingGroupType === type
              return (
                <div
                  key={type}
                  role="button"
                  tabIndex={0}
                  onClick={() => setMonitorMachineType((current) => (current === type ? '' : type))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setMonitorMachineType((current) => (current === type ? '' : type))
                    }
                  }}
                  className={`rounded-xl border p-4 text-left shadow-sm transition hover:border-emerald-300 hover:shadow-md ${
                    selected ? 'border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300' : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold text-gray-900">{type}</div>
                      <div className="mt-0.5 text-xs text-gray-500">
                        {stats.machines.length} เครื่อง · ทำงาน {stats.workingCount}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {canToggleMachinePower && <label
                        className={`inline-flex items-center gap-1.5 ${switchableMachines.length > 0 && !groupSaving ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                        title={allPoweredOn ? `ปิดเครื่องที่เปิดอยู่ทั้งหมดในกลุ่ม ${type}` : `เปิดเครื่องที่ปิดอยู่ทั้งหมดในกลุ่ม ${type}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="text-[10px] font-bold uppercase text-slate-600">{groupSaving ? 'กำลังบันทึก' : allPoweredOn ? 'เปิด' : 'ปิด'}</span>
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          checked={allPoweredOn}
                          disabled={switchableMachines.length === 0 || groupSaving || savingGroupType !== null}
                          onChange={() => void onGroupPowerChange(type, !allPoweredOn)}
                          aria-label={`${allPoweredOn ? 'ปิด' : 'เปิด'}เครื่องทั้งกลุ่ม ${type}`}
                        />
                        <span className="relative h-6 w-11 rounded-full bg-slate-400 transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-60 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
                      </label>}
                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                        abnormalCount > 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {abnormalCount > 0 ? `ผิดปกติ ${abnormalCount}` : 'ปกติ'}
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                    <div><div className="text-xs text-gray-500">งานวันนี้</div><div className="font-bold tabular-nums">{fmtInt(stats.productionToday)}</div></div>
                    <div><div className="text-xs text-gray-500">กำลังผลิตรวม</div><div className="font-bold tabular-nums">{fmtInt(stats.maxCapacity)}</div></div>
                    <div><div className="text-xs text-gray-500">ใช้งาน</div><div className="font-bold tabular-nums">{stats.utilizationPercent.toFixed(1)}%</div></div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className={`h-full rounded-full ${stats.utilizationPercent > 100 ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(stats.utilizationPercent, 100)}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="grid gap-3 xl:grid-cols-[minmax(420px,2fr)_minmax(0,6fr)]">
          <div
            className={`grid grid-cols-2 items-center rounded-xl border px-4 py-4 sm:px-5 sm:py-4 ${
              isMobileRole
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900'
            }`}
          >
            <div>
              <div className="text-left text-sm font-semibold sm:text-base">ผลิตวันนี้:</div>
              <div className="mt-1 text-left">
                <span className="text-xl font-black tabular-nums sm:text-2xl">{monitorCapacityUnit ? fmtInt(totalProductionToday) : '—'}</span>
                <span className={`ml-1 text-sm sm:text-base ${isMobileRole ? 'text-emerald-700' : ''}`}>{monitorCapacityUnit || 'เลือกประเภทเพื่อรวมกำลังผลิต'}</span>
              </div>
            </div>
            <div
              className={`border-l pl-4 text-left ${
                isMobileRole ? 'border-emerald-300/80' : 'border-emerald-300/80'
              }`}
            >
              <div className="text-sm font-semibold sm:text-base">กำลังผลิตสูงสุด:</div>
              <div className="mt-1">
                <span className="text-xl font-black tabular-nums sm:text-2xl">{monitorCapacityUnit ? fmtInt(totalMaxProductionPerDay) : '—'}</span>
                <span className={`ml-1 text-sm sm:text-base ${isMobileRole ? 'text-emerald-700' : ''}`}>{monitorCapacityUnit || 'หน่วยต่างกัน ไม่สามารถรวมได้'}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div
              className={`rounded-xl border p-4 text-center shadow-sm ${
                isMobileRole
                  ? 'border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200 shadow-emerald-100'
                  : 'border-emerald-300 bg-emerald-50/80 shadow-sm ring-1 ring-emerald-200/60'
              }`}
            >
              <div className={`text-xs font-medium ${isMobileRole ? 'text-emerald-700' : 'text-emerald-800'}`}>
                จำนวนรวม / ปิดเครื่อง
              </div>
              <div
                className={`text-2xl sm:text-3xl font-black tabular-nums ${
                  isMobileRole ? 'text-emerald-900' : 'text-emerald-900'
                }`}
              >
                {monitorMachines.length}/{statusCounts.power_off}
              </div>
            </div>
            {STATUS_SUMMARY_ORDER.map((s) => (
              <div
                key={s}
                className={`rounded-xl border p-4 text-center shadow-sm ${
                  isMobileRole
                    ? 'border-slate-200 bg-white shadow-slate-100'
                    : 'border-gray-200 bg-white shadow-sm'
                }`}
              >
                <div className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>
                  {MACHINERY_STATUS_LABELS[s]}
                </div>
                <div className={`text-2xl sm:text-3xl font-black tabular-nums ${isMobileRole ? 'text-gray-900' : 'text-gray-900'}`}>
                  {statusCounts[s]}
                </div>
              </div>
            ))}
          </div>
          </div>

          {isMobileRole ? (
            <div className="space-y-4">
              {monitorMachines.length === 0 ? (
                <div
                  className={`rounded-2xl border px-6 py-12 text-center text-sm sm:text-base ${
                    isMobileRole ? 'border-slate-200 bg-white text-gray-500' : 'border-gray-200 bg-gray-50 text-gray-500'
                  }`}
                >
                  ยังไม่มีเครื่อง — ไปแท็บตั้งค่าเพื่อเพิ่ม
                </div>
              ) : (
                <>
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-2">เลือกเครื่องจักร</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {monitorMachines.map((m) => {
                        const st = m.current_status
                        const selected = selectedMonitorMachineId === m.id
                        const groupStats = machineTypeStats.get(m.machine_type || 'ทั่วไป')
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() =>
                              setSelectedMonitorMachineId((prev) => (prev === m.id ? null : m.id))
                            }
                            className={monitorPickerButtonClass(st, selected)}
                          >
                            <div className="flex items-start gap-2 min-w-0">
                              <span
                                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                                  st === 'working'
                                    ? 'bg-emerald-400'
                                    : st === 'broken'
                                      ? 'bg-red-400'
                                      : st === 'repairing'
                                        ? 'bg-yellow-400'
                                        : st === 'idle'
                                          ? 'bg-sky-400'
                                          : st === 'decommissioned'
                                            ? 'bg-zinc-400'
                                            : 'bg-white'
                                }`}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-slate-800 leading-snug line-clamp-2">
                                  {m.name}
                                </span>
                                <span className="mt-0.5 block text-xs sm:text-sm font-semibold text-slate-500 truncate">
                                  {MACHINERY_STATUS_LABELS[st]}
                                </span>
                                <span className="mt-1 block text-[11px] sm:text-xs tabular-nums font-medium text-emerald-700">
                                  งานเครื่อง {fmtQuantity(machineProductionToday.get(m.id) || 0)} {groupStats?.capacityUnit || m.capacity_unit || 'หน่วย'}
                                </span>
                              </span>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-center text-xs text-gray-500 mt-3">
                      แตะชื่อเครื่องอีกครั้งเพื่อปิดรายละเอียด
                    </p>
                  </div>
                  {selectedMonitorMachineId &&
                    (() => {
                      const sel = machines.find((x) => x.id === selectedMonitorMachineId)
                      return sel ? renderMonitorMachineArticle(sel) : null
                    })()}
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
              {monitorMachines.length === 0 && (
                <div
                  className={`col-span-full rounded-2xl border px-6 py-12 text-center text-sm sm:text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-800/60 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-500'
                  }`}
                >
                  ยังไม่มีเครื่อง — ไปแท็บตั้งค่าเพื่อเพิ่ม
                </div>
              )}
              {monitorMachines.map((m) => renderMonitorMachineArticle(m))}
            </div>
          )}
        </section>
      )}

      {tab === 'machineSettings' && showMachineSettingsTab && (
        <section className="space-y-6">
          {!isMachineFormOpen && <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                resetForm()
                setIsMachineFormOpen(true)
              }}
              className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
              aria-expanded="false"
            >
              เพิ่มเครื่อง
            </button>
          </div>}
          {isMachineFormOpen && <form
            onSubmit={saveMachine}
            className={`rounded-xl border p-5 sm:p-6 shadow-sm space-y-4 ${
              isMobileRole
                ? 'border-slate-600 bg-slate-800/90 shadow-black/30'
                : 'border-gray-200 bg-white'
            }`}
          >
            <h2
              className={`text-xl sm:text-2xl font-bold ${isMobileRole ? 'text-gray-900' : 'text-gray-900'}`}
            >
              {form.id ? 'แก้ไขเครื่อง' : 'เพิ่มเครื่อง'}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[repeat(20,minmax(0,1fr))] [&>label]:xl:col-span-5">
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>ชื่อเครื่อง *</span>
                <input
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.name || ''}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>IP Address</span>
                <input
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base font-mono ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.ip_address || ''}
                  onChange={(e) => setForm((f) => ({ ...f, ip_address: e.target.value }))}
                  placeholder="เช่น 192.168.1.100"
                  maxLength={45}
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>สถานที่</span>
                <input
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.location || ''}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>เริ่มกะ</span>
                <input
                  type="time"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.work_start || ''}
                  onChange={(e) => setForm((f) => ({ ...f, work_start: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>สิ้นสุดกะ</span>
                <input
                  type="time"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.work_end || ''}
                  onChange={(e) => setForm((f) => ({ ...f, work_end: e.target.value }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">ประเภทเครื่องจักร *</span>
                <input
                  list="machinery-type-options"
                  className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base"
                  value={form.machine_type || ''}
                  onChange={(e) => setForm((f) => ({ ...f, machine_type: e.target.value }))}
                  placeholder="เช่น เครื่องพิมพ์, เครื่องตัด, เครื่องเคลือบ"
                  required
                />
                <datalist id="machinery-type-options">
                  {machineTypes.map((type) => <option key={type} value={type} />)}
                </datalist>
              </label>
              <label className="block">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>
                  กำลังผลิตต่อชั่วโมง
                </span>
                <input
                  type="number"
                  step="0.0001"
                  className={`mt-1 w-full border rounded-lg px-3 py-2.5 text-base ${
                    isMobileRole ? 'border-slate-600 bg-slate-900/80 text-white' : ''
                  }`}
                  value={form.capacity_units_per_hour ?? 0}
                  onChange={(e) => setForm((f) => ({ ...f, capacity_units_per_hour: parseFloat(e.target.value) }))}
                />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">หน่วยกำลังผลิต *</span>
                <input
                  className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base"
                  value={form.capacity_unit || ''}
                  onChange={(e) => setForm((f) => ({ ...f, capacity_unit: e.target.value }))}
                  placeholder="เช่น ชิ้น, แผ่น, เมตร, กก."
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">แผนกใน Master Plan</span>
                <select
                  className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base"
                  value={form.department_name || ''}
                  onChange={(e) => setForm((current) => ({
                    ...current,
                    department_name: e.target.value || null,
                    line_index: e.target.value ? 0 : null,
                  }))}
                >
                  <option value="">— ไม่ผูกกับแผนก —</option>
                  {form.department_name && !planLineSettings.departments.includes(form.department_name) && (
                    <option value={form.department_name}>{form.department_name} (ไม่พบในการตั้งค่า Plan)</option>
                  )}
                  {planLineSettings.departments.map((department) => (
                    <option key={department} value={department}>{department}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">ไลน์ผลิต</span>
                <select
                  className="mt-1 w-full rounded-lg border px-3 py-2.5 text-base disabled:bg-gray-100 disabled:text-gray-400"
                  value={form.line_index == null ? '' : String(form.line_index)}
                  disabled={!form.department_name}
                  onChange={(e) => setForm((current) => ({ ...current, line_index: e.target.value === '' ? null : Number(e.target.value) }))}
                >
                  {!form.department_name && <option value="">— เลือกแผนกก่อน —</option>}
                  {form.department_name && Array.from(
                    { length: planLineSettings.linesPerDept[form.department_name] || 1 },
                    (_, index) => <option key={index} value={index}>Line {index + 1}</option>,
                  )}
                </select>
              </label>
              <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2 xl:[grid-column:1/16]">
                <label className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                  form.is_primary_machine ?? true
                    ? 'border-emerald-300 bg-emerald-50'
                    : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                  <input type="checkbox" className="h-5 w-5 rounded border-gray-300 accent-emerald-600" checked={form.is_primary_machine ?? true} onChange={(e) => setForm((f) => ({ ...f, is_primary_machine: e.target.checked }))} />
                  <span><b className="block text-sm text-gray-800">เครื่องหลักของไลน์</b><span className="text-xs text-gray-500">ใช้เป็นเครื่องหลักในการวางแผนผลิต</span></span>
                </label>
                <label className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                  form.can_substitute ?? false
                    ? 'border-blue-300 bg-blue-50'
                    : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                  <input type="checkbox" className="h-5 w-5 rounded border-gray-300 accent-blue-600" checked={form.can_substitute ?? false} onChange={(e) => setForm((f) => ({ ...f, can_substitute: e.target.checked }))} />
                  <span><b className="block text-sm text-gray-800">ใช้เป็นเครื่องสำรองได้</b><span className="text-xs text-gray-500">อนุญาตให้ใช้ทดแทนเครื่องหลัก</span></span>
                </label>
              </div>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:col-span-2 xl:[grid-column:16/21] xl:row-span-4 xl:row-start-1">
                <span className="text-sm font-semibold text-gray-700">หัวข้อ/อาการหลักที่พบบ่อย</span>
                <div className="mt-2 flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                    value={incidentTitleDraft}
                    onChange={(e) => setIncidentTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return
                      e.preventDefault()
                      const title = incidentTitleDraft.trim()
                      if (!title) return
                      setForm((current) => ({ ...current, incident_titles: [...new Set([...(current.incident_titles || []).filter(Boolean), title])] }))
                      setIncidentTitleDraft('')
                    }}
                    placeholder="เช่น กระดาษติด"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const title = incidentTitleDraft.trim()
                      if (!title) return
                      setForm((current) => ({ ...current, incident_titles: [...new Set([...(current.incident_titles || []).filter(Boolean), title])] }))
                      setIncidentTitleDraft('')
                    }}
                    disabled={!incidentTitleDraft.trim()}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                  >
                    เพิ่ม
                  </button>
                </div>
                <div className="mt-3 flex min-h-8 flex-wrap gap-2">
                  {(form.incident_titles || []).filter(Boolean).map((title) => (
                    <span key={title} className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-sm text-emerald-800 shadow-sm">
                      {title}
                      <button type="button" onClick={() => setForm((current) => ({ ...current, incident_titles: (current.incident_titles || []).filter((item) => item !== title) }))} className="font-bold text-gray-400 hover:text-red-600" aria-label={`ลบ ${title}`}>×</button>
                    </span>
                  ))}
                  {(form.incident_titles || []).filter(Boolean).length === 0 && <span className="text-xs text-gray-400">ยังไม่มีรายการอาการ</span>}
                </div>
                <span className="mt-2 block text-xs text-gray-500">กด Enter หรือปุ่มเพิ่ม รายการจะแสดงในหน้าแจ้งเสีย / ซ่อม</span>
              </div>
              <div className="sm:col-span-2 xl:order-2 xl:col-span-12 xl:col-start-9 rounded-xl border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-semibold text-gray-700">สินค้าที่ผลิตด้วยเครื่องนี้</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSelectedProducts((current) => !current)}
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                      showSelectedProducts
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    }`}
                    title={showSelectedProducts ? 'แสดงสินค้าทั้งหมด' : 'ดูเฉพาะสินค้าที่เลือก'}
                  >
                    เลือกแล้ว {(form.product_ids || []).length} รายการ
                  </button>
                </div>
                <input
                  className="mt-3 w-full rounded-lg border px-3 py-2 text-sm"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="ค้นหารหัสสินค้า ชื่อสินค้า หมวดหมู่ หรือประเภท"
                />
                <div className="mt-2 max-h-96 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                  <div className="sticky top-0 z-10 grid grid-cols-[1.15fr_2fr_1fr_0.8fr] gap-3 border-b border-gray-200 bg-gray-50 px-10 py-2 text-xs font-semibold text-gray-500">
                    <span>รหัสสินค้า</span>
                    <span>ชื่อสินค้า</span>
                    <span>หมวดหมู่</span>
                    <span>ประเภท</span>
                  </div>
                  {productOptions
                    .filter((product) => {
                      if (showSelectedProducts && !(form.product_ids || []).includes(product.id)) return false
                      const q = productSearch.trim().toLowerCase()
                      if (!q) return true
                      return [product.product_code, product.product_name, product.product_category, product.product_type]
                        .filter(Boolean)
                        .some((value) => String(value).toLowerCase().includes(q))
                    })
                    .map((product) => {
                      const checked = (form.product_ids || []).includes(product.id)
                      return (
                        <label key={product.id} className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-3 py-2.5 last:border-0 hover:bg-emerald-50">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded border-gray-300 text-emerald-600"
                            checked={checked}
                            onChange={(e) => setForm((current) => ({
                              ...current,
                              product_ids: e.target.checked
                                ? [...new Set([...(current.product_ids || []), product.id])]
                                : (current.product_ids || []).filter((id) => id !== product.id),
                            }))}
                          />
                          <span className="grid min-w-0 flex-1 grid-cols-[1.15fr_2fr_1fr_0.8fr] items-center gap-3 text-sm">
                            <span className="truncate font-semibold text-gray-800">{product.product_code}</span>
                            <span className="truncate text-gray-700" title={product.product_name}>{product.product_name}</span>
                            <span className="truncate text-gray-500">{product.product_category || '—'}</span>
                            <span className="truncate text-gray-500">{product.product_type || '—'}</span>
                          </span>
                        </label>
                      )
                    })}
                </div>
              </div>
              <div className="sm:col-span-2 xl:order-1 xl:col-span-8 xl:col-start-1 space-y-2 rounded-xl border border-gray-200 p-4">
                <span className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>รูปเครื่อง (JPEG/PNG/WebP)</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className={`block w-full text-base file:mr-3 file:rounded-lg file:border-0 file:px-3 file:py-2 file:font-semibold ${
                    isMobileRole
                      ? 'file:bg-slate-700 file:text-slate-100 text-gray-300'
                      : 'file:bg-emerald-600 file:text-white text-gray-700'
                  }`}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
                    setPhotoFile(f)
                    setPhotoPreview(URL.createObjectURL(f))
                    setPhotoRemove(false)
                  }}
                />
                {(photoRemove ? null : photoPreview || form.image_url) && (
                  <div className="space-y-3">
                    <img
                      src={(photoRemove ? null : photoPreview || form.image_url) || ''}
                      alt=""
                      className={`h-64 w-full rounded-xl object-contain border bg-gray-50 sm:h-72 ${
                        isMobileRole ? 'border-slate-600/50' : 'border-gray-200'
                      }`}
                    />
                    <button
                      type="button"
                      className={`block text-sm font-semibold px-3 py-2 rounded-lg ${
                        isMobileRole ? 'bg-red-900/50 text-red-300 hover:bg-red-900/70' : 'bg-red-100 text-red-800 hover:bg-red-200'
                      }`}
                      onClick={() => {
                        if (photoPreview?.startsWith('blob:')) URL.revokeObjectURL(photoPreview)
                        setPhotoFile(null)
                        setPhotoPreview(null)
                        setPhotoRemove(true)
                      }}
                    >
                      ลบรูป
                    </button>
                  </div>
                )}
                {photoRemove && form.id && (
                  <p className={`text-sm ${isMobileRole ? 'text-amber-300/90' : 'text-amber-800'}`}>
                    จะลบรูปออกจากเครื่องนี้เมื่อกดบันทึก
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-base font-semibold hover:bg-emerald-700"
              >
                บันทึก
              </button>
              <button
                type="button"
                className={`px-4 py-2 rounded-lg ${
                  isMobileRole ? 'bg-slate-700 text-slate-100 hover:bg-slate-600' : 'bg-gray-200 text-gray-800'
                }`}
                onClick={() => {
                  resetForm()
                  setIsMachineFormOpen(false)
                }}
              >
                ยกเลิก
              </button>
            </div>
          </form>}

          <div
            className={`overflow-x-auto rounded-xl border shadow-sm ${
              isMobileRole ? 'border-slate-600 bg-slate-800/90 shadow-black/30' : 'border-gray-200 bg-white'
            }`}
          >
            <table className="min-w-full text-base sm:text-lg">
              <thead
                className={`text-left ${isMobileRole ? 'bg-slate-800/90 text-gray-300' : 'bg-gray-50 text-gray-600'}`}
              >
                <tr>
                  <th className="w-20 px-3 py-3 whitespace-nowrap text-center">ลากลำดับ</th>
                  <th className="px-3 py-3 whitespace-nowrap w-16">รูป</th>
                  <th className="px-3 py-3 whitespace-nowrap">เครื่อง</th>
                  <th className="px-3 py-3 whitespace-nowrap">IP Address</th>
                  <th className="px-3 py-3 whitespace-nowrap">ประเภท</th>
                  <th className="px-3 py-3 whitespace-nowrap min-w-[8rem]">สถานที่</th>
                  <th className="px-3 py-3 whitespace-nowrap">กะ</th>
                  <th className="px-3 py-3 whitespace-nowrap">กำลังผลิต/ชม.</th>
                  <th className="px-3 py-3 whitespace-nowrap">กำลังผลิตรวม</th>
                  <th className="px-3 py-3 whitespace-nowrap text-right" />
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr
                    key={m.id}
                    draggable={!isReorderingMachines}
                    onDragStart={(event) => {
                      setDraggedMachineId(m.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', m.id)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      void reorderMachines(event.dataTransfer.getData('text/plain'), m.id)
                    }}
                    onDragEnd={() => setDraggedMachineId(null)}
                    className={`border-t transition ${
                      draggedMachineId === m.id ? 'opacity-40' : ''
                    } ${isReorderingMachines ? 'cursor-wait' : 'cursor-grab active:cursor-grabbing'} ${
                      isMobileRole ? 'border-slate-700' : 'border-gray-100 hover:bg-emerald-50/40'
                    }`}
                  >
                    <td className={`px-3 py-3 text-center ${isMobileRole ? 'text-gray-300' : 'text-gray-500'}`}>
                      <span className="inline-flex select-none items-center text-2xl leading-none" title="ลากเพื่อจัดลำดับ" aria-label="ลากเพื่อจัดลำดับ">≡</span>
                    </td>
                    <td className="px-3 py-2">
                      {m.image_url ? (
                        <img src={m.image_url} alt="" className="h-10 w-14 rounded object-cover" loading="lazy" />
                      ) : (
                        <span className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-400'}`}>—</span>
                      )}
                    </td>
                    <td className={`px-3 py-3 font-medium ${isMobileRole ? 'text-slate-100' : 'text-gray-900'}`}>
                      {m.name}
                    </td>
                    <td className={`px-3 py-3 font-mono text-sm ${isMobileRole ? 'text-gray-300' : 'text-gray-600'}`}>
                      {m.ip_address?.trim() || '—'}
                    </td>
                    <td className="px-3 py-3 text-gray-600">{m.machine_type || 'ทั่วไป'}</td>
                    <td className={`px-3 py-3 ${isMobileRole ? 'text-gray-400' : 'text-gray-600'}`}>
                      {m.location?.trim() ? m.location : '—'}
                    </td>
                    <td className={`px-3 py-3 font-mono text-sm sm:text-base ${isMobileRole ? 'text-gray-400' : ''}`}>
                      {m.work_start.slice(0, 5)} – {m.work_end.slice(0, 5)}
                    </td>
                    <td className={`px-3 py-3 tabular-nums ${isMobileRole ? 'text-gray-200' : ''}`}>
                      {fmtInt(Number(m.capacity_units_per_hour))} {m.capacity_unit || 'หน่วย'}
                    </td>
                    <td className={`px-3 py-3 tabular-nums font-medium ${isMobileRole ? 'text-emerald-300/90' : 'text-emerald-800'}`}>
                      {fmtInt(totalProductionCapacityPerShift(m))} {m.capacity_unit || 'หน่วย'}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                          isMobileRole
                            ? 'border-emerald-500/70 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/60'
                            : 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        }`}
                        onClick={() => copyMachine(m)}
                      >
                        คัดลอก
                      </button>
                      <button
                        type="button"
                        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                          isMobileRole
                            ? 'border-sky-500/70 bg-sky-950/40 text-sky-300 hover:bg-sky-900/60'
                            : 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100'
                        }`}
                        onClick={() => editMachine(m)}
                      >
                        แก้ไข
                      </button>
                      <button
                        type="button"
                        className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                          isMobileRole
                            ? 'border-red-500/70 bg-red-950/40 text-red-300 hover:bg-red-900/60'
                            : 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100'
                        }`}
                        onClick={() => removeMachine(m.id)}
                      >
                        ลบ
                      </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'purchaseRequest' && <MachineryPurchaseRequest onCountChange={setMyPendingPurchaseCount} />}

      {tab === 'stock' && <MachineryStock />}

      {tab === 'purchaseSettings' && showPurchaseSettingsTab && <MachineryPurchaseSettings />}

      {tab === 'history' && (
        <section className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>จากวันที่</span>
              <input
                type="date"
                className={`border rounded-lg px-3 py-2 ${
                  isMobileRole ? 'border-slate-300 bg-white text-slate-800' : ''
                }`}
                value={histFrom}
                onChange={(e) => setHistFrom(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>ถึงวันที่</span>
              <input
                type="date"
                className={`border rounded-lg px-3 py-2 ${
                  isMobileRole ? 'border-slate-300 bg-white text-slate-800' : ''
                }`}
                value={histTo}
                onChange={(e) => setHistTo(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>เครื่อง</span>
              <select
                className={`border rounded-lg px-3 py-2 min-w-[10rem] ${
                  isMobileRole ? 'border-slate-300 bg-white text-slate-800' : ''
                }`}
                value={histMachineId}
                onChange={(e) => setHistMachineId(e.target.value)}
              >
                <option value="">ทั้งหมด</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className={`block text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>สถานะ</span>
              <select
                className={`border rounded-lg px-3 py-2 min-w-[10rem] ${
                  isMobileRole ? 'border-slate-300 bg-white text-slate-800' : ''
                }`}
                value={histStatus}
                onChange={(e) => setHistStatus((e.target.value || '') as '' | PrMachineryStatus)}
              >
                <option value="">ทั้งหมด</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {MACHINERY_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {histLoading && (
            <p className={`text-sm ${isMobileRole ? 'text-gray-500' : 'text-gray-500'}`}>กำลังโหลดประวัติ…</p>
          )}

          <h3 className={`font-bold text-base ${isMobileRole ? 'text-gray-800' : 'text-gray-800'}`}>
            สรุปผลการผลิตรายวัน (วันต่อวัน)
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            จำนวนผลิตดึงจากสินค้าในใบงานของแต่ละวัน โดยอ้างอิงสินค้าที่ผูกไว้ในหน้าตั้งค่าเครื่อง
          </p>
          <div
            className={`rounded-xl border shadow-sm ${
              isMobileRole
                ? 'overflow-x-auto border-slate-200 bg-white shadow-slate-100'
                : 'w-full overflow-x-auto border-gray-200 bg-white shadow-md'
            }`}
          >
            <table
              className={
                isMobileRole
                  ? 'w-max min-w-max text-sm'
                  : 'min-w-full w-max border-collapse text-sm text-gray-800'
              }
            >
              <thead
                className={`text-left ${
                  isMobileRole
                    ? 'bg-slate-50 text-gray-700'
                    : 'border-b-2 border-emerald-200/80 bg-gradient-to-r from-gray-50 to-slate-50 text-gray-700'
                }`}
              >
                <tr>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-xs font-bold uppercase tracking-wide'}`}>
                    วันที่
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-xs font-bold uppercase tracking-wide'}`}>
                    เครื่อง
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    ชม.กะ
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    ชม.ทำงาน
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    ชม.หยุด
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    หน่วย
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                    title="จำนวนงานที่จัดสรรให้เครื่อง ÷ กำลังผลิตรวมต่อกะ"
                  >
                    ใช้งาน
                  </th>
                </tr>
              </thead>
              <tbody>
                {historyRowsComputed.map((r, i) => (
                  <tr
                    key={`${r.machine_id}-${r.date}-${i}`}
                    className={
                      isMobileRole
                        ? `border-t border-slate-200 even:bg-slate-50/70`
                        : 'border-b border-gray-100 transition-colors even:bg-slate-50/70 hover:bg-emerald-50/50 last:border-b-0'
                    }
                  >
                    <td
                      className={`font-mono whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-700' : 'px-4 py-3 text-gray-700'}`}
                    >
                      {r.date}
                    </td>
                    <td
                      className={`whitespace-nowrap font-medium ${isMobileRole ? 'px-3 py-2 text-slate-900' : 'px-4 py-3 text-gray-900'}`}
                    >
                      {r.machine_name}
                    </td>
                    <td
                      className={`font-mono tabular-nums text-xs whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-300' : 'px-4 py-3 text-right text-gray-700'}`}
                    >
                      {hoursToHms(r.shift_hours)}
                    </td>
                    <td
                      className={`font-mono tabular-nums text-xs whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-300' : 'px-4 py-3 text-right text-gray-700'}`}
                    >
                      {hoursToHms(r.working_hours)}
                    </td>
                    <td
                      className={`font-mono tabular-nums text-xs whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-300' : 'px-4 py-3 text-right text-gray-700'}`}
                    >
                      {hoursToHms(r.downtime_hours)}
                    </td>
                    <td
                      className={`font-semibold tabular-nums whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-emerald-300' : 'px-4 py-3 text-right text-base text-emerald-700'}`}
                    >
                      {fmtQuantity(r.production_units)}
                    </td>
                    <td
                      className={`font-semibold tabular-nums whitespace-nowrap ${
                        isMobileRole
                          ? `px-3 py-2 ${r.utilization_percent > 100 ? 'text-red-500' : 'text-emerald-700'}`
                          : `px-4 py-3 text-right text-base ${r.utilization_percent > 100 ? 'text-red-600' : 'text-emerald-700'}`
                      }`}
                    >
                      {r.utilization_percent.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className={`font-bold text-base pt-4 ${isMobileRole ? 'text-gray-800' : 'text-gray-800'}`}>
            รอบเครื่องเสีย → กลับมาทำงาน
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            จับเวลาจากเปลี่ยนเป็น “เครื่องเสีย” จนถึงครั้งถัดไปที่เป็น “ทำงาน” (รวมช่วงซ่อม/รอ)
          </p>
          <div
            className={`rounded-xl border shadow-sm ${
              isMobileRole
                ? 'overflow-x-auto border-slate-200 bg-white shadow-slate-100'
                : 'w-full overflow-x-auto border-gray-200 bg-white shadow-md'
            }`}
          >
            <table
              className={
                isMobileRole
                  ? 'w-max min-w-max text-sm'
                  : 'min-w-full w-max border-collapse text-sm text-gray-800'
              }
            >
              <thead
                className={`text-left ${
                  isMobileRole
                    ? 'bg-amber-50 text-gray-700'
                    : 'border-b-2 border-amber-200/80 bg-gradient-to-r from-gray-50 to-amber-50/40 text-gray-700'
                }`}
              >
                <tr>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'w-[18%] px-4 py-3.5 text-xs font-bold uppercase tracking-wide'}`}>
                    เครื่อง
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-xs font-bold uppercase tracking-wide'}`}>
                    เริ่มเครื่องเสีย
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3.5 text-xs font-bold uppercase tracking-wide'}`}>
                    กลับมาทำงาน
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'w-[14%] px-4 py-3.5 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    ระยะเวลา
                  </th>
                </tr>
              </thead>
              <tbody>
                {repairRoundsFiltered.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className={`py-6 text-center text-sm ${isMobileRole ? 'px-3 text-gray-500' : 'px-4 text-gray-500'}`}
                    >
                      ไม่มีรอบเครื่องเสียในช่วงที่เลือก
                    </td>
                  </tr>
                )}
                {repairRoundsFiltered.map((r, idx) => (
                  <tr
                    key={`repair-${idx}-${r.machine_id}-${r.broken_at}`}
                    className={
                      isMobileRole
                        ? `border-t border-slate-200 even:bg-amber-50/40`
                        : 'border-b border-gray-100 transition-colors even:bg-slate-50/70 hover:bg-amber-50/40 last:border-b-0'
                    }
                  >
                    <td
                      className={`whitespace-nowrap font-medium ${isMobileRole ? 'px-3 py-2 text-slate-900' : 'px-4 py-3 text-gray-900'}`}
                    >
                      {r.machine_name}
                    </td>
                    <td
                      className={`font-mono text-xs whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-300' : 'px-4 py-3 text-gray-700'}`}
                    >
                      {new Date(r.broken_at).toLocaleString('th-TH')}
                    </td>
                    <td
                      className={`font-mono text-xs whitespace-nowrap ${isMobileRole ? 'px-3 py-2 text-gray-300' : 'px-4 py-3 text-gray-700'}`}
                    >
                      {r.back_to_work_at ? new Date(r.back_to_work_at).toLocaleString('th-TH') : '— (ยังไม่กลับมาทำงาน)'}
                    </td>
                    <td
                      className={`font-medium whitespace-nowrap tabular-nums ${isMobileRole ? 'px-3 py-2 text-amber-200' : 'px-4 py-3 text-right text-amber-900'}`}
                    >
                      {formatDurationHoursMinutes(r.duration_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className={`font-bold text-base pt-4 ${isMobileRole ? 'text-gray-800' : 'text-gray-800'}`}>
            ช่วงสถานะทุกประเภท (ระยะเวลา)
          </h3>
          <p className={`text-xs ${isMobileRole ? 'text-gray-500' : 'text-gray-600'}`}>
            รวมเครื่องเสีย / กำลังซ่อม / พักเครื่อง / หยุดใช้งาน / ทำงาน — แสดงชม. นาที ต่อช่วง
          </p>
          <div
            className={`rounded-xl border shadow-sm max-h-[28rem] overflow-y-auto ${
              isMobileRole
                ? isTechnicianMobileMachinery
                  ? 'overflow-x-auto border-slate-200 bg-white shadow-slate-100'
                  : 'overflow-x-auto border-slate-200 bg-white shadow-slate-100'
                : 'w-full overflow-x-auto border-gray-200 bg-white shadow-md'
            }`}
          >
            <table
              className={
                isMobileRole
                  ? 'w-max min-w-max text-xs sm:text-sm'
                  : 'min-w-full w-max border-collapse text-sm text-gray-800'
              }
            >
              <thead
                className={`text-left sticky top-0 ${
                  isMobileRole
                    ? isTechnicianMobileMachinery
                      ? 'z-20 border-b border-slate-200 bg-sky-50 text-gray-700 shadow-sm [&_th]:bg-sky-50'
                      : 'z-10 bg-sky-50 text-gray-700 shadow-sm'
                    : 'z-10 border-b border-gray-200 bg-white text-gray-800 shadow-[0_1px_0_0_rgba(0,0,0,0.06)]'
                }`}
              >
                <tr>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'w-[20%] px-4 py-3 text-xs font-bold uppercase tracking-wide'}`}>
                    เครื่อง
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'w-[14%] px-4 py-3 text-xs font-bold uppercase tracking-wide'}`}>
                    สถานะ
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3 text-xs font-bold uppercase tracking-wide'}`}>
                    เริ่ม
                  </th>
                  <th className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'px-4 py-3 text-xs font-bold uppercase tracking-wide'}`}>
                    จบ
                  </th>
                  <th
                    className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-2' : 'w-[12%] px-4 py-3 text-right text-xs font-bold uppercase tracking-wide'}`}
                  >
                    ระยะเวลา
                  </th>
                </tr>
              </thead>
              <tbody>
                {statusSegmentsDisplay.map(({ ev, durationMs }) => {
                  const name = machines.find((x) => x.id === ev.machine_id)?.name || ev.machine_id
                  return (
                    <tr
                      key={ev.id}
                      className={
                        isMobileRole
                          ? `border-t border-slate-200 even:bg-slate-50/70`
                          : 'border-b border-gray-100 transition-colors even:bg-slate-50/70 hover:bg-sky-50/45 last:border-b-0'
                      }
                    >
                      <td
                        className={`whitespace-nowrap font-medium ${isMobileRole ? 'px-3 py-1.5 text-slate-900' : 'px-4 py-2.5 text-gray-900'}`}
                      >
                        {name}
                      </td>
                      <td className={`whitespace-nowrap ${isMobileRole ? 'px-3 py-1.5 text-gray-800' : 'px-4 py-2.5 text-gray-800'}`}>
                        {MACHINERY_STATUS_LABELS[ev.status]}
                      </td>
                      <td
                        className={`font-mono whitespace-nowrap ${isMobileRole ? 'px-3 py-1.5 text-xs sm:text-sm text-gray-300' : 'px-4 py-2.5 text-xs text-gray-700'}`}
                      >
                        {new Date(ev.started_at).toLocaleString('th-TH')}
                      </td>
                      <td
                        className={`font-mono whitespace-nowrap ${isMobileRole ? 'px-3 py-1.5 text-xs sm:text-sm text-gray-300' : 'px-4 py-2.5 text-xs text-gray-700'}`}
                      >
                        {ev.ended_at ? new Date(ev.ended_at).toLocaleString('th-TH') : '—'}
                      </td>
                      <td
                        className={`font-medium whitespace-nowrap tabular-nums ${isMobileRole ? 'px-3 py-1.5 text-sky-200' : 'px-4 py-2.5 text-right text-sky-900'}`}
                      >
                        {formatDurationHoursMinutes(durationMs)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {ConfirmModal}
      </div>
    </div>
  )
}

function normalizeTime(t: string): string {
  if (t.includes(':') && t.split(':').length === 2) {
    return `${t}:00`
  }
  return t
}

/** แสดงตัวเลขเป็นจำนวนเต็ม พร้อมคั่นหลักพันด้วยลูกน้ำ */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('th-TH')
}

function fmtQuantity(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

const HOURS_TO_MS = 3600000

/** แปลงจำนวนชั่วโมง (ทศนิยม) เป็น HH:MM:SS */
function hoursToHms(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return formatMsAsHms(0)
  return formatMsAsHms(Math.round(hours * HOURS_TO_MS))
}
