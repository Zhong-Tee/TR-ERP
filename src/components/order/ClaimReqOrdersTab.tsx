import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import { fetchClaimTypeLabelMap, claimTypeLabel } from '../../lib/claimTypeLabels'
import { loadClaimCompareBundle } from '../../lib/claimRequestCompareLoad'
import Modal from '../ui/Modal'
import ClaimRequestComparePanel from '../claim/ClaimRequestComparePanel'
import ClaimEditModal from '../claim/ClaimEditModal'
import VerificationResultModal, { type AmountStatus } from './VerificationResultModal'
import { verifyAndSaveClaimSlips, type ClaimSlipVerifyResult } from '../../lib/claimSlipVerification'
import { parseAddressText } from '../../lib/thaiAddress'
import type { ClaimCompareDetail, RefOrderDetail } from '../claim/claimCompareShared'
import { fmtMoney, mobilePhoneFromBillingDetails } from '../claim/claimCompareShared'

type ClaimRow = {
  id: string
  status: string
  created_at: string
  reviewed_at: string | null
  claim_type: string
  ref_snapshot: { bill_no?: string; total_amount?: number } | null
  created_claim_order_id: string | null
  ref_order_id?: string
  submitted_by?: string | null
  supporting_url?: string | null
  claim_description?: string | null
  proposed_snapshot?: { order?: Record<string, unknown>; items?: unknown[] } | null
}

/** ข้อมูลบิลอ้างอิง + ผู้ส่งคำขอ ที่แสดงร่วมกันทุกแท็บ (รออนุมัติ/อนุมัติแล้ว/ปฏิเสธ) */
type ClaimRowCommonInfo = {
  submitter: { username?: string | null } | null
  /** วันที่สร้างบิลอ้างอิง (created_at หรือ entry_date) */
  ref_bill_date_label: string
  /** ผู้สร้างบิลแรกที่เป็นบิลอ้างอิง */
  ref_admin_user: string | null
  ref_customer_name: string | null
  ref_customer_address: string | null
  ref_mobile_phone: string | null
  ref_channel_order_no: string | null
  packing_video_url: string | null
}

/** แถวรออนุมัติ — ขยายข้อมูลสำหรับตาราง */
type PendingClaimRow = ClaimRow & {
  ref_order_id: string
  submitted_by: string | null
  supporting_url?: string | null
  claim_description?: string | null
} & ClaimRowCommonInfo

/** แถวอนุมัติแล้ว — ขยายข้อมูลสำหรับตาราง */
type ApprovedClaimRow = ClaimRow & ClaimRowCommonInfo

/** role ที่แก้ไขบิลเคลม (pending) ได้ — ชุดเดียวกับที่ส่งคำขอเคลมได้ */
const CAN_EDIT_CLAIM_ROLES = ['superadmin', 'admin', 'sales-tr', 'sales-pump', 'qc_order', 'account']

/** แถวปฏิเสธโดยบัญชี — อ่านอย่างเดียว */
type RejectedClaimRow = {
  id: string
  created_at: string
  reviewed_at: string | null
  claim_type: string
  ref_snapshot: { bill_no?: string; total_amount?: number } | null
  proposed_snapshot?: { order?: Record<string, unknown>; items?: unknown[] } | null
  ref_order_id: string
  submitted_by: string | null
  supporting_url?: string | null
  claim_description?: string | null
  rejected_reason?: string | null
} & ClaimRowCommonInfo

function externalUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) return s
  return `https://${s}`
}

/** รองรับค่าจาก Supabase ที่อาจไม่ใช่ string ตรงๆ */
function supportingHref(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).replace(/\u200b/g, '').trim()
  return externalUrlOrNull(s || undefined)
}

/** ลิงก์หลักฐาน — ใช้ <a> แทนปุ่ม+window.open เพื่อให้คลิกได้เสถียรและไม่โดนบล็อกแท็บใหม่ */
function EvidenceLinkCell({ supportingUrl }: { supportingUrl: unknown }) {
  const href = supportingHref(supportingUrl)
  if (!href) {
    return (
      <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 text-gray-300" title="ไม่มีลิงก์หลักฐาน">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></svg>
      </span>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="เปิดลิงก์หลักฐานในแท็บใหม่"
      aria-label="เปิดลิงก์หลักฐาน"
      className="relative z-[1] inline-flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1"
      onClick={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></svg>
    </a>
  )
}

function submitterDisplay(submittedBy: string | null, submitter: { username?: string | null } | null): string {
  const u = submitter?.username?.trim()
  if (u) return u
  if (submittedBy) return submittedBy.slice(0, 8) + '…'
  return '–'
}

/** แสดงวันที่บรรทัดแรก เวลาบรรทัดที่สอง — รับข้อความรูปแบบ "วันที่ เวลา" */
function DateTimeCellText({ text }: { text: string }) {
  const s = (text || '').trim()
  const i = s.indexOf(' ')
  const datePart = i === -1 ? s : s.slice(0, i)
  const timePart = i === -1 ? '' : s.slice(i + 1)
  if (!datePart) return <>–</>
  return (
    <div className="leading-tight">
      <div>{datePart}</div>
      {timePart && <div className="text-xs text-gray-500">{timePart}</div>}
    </div>
  )
}

/** ปุ่มวิดีโอแพคสินค้า (ของบิลอ้างอิง) */
function VideoLinkCell({ url }: { url: string | null }) {
  return (
    <button
      type="button"
      disabled={!url}
      aria-label={url ? 'เปิดวิดีโอแพคสินค้า' : 'ไม่มีวิดีโอแพคสินค้า'}
      title={url ? 'เปิดวิดีโอแพคในแท็บใหม่' : 'ยังไม่พบวิดีโอของบิลนี้'}
      onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-300"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2" /><path strokeLinecap="round" strokeLinejoin="round" d="m17 10 4-2v8l-4-2" /></svg>
    </button>
  )
}

/** หัวคอลัมน์ข้อมูลบิลอ้างอิง/ผู้สร้าง — ใช้ร่วมทุกแท็บ (เรียงเหมือนหน้าอนุมัติเคลมของบัญชี) */
function ClaimInfoHeadCells() {
  return (
    <>
      <th className="text-left p-3 whitespace-nowrap">วันที่สร้างบิล</th>
      <th className="text-left p-3 whitespace-nowrap" title="ผู้สร้างบิลแรกที่เป็นบิลอ้างอิงของเคลมนี้">
        ผู้สร้างบิล
      </th>
      <th className="text-left p-3 whitespace-nowrap">ผู้สร้างบิลเคลม</th>
      <th className="text-left p-3 whitespace-nowrap">ชื่อลูกค้า</th>
      <th className="text-left p-3 whitespace-nowrap">ที่อยู่จัดส่ง</th>
      <th className="text-left p-3 whitespace-nowrap">เบอร์โทร</th>
      <th className="text-left p-3 whitespace-nowrap">เลขคำสั่งซื้อ</th>
    </>
  )
}

function ClaimInfoCells({ row, submittedBy }: { row: ClaimRowCommonInfo; submittedBy: string | null }) {
  return (
    <>
      <td className="p-3 whitespace-nowrap">
        <DateTimeCellText text={row.ref_bill_date_label} />
      </td>
      <td className="p-3 whitespace-nowrap">{row.ref_admin_user?.trim() || '–'}</td>
      <td className="p-3 whitespace-nowrap">{submitterDisplay(submittedBy, row.submitter)}</td>
      <td className="p-3 max-w-[160px] truncate" title={row.ref_customer_name || ''}>
        {row.ref_customer_name?.trim() || '–'}
      </td>
      <td className="p-3 max-w-[200px] truncate align-top" title={row.ref_customer_address || ''}>
        {row.ref_customer_address?.trim() || '–'}
      </td>
      <td className="p-3 whitespace-nowrap">{row.ref_mobile_phone?.trim() || '–'}</td>
      <td className="p-3 whitespace-nowrap font-mono text-xs">{row.ref_channel_order_no?.trim() || '–'}</td>
    </>
  )
}

/** หัวคอลัมน์ยอดเงิน — ยอดเดิม / ยอดบิลเคลม / ค่าส่ง */
function ClaimMoneyHeadCells() {
  return (
    <>
      <th className="text-right p-3 whitespace-nowrap">ยอดเดิม</th>
      <th className="text-right p-3 whitespace-nowrap">ยอดบิลเคลม</th>
      <th className="text-right p-3 whitespace-nowrap">ค่าส่ง</th>
    </>
  )
}

function ClaimMoneyCells({
  refSnapshot,
  proposedSnapshot,
}: {
  refSnapshot: { total_amount?: number } | null
  proposedSnapshot?: { order?: Record<string, unknown>; items?: unknown[] } | null
}) {
  return (
    <>
      <td className="p-3 text-right whitespace-nowrap tabular-nums">
        {fmtMoney(Number(refSnapshot?.total_amount) || 0)}
      </td>
      <td className="p-3 text-right whitespace-nowrap tabular-nums font-semibold">
        {fmtMoney(Number(proposedSnapshot?.order?.price) || 0)}
      </td>
      <td className="p-3 text-right whitespace-nowrap tabular-nums">
        {fmtMoney(Number(proposedSnapshot?.order?.shipping_cost) || 0)}
      </td>
    </>
  )
}

function formatRefBillDate(entryDate: string | null | undefined, createdAt: string | null | undefined): string {
  // ใช้ created_at ก่อน (timestamp มีเวลาสร้างจริง — ตรงกับหน้ารายละเอียดบิล) แล้วค่อย fallback entry_date
  const raw = (createdAt && String(createdAt).trim()) || (entryDate && String(entryDate).trim()) || ''
  if (!raw) return '–'
  // entry_date เป็นวันที่ล้วน (YYYY-MM-DD) — parse แบบ local และแสดงเฉพาะวันที่ กันเวลาปลอม 07:00 จาก UTC shift
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  const d = isDateOnly ? new Date(raw + 'T00:00:00') : new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return isDateOnly ? d.toLocaleDateString('th-TH') : d.toLocaleString('th-TH')
}

/** กรองตามวันที่ส่งคำขอ (or_claim_requests.created_at) */
function claimCreatedAtInRange(createdAt: string, dateFrom: string, dateTo: string): boolean {
  const df = dateFrom.trim()
  const dt = dateTo.trim()
  if (!df && !dt) return true
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return true
  if (df) {
    const start = new Date(df + 'T00:00:00').getTime()
    if (t < start) return false
  }
  if (dt) {
    const end = new Date(dt + 'T23:59:59.999').getTime()
    if (t > end) return false
  }
  return true
}

function matchesReqSearch(q: string, parts: (string | null | undefined)[]): boolean {
  const qq = q.trim().toLowerCase()
  if (!qq) return true
  return parts.some((p) => String(p ?? '').toLowerCase().includes(qq))
}

/** ร่างเคลม (status draft) ของผู้ใช้เอง — แก้ต่อ/ส่งอนุมัติ/ลบได้ */
type DraftClaimRow = {
  id: string
  created_at: string
  claim_type: string
  ref_order_id: string
  ref_snapshot: { bill_no?: string; total_amount?: number } | null
  proposed_snapshot: { order?: Record<string, unknown>; items?: unknown[] } | null
  supporting_url: string | null
  claim_description: string | null
}

type ReqOrderRow = {
  id: string
  bill_no: string
  recipient_name: string | null
  customer_address: string
  billing_details: { mobile_phone?: string | null } | null
  claim_shipping_confirmed_at: string | null
  channel_code: string
  admin_user: string
  status: string
  total_amount: number | null
}

const CAN_CONFIRM_ROLES = ['superadmin', 'admin', 'sales-tr', 'sales-pump'] as const

function defaultReqFilterDateFrom(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
}

function defaultReqFilterDateTo(): string {
  return new Date().toISOString().split('T')[0]
}

interface ClaimReqOrdersTabProps {
  userRole: string | undefined
  /** กรอง admin_user (sales-tr สมาชิก / pump owner) */
  narrowAdminUser?: string
  refreshTrigger?: number
  /** จำนวนรออนุมัติ, รอกรอกที่อยู่ REQ, จำนวนที่ปฏิเสธ (ในขอบเขตผู้ใช้) */
  onCountsChange?: (pendingApproval: number, needShipping: number, rejectedCount: number) => void
}

export default function ClaimReqOrdersTab({
  userRole,
  narrowAdminUser,
  refreshTrigger = 0,
  onCountsChange,
}: ClaimReqOrdersTabProps) {
  const [loading, setLoading] = useState(true)
  const [pendingClaims, setPendingClaims] = useState<PendingClaimRow[]>([])
  const [rejectedClaims, setRejectedClaims] = useState<RejectedClaimRow[]>([])
  const [approvedClaims, setApprovedClaims] = useState<ApprovedClaimRow[]>([])
  const [draftClaims, setDraftClaims] = useState<DraftClaimRow[]>([])
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null)
  const [claimLabels, setClaimLabels] = useState<Record<string, string>>({})
  const [orderById, setOrderById] = useState<Record<string, ReqOrderRow>>({})
  /** คำขอรออนุมัติที่เป็นเคลมซ้ำ: ref_order_id → เลขบิล REQ ล่าสุดที่อนุมัติแล้ว */
  const [latestReqBillByRefOrderId, setLatestReqBillByRefOrderId] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [modalOrder, setModalOrder] = useState<ReqOrderRow | null>(null)
  const [modalClaim, setModalClaim] = useState<ClaimRow | null>(null)
  const [recipientName, setRecipientName] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [mobilePhone, setMobilePhone] = useState('')
  const [autoFillAddressText, setAutoFillAddressText] = useState('')
  const [autoFillAddressLoading, setAutoFillAddressLoading] = useState(false)
  /** สลิปโอนที่แนบตอนยืนยันที่อยู่ — ตรวจผ่าน API แล้วปรับสถานะตามผล */
  const [confirmSlipFiles, setConfirmSlipFiles] = useState<File[]>([])
  const [confirmSlipPreviews, setConfirmSlipPreviews] = useState<{ url: string; name: string }[]>([])
  const [expandedSlipPreview, setExpandedSlipPreview] = useState<{ url: string; name: string } | null>(null)
  const [claimVerify, setClaimVerify] = useState<{
    open: boolean
    type: 'success' | 'failed'
    accountMatch: boolean | null
    bankCodeMatch: boolean | null
    amountStatus: AmountStatus
    orderAmount: number
    totalAmount: number
    errors: string[]
    statusMessage: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [reqSubTab, setReqSubTab] = useState<'pending' | 'approved' | 'rejected' | 'draft'>('pending')
  /** กรองตามวันที่ส่งคำขอ (created_at ของคำขอ) — ค่าเริ่มต้น วันที่ 1 ของเดือน ถึง วันนี้ */
  const [reqFilterDateFrom, setReqFilterDateFrom] = useState(defaultReqFilterDateFrom)
  const [reqFilterDateTo, setReqFilterDateTo] = useState(defaultReqFilterDateTo)
  const [reqFilterSearch, setReqFilterSearch] = useState('')
  const [channelLabels, setChannelLabels] = useState<Record<string, string>>({})
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareDetail, setCompareDetail] = useState<ClaimCompareDetail | null>(null)
  const [compareRefOrder, setCompareRefOrder] = useState<RefOrderDetail | null>(null)
  const [compareLatestPrior, setCompareLatestPrior] = useState<string | null>(null)
  const [compareApprovedResult, setCompareApprovedResult] = useState<string | null>(null)
  /** แก้ไขบิลเคลม (เฉพาะคำขอสถานะ pending) */
  const [editOpen, setEditOpen] = useState(false)

  const canConfirm = CAN_CONFIRM_ROLES.includes(userRole as (typeof CAN_CONFIRM_ROLES)[number])
  const canEditClaim = CAN_EDIT_CLAIM_ROLES.includes(userRole || '')

  /** เปิดดูแล้ว (อนุมัติแล้ว/ปฏิเสธ) — จำต่อผู้ใช้ใน localStorage เพื่อให้ badge ลดลงเมื่อคลิกดู */
  const { user } = useAuthContext()
  const seenStorageKey = `claimReqSeenV1:${user?.id || 'anon'}`
  const [seenKeys, setSeenKeys] = useState<Set<string>>(new Set())
  useEffect(() => {
    try {
      const raw = localStorage.getItem(seenStorageKey)
      setSeenKeys(new Set(raw ? (JSON.parse(raw) as string[]) : []))
    } catch {
      setSeenKeys(new Set())
    }
  }, [seenStorageKey])
  const markSeen = useCallback(
    (id: string, status: 'approved' | 'rejected') => {
      const key = `${id}|${status}`
      setSeenKeys((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        try {
          localStorage.setItem(seenStorageKey, JSON.stringify([...next].slice(-800)))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [seenStorageKey],
  )

  const onCountsChangeRef = useRef(onCountsChange)
  onCountsChangeRef.current = onCountsChange

  useEffect(() => {
    void fetchClaimTypeLabelMap().then(setClaimLabels)
  }, [])

  useEffect(() => {
    void supabase
      .from('channels')
      .select('channel_code, channel_name')
      .then(({ data }) => {
        setChannelLabels(Object.fromEntries((data || []).map((c) => [c.channel_code, c.channel_name])))
      })
  }, [])

  async function openClaimCompare(requestId: string) {
    setCompareOpen(true)
    setCompareLoading(true)
    setCompareDetail(null)
    setCompareRefOrder(null)
    setCompareLatestPrior(null)
    setCompareApprovedResult(null)
    try {
      const b = await loadClaimCompareBundle(supabase, requestId)
      setCompareDetail(b.detail)
      setCompareRefOrder(b.refOrder)
      setCompareLatestPrior(b.latestPriorReqBillNo)
      setCompareApprovedResult(b.approvedResultBillNo)
    } catch (e: unknown) {
      console.error('openClaimCompare', e)
      alert('โหลดรายละเอียดไม่สำเร็จ: ' + ((e as Error)?.message || String(e)))
      setCompareOpen(false)
    } finally {
      setCompareLoading(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: pending, error: e1 } = await supabase
        .from('or_claim_requests')
        .select(
          'id, status, created_at, reviewed_at, claim_type, ref_snapshot, created_claim_order_id, ref_order_id, submitted_by, supporting_url, claim_description, proposed_snapshot',
        )
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200)
      if (e1) throw e1

      const { data: approved, error: e2 } = await supabase
        .from('or_claim_requests')
        .select(
          'id, status, created_at, reviewed_at, claim_type, ref_snapshot, created_claim_order_id, ref_order_id, submitted_by, supporting_url, claim_description, proposed_snapshot',
        )
        .eq('status', 'approved')
        .not('created_claim_order_id', 'is', null)
        .order('reviewed_at', { ascending: false })
        .limit(200)
      if (e2) throw e2

      const { data: rejected, error: eRej } = await supabase
        .from('or_claim_requests')
        .select(
          'id, created_at, reviewed_at, claim_type, ref_snapshot, ref_order_id, submitted_by, supporting_url, claim_description, rejected_reason, proposed_snapshot',
        )
        .eq('status', 'rejected')
        .order('reviewed_at', { ascending: false })
        .limit(200)
      if (eRej) throw eRej

      // ร่างเคลม — เฉพาะของผู้ใช้เอง (submitted_by = ตัวเอง)
      if (user?.id) {
        const { data: drafts, error: eDraft } = await supabase
          .from('or_claim_requests')
          .select('id, created_at, claim_type, ref_order_id, ref_snapshot, proposed_snapshot, supporting_url, claim_description')
          .eq('status', 'draft')
          .eq('submitted_by', user.id)
          .order('created_at', { ascending: false })
          .limit(200)
        if (eDraft) console.warn('ClaimReqOrdersTab: load drafts', eDraft)
        setDraftClaims((drafts || []) as DraftClaimRow[])
      } else {
        setDraftClaims([])
      }

      const pBase = (pending || []) as Array<
        ClaimRow & {
          ref_order_id: string
          submitted_by: string | null
          supporting_url?: string | null
          claim_description?: string | null
        }
      >
      const aList = (approved || []) as ClaimRow[]

      const rejBase = (rejected || []) as Array<{
        id: string
        created_at: string
        reviewed_at: string | null
        claim_type: string
        ref_snapshot: { bill_no?: string; total_amount?: number } | null
        proposed_snapshot?: { order?: Record<string, unknown>; items?: unknown[] } | null
        ref_order_id: string
        submitted_by: string | null
        supporting_url?: string | null
        claim_description?: string | null
        rejected_reason?: string | null
      }>

      const pendingRefIds = [...new Set(pBase.map((r) => r.ref_order_id))]
      const rejectedRefIds = [...new Set(rejBase.map((r) => r.ref_order_id))]
      const approvedRefIds = [...new Set(aList.map((r) => String(r.ref_order_id || '')).filter(Boolean))]
      const allRefIds = [...new Set([...pendingRefIds, ...rejectedRefIds, ...approvedRefIds])]

      const pendingSubmitterIds = pBase.map((r) => r.submitted_by).filter((id): id is string => Boolean(id))
      const rejectedSubmitterIds = rejBase.map((r) => r.submitted_by).filter((id): id is string => Boolean(id))
      const approvedSubmitterIds = aList.map((r) => r.submitted_by ?? null).filter((id): id is string => Boolean(id))
      const allSubmitterIds = [...new Set([...pendingSubmitterIds, ...rejectedSubmitterIds, ...approvedSubmitterIds])]

      const refOrderMetaById: Record<
        string,
        {
          entry_date?: string | null
          created_at?: string | null
          admin_user?: string | null
          customer_name?: string | null
          customer_address?: string | null
          mobile_phone?: string | null
          channel_order_no?: string | null
          tracking_number?: string | null
        }
      > = {}
      if (allRefIds.length > 0) {
        const { data: refRows, error: refErr } = await supabase
          .from('or_orders')
          .select('id, entry_date, created_at, admin_user, customer_name, customer_address, billing_details, channel_order_no, tracking_number')
          .in('id', allRefIds)
        if (refErr) console.warn('ClaimReqOrdersTab: ref orders meta', refErr)
        for (const row of refRows || []) {
          const r = row as {
            id: string
            entry_date?: string | null
            created_at?: string | null
            admin_user?: string | null
            customer_name?: string | null
            customer_address?: string | null
            billing_details?: unknown
            channel_order_no?: string | null
            tracking_number?: string | null
          }
          refOrderMetaById[String(r.id)] = {
            entry_date: r.entry_date ?? null,
            created_at: r.created_at ?? null,
            admin_user: r.admin_user ?? null,
            customer_name: r.customer_name ?? null,
            customer_address: r.customer_address ?? null,
            mobile_phone: mobilePhoneFromBillingDetails(r.billing_details),
            channel_order_no: r.channel_order_no ?? null,
            tracking_number: r.tracking_number ?? null,
          }
        }
      }

      // วิดีโอแพคสินค้าของบิลอ้างอิง (ตาม order_id ก่อน แล้ว fallback เลขพัสดุ)
      const videoByOrder = new Map<string, string>()
      const videoByTracking = new Map<string, string>()
      if (allRefIds.length > 0) {
        try {
          const { data: vrows, error: vErr } = await supabase
            .from('pk_packing_videos')
            .select('order_id, tracking_number, gdrive_url, created_at')
            .in('order_id', allRefIds)
            .not('gdrive_url', 'is', null)
            .order('created_at', { ascending: false })
          if (vErr) throw vErr
          for (const vr of vrows || []) {
            const url = vr.gdrive_url ? String(vr.gdrive_url) : ''
            if (!url) continue
            const oid = vr.order_id ? String(vr.order_id) : ''
            const tn = vr.tracking_number ? String(vr.tracking_number).trim() : ''
            if (oid && !videoByOrder.has(oid)) videoByOrder.set(oid, url)
            if (tn && !videoByTracking.has(tn)) videoByTracking.set(tn, url)
          }
        } catch {
          /* ignore video lookup */
        }
      }

      const submitterById: Record<string, { username?: string | null }> = {}
      if (allSubmitterIds.length > 0) {
        const { data: uRows, error: uErr } = await supabase
          .from('us_users')
          .select('id, username')
          .in('id', allSubmitterIds)
        if (uErr) console.warn('ClaimReqOrdersTab: us_users batch', uErr)
        for (const u of uRows || []) {
          submitterById[String((u as { id: string }).id)] = {
            username: (u as { username?: string | null }).username ?? null,
          }
        }
      }

      /** ประกอบข้อมูลร่วม (บิลอ้างอิง/ผู้ส่ง/วิดีโอแพค) ให้แถวทุกแท็บ */
      const makeCommon = (refOrderId: string, submittedBy: string | null): ClaimRowCommonInfo => {
        const meta = refOrderMetaById[refOrderId]
        const tn = (meta?.tracking_number || '').trim()
        return {
          submitter: submittedBy ? submitterById[submittedBy] ?? null : null,
          ref_bill_date_label: formatRefBillDate(meta?.entry_date, meta?.created_at),
          ref_admin_user: meta?.admin_user ?? null,
          ref_customer_name: meta?.customer_name ?? null,
          ref_customer_address: meta?.customer_address ?? null,
          ref_mobile_phone: meta?.mobile_phone ?? null,
          ref_channel_order_no: meta?.channel_order_no ?? null,
          packing_video_url: videoByOrder.get(refOrderId) || (tn ? videoByTracking.get(tn) : undefined) || null,
        }
      }

      let latestReqByRef: Record<string, string> = {}
      if (pendingRefIds.length > 0) {
        const CHUNK = 80
        type PriorApprovedRow = {
          ref_order_id: string
          created_claim_order_id: string
          reviewed_at: string | null
        }
        const priorRows: PriorApprovedRow[] = []
        for (let i = 0; i < pendingRefIds.length; i += CHUNK) {
          const ch = pendingRefIds.slice(i, i + CHUNK)
          const { data: part, error: apErr } = await supabase
            .from('or_claim_requests')
            .select('ref_order_id, created_claim_order_id, reviewed_at')
            .eq('status', 'approved')
            .not('created_claim_order_id', 'is', null)
            .in('ref_order_id', ch)
          if (apErr) console.warn('ClaimReqOrdersTab: prior approved for pending refs', apErr)
          if (part) priorRows.push(...(part as PriorApprovedRow[]))
        }
        const bestByRef = new Map<string, { reviewed_at: string; created_claim_order_id: string }>()
        for (const r of priorRows) {
          const prev = bestByRef.get(r.ref_order_id)
          const rt = r.reviewed_at || ''
          if (!prev || rt > prev.reviewed_at) {
            bestByRef.set(r.ref_order_id, {
              reviewed_at: rt,
              created_claim_order_id: r.created_claim_order_id,
            })
          }
        }
        const cidList = [...new Set([...bestByRef.values()].map((v) => v.created_claim_order_id))]
        const billById: Record<string, string> = {}
        for (let i = 0; i < cidList.length; i += CHUNK) {
          const ch = cidList.slice(i, i + CHUNK)
          if (ch.length === 0) continue
          const { data: ors, error: boErr } = await supabase
            .from('or_orders')
            .select('id, bill_no')
            .in('id', ch)
          if (boErr) console.warn('ClaimReqOrdersTab: REQ bill_no for pending display', boErr)
          for (const row of ors || []) {
            const o = row as { id: string; bill_no: string | null }
            const bn = (o.bill_no || '').trim()
            if (bn) billById[o.id] = bn
          }
        }
        for (const [refId, v] of bestByRef) {
          const bn = billById[v.created_claim_order_id]
          if (bn) latestReqByRef[refId] = bn
        }
      }
      setLatestReqBillByRefOrderId(latestReqByRef)

      const pList: PendingClaimRow[] = pBase.map((r) => ({
        ...r,
        ...makeCommon(r.ref_order_id, r.submitted_by),
      }))
      setPendingClaims(pList)

      const aEnriched: ApprovedClaimRow[] = aList.map((r) => ({
        ...r,
        ...makeCommon(String(r.ref_order_id || ''), r.submitted_by ?? null),
      }))

      let rejList: RejectedClaimRow[] = rejBase.map((r) => ({
        ...r,
        ...makeCommon(r.ref_order_id, r.submitted_by),
      }))
      if (narrowAdminUser?.trim()) {
        const nu = narrowAdminUser.trim()
        rejList = rejList.filter(
          (r) => (refOrderMetaById[r.ref_order_id]?.admin_user ?? '').trim() === nu,
        )
      }
      setRejectedClaims(rejList)

      const orderIds = [
        ...new Set(aList.map((c) => c.created_claim_order_id).filter(Boolean) as string[]),
      ]
      let ordersMap: Record<string, ReqOrderRow> = {}
      if (orderIds.length > 0) {
        let oq = supabase
          .from('or_orders')
          .select(
            'id, bill_no, recipient_name, customer_address, billing_details, claim_shipping_confirmed_at, channel_code, admin_user, status, total_amount',
          )
          .in('id', orderIds)
        if (narrowAdminUser?.trim()) {
          oq = oq.eq('admin_user', narrowAdminUser.trim())
        }
        const { data: ordRows, error: e3 } = await oq
        if (e3) throw e3
        ordersMap = Object.fromEntries(
          ((ordRows || []) as ReqOrderRow[]).map((o) => [o.id, o]),
        )
      }
      setOrderById(ordersMap)

      const visibleApproved = narrowAdminUser?.trim()
        ? aEnriched.filter((c) => ordersMap[c.created_claim_order_id!])
        : aEnriched
      setApprovedClaims(visibleApproved)

    } catch (e: unknown) {
      console.error('ClaimReqOrdersTab load:', e)
      alert('โหลดรายการบิลเคลมไม่สำเร็จ: ' + ((e as Error)?.message || String(e)))
    } finally {
      setLoading(false)
    }
  }, [narrowAdminUser, user?.id])

  useEffect(() => {
    load()
  }, [load, refreshTrigger])

  useEffect(() => {
    const previews = confirmSlipFiles.map((file) => ({ url: URL.createObjectURL(file), name: file.name }))
    setConfirmSlipPreviews(previews)
    setExpandedSlipPreview(null)
    return () => previews.forEach((preview) => URL.revokeObjectURL(preview.url))
  }, [confirmSlipFiles])

  /** เรียลไทม์: โหลดรายการและตัวเลขใหม่เมื่อคำขอหรือสถานะยืนยันที่อยู่เปลี่ยน */
  useEffect(() => {
    const channel = supabase
      .channel('claim-req-orders-tab')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_claim_requests' }, () => {
        void load()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        void load()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [load])

  function openConfirm(c: ClaimRow) {
    const oid = c.created_claim_order_id
    if (!oid) return
    const o = orderById[oid]
    if (!o) return
    setModalClaim(c)
    setModalOrder(o)
    const refName = (o.recipient_name || '').trim()
    const refAddress = (o.customer_address || '').trim()
    const mp = (o.billing_details as { mobile_phone?: string } | null)?.mobile_phone
    const refPhone = (mp || '').trim()
    setRecipientName(refName)
    setCustomerAddress(refAddress)
    setMobilePhone(refPhone)
    setAutoFillAddressText('')
    setConfirmSlipFiles([])
    setErrorMsg('')
    setModalOpen(true)
    // ถ้ามีที่อยู่เดิมจากบิลเก่า แยกข้อมูลอัตโนมัติทันที (เลี่ยงซ้ำถ้าที่อยู่มีชื่อ/เบอร์อยู่แล้ว)
    const autoFillParts: string[] = []
    if (refName && !refAddress.includes(refName)) autoFillParts.push(refName)
    if (refAddress) autoFillParts.push(refAddress)
    if (refPhone && !refAddress.includes(refPhone)) autoFillParts.push(refPhone)
    const composed = autoFillParts.join('\n').trim()
    if (composed) void handleAutoFillShipping(composed)
  }

  async function handleAutoFillShipping(addressText?: string) {
    const source = addressText ?? autoFillAddressText
    if (!source.trim()) return
    setAutoFillAddressLoading(true)
    setErrorMsg('')
    try {
      const parsed = await parseAddressText(source, supabase)
      const composedAddress = [
        parsed.addressLine,
        parsed.subDistrict,
        parsed.district,
        parsed.province,
        parsed.postalCode,
      ].filter(Boolean).join(' ').trim()
      setCustomerAddress(composedAddress || source.trim())
      if (parsed.recipientName?.trim()) setRecipientName(parsed.recipientName.trim())
      if (parsed.mobilePhone?.trim()) setMobilePhone(parsed.mobilePhone.trim())
      // แยกสำเร็จแล้ว เคลียร์กล่อง Auto fill ให้ว่าง
      setAutoFillAddressText('')
    } catch (error) {
      console.error('Claim shipping address auto fill:', error)
      setErrorMsg('ไม่สามารถแยกข้อมูลที่อยู่ได้ กรุณาตรวจสอบข้อมูลแล้วลองอีกครั้ง')
    } finally {
      setAutoFillAddressLoading(false)
    }
  }

  async function handleSaveConfirm() {
    if (!modalOrder) return
    const missingFields = [
      !recipientName.trim() && 'ชื่อผู้รับ',
      !customerAddress.trim() && 'ที่อยู่จัดส่ง',
      !mobilePhone.trim() && 'เบอร์โทร',
    ].filter(Boolean)
    if (missingFields.length > 0) {
      setErrorMsg(`กรุณากรอกข้อมูลให้ครบ: ${missingFields.join(', ')}`)
      return
    }
    if (confirmSlipFiles.length === 0) {
      setErrorMsg('กรุณาแนบสลิปโอนเพื่อให้ระบบตรวจสอบก่อนยืนยันที่อยู่')
      return
    }
    setSaving(true)
    setErrorMsg('')
    try {
      // EasySlip must pass before shipping is confirmed.
      const orderAmount = Number(modalOrder.total_amount) || 0
      let outcome: ClaimSlipVerifyResult | null = null
      let verifyError: string | null = null
      try {
        outcome = await verifyAndSaveClaimSlips({
          orderId: modalOrder.id,
          billNo: modalOrder.bill_no,
          channelCode: modalOrder.channel_code || null,
          expectedAmount: orderAmount,
          files: confirmSlipFiles,
          verifiedBy: user?.id ?? null,
        })
      } catch (ve: unknown) {
        verifyError = (ve as Error)?.message || String(ve)
      }
      const passed = !!outcome?.passed

      if (passed) {
        const { error } = await supabase.rpc('rpc_confirm_claim_req_shipping', {
          p_order_id: modalOrder.id,
          p_recipient_name: recipientName.trim(),
          p_customer_address: customerAddress.trim(),
          p_mobile_phone: mobilePhone.trim(),
        })
        if (error) throw error
      }

      const { error: stErr } = await supabase
        .from('or_orders')
        .update({ status: passed ? 'ตรวจสอบแล้ว' : 'ตรวจสอบไม่ผ่าน' })
        .eq('id', modalOrder.id)
      if (stErr) console.warn('ClaimReqOrdersTab: update status after slip verify', stErr)

      setClaimVerify({
        open: true,
        type: passed ? 'success' : 'failed',
        accountMatch: outcome?.accountMatch ?? null,
        bankCodeMatch: outcome?.bankCodeMatch ?? null,
        amountStatus: outcome?.amountStatus ?? 'mismatch',
        orderAmount,
        totalAmount: outcome?.totalFromSlips ?? 0,
        errors: verifyError ? [verifyError] : outcome?.errors ?? [],
        statusMessage: passed
          ? 'ตรวจสลิปผ่าน — ยืนยันที่อยู่และย้ายบิลไป "ตรวจสอบแล้ว" เรียบร้อย'
          : 'ตรวจสลิปไม่ผ่าน — ยังไม่ยืนยันที่อยู่ และบิลถูกย้ายไปเมนู "ตรวจสอบไม่ผ่าน"',
      })

      setModalOpen(false)
      setConfirmSlipFiles([])
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      await load()
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || String(e)
      setErrorMsg(msg)
    } finally {
      setSaving(false)
    }
  }

  /** เปิดร่างเข้า modal เคลม (หน้าสร้าง/แก้ไข) เพื่อแก้ต่อ */
  function openDraftForEdit(d: DraftClaimRow) {
    window.dispatchEvent(
      new CustomEvent('open-claim-draft', {
        detail: {
          draft: {
            id: d.id,
            ref_order_id: d.ref_order_id,
            claim_type: d.claim_type,
            supporting_url: d.supporting_url,
            claim_description: d.claim_description,
            proposed_snapshot: d.proposed_snapshot,
          },
        },
      }),
    )
  }

  /** ส่งอนุมัติจากร่างโดยตรง (draft -> pending) */
  async function submitDraft(d: DraftClaimRow) {
    const items = (d.proposed_snapshot?.items || []) as unknown[]
    if (items.length === 0) {
      alert('ร่างนี้ยังไม่มีรายการสินค้า กรุณากด "แก้ไข" เพื่อเพิ่มรายการก่อนส่งอนุมัติ')
      return
    }
    setDraftBusyId(d.id)
    try {
      const { data, error } = await supabase
        .from('or_claim_requests')
        .update({ status: 'pending' })
        .eq('id', d.id)
        .eq('status', 'draft')
        .select('id')
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          alert('บิลนี้มีคำขอเคลมที่รออนุมัติอยู่แล้ว')
          return
        }
        throw error
      }
      if (!data || data.length === 0) {
        alert('ไม่พบร่างนี้ (อาจถูกลบหรือส่งไปแล้ว)')
        return
      }
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      await load()
    } catch (e: unknown) {
      alert('ส่งอนุมัติไม่สำเร็จ: ' + ((e as Error)?.message || String(e)))
    } finally {
      setDraftBusyId(null)
    }
  }

  /** ลบร่าง */
  async function deleteDraft(d: DraftClaimRow) {
    if (!window.confirm('ลบร่างเคลมนี้? การลบไม่สามารถกู้คืนได้')) return
    setDraftBusyId(d.id)
    try {
      const { error } = await supabase.from('or_claim_requests').delete().eq('id', d.id).eq('status', 'draft')
      if (error) throw error
      await load()
    } catch (e: unknown) {
      alert('ลบไม่สำเร็จ: ' + ((e as Error)?.message || String(e)))
    } finally {
      setDraftBusyId(null)
    }
  }

  const filteredDraftClaims = useMemo(() => {
    return draftClaims.filter((d) => {
      if (!claimCreatedAtInRange(d.created_at, reqFilterDateFrom, reqFilterDateTo)) return false
      return matchesReqSearch(reqFilterSearch, [
        d.ref_snapshot?.bill_no,
        claimTypeLabel(claimLabels, d.claim_type),
        d.claim_description,
        d.id,
      ])
    })
  }, [draftClaims, reqFilterDateFrom, reqFilterDateTo, reqFilterSearch, claimLabels])

  const filteredPendingClaims = useMemo(() => {
    return pendingClaims.filter((c) => {
      if (!claimCreatedAtInRange(c.created_at, reqFilterDateFrom, reqFilterDateTo)) return false
      return matchesReqSearch(reqFilterSearch, [
        c.ref_snapshot?.bill_no,
        latestReqBillByRefOrderId[c.ref_order_id],
        submitterDisplay(c.submitted_by, c.submitter),
        c.ref_admin_user,
        c.ref_customer_name,
        c.ref_channel_order_no,
        claimTypeLabel(claimLabels, c.claim_type),
        c.claim_description,
        c.id,
      ])
    })
  }, [
    pendingClaims,
    latestReqBillByRefOrderId,
    reqFilterDateFrom,
    reqFilterDateTo,
    reqFilterSearch,
    claimLabels,
  ])

  const filteredApprovedClaims = useMemo(() => {
    return approvedClaims.filter((c) => {
      if (!claimCreatedAtInRange(c.created_at, reqFilterDateFrom, reqFilterDateTo)) return false
      const o = c.created_claim_order_id ? orderById[c.created_claim_order_id] : undefined
      return matchesReqSearch(reqFilterSearch, [
        c.ref_snapshot?.bill_no,
        o?.bill_no,
        submitterDisplay(c.submitted_by ?? null, c.submitter),
        c.ref_admin_user,
        c.ref_customer_name,
        c.ref_channel_order_no,
        claimTypeLabel(claimLabels, c.claim_type),
        c.claim_description,
        c.id,
      ])
    })
  }, [approvedClaims, orderById, reqFilterDateFrom, reqFilterDateTo, reqFilterSearch, claimLabels])

  const filteredRejectedClaims = useMemo(() => {
    return rejectedClaims.filter((c) => {
      if (!claimCreatedAtInRange(c.created_at, reqFilterDateFrom, reqFilterDateTo)) return false
      return matchesReqSearch(reqFilterSearch, [
        c.ref_snapshot?.bill_no,
        submitterDisplay(c.submitted_by, c.submitter),
        c.ref_admin_user,
        c.ref_customer_name,
        c.ref_channel_order_no,
        claimTypeLabel(claimLabels, c.claim_type),
        c.claim_description,
        c.rejected_reason,
        c.id,
      ])
    })
  }, [rejectedClaims, reqFilterDateFrom, reqFilterDateTo, reqFilterSearch, claimLabels])

  /** จำนวนบิลอนุมัติแล้วที่ยังไม่ได้บันทึกและยืนยันที่อยู่ */
  const needShippingCount = useMemo(
    () => approvedClaims.filter(
      (c) => c.created_claim_order_id && !orderById[c.created_claim_order_id]?.claim_shipping_confirmed_at,
    ).length,
    [approvedClaims, orderById],
  )
  const unseenRejectedCount = useMemo(
    () => rejectedClaims.filter((c) => !seenKeys.has(`${c.id}|rejected`)).length,
    [rejectedClaims, seenKeys],
  )

  /** ส่ง counts ให้แท็บแม่ — ปฏิเสธใช้จำนวนที่ยังไม่ได้เปิดดู (ลดลงทันทีเมื่อคลิกดู) */
  useEffect(() => {
    onCountsChangeRef.current?.(pendingClaims.length, needShippingCount, unseenRejectedCount)
  }, [pendingClaims.length, needShippingCount, unseenRejectedCount])

  const filterActive =
    !!reqFilterSearch.trim() ||
    reqFilterDateFrom !== defaultReqFilterDateFrom() ||
    reqFilterDateTo !== defaultReqFilterDateTo()

  if (loading && pendingClaims.length === 0 && approvedClaims.length === 0 && rejectedClaims.length === 0) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6 px-2">
      <div className="flex flex-wrap gap-2 border-b border-surface-200 pb-2">
        {(
          [
            { id: 'pending' as const, label: 'รออนุมัติ', count: pendingClaims.length },
            { id: 'approved' as const, label: 'อนุมัติแล้ว', count: needShippingCount },
            { id: 'rejected' as const, label: 'ปฏิเสธ', count: unseenRejectedCount },
            { id: 'draft' as const, label: 'บันทึกร่าง(เคลม)', count: draftClaims.length },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setReqSubTab(t.id)}
            className={`px-4 py-2 rounded-t-lg text-sm font-semibold border-b-2 transition-colors ${
              reqSubTab === t.id
                ? 'border-blue-500 text-blue-600 bg-blue-50/50'
                : 'border-transparent text-gray-600 hover:text-blue-600'
            }`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">วันที่ส่งคำขอ ตั้งแต่</label>
          <input
            type="date"
            value={reqFilterDateFrom}
            onChange={(e) => setReqFilterDateFrom(e.target.value)}
            className="px-3 py-2 border border-surface-300 rounded-lg text-sm bg-white"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">ถึง</label>
          <input
            type="date"
            value={reqFilterDateTo}
            onChange={(e) => setReqFilterDateTo(e.target.value)}
            className="px-3 py-2 border border-surface-300 rounded-lg text-sm bg-white"
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-600 mb-1">ค้นหา</label>
          <input
            type="text"
            placeholder="เลขบิล / REQ / ผู้สร้าง / หัวข้อเคลม / คำอธิบาย"
            value={reqFilterSearch}
            onChange={(e) => setReqFilterSearch(e.target.value)}
            className="w-full px-3 py-2 border border-surface-300 rounded-lg text-sm bg-white"
          />
        </div>
        {filterActive && (
          <button
            type="button"
            className="text-sm text-blue-600 hover:underline px-2 py-2"
            onClick={() => {
              setReqFilterDateFrom(defaultReqFilterDateFrom())
              setReqFilterDateTo(defaultReqFilterDateTo())
              setReqFilterSearch('')
            }}
          >
            ล้างตัวกรอง
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 -mt-2">
        ค่าเริ่มต้นช่วงวันที่ = วันที่ 1 ของเดือนนี้ ถึงวันนี้ — กรองตาม <strong>วันที่ส่งคำขอ</strong>{' '}
        (เวลาที่สร้างคำขอในระบบ) และข้อความในตารางของแท็บที่เลือก · คลิกแถวเพื่อดูรายละเอียดเปรียบเทียบบิล
      </p>

      {reqSubTab === 'pending' && (
        <section>
          {pendingClaims.length === 0 ? (
            <p className="text-gray-500 text-sm">ไม่มีคำขอที่รออนุมัติ</p>
          ) : filteredPendingClaims.length === 0 ? (
            <p className="text-gray-500 text-sm">ไม่มีรายการตามช่วงวันที่หรือคำค้นหา</p>
          ) : (
            <div className="overflow-x-auto border border-surface-200 rounded-xl bg-white">
              <table className="min-w-full text-sm bg-white">
                <thead className="bg-surface-100">
                  <tr>
                    <th className="text-left p-3 whitespace-nowrap">วันที่ส่งคำขอ</th>
                    <th
                      className="text-left p-3 whitespace-nowrap"
                      title="เคลมซ้ำ: แสดงเลข REQ ล่าสุด — บรรทัดรองเป็นเลขบิลจัดส่งต้น"
                    >
                      บิลอ้างอิง
                    </th>
                    <ClaimInfoHeadCells />
                    <th className="text-left p-3 whitespace-nowrap">หัวข้อเคลม</th>
                    <th className="text-left p-3 min-w-[180px] whitespace-nowrap">คำอธิบายเคลม</th>
                    <ClaimMoneyHeadCells />
                    <th className="text-center p-3 whitespace-nowrap">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {filteredPendingClaims.map((c) => {
                    const baseBill = c.ref_snapshot?.bill_no || '–'
                    const reqLatest = latestReqBillByRefOrderId[c.ref_order_id]
                    return (
                      <tr
                        key={c.id}
                        className="border-t border-surface-200 bg-white cursor-pointer hover:bg-slate-50/90 transition-colors"
                        onClick={() => void openClaimCompare(c.id)}
                      >
                        <td className="p-3 whitespace-nowrap">
                          <DateTimeCellText text={new Date(c.created_at).toLocaleString('th-TH')} />
                        </td>
                        <td className="p-3 align-top">
                          {reqLatest ? (
                            <div>
                              <div className="font-mono font-semibold text-gray-900">{reqLatest}</div>
                              <div className="text-xs text-gray-500 mt-0.5">บิลต้น {baseBill}</div>
                            </div>
                          ) : (
                            <span className="font-mono">{baseBill}</span>
                          )}
                        </td>
                        <ClaimInfoCells row={c} submittedBy={c.submitted_by} />
                        <td className="p-3">{claimTypeLabel(claimLabels, c.claim_type)}</td>
                        <td className="p-3 text-gray-700 align-top max-w-md min-w-[200px]">
                          <span className="whitespace-pre-wrap break-words text-sm">
                            {(c.claim_description ?? '').trim() || '–'}
                          </span>
                        </td>
                        <ClaimMoneyCells refSnapshot={c.ref_snapshot} proposedSnapshot={c.proposed_snapshot} />
                        <td className="p-3 align-middle" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-2">
                            <EvidenceLinkCell supportingUrl={c.supporting_url} />
                            <VideoLinkCell url={c.packing_video_url} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {reqSubTab === 'approved' && (
        <section>
          {approvedClaims.length === 0 ? (
            <p className="text-gray-500 text-sm">ไม่มีรายการ (หรือไม่มีบิลในขอบเขตผู้ใช้)</p>
          ) : filteredApprovedClaims.length === 0 ? (
            <p className="text-gray-500 text-sm">ไม่มีรายการตามช่วงวันที่หรือคำค้นหา</p>
          ) : (
            <div className="overflow-x-auto border border-surface-200 rounded-xl bg-white">
              <table className="min-w-full text-sm bg-white">
                <thead className="bg-surface-100">
                  <tr>
                    <th className="text-left p-3 whitespace-nowrap">วันที่ส่งคำขอ</th>
                    <th className="text-left p-3 whitespace-nowrap">บิล REQ</th>
                    <th className="text-left p-3 whitespace-nowrap">บิลอ้างอิง</th>
                    <th className="text-left p-3 whitespace-nowrap">ช่องทาง</th>
                    <ClaimMoneyHeadCells />
                    <th className="text-left p-3 whitespace-nowrap">สถานะที่อยู่</th>
                    <th className="text-left p-3"> </th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {filteredApprovedClaims.map((c) => {
                    const o = c.created_claim_order_id ? orderById[c.created_claim_order_id] : undefined
                    if (!o) return null
                    const done = !!o.claim_shipping_confirmed_at
                    return (
                      <tr
                        key={c.id}
                        className="border-t border-surface-200 bg-white cursor-pointer hover:bg-slate-50/90 transition-colors"
                        onClick={() => {
                          markSeen(c.id, 'approved')
                          void openClaimCompare(c.id)
                        }}
                      >
                        <td className="p-3 whitespace-nowrap">
                          <DateTimeCellText text={new Date(c.created_at).toLocaleString('th-TH')} />
                        </td>
                        <td className="p-3 font-mono font-semibold">{o.bill_no}</td>
                        <td className="p-3 font-mono">{c.ref_snapshot?.bill_no || '–'}</td>
                        <td className="p-3">{o.channel_code}</td>
                        <ClaimMoneyCells refSnapshot={c.ref_snapshot} proposedSnapshot={c.proposed_snapshot} />
                        <td className="p-3 whitespace-nowrap">
                          {done ? (
                            <div className="leading-tight">
                              <div className="text-green-700 font-medium">ยืนยันแล้ว</div>
                              {o.claim_shipping_confirmed_at && (
                                <div className="text-xs text-gray-500 mt-0.5">
                                  {new Date(o.claim_shipping_confirmed_at).toLocaleString('th-TH')}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-amber-700 font-medium">รอกรอก / ยืนยัน</span>
                          )}
                        </td>
                        <td className="p-3" onClick={(e) => e.stopPropagation()}>
                          {!done && canConfirm && (
                            <button
                              type="button"
                              onClick={() => {
                                markSeen(c.id, 'approved')
                                openConfirm(c)
                              }}
                              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                            >
                              กรอกที่อยู่จัดส่ง
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {reqSubTab === 'rejected' && (
        <section className="rounded-xl border border-rose-200/80 bg-rose-50/40 p-4">
          <h3 className="text-lg font-bold text-rose-900 mb-1">ปฏิเสธ (บัญชี)</h3>
          <p className="text-xs text-rose-800/80 mb-3">
            รายการที่ฝ่ายบัญชีปฏิเสธ — ดูเหตุผลแล้วแจ้งลูกค้าหรือส่งคำขอเคลมใหม่ตามขั้นตอนปกติ
          </p>
          {rejectedClaims.length === 0 ? (
            <p className="text-gray-600 text-sm">ไม่มีคำขอที่ถูกปฏิเสธในขอบเขตนี้</p>
          ) : filteredRejectedClaims.length === 0 ? (
            <p className="text-gray-600 text-sm">ไม่มีรายการตามช่วงวันที่หรือคำค้นหา</p>
          ) : (
            <div className="overflow-x-auto border border-rose-200 rounded-xl bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-rose-100/90">
                  <tr>
                    <th className="text-left p-3 whitespace-nowrap">วันที่ส่งคำขอ</th>
                    <th className="text-left p-3 whitespace-nowrap">บิลอ้างอิง</th>
                    <th className="text-left p-3 whitespace-nowrap">ผู้สร้างบิลเคลม</th>
                    <th className="text-left p-3 whitespace-nowrap">วันที่สร้างบิล</th>
                    <th className="text-left p-3 whitespace-nowrap">หัวข้อเคลม</th>
                    <th className="text-left p-3 min-w-[160px] whitespace-nowrap">คำอธิบายเคลม</th>
                    <th className="text-left p-3 min-w-[160px] whitespace-nowrap">เหตุผลปฏิเสธ</th>
                    <th className="text-left p-3 whitespace-nowrap">วันที่ปฏิเสธ</th>
                    <th className="text-center p-3 whitespace-nowrap">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRejectedClaims.map((c) => {
                    return (
                      <tr
                        key={c.id}
                        className="border-t border-rose-100 cursor-pointer hover:bg-rose-50/60 transition-colors"
                        onClick={() => {
                          markSeen(c.id, 'rejected')
                          void openClaimCompare(c.id)
                        }}
                      >
                        <td className="p-3 whitespace-nowrap">
                          <DateTimeCellText text={new Date(c.created_at).toLocaleString('th-TH')} />
                        </td>
                        <td className="p-3 font-mono">{c.ref_snapshot?.bill_no || '–'}</td>
                        <td className="p-3 whitespace-nowrap">
                          {submitterDisplay(c.submitted_by, c.submitter)}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <DateTimeCellText text={c.ref_bill_date_label} />
                        </td>
                        <td className="p-3">{claimTypeLabel(claimLabels, c.claim_type)}</td>
                        <td className="p-3 text-gray-700 align-top max-w-md min-w-[180px]">
                          <span className="whitespace-pre-wrap break-words text-sm">
                            {(c.claim_description ?? '').trim() || '–'}
                          </span>
                        </td>
                        <td className="p-3 text-gray-800 align-top max-w-md min-w-[180px]">
                          <span className="whitespace-pre-wrap break-words text-sm">
                            {(c.rejected_reason ?? '').trim() || '–'}
                          </span>
                        </td>
                        <td className="p-3 whitespace-nowrap text-gray-700">
                          {c.reviewed_at ? (
                            <DateTimeCellText text={new Date(c.reviewed_at).toLocaleString('th-TH')} />
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className="p-3 align-middle" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-2">
                            <EvidenceLinkCell supportingUrl={c.supporting_url} />
                            <VideoLinkCell url={c.packing_video_url} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {reqSubTab === 'draft' && (
        <section className="rounded-xl border border-indigo-200/80 bg-indigo-50/30 p-4">
          <h3 className="text-lg font-bold text-indigo-900 mb-1">บันทึกร่าง(เคลม)</h3>
          <p className="text-xs text-indigo-800/80 mb-3">
            ร่างเคลมที่คุณบันทึกไว้ (เห็นเฉพาะร่างของคุณ) — กด "แก้ไข" เพื่อทำต่อในหน้าเคลม, "ส่งอนุมัติ" เพื่อส่งให้บัญชี หรือ "ลบ"
          </p>
          {draftClaims.length === 0 ? (
            <p className="text-gray-600 text-sm">ยังไม่มีร่างเคลม — สร้างได้ที่ สร้าง/แก้ไข → เคลม แล้วกด "บันทึกร่าง(เคลม)"</p>
          ) : filteredDraftClaims.length === 0 ? (
            <p className="text-gray-600 text-sm">ไม่มีรายการตามช่วงวันที่หรือคำค้นหา</p>
          ) : (
            <div className="overflow-x-auto border border-indigo-200 rounded-xl bg-white">
              <table className="min-w-full text-sm bg-white">
                <thead className="bg-indigo-100/80">
                  <tr>
                    <th className="text-left p-3 whitespace-nowrap">วันที่บันทึกร่าง</th>
                    <th className="text-left p-3 whitespace-nowrap">บิลอ้างอิง</th>
                    <th className="text-left p-3 whitespace-nowrap">หัวข้อเคลม</th>
                    <th className="text-left p-3 min-w-[180px] whitespace-nowrap">คำอธิบายเคลม</th>
                    <th className="text-right p-3 whitespace-nowrap">จำนวนรายการ</th>
                    <th className="text-right p-3 whitespace-nowrap">ยอดบิลเคลม</th>
                    <th className="text-center p-3 whitespace-nowrap">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {filteredDraftClaims.map((d) => {
                    const itemCount = ((d.proposed_snapshot?.items || []) as unknown[]).length
                    const busy = draftBusyId === d.id
                    return (
                      <tr key={d.id} className="border-t border-indigo-100">
                        <td className="p-3 whitespace-nowrap">
                          <DateTimeCellText text={new Date(d.created_at).toLocaleString('th-TH')} />
                        </td>
                        <td className="p-3 font-mono">{d.ref_snapshot?.bill_no || '–'}</td>
                        <td className="p-3">{claimTypeLabel(claimLabels, d.claim_type)}</td>
                        <td className="p-3 text-gray-700 align-top max-w-md min-w-[180px]">
                          <span className="whitespace-pre-wrap break-words text-sm">
                            {(d.claim_description ?? '').trim() || '–'}
                          </span>
                        </td>
                        <td className="p-3 text-right tabular-nums">{itemCount}</td>
                        <td className="p-3 text-right tabular-nums font-semibold">
                          {fmtMoney(Number(d.proposed_snapshot?.order?.price) || 0)}
                        </td>
                        <td className="p-3 align-middle">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openDraftForEdit(d)}
                              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                            >
                              แก้ไข
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void submitDraft(d)}
                              className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50"
                            >
                              {busy ? '...' : 'ส่งอนุมัติ'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void deleteDraft(d)}
                              className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 text-sm font-medium hover:bg-red-50 disabled:opacity-50"
                            >
                              ลบ
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Modal
        open={compareOpen}
        onClose={() => !compareLoading && setCompareOpen(false)}
        contentClassName="max-w-6xl w-full max-h-[92vh] flex flex-col"
        closeOnBackdropClick={!compareLoading}
      >
        <div className="p-5 flex flex-col flex-1 min-h-0">
          {compareLoading && !compareDetail ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500 gap-2">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
              <span>กำลังโหลดรายละเอียด...</span>
            </div>
          ) : compareDetail ? (
            <>
              <ClaimRequestComparePanel
                detail={compareDetail}
                refOrder={compareRefOrder}
                refLoading={compareLoading}
                channelLabels={channelLabels}
                claimLabels={claimLabels}
                latestPriorReqBillNo={compareLatestPrior}
                approvedResultBillNo={compareApprovedResult}
              />
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-gray-100 pt-4 shrink-0">
                <div>
                  {compareDetail.status === 'pending' && canEditClaim && (
                    <button
                      type="button"
                      disabled={compareLoading}
                      onClick={() => setEditOpen(true)}
                      className="px-5 py-2.5 rounded-xl bg-amber-500 text-white font-medium hover:bg-amber-600 disabled:opacity-50"
                    >
                      ✏️ แก้ไขบิลเคลม
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  disabled={compareLoading}
                  onClick={() => setCompareOpen(false)}
                  className="px-5 py-2.5 rounded-xl border border-surface-300 bg-white text-gray-800 font-medium hover:bg-surface-50 disabled:opacity-50"
                >
                  ปิด
                </button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>

      <ClaimEditModal
        open={editOpen}
        detail={compareDetail}
        refOrderTotal={compareRefOrder?.total_amount ?? (Number(compareDetail?.ref_snapshot?.total_amount) || 0)}
        onClose={() => setEditOpen(false)}
        onSaved={async () => {
          await load()
          if (compareDetail) await openClaimCompare(compareDetail.id)
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => !saving && setModalOpen(false)}
        contentClassName="max-w-md w-[calc(100vw-2rem)] sm:w-full"
        closeOnBackdropClick={!saving}
      >
        <div className="p-6">
          <h4 className="text-lg font-bold text-gray-900 mb-1">ยืนยันที่อยู่จัดส่ง</h4>
          <p className="text-base font-mono font-semibold text-blue-800 mb-1">{modalOrder?.bill_no}</p>
          <p className="text-xs text-gray-500 mb-5">
            อ้างอิงบิลจัดส่งต้น:{' '}
            <span className="font-mono text-gray-700">{modalClaim?.ref_snapshot?.bill_no || '–'}</span>
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSaveConfirm()
            }}
          >
          <div className="mb-4">
            <div className="mb-1.5 flex items-center gap-2">
              <label className="block text-sm font-medium text-gray-700">ที่อยู่ลูกค้า</label>
              <button
                type="button"
                onClick={() => void handleAutoFillShipping()}
                disabled={autoFillAddressLoading || !autoFillAddressText.trim()}
                className="rounded-lg bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {autoFillAddressLoading ? 'กำลังแยก...' : 'Auto fill'}
              </button>
            </div>
            <textarea
              value={autoFillAddressText}
              onChange={(e) => setAutoFillAddressText(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text')
                if (!pasted.trim()) return
                const el = e.currentTarget
                const next = el.value.slice(0, el.selectionStart ?? el.value.length)
                  + pasted
                  + el.value.slice(el.selectionEnd ?? el.value.length)
                void handleAutoFillShipping(next)
              }}
              placeholder="วางชื่อ ที่อยู่ และเบอร์โทร ระบบจะแยกข้อมูลให้อัตโนมัติ"
              rows={3}
              className="w-full resize-y rounded-xl border border-blue-200 bg-blue-50/40 px-3 py-2.5 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200"
            />
          </div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">ชื่อผู้รับ <span className="text-red-500">*</span></label>
          <input
            name="name"
            autoComplete="name"
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
            required
          />
          <label className="block text-sm font-medium text-gray-700 mb-1.5">ที่อยู่จัดส่ง <span className="text-red-500">*</span></label>
          <textarea
            name="street-address"
            autoComplete="street-address"
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 min-h-[96px] text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none resize-y"
            value={customerAddress}
            onChange={(e) => setCustomerAddress(e.target.value)}
            required
          />
          <label className="block text-sm font-medium text-gray-700 mb-1.5">เบอร์โทร <span className="text-red-500">*</span></label>
          <input
            name="tel"
            autoComplete="tel"
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
            value={mobilePhone}
            onChange={(e) => setMobilePhone(e.target.value)}
            required
          />
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-800">สลิปโอน <span className="text-red-500">*</span></p>
                <p className="text-xs text-gray-500">ต้องผ่านการตรวจสอบ EasySlip ก่อนยืนยัน</p>
              </div>
              <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-emerald-700 shadow-sm ring-1 ring-inset ring-emerald-200 transition hover:bg-emerald-100">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L7 9m5-5 5 5M5 14v5h14v-5" />
                </svg>
                เลือกสลิป
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setConfirmSlipFiles(Array.from(e.target.files || []))}
                  className="sr-only"
                />
              </label>
            </div>
            {confirmSlipFiles.length > 0 && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {confirmSlipFiles.map((f, i) => {
                  const preview = confirmSlipPreviews[i]
                  return (
                    <div key={`${f.name}-${i}`} className="overflow-hidden rounded-lg border border-emerald-200 bg-white">
                      {preview && (
                        <button
                          type="button"
                          onClick={() => setExpandedSlipPreview(preview)}
                          className="block w-full bg-slate-100 p-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-400"
                          title="คลิกเพื่อดูภาพขนาดใหญ่"
                        >
                          <img
                            src={preview.url}
                            alt={`สลิป ${f.name}`}
                            className="mx-auto h-48 w-full object-contain"
                          />
                        </button>
                      )}
                      <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs text-gray-700">
                        <span className="truncate" title={f.name}>{f.name}</span>
                        <button
                          type="button"
                          className="shrink-0 font-medium text-red-600 hover:underline"
                          onClick={() => setConfirmSlipFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        >
                          ลบ
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          </form>
          {errorMsg && <p className="text-sm text-red-600 mb-3">{errorMsg}</p>}
          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              className="px-4 py-2.5 rounded-xl border border-surface-300 text-gray-700 hover:bg-surface-50"
              disabled={saving}
              onClick={() => setModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button
              type="button"
              className="px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50 shadow-sm"
              disabled={
                saving
                || !recipientName.trim()
                || !customerAddress.trim()
                || !mobilePhone.trim()
                || confirmSlipFiles.length === 0
              }
              onClick={handleSaveConfirm}
            >
              {saving ? 'กำลังตรวจสลิป...' : 'บันทึกและยืนยันที่อยู่'}
            </button>
          </div>
        </div>
      </Modal>

      {expandedSlipPreview && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`ดูสลิป ${expandedSlipPreview.name}`}
          onClick={() => setExpandedSlipPreview(null)}
        >
          <div className="relative flex max-h-full max-w-5xl items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <img
              src={expandedSlipPreview.url}
              alt={`สลิป ${expandedSlipPreview.name}`}
              className="max-h-[90vh] max-w-[92vw] rounded-lg bg-white object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setExpandedSlipPreview(null)}
              className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-2xl leading-none text-white shadow-lg transition hover:bg-black"
              aria-label="ปิดรูปสลิป"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {claimVerify && (
        <VerificationResultModal
          open={claimVerify.open}
          onClose={() => setClaimVerify(null)}
          type={claimVerify.type}
          accountMatch={claimVerify.accountMatch}
          bankCodeMatch={claimVerify.bankCodeMatch}
          amountStatus={claimVerify.amountStatus}
          orderAmount={claimVerify.orderAmount}
          totalAmount={claimVerify.totalAmount}
          errors={claimVerify.errors}
          statusMessage={claimVerify.statusMessage}
        />
      )}
    </div>
  )
}
