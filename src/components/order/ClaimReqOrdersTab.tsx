import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { fetchClaimTypeLabelMap, claimTypeLabel } from '../../lib/claimTypeLabels'
import { loadClaimCompareBundle } from '../../lib/claimRequestCompareLoad'
import Modal from '../ui/Modal'
import ClaimRequestComparePanel from '../claim/ClaimRequestComparePanel'
import type { ClaimCompareDetail, RefOrderDetail } from '../claim/claimCompareShared'

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

/** แถวรออนุมัติ — ขยายข้อมูลสำหรับตาราง */
type PendingClaimRow = ClaimRow & {
  ref_order_id: string
  submitted_by: string | null
  supporting_url?: string | null
  claim_description?: string | null
  submitter: { username?: string | null } | null
  /** วันที่สร้างบิลอ้างอิง (entry_date หรือ created_at) */
  ref_bill_date_label: string
}

/** แถวปฏิเสธโดยบัญชี — อ่านอย่างเดียว */
type RejectedClaimRow = {
  id: string
  created_at: string
  reviewed_at: string | null
  claim_type: string
  ref_snapshot: { bill_no?: string } | null
  ref_order_id: string
  submitted_by: string | null
  supporting_url?: string | null
  claim_description?: string | null
  rejected_reason?: string | null
  submitter: { username?: string | null } | null
  ref_bill_date_label: string
}

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
    return <span className="text-gray-400 text-sm">–</span>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="เปิดลิงก์หลักฐานในแท็บใหม่"
      className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1 relative z-[1]"
      onClick={(e) => e.stopPropagation()}
    >
      ลิงก์
    </a>
  )
}

function submitterDisplay(submittedBy: string | null, submitter: { username?: string | null } | null): string {
  const u = submitter?.username?.trim()
  if (u) return u
  if (submittedBy) return submittedBy.slice(0, 8) + '…'
  return '–'
}

function formatRefBillDate(entryDate: string | null | undefined, createdAt: string | null | undefined): string {
  const raw = (entryDate && String(entryDate).trim()) || (createdAt && String(createdAt).trim()) || ''
  if (!raw) return '–'
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleString('th-TH')
  }
  return raw
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
  const [approvedClaims, setApprovedClaims] = useState<ClaimRow[]>([])
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
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [reqSubTab, setReqSubTab] = useState<'pending' | 'approved' | 'rejected'>('pending')
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

  const canConfirm = CAN_CONFIRM_ROLES.includes(userRole as (typeof CAN_CONFIRM_ROLES)[number])

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
        ref_snapshot: { bill_no?: string } | null
        ref_order_id: string
        submitted_by: string | null
        supporting_url?: string | null
        claim_description?: string | null
        rejected_reason?: string | null
      }>

      const pendingRefIds = [...new Set(pBase.map((r) => r.ref_order_id))]
      const rejectedRefIds = [...new Set(rejBase.map((r) => r.ref_order_id))]
      const allRefIds = [...new Set([...pendingRefIds, ...rejectedRefIds])]

      const pendingSubmitterIds = pBase.map((r) => r.submitted_by).filter((id): id is string => Boolean(id))
      const rejectedSubmitterIds = rejBase.map((r) => r.submitted_by).filter((id): id is string => Boolean(id))
      const allSubmitterIds = [...new Set([...pendingSubmitterIds, ...rejectedSubmitterIds])]

      const refOrderMetaById: Record<
        string,
        { entry_date?: string | null; created_at?: string | null; admin_user?: string | null }
      > = {}
      if (allRefIds.length > 0) {
        const { data: refRows, error: refErr } = await supabase
          .from('or_orders')
          .select('id, entry_date, created_at, admin_user')
          .in('id', allRefIds)
        if (refErr) console.warn('ClaimReqOrdersTab: ref orders meta', refErr)
        for (const row of refRows || []) {
          const id = String((row as { id: string }).id)
          refOrderMetaById[id] = {
            entry_date: (row as { entry_date?: string | null }).entry_date ?? null,
            created_at: (row as { created_at?: string | null }).created_at ?? null,
            admin_user: (row as { admin_user?: string | null }).admin_user ?? null,
          }
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

      const pList: PendingClaimRow[] = pBase.map((r) => {
        const meta = refOrderMetaById[r.ref_order_id]
        return {
          ...r,
          submitter: r.submitted_by ? submitterById[r.submitted_by] ?? null : null,
          ref_bill_date_label: formatRefBillDate(meta?.entry_date, meta?.created_at),
        }
      })
      setPendingClaims(pList)

      let rejList: RejectedClaimRow[] = rejBase.map((r) => {
        const meta = refOrderMetaById[r.ref_order_id]
        return {
          id: r.id,
          created_at: r.created_at,
          reviewed_at: r.reviewed_at,
          claim_type: r.claim_type,
          ref_snapshot: r.ref_snapshot,
          ref_order_id: r.ref_order_id,
          submitted_by: r.submitted_by,
          supporting_url: r.supporting_url,
          claim_description: r.claim_description,
          rejected_reason: r.rejected_reason,
          submitter: r.submitted_by ? submitterById[r.submitted_by] ?? null : null,
          ref_bill_date_label: formatRefBillDate(meta?.entry_date, meta?.created_at),
        }
      })
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
            'id, bill_no, recipient_name, customer_address, billing_details, claim_shipping_confirmed_at, channel_code, admin_user, status',
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
        ? aList.filter((c) => ordersMap[c.created_claim_order_id!])
        : aList
      setApprovedClaims(visibleApproved)

      const needShipping = visibleApproved.filter(
        (c) => c.created_claim_order_id && !ordersMap[c.created_claim_order_id]?.claim_shipping_confirmed_at,
      ).length
      onCountsChangeRef.current?.(pList.length, needShipping, rejList.length)
    } catch (e: unknown) {
      console.error('ClaimReqOrdersTab load:', e)
      alert('โหลดรายการบิลเคลมไม่สำเร็จ: ' + ((e as Error)?.message || String(e)))
    } finally {
      setLoading(false)
    }
  }, [narrowAdminUser])

  useEffect(() => {
    load()
  }, [load, refreshTrigger])

  function openConfirm(c: ClaimRow) {
    const oid = c.created_claim_order_id
    if (!oid) return
    const o = orderById[oid]
    if (!o) return
    setModalClaim(c)
    setModalOrder(o)
    setRecipientName((o.recipient_name || '').trim())
    setCustomerAddress((o.customer_address || '').trim())
    const mp = (o.billing_details as { mobile_phone?: string } | null)?.mobile_phone
    setMobilePhone((mp || '').trim())
    setErrorMsg('')
    setModalOpen(true)
  }

  async function handleSaveConfirm() {
    if (!modalOrder) return
    setSaving(true)
    setErrorMsg('')
    try {
      const { error } = await supabase.rpc('rpc_confirm_claim_req_shipping', {
        p_order_id: modalOrder.id,
        p_recipient_name: recipientName.trim(),
        p_customer_address: customerAddress.trim(),
        p_mobile_phone: mobilePhone.trim(),
      })
      if (error) throw error
      setModalOpen(false)
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
      await load()
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message || String(e)
      setErrorMsg(msg)
    } finally {
      setSaving(false)
    }
  }

  const filteredPendingClaims = useMemo(() => {
    return pendingClaims.filter((c) => {
      if (!claimCreatedAtInRange(c.created_at, reqFilterDateFrom, reqFilterDateTo)) return false
      return matchesReqSearch(reqFilterSearch, [
        c.ref_snapshot?.bill_no,
        latestReqBillByRefOrderId[c.ref_order_id],
        submitterDisplay(c.submitted_by, c.submitter),
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
        claimTypeLabel(claimLabels, c.claim_type),
        c.claim_description,
        c.rejected_reason,
        c.id,
      ])
    })
  }, [rejectedClaims, reqFilterDateFrom, reqFilterDateTo, reqFilterSearch, claimLabels])

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
      <p className="text-sm text-gray-600 max-w-none md:max-w-5xl leading-relaxed">
        บิลเคลม (REQ) หลังฝ่ายบัญชีอนุมัติแล้ว ต้องกรอกและยืนยัน{' '}
        <strong>ชื่อผู้รับ</strong> / <strong>ที่อยู่จัดส่ง</strong> / <strong>เบอร์โทร</strong>{' '}
        ที่นี่ก่อนจึงจะปรับสถานะ<span className="whitespace-nowrap">เข้าคิวใบสั่งงาน (Plan) ได้</span>
      </p>

      <div className="flex flex-wrap gap-2 border-b border-surface-200 pb-2">
        {(
          [
            { id: 'pending' as const, label: 'รออนุมัติ', count: pendingClaims.length },
            { id: 'approved' as const, label: 'อนุมัติแล้ว', count: approvedClaims.length },
            { id: 'rejected' as const, label: 'ปฏิเสธ', count: rejectedClaims.length },
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
                    <th className="text-left p-3">วันที่ส่งคำขอ</th>
                    <th
                      className="text-left p-3"
                      title="เคลมซ้ำ: แสดงเลข REQ ล่าสุด — บรรทัดรองเป็นเลขบิลจัดส่งต้น"
                    >
                      บิลอ้างอิง
                    </th>
                    <th className="text-left p-3">ผู้สร้าง</th>
                    <th className="text-left p-3">วันที่สร้างบิล</th>
                    <th className="text-left p-3">หัวข้อเคลม</th>
                    <th className="text-left p-3 min-w-[180px]">คำอธิบายเคลม</th>
                    <th className="text-left p-3">ลิงก์หลักฐาน</th>
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
                          {new Date(c.created_at).toLocaleString('th-TH')}
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
                        <td className="p-3 whitespace-nowrap">
                          {submitterDisplay(c.submitted_by, c.submitter)}
                        </td>
                        <td className="p-3 whitespace-nowrap">{c.ref_bill_date_label}</td>
                        <td className="p-3">{claimTypeLabel(claimLabels, c.claim_type)}</td>
                        <td className="p-3 text-gray-700 align-top max-w-md min-w-[200px]">
                          <span className="whitespace-pre-wrap break-words text-sm">
                            {(c.claim_description ?? '').trim() || '–'}
                          </span>
                        </td>
                        <td className="p-3 align-middle" onClick={(e) => e.stopPropagation()}>
                          <EvidenceLinkCell supportingUrl={c.supporting_url} />
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
                    <th className="text-left p-3">วันที่ส่งคำขอ</th>
                    <th className="text-left p-3">บิล REQ</th>
                    <th className="text-left p-3">บิลอ้างอิง</th>
                    <th className="text-left p-3">สถานะที่อยู่</th>
                    <th className="text-left p-3">ช่องทาง</th>
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
                        onClick={() => void openClaimCompare(c.id)}
                      >
                        <td className="p-3 whitespace-nowrap">
                          {new Date(c.created_at).toLocaleString('th-TH')}
                        </td>
                        <td className="p-3 font-mono font-semibold">{o.bill_no}</td>
                        <td className="p-3 font-mono">{c.ref_snapshot?.bill_no || '–'}</td>
                        <td className="p-3">
                          {done ? (
                            <span className="text-green-700 font-medium">ยืนยันแล้ว</span>
                          ) : (
                            <span className="text-amber-700 font-medium">รอกรอก / ยืนยัน</span>
                          )}
                        </td>
                        <td className="p-3">{o.channel_code}</td>
                        <td className="p-3" onClick={(e) => e.stopPropagation()}>
                          {!done && canConfirm && (
                            <button
                              type="button"
                              onClick={() => openConfirm(c)}
                              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                            >
                              กรอกที่อยู่จัดส่ง
                            </button>
                          )}
                          {done && (
                            <span className="text-gray-400 text-xs">
                              {new Date(o.claim_shipping_confirmed_at!).toLocaleString('th-TH')}
                            </span>
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
                    <th className="text-left p-3">วันที่ส่งคำขอ</th>
                    <th className="text-left p-3">บิลอ้างอิง</th>
                    <th className="text-left p-3">ผู้สร้าง</th>
                    <th className="text-left p-3">วันที่สร้างบิล</th>
                    <th className="text-left p-3">หัวข้อเคลม</th>
                    <th className="text-left p-3 min-w-[160px]">คำอธิบายเคลม</th>
                    <th className="text-left p-3 min-w-[160px]">เหตุผลปฏิเสธ</th>
                    <th className="text-left p-3">วันที่ปฏิเสธ</th>
                    <th className="text-left p-3">ลิงก์หลักฐาน</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRejectedClaims.map((c) => {
                    return (
                      <tr
                        key={c.id}
                        className="border-t border-rose-100 cursor-pointer hover:bg-rose-50/60 transition-colors"
                        onClick={() => void openClaimCompare(c.id)}
                      >
                        <td className="p-3 whitespace-nowrap">
                          {new Date(c.created_at).toLocaleString('th-TH')}
                        </td>
                        <td className="p-3 font-mono">{c.ref_snapshot?.bill_no || '–'}</td>
                        <td className="p-3 whitespace-nowrap">
                          {submitterDisplay(c.submitted_by, c.submitter)}
                        </td>
                        <td className="p-3 whitespace-nowrap">{c.ref_bill_date_label}</td>
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
                          {c.reviewed_at
                            ? new Date(c.reviewed_at).toLocaleString('th-TH')
                            : '–'}
                        </td>
                        <td className="p-3 align-middle" onClick={(e) => e.stopPropagation()}>
                          <EvidenceLinkCell supportingUrl={c.supporting_url} />
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
              <div className="mt-4 flex justify-end border-t border-gray-100 pt-4 shrink-0">
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
          <label className="block text-sm font-medium text-gray-700 mb-1.5">ชื่อผู้รับ</label>
          <input
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
            value={recipientName}
            onChange={(e) => setRecipientName(e.target.value)}
          />
          <label className="block text-sm font-medium text-gray-700 mb-1.5">ที่อยู่จัดส่ง</label>
          <textarea
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 min-h-[96px] text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none resize-y"
            value={customerAddress}
            onChange={(e) => setCustomerAddress(e.target.value)}
          />
          <label className="block text-sm font-medium text-gray-700 mb-1.5">เบอร์โทร</label>
          <input
            className="w-full border border-surface-300 rounded-xl px-3 py-2.5 mb-4 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none"
            value={mobilePhone}
            onChange={(e) => setMobilePhone(e.target.value)}
          />
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
              disabled={saving}
              onClick={handleSaveConfirm}
            >
              {saving ? 'กำลังบันทึก...' : 'บันทึกและยืนยันที่อยู่'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
