/**
 * แคตตาล็อก "สถานการณ์" ของกติกาคะแนนปฏิบัติงาน
 *
 * หน้าตั้งค่าให้ผู้ใช้เลือกสถานการณ์เป็นภาษาไทย แล้วโมดูลนี้แปลงเป็น event_code
 * ที่ตัวคิดคะแนน (workScore.ts) รู้จัก — ผู้ตั้งค่าไม่ต้องรู้รหัสเลย
 *
 * ต้องอยู่ sync กับ EVENT ใน workScore.ts เสมอ: รหัสที่ engine ไม่รู้จักจะถูกบันทึกลง
 * ตารางได้ แต่ไม่มีเหตุการณ์ไหน match จึงไม่หักคะแนนเลยแบบเงียบ ๆ
 * (มีเทสใน scoreSituations.test.ts คุมไว้)
 */
import { EVENT } from './workScore'
import type { ScoreRule } from './workScore'

export const GROUP_LABELS: Record<string, string> = {
  attendance: 'การมาทำงาน',
  time_entry: 'การลงเวลา',
  leave: 'การลา',
  ot: 'OT',
  attendance_cumulative: 'ทำผิดซ้ำสะสม',
}

export const groupLabel = (code: string) => GROUP_LABELS[code] ?? code

/**
 * fixed      = event_code ตายตัว ต้องตรงกับ EVENT ใน workScore.ts (ตั้งได้ครั้งเดียว)
 * late       = ขั้นความสาย ตั้งได้หลายขั้น รหัสสร้างจากช่วงนาที (late_16_30)
 * cumulative = ทำผิดซ้ำสะสม ตั้งได้หลายข้อ รหัสสร้างจาก "นับจาก" ที่เลือก
 */
export type SituationKind = 'fixed' | 'late' | 'cumulative'

export interface Situation {
  key: string
  kind: SituationKind
  /** null = สร้างรหัสอัตโนมัติ */
  code: string | null
  group: string
  label: string
  defaultName: string
  hint: string
  /** ป้ายของ threshold_min — undefined = สถานการณ์นี้ไม่ใช้ช่องนี้ */
  minLabel?: string
  minHint?: string
}

export const LATE_KEY = '__late__'
export const CUMULATIVE_KEY = '__cumulative__'

export const SITUATIONS: Situation[] = [
  {
    key: LATE_KEY, kind: 'late', code: null, group: 'attendance',
    label: 'มาสาย (กำหนดช่วงนาทีเอง)',
    defaultName: '',
    hint: 'ตั้งได้หลายขั้น เช่น สาย 1–15 / 16–30 / เกิน 30 — ระบบเลือกขั้นที่ตรงกับจำนวนนาทีที่สายจริง',
  },
  {
    key: EVENT.earlyLeave, kind: 'fixed', code: EVENT.earlyLeave, group: 'attendance',
    label: 'กลับก่อนเวลาเลิกงาน',
    defaultName: 'กลับก่อนเวลา',
    hint: 'ลารายชั่วโมงที่อนุมัติแล้วครอบคลุมช่วงท้ายวัน จะไม่ถูกหัก',
    minLabel: 'ผ่อนผันได้ (นาที)',
    minHint: 'ออกก่อนไม่เกินเท่านี้ ไม่หัก · ว่าง = 1 นาที',
  },
  {
    key: EVENT.missingInCertified, kind: 'fixed', code: EVENT.missingInCertified, group: 'time_entry',
    label: 'ไม่มีเวลาเข้า แต่หัวหน้ารับรองเวลาให้',
    defaultName: 'ไม่มีเวลาเข้า แต่หัวหน้ารับรองเวลาได้',
    hint: 'ตั้งคะแนน 0 = เก็บเป็นประวัติแต่ไม่หักคะแนน',
  },
  {
    key: EVENT.missingInUnproven, kind: 'fixed', code: EVENT.missingInUnproven, group: 'time_entry',
    label: 'ไม่มีเวลาเข้า และพิสูจน์เวลาไม่ได้',
    defaultName: 'ไม่มีเวลาเข้า และพิสูจน์เวลาไม่ได้',
    hint: 'ถ้าอยู่ไม่ถึงเวลาขั้นต่ำที่ตั้งไว้ จะถูกนับเป็น "ขาดงาน" แทนข้อนี้',
    minLabel: 'ต้องอยู่ถึงกี่นาที จึงเชื่อว่ามาทำงานจริง',
    minHint: 'นับจากเวลาเริ่มงานถึงเวลาที่กดออก · ว่าง = 240 นาที',
  },
  {
    key: EVENT.missingOutCertified, kind: 'fixed', code: EVENT.missingOutCertified, group: 'time_entry',
    label: 'ไม่มีเวลาออก แต่หัวหน้ารับรองเวลาให้',
    defaultName: 'ไม่มีเวลาออก แต่หัวหน้ารับรองเวลาได้',
    hint: 'ตั้งคะแนน 0 = เก็บเป็นประวัติแต่ไม่หักคะแนน',
  },
  {
    key: EVENT.missingOutUnproven, kind: 'fixed', code: EVENT.missingOutUnproven, group: 'time_entry',
    label: 'ไม่มีเวลาออก และพิสูจน์เวลาไม่ได้',
    defaultName: 'ไม่มีเวลาออก และพิสูจน์เวลาไม่ได้',
    hint: 'ไม่กดออกงาน และไม่มีใบรับรองจากหัวหน้า',
  },
  {
    key: EVENT.leaveApproved, kind: 'fixed', code: EVENT.leaveApproved, group: 'leave',
    label: 'ลาถูกต้องตามระเบียบ (อนุมัติแล้ว)',
    defaultName: 'ลาถูกต้องตามระเบียบ (อนุมัติแล้ว)',
    hint: 'ตั้ง 0 = ไม่หัก · ตั้งค่าบวกได้ถ้าต้องการให้คะแนนคนที่ลาถูกระเบียบ',
  },
  {
    key: EVENT.leaveLateNotice, kind: 'fixed', code: EVENT.leaveLateNotice, group: 'leave',
    label: 'แจ้งลาหลังเวลาเริ่มงานของวันแรกที่ลา',
    defaultName: 'แจ้งลาหลังเวลาเริ่มงาน',
    hint: 'ใบลาอนุมัติแล้ว แต่ยื่นช้ากว่าเวลาเริ่มงาน',
  },
  {
    key: EVENT.absentPendingLeave, kind: 'fixed', code: EVENT.absentPendingLeave, group: 'leave',
    label: 'ไม่มาทำงาน ทั้งที่ใบลายังไม่อนุมัติ',
    defaultName: 'ไม่มาทำงาน ทั้งที่การลายังไม่อนุมัติ',
    hint: 'มีใบลาในระบบแต่ยังรออนุมัติ แล้วไม่มาทำงาน',
  },
  {
    key: EVENT.absent, kind: 'fixed', code: EVENT.absent, group: 'leave',
    label: 'ขาดงาน (ไม่มา ไม่มีใบลา)',
    defaultName: 'ขาดงาน',
    hint: 'ไม่มีทั้งเวลาเข้า เวลาออก ใบลา และใบรับรอง',
  },
  {
    key: EVENT.otLateRequest, kind: 'fixed', code: EVENT.otLateRequest, group: 'ot',
    label: 'ลืมขอ OT ก่อนเริ่มทำ',
    defaultName: 'ลืมขอ OT ก่อนเริ่มทำ',
    hint: 'ใบขอ OT อนุมัติแล้ว แต่ยื่นหลังเริ่มทำจริง',
  },
  {
    key: EVENT.otUnapproved, kind: 'fixed', code: EVENT.otUnapproved, group: 'ot',
    label: 'ทำ OT โดยไม่ได้รับอนุมัติ',
    defaultName: 'ทำ OT โดยไม่ได้รับอนุมัติ',
    hint: 'มีการกดเริ่ม OT แต่ใบขอยังไม่อนุมัติ หรือถูกปฏิเสธ',
  },
  {
    key: CUMULATIVE_KEY, kind: 'cumulative', code: null, group: 'attendance_cumulative',
    label: 'ทำผิดซ้ำเกินโควตาต่อเดือน',
    defaultName: '',
    hint: 'หักเพิ่มจากกติการายวันที่หักไปแล้ว เมื่อทำผิดเรื่องเดิมซ้ำเกินจำนวนครั้งที่ยอมให้',
  },
]

/** ตัวเลือก "นับจาก" ของกติกาสะสม — ค่าที่เก็บคือ counts_event_prefix */
export const COUNT_SOURCES: Array<{ prefix: string; label: string; codeBase: string }> = [
  { prefix: 'late_', label: 'การมาสาย (ทุกขั้น)', codeBase: 'late' },
  { prefix: 'absent', label: 'การขาดงาน (รวมไม่มาเพราะใบลายังไม่อนุมัติ)', codeBase: 'absent' },
  { prefix: EVENT.earlyLeave, label: 'การกลับก่อนเวลา', codeBase: 'early_leave' },
  { prefix: 'missing_in_', label: 'การไม่มีเวลาเข้า', codeBase: 'missing_in' },
  { prefix: 'missing_out_', label: 'การไม่มีเวลาออก', codeBase: 'missing_out' },
  { prefix: EVENT.leaveLateNotice, label: 'การแจ้งลาหลังเวลาเริ่มงาน', codeBase: 'leave_late_notice' },
  { prefix: 'ot_', label: 'ความผิดเกี่ยวกับ OT', codeBase: 'ot' },
]

export const situationByKey = (key: string) => SITUATIONS.find((s) => s.key === key) ?? SITUATIONS[0]

/** กติกาที่มีอยู่ → สถานการณ์ · null = รหัสที่ตัวคิดคะแนนไม่รู้จัก (กติกาจะไม่ทำงาน) */
export function situationOfRule(r: ScoreRule): Situation | null {
  if (r.counts_event_prefix) return situationByKey(CUMULATIVE_KEY)
  if (r.group_code === 'attendance' && r.event_code.startsWith('late_')) return situationByKey(LATE_KEY)
  return SITUATIONS.find((s) => s.code === r.event_code) ?? null
}

/** รหัสของขั้นความสาย — สร้างจากช่วงนาทีเพื่อให้อ่านออกและไม่ซ้ำกันเอง */
export const lateCode = (min: string, max: string) =>
  `late_${Number(min || 0)}_${max.trim() === '' ? 'up' : Number(max)}`

/** รหัสของกติกาสะสม — เติมเลขท้ายถ้าซ้ำ เพื่อให้ตั้งหลายขั้นจากฐานเดียวกันได้ */
export function cumulativeCode(prefix: string, taken: Set<string>): string {
  const base = `${COUNT_SOURCES.find((s) => s.prefix === prefix)?.codeBase ?? 'event'}_repeat`
  if (!taken.has(base)) return base
  for (let i = 2; i < 50; i++) {
    if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
  }
  return `${base}_${Date.now()}`
}
