import { supabase } from './supabase'

export type PrMachineryStatus =
  | 'working'
  | 'broken'
  | 'repairing'
  | 'idle'
  | 'decommissioned'
  | 'power_off'

export interface MachineryMachine {
  id: string
  name: string
  location: string | null
  image_url: string | null
  work_start: string
  work_end: string
  capacity_units_per_hour: number
  current_status: PrMachineryStatus
  status_changed_at: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface MachineryEvent {
  id: string
  machine_id: string
  status: PrMachineryStatus
  started_at: string
  ended_at: string | null
  note: string | null
  created_by: string | null
  created_at: string
}

export const MACHINERY_STATUS_LABELS: Record<PrMachineryStatus, string> = {
  working: 'ทำงาน',
  broken: 'เครื่องเสีย',
  repairing: 'กำลังซ่อม',
  idle: 'พักเครื่อง',
  decommissioned: 'หยุดใช้งาน',
  power_off: 'ปิดเครื่อง',
}

export async function fetchMachines(): Promise<MachineryMachine[]> {
  const { data, error } = await supabase
    .from('pr_machinery_machines')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return (data || []) as MachineryMachine[]
}

export async function upsertMachine(
  row: Partial<MachineryMachine> & { name: string },
): Promise<MachineryMachine> {
  const payload: Record<string, unknown> = {
    name: row.name,
    location: row.location ?? null,
    work_start: row.work_start ?? '08:00:00',
    work_end: row.work_end ?? '17:00:00',
    capacity_units_per_hour: row.capacity_units_per_hour ?? 0,
    sort_order: row.sort_order ?? 0,
  }
  if ('image_url' in row) {
    payload.image_url = row.image_url
  }
  if (row.id) {
    const { data, error } = await supabase
      .from('pr_machinery_machines')
      .update(payload)
      .eq('id', row.id)
      .select()
      .single()
    if (error) throw error
    return data as MachineryMachine
  }
  const { data, error } = await supabase
    .from('pr_machinery_machines')
    .insert({
      ...payload,
      image_url: 'image_url' in row ? row.image_url : null,
      current_status: 'working',
      status_changed_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  const machine = data as MachineryMachine
  await insertStatusEvent({
    machine_id: machine.id,
    status: 'working',
    started_at: new Date().toISOString(),
    ended_at: null,
  })
  return machine
}

export async function deleteMachine(id: string): Promise<void> {
  const { error } = await supabase.from('pr_machinery_machines').delete().eq('id', id)
  if (error) throw error
}

const MACHINERY_PHOTOS_BUCKET = 'machinery-photos'

/** อัปโหลดรูปเครื่อง → public URL (บันทึกใน image_url ผ่าน upsertMachine) */
export async function uploadMachineryPhoto(machineId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const safe = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? ext : 'jpg'
  const path = `${machineId}/${Date.now()}.${safe}`
  const { error } = await supabase.storage.from(MACHINERY_PHOTOS_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw error
  const { data } = supabase.storage.from(MACHINERY_PHOTOS_BUCKET).getPublicUrl(path)
  return data.publicUrl
}

async function insertStatusEvent(ev: {
  machine_id: string
  status: PrMachineryStatus
  started_at: string
  ended_at: string | null
  note?: string | null
}): Promise<void> {
  const { data: u } = await supabase.auth.getUser()
  const { error } = await supabase.from('pr_machinery_status_events').insert({
    machine_id: ev.machine_id,
    status: ev.status,
    started_at: ev.started_at,
    ended_at: ev.ended_at,
    note: ev.note ?? null,
    created_by: u?.user?.id ?? null,
  })
  if (error) throw error
}

/** ปิดช่วง event ที่ยังไม่มี ended_at */
export async function closeOpenEvents(machineId: string, endAt: string): Promise<void> {
  const { error } = await supabase
    .from('pr_machinery_status_events')
    .update({ ended_at: endAt })
    .eq('machine_id', machineId)
    .is('ended_at', null)
  if (error) throw error
}

export async function changeMachineStatus(
  machineId: string,
  status: PrMachineryStatus,
  note?: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  await closeOpenEvents(machineId, now)
  const { data: u } = await supabase.auth.getUser()
  const { error: upErr } = await supabase
    .from('pr_machinery_machines')
    .update({
      current_status: status,
      status_changed_at: now,
    })
    .eq('id', machineId)
  if (upErr) throw upErr
  const { error: insErr } = await supabase.from('pr_machinery_status_events').insert({
    machine_id: machineId,
    status,
    started_at: now,
    ended_at: null,
    note: note ?? null,
    created_by: u?.user?.id ?? null,
  })
  if (insErr) throw insErr
}

/** ดึง events ที่ทับช่วง [fromIso, toIso) — รวมช่วงที่เริ่มก่อน from แต่ยังไม่จบ */
export async function fetchEventsOverlappingRange(
  fromIso: string,
  toIso: string,
  machineId?: string | null,
): Promise<MachineryEvent[]> {
  let q = supabase
    .from('pr_machinery_status_events')
    .select('*')
    .lt('started_at', toIso)
    .or(`ended_at.is.null,ended_at.gt.${fromIso}`)
    .order('started_at', { ascending: true })
  if (machineId) {
    q = q.eq('machine_id', machineId)
  }
  const { data, error } = await q
  if (error) throw error
  return (data || []) as MachineryEvent[]
}

/** ขอบเขตกะในวันที่ (local) — ถ้า work_end <= work_start ถือว่าข้ามวัน */
export function getShiftBoundsForDate(
  day: Date,
  workStart: string,
  workEnd: string,
): { start: Date; end: Date } {
  const y = day.getFullYear()
  const m = day.getMonth()
  const d = day.getDate()
  const parseT = (t: string) => {
    const p = t.split(':').map((x) => parseInt(x, 10))
    return { h: p[0] || 0, min: p[1] || 0, s: p[2] || 0 }
  }
  const a = parseT(workStart)
  const b = parseT(workEnd)
  const start = new Date(y, m, d, a.h, a.min, a.s, 0)
  let end = new Date(y, m, d, b.h, b.min, b.s, 0)
  if (end.getTime() <= start.getTime()) {
    end = new Date(y, m, d + 1, b.h, b.min, b.s, 0)
  }
  return { start, end }
}

function overlapMs(segStart: Date, segEnd: Date, winStart: Date, winEnd: Date): number {
  const s = Math.max(segStart.getTime(), winStart.getTime())
  const e = Math.min(segEnd.getTime(), winEnd.getTime())
  return Math.max(0, e - s)
}

const MS_PER_HOUR = 3600000
const MS_PER_MIN = 60000

/** ความยาวกะในวันที่ (ms) — จากเริ่มกะถึงสิ้นสุดกะ */
export function computeShiftDurationMsForDay(machine: MachineryMachine, day: Date): number {
  const { start, end } = getShiftBoundsForDate(day, machine.work_start, machine.work_end)
  return Math.max(0, end.getTime() - start.getTime())
}

/**
 * จับเวลาในกะ (นาฬิกาเวลา): ตั้งแต่เริ่มกะ ถึง min(ตอนนี้, สิ้นสุดกะ)
 * ก่อนเริ่มกะ = 0; หลังสิ้นสุดกะ = เต็มความยาวกะ (หยุดที่ปลายกะ)
 */
export function computeShiftElapsedWallClockMs(machine: MachineryMachine, now: Date): number {
  const { start, end } = getShiftBoundsForDate(now, machine.work_start, machine.work_end)
  const t = now.getTime()
  if (t < start.getTime()) return 0
  const cap = Math.min(t, end.getTime())
  return Math.max(0, cap - start.getTime())
}

/** เวลาสะสม “สถานะทำงาน” ในกะของวันปฏิทินวันนี้ (ms) */
export function computeWorkingTimeInShiftMsToday(
  machine: MachineryMachine,
  events: MachineryEvent[],
  now: Date = new Date(),
): number {
  return Math.round(computeWorkingHoursToday(machine, events, now) * MS_PER_HOUR)
}

/** แสดงระยะเวลาเป็น HH:MM:SS */
export function formatMsAsHms(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const hh = Math.floor(totalSec / 3600)
  const mm = Math.floor((totalSec % 3600) / 60)
  const ss = totalSec % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** เริ่มต้นวันปฏิทิน (เวลา local) */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

/** ชั่วโมงที่สถานะ = working ภายในช่วง [winStart, winEnd] */
export function computeWorkingHoursInShift(
  events: MachineryEvent[],
  shiftStart: Date,
  shiftEnd: Date,
  nowCap: Date,
): number {
  const winEnd = new Date(Math.min(shiftEnd.getTime(), nowCap.getTime()))
  const winStart = shiftStart
  if (winEnd <= winStart) return 0

  let ms = 0
  for (const ev of events) {
    const s = new Date(ev.started_at)
    const e = ev.ended_at ? new Date(ev.ended_at) : nowCap
    if (ev.status !== 'working') continue
    ms += overlapMs(s, e, winStart, winEnd)
  }
  return ms / MS_PER_HOUR
}

/** ชั่วโมงกะต่อวัน (จาก work_start และ work_end ของวันปฏิทินที่ระบุ) */
export function computeShiftHours(machine: MachineryMachine, day: Date = new Date()): number {
  const { start, end } = getShiftBoundsForDate(day, machine.work_start, machine.work_end)
  return Math.max(0, (end.getTime() - start.getTime()) / MS_PER_HOUR)
}

/** กำลังผลิตรวมต่อกะ (หน่วย) = ชม.กะ × หน่วย/ชม. */
export function totalProductionCapacityPerShift(machine: MachineryMachine): number {
  return computeShiftHours(machine) * Number(machine.capacity_units_per_hour)
}

export interface DailySummaryRow {
  date: string
  machine_id: string
  machine_name: string
  shift_hours: number
  working_hours: number
  effective_units: number
  downtime_hours: number
}

/** สรุปตัวเลขรายวันปฏิทิน (ตัดกะกับวัน 00:00–23:59) — ใช้ร่วมกันทั้งมอนิเตอร์และรายงานรายวัน */
export interface MachineDayMetrics extends DailySummaryRow {
  winStart: Date
  winEnd: Date
}

export function getMachineDayMetrics(
  machine: MachineryMachine,
  day: Date,
  events: MachineryEvent[],
  now: Date = new Date(),
): MachineDayMetrics {
  const { start, end } = getShiftBoundsForDate(day, machine.work_start, machine.work_end)
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0)
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999)
  const isToday =
    day.getFullYear() === now.getFullYear() &&
    day.getMonth() === now.getMonth() &&
    day.getDate() === now.getDate()

  let winStart = new Date(Math.max(start.getTime(), dayStart.getTime()))
  let winEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()))
  if (isToday) {
    winEnd = new Date(Math.min(winEnd.getTime(), now.getTime()))
  }

  const shiftMs = Math.max(0, end.getTime() - start.getTime())
  const shiftHours = shiftMs / MS_PER_HOUR

  let workingMs = 0
  let nonWorkingMs = 0
  if (winEnd > winStart) {
    const evs = events.filter((e) => e.machine_id === machine.id)
    const cap = isToday ? now : dayEnd
    for (const ev of evs) {
      const s = new Date(ev.started_at)
      const e = ev.ended_at ? new Date(ev.ended_at) : cap
      const seg = overlapMs(s, e, winStart, winEnd)
      if (seg <= 0) continue
      if (ev.status === 'working') workingMs += seg
      else nonWorkingMs += seg
    }
  }

  const working_hours = workingMs / MS_PER_HOUR
  const downtime_hours = nonWorkingMs / MS_PER_HOUR
  const effective_units = working_hours * Number(machine.capacity_units_per_hour)

  return {
    date: day.toISOString().slice(0, 10),
    machine_id: machine.id,
    machine_name: machine.name,
    shift_hours: shiftHours,
    working_hours,
    effective_units,
    downtime_hours,
    winStart,
    winEnd,
  }
}

/** ชม. ทำงานจริง “วันปฏิทินวันนี้” ภายในหน้าต่างกะ∩วัน (สถานะ working) */
export function computeWorkingHoursToday(
  machine: MachineryMachine,
  events: MachineryEvent[],
  now: Date = new Date(),
): number {
  return getMachineDayMetrics(machine, startOfLocalDay(now), events, now).working_hours
}

/** หน่วยผลิตโดยประมาณวันนี้ (วันปฏิทิน) */
export function computeEffectiveUnitsToday(
  machine: MachineryMachine,
  events: MachineryEvent[],
  now: Date = new Date(),
): number {
  return getMachineDayMetrics(machine, startOfLocalDay(now), events, now).effective_units
}

/** ชม.กะรวมของวันปฏิทินวันนี้ (จากการตั้งค่าเริ่ม–สิ้นสุด) — ใช้คู่กับมอนิเตอร์ */
export function computeShiftHoursToday(machine: MachineryMachine, now: Date = new Date()): number {
  return getMachineDayMetrics(machine, startOfLocalDay(now), [], now).shift_hours
}

export function summarizeDayForMachine(
  machine: MachineryMachine,
  day: Date,
  events: MachineryEvent[],
): DailySummaryRow {
  const m = getMachineDayMetrics(machine, day, events, new Date())
  const { winStart: _a, winEnd: _b, ...row } = m
  return row
}

/** ระยะเวลาของ event หนึ่งรายการ (ถ้ายังไม่จบ ใช้ nowRef) */
export function computeEventDurationMs(ev: MachineryEvent, nowRef: Date = new Date()): number {
  const s = new Date(ev.started_at).getTime()
  const e = ev.ended_at ? new Date(ev.ended_at).getTime() : nowRef.getTime()
  return Math.max(0, e - s)
}

/** แสดงเป็น "ชม. นาที" / "ชม.:นาที" */
export function formatDurationHoursMinutes(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return '—'
  const totalMin = Math.round(ms / MS_PER_MIN)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h} ชม. ${String(m).padStart(2, '0')} นาที`
}

/** รอบ “เครื่องเสีย → กลับมาทำงาน” (จากเวลาเริ่ม broken ถึงเวลาเริ่ม working ครั้งถัดไป) */
export interface RepairRoundRow {
  machine_id: string
  machine_name: string
  broken_at: string
  back_to_work_at: string | null
  duration_ms: number
}

export function computeRepairRounds(
  machines: MachineryMachine[],
  events: MachineryEvent[],
  nowRef: Date = new Date(),
): RepairRoundRow[] {
  const byMachine = new Map<string, MachineryMachine>()
  for (const m of machines) byMachine.set(m.id, m)

  const rounds: RepairRoundRow[] = []
  const evs = [...events].sort(
    (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
  )

  for (const ev of evs) {
    if (ev.status !== 'broken') continue
    const brokeAt = new Date(ev.started_at).getTime()
    let nextWork: MachineryEvent | undefined
    for (const e2 of evs) {
      if (e2.machine_id !== ev.machine_id) continue
      const t2 = new Date(e2.started_at).getTime()
      if (t2 <= brokeAt) continue
      if (e2.status === 'working') {
        nextWork = e2
        break
      }
    }
    const mc = byMachine.get(ev.machine_id)
    if (!mc) continue
    if (nextWork) {
      const back = new Date(nextWork.started_at).getTime()
      rounds.push({
        machine_id: ev.machine_id,
        machine_name: mc.name,
        broken_at: ev.started_at,
        back_to_work_at: nextWork.started_at,
        duration_ms: back - brokeAt,
      })
    } else {
      rounds.push({
        machine_id: ev.machine_id,
        machine_name: mc.name,
        broken_at: ev.started_at,
        back_to_work_at: null,
        duration_ms: Math.max(0, nowRef.getTime() - brokeAt),
      })
    }
  }

  return rounds.sort((a, b) => new Date(b.broken_at).getTime() - new Date(a.broken_at).getTime())
}
