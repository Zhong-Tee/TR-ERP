import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { Refund, Order } from '../types'
import { formatDateTime, downloadFileFromUrl } from '../lib/utils'
import { splitAddressParts } from '../lib/thaiAddress'
import { fetchClaimTypeLabelMap, claimTypeLabel } from '../lib/claimTypeLabels'
import { useAuthContext } from '../contexts/AuthContext'
import { useMenuAccess } from '../contexts/MenuAccessContext'
import { getEasySlipQuota, uploadMultipleToStorage, getSignedUrlsFromStoragePaths } from '../lib/slipVerification'
import Modal from '../components/ui/Modal'
import BillEditSection from '../components/account/BillEditSection'
import ManualSlipCheckSection from '../components/account/ManualSlipCheckSection'
import TaxInvoiceModal from '../components/account/TaxInvoiceModal'
import TrialBalanceSection from '../components/account/TrialBalanceSection'
import EcommerceSection from '../components/account/EcommerceSection'
import AmendmentSection from '../components/account/AmendmentSection'
import ClaimApprovalSection from '../components/account/ClaimApprovalSection'
import { SLIP_BANK_APPS_30D, SLIP_BANK_APPS_7D, bankLogoUrl } from '../config/thaiBanks'
import * as XLSX from 'xlsx'

type AccountSection = 'dashboard' | 'slip-verification' | 'manual-slip-check' | 'bill-edit' | 'amendment' | 'claim-approval' | 'slip-age' | 'ecommerce' | 'trial-balance'
type AccountTab = 'refunds' | 'claim-approval' | 'tax-invoice' | 'approvals'
type ApprovalFilter = 'refund' | 'claim' | 'tax-invoice'

type ClaimHistoryRow = {
  id: string
  ref_order_id: string
  claim_type: string
  status: string
  created_at: string
  reviewed_at: string | null
  rejected_reason: string | null
  created_claim_order_id: string | null
  ref_snapshot: { bill_no?: string; total_amount?: number } | null
  new_order?: { bill_no: string | null } | null
}

type VerifiedSlipRow = {
  id: string
  order_id: string
  verified_amount: number
  verified_at: string | null
  easyslip_date: string | null
  easyslip_response: Record<string, unknown> | null
  easyslip_receiver_account: string | null
  validation_status: string | null
  validation_errors: string[] | null
  expected_amount: number | null
  is_deleted: boolean | null
  deletion_reason: string | null
  or_orders: { bill_no: string | null; channel_code: string | null; admin_user: string | null } | null
}

type BillingRequestOrder = {
  id: string
  bill_no: string
  customer_name: string
  total_amount: number
  shipping_cost: number | null
  discount: number | null
  status: string
  created_at: string
  billing_details: any
  channel_code: string | null
  channel_order_no: string | null
}

/** ดึงชื่อบัญชีผู้โอนจาก easyslip_response (data.sender.account.name.th / .en) */
function getPayerName(res: Record<string, unknown> | null): string {
  if (!res?.data || typeof res.data !== 'object') return '–'
  const d = res.data as Record<string, unknown>
  const sender = d.sender as Record<string, unknown> | undefined
  const acc = sender?.account as Record<string, unknown> | undefined
  const nameObj = acc?.name as Record<string, string> | undefined
  if (nameObj?.th && typeof nameObj.th === 'string') return nameObj.th
  if (nameObj?.en && typeof nameObj.en === 'string') return nameObj.en
  if (sender?.name && typeof sender.name === 'string') return sender.name
  const from = d.from as Record<string, unknown> | undefined
  const fromAcc = from?.account as Record<string, unknown> | undefined
  if (fromAcc?.name && typeof fromAcc.name === 'string') return fromAcc.name
  if (from?.name && typeof from.name === 'string') return from.name
  return '–'
}

/** ดึงเลขบัญชีผู้โอนจาก easyslip_response (data.sender.account.bank.account) */
function getPayerAccountNumber(res: Record<string, unknown> | null): string {
  if (!res?.data || typeof res.data !== 'object') return '–'
  const d = res.data as Record<string, unknown>
  const sender = d.sender as Record<string, unknown> | undefined
  const acc = sender?.account as Record<string, unknown> | undefined
  const bank = acc?.bank as Record<string, unknown> | undefined
  if (bank?.account && typeof bank.account === 'string') return bank.account
  return '–'
}

function getReceiverName(res: Record<string, unknown> | null, fallbackAccount: string | null): string {
  if (!res?.data || typeof res.data !== 'object') return fallbackAccount || '–'
  const d = res.data as Record<string, unknown>
  const receiver = d.receiver as Record<string, unknown> | undefined
  const acc = receiver?.account as Record<string, unknown> | undefined
  if (acc?.name && typeof acc.name === 'string') return acc.name
  const bank = acc?.bank as Record<string, unknown> | undefined
  if (bank?.account && typeof bank.account === 'string') return bank.account
  return fallbackAccount || '–'
}

/** คืนค่าสถานะยอดสำหรับแถวสลิป: ซ้ำ, โอนเกิน, ยอดไม่พอ (หลายค่าแยกด้วย comma) */
function getTagLogic(row: VerifiedSlipRow): string {
  const tags: string[] = []
  const errs = row.validation_errors
  if (errs && Array.isArray(errs) && errs.some((e: string) => e.includes('สลิปซ้ำ') || e.includes('ซ้ำ'))) {
    tags.push('ซ้ำ')
  }
  const expected = row.expected_amount != null ? Number(row.expected_amount) : null
  const verified = Number(row.verified_amount)
  if (expected != null) {
    if (verified > expected) tags.push('โอนเกิน')
    else if (verified < expected) tags.push('ยอดไม่พอ')
  }
  return tags.length > 0 ? tags.join(', ') : '–'
}

/** แปลงข้อความเหตุผล refund เป็นรูปแบบใหม่ (รองรับข้อมูลเก่าที่ใช้รูปแบบเดิม) — ตัดคำนำหน้า โอนเกิน/ลูกค้าโอนเกิน เมื่อตามด้วย (ยอดบิล… */
function formatRefundReason(reason: string): string {
  let s = reason
    .replace('ยอดออเดอร์:', 'ยอดบิล:')
    .replace('ยอดสลิป:', 'สลิป:')
  s = s.replace(/^\s*ลูกค้าโอนเกิน\s*(?=\()/u, '')
  s = s.replace(/^\s*โอนเกิน\s*(?=\()/u, '')
  return s.trim()
}

async function fetchSlipImageUrlsForOrder(orderId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('ac_verified_slips')
    .select('slip_image_url, slip_storage_path')
    .eq('order_id', orderId)
    .or('is_deleted.is.null,is_deleted.eq.false')
    .order('created_at', { ascending: true })
  if (error) throw error
  const rows = (data || []) as { slip_image_url?: string; slip_storage_path?: string | null }[]
  const urls: string[] = []
  for (const r of rows) {
    if (r.slip_storage_path) {
      const raw = r.slip_storage_path
      const parts = raw.split('/')
      const bucket = parts[0] || 'slip-images'
      const filePath = parts.slice(1).join('/')
      let signedUrl: string | null = null
      const { data: signed, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(filePath, 3600)
      if (!signErr && signed?.signedUrl) signedUrl = signed.signedUrl
      if (!signedUrl && raw) {
        const retry = await supabase.storage
          .from('slip-images')
          .createSignedUrl(parts.length > 1 ? filePath : raw, 3600)
        if (!retry.error && retry.data?.signedUrl) signedUrl = retry.data.signedUrl
      }
      if (signedUrl) {
        urls.push(signedUrl)
        continue
      }
      if (signErr) console.warn('Slip signed URL failed:', raw, signErr)
    }
    if (r.slip_image_url) urls.push(r.slip_image_url)
  }
  return urls
}

const ALL_ACCOUNT_SECTIONS: AccountSection[] = [
  'dashboard', 'slip-verification', 'manual-slip-check',
  'bill-edit', 'amendment', 'claim-approval', 'slip-age', 'ecommerce', 'trial-balance',
]

/** แถบเมนูหลักบัญชี — รวมลิงก์เข้า Dashboard แยกแท็บโอนคืน / ใบกำกับภาษี */
const ACCOUNT_TOP_NAV_ITEMS: Array<{
  id: string
  section: AccountSection
  label: string
  dashboardTab?: AccountTab
  count?: 'manualSlip' | 'amendment' | 'refunds' | 'taxInvoice' | 'claimPending'
  accessKey?: string
}> = [
  { id: 'nav-dashboard', section: 'dashboard', label: 'Dashboard', accessKey: 'account-dashboard' },
  { id: 'nav-slip-verification', section: 'slip-verification', label: 'รายการการตรวจสลิป' },
  { id: 'nav-manual-slip', section: 'manual-slip-check', label: 'ตรวจสลิปมือ', count: 'manualSlip' },
  { id: 'nav-bill-edit', section: 'bill-edit', label: 'แก้ไขบิล' },
  { id: 'nav-amendment', section: 'amendment', label: 'ขอยกเลิกบิล', count: 'amendment' },
  { id: 'nav-claim-approval', section: 'claim-approval', label: 'อนุมัติเคลม', count: 'claimPending', accessKey: 'account-claim-approval' },
  { id: 'nav-slip-age', section: 'slip-age', label: 'อายุสลิป' },
  { id: 'nav-ecommerce', section: 'ecommerce', label: 'Ecommerce', accessKey: 'account-ecommerce' },
  { id: 'nav-trial', section: 'trial-balance', label: 'งบต้นทุนขาย' },
  { id: 'nav-refunds', section: 'dashboard', label: 'รายการโอนคืน', dashboardTab: 'refunds', count: 'refunds', accessKey: 'account-refunds' },
  { id: 'nav-tax-inv', section: 'dashboard', label: 'ขอใบกำกับภาษี', dashboardTab: 'tax-invoice', count: 'taxInvoice', accessKey: 'account-tax-invoice' },
]

export default function Account() {
  const { user } = useAuthContext()
  const { hasAccess, menuAccessLoading } = useMenuAccess()
  const [accountSection, setAccountSection] = useState<AccountSection>('dashboard')
  const [activeTab, setActiveTab] = useState<AccountTab>('refunds')
  /** แยกไฮไลต์แท็บ Dashboard กับแท็บย่อย "รายการโอนคืน" ในแถบบน (ทั้งคู่เปิด dashboard+refunds ได้) */
  const [dashboardFromOverview, setDashboardFromOverview] = useState(true)

  useEffect(() => {
    if (menuAccessLoading) return
    if (!hasAccess(`account-${accountSection}`)) {
      const first = ALL_ACCOUNT_SECTIONS.find((s) => hasAccess(`account-${s}`))
      if (first) setAccountSection(first)
    }
  }, [menuAccessLoading])

  const [orderToAmend, setOrderToAmend] = useState<(Order & { order_items?: any[] }) | null>(null)
  const [refunds, setRefunds] = useState<Refund[]>([])
  const [loading, setLoading] = useState(true)
  const [billingLoading, setBillingLoading] = useState(true)
  const [taxInvoiceOrders, setTaxInvoiceOrders] = useState<BillingRequestOrder[]>([])
  const [easyslipQuotaInfo, setEasyslipQuotaInfo] = useState<{
    usedQuota: number
    maxQuota: number
    remainingQuota: number
    expiredAt: string
    currentCredit: number
  } | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyTaxInvoices, setHistoryTaxInvoices] = useState<BillingRequestOrder[]>([])
  const [historyRefunds, setHistoryRefunds] = useState<Refund[]>([])
  const [historyClaimRequests, setHistoryClaimRequests] = useState<ClaimHistoryRow[]>([])
  const [viewOrderId, setViewOrderId] = useState<string | null>(null)
  /** เมื่อเปิดจากแถวรายการโอนคืน — แสดงรายละเอียดโอนเกินในโมดัลข้อมูลบิล */
  const [viewBillRefund, setViewBillRefund] = useState<Refund | null>(null)
  const [viewOrder, setViewOrder] = useState<(Order & { order_items?: any[] }) | null>(null)
  const [viewOrderLoading, setViewOrderLoading] = useState(false)
  const [billViewSlipUrls, setBillViewSlipUrls] = useState<string[]>([])
  const [billViewSlipLoading, setBillViewSlipLoading] = useState(false)
  const [billViewSlipFailed, setBillViewSlipFailed] = useState<Set<number>>(new Set())
  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>('refund')
  const [claimLabels, setClaimLabels] = useState<Record<string, string>>({})
  const [slipPopupOrderId, setSlipPopupOrderId] = useState<string | null>(null)
  const [slipPopupBillNo, setSlipPopupBillNo] = useState<string>('')
  const [slipPopupUrls, setSlipPopupUrls] = useState<string[]>([])
  const [slipPopupLoading, setSlipPopupLoading] = useState(false)
  const [slipPopupFailed, setSlipPopupFailed] = useState<Set<number>>(new Set())
  /** สลิปโอนคืน (เราโอนคืนลูกค้า) — thumbnail ต่อ refund + อัปโหลด + viewer */
  const [refundSlipThumbs, setRefundSlipThumbs] = useState<Record<string, string[]>>({})
  const [refundSlipUploadingId, setRefundSlipUploadingId] = useState<string | null>(null)
  const [refundSlipTargetId, setRefundSlipTargetId] = useState<string | null>(null)
  const refundSlipInputRef = useRef<HTMLInputElement | null>(null)
  const [refundSlipViewer, setRefundSlipViewer] = useState<{ billNo: string; urls: string[]; loading: boolean } | null>(null)
  const [refundSlipViewerFailed, setRefundSlipViewerFailed] = useState<Set<number>>(new Set())
  /** Popup ยืนยัน อนุมัติ/ปฏิเสธ โอนคืน — ใช้ Modal เดียว */
  const [refundActionModal, setRefundActionModal] = useState<{
    open: boolean
    refund: Refund | null
    action: 'approve' | 'reject' | null
    submitting: boolean
    /** เหตุผลไม่อนุมัติ (เฉพาะ action = reject) */
    rejectReason: string
  }>({ open: false, refund: null, action: null, submitting: false, rejectReason: '' })
  /** Modal แจ้งผลหลังอนุมัติ/ปฏิเสธโอนคืน (แทน alert) */
  const [refundResultModal, setRefundResultModal] = useState<{ open: boolean; message: string }>({ open: false, message: '' })
  /** Modal ยืนยัน ขอใบกำกับภาษี (แทน confirm) */
  const [billingConfirmModal, setBillingConfirmModal] = useState<{
    open: boolean
    order: BillingRequestOrder | null
    type: 'tax-invoice' | null
    submitting: boolean
  }>({ open: false, order: null, type: null, submitting: false })
  /** Modal แจ้งผลหลังยืนยันใบกำกับภาษี (แทน alert) */
  const [billingResultModal, setBillingResultModal] = useState<{ open: boolean; title: string; message: string }>({ open: false, title: '', message: '' })
  /** Modal เปิดใบกำกับภาษี */
  const [taxInvoiceModal, setTaxInvoiceModal] = useState<{ open: boolean; order: BillingRequestOrder | null; submitting: boolean; viewOnly: boolean }>({ open: false, order: null, submitting: false, viewOnly: false })
  /** Modal ยืนยัน ปิดคำขอใบกำกับภาษี (บิลถูกยกเลิก) — ปิดแล้วคำขอจะไม่กลับมาแสดงซ้ำ */
  const [closeTaxRequestModal, setCloseTaxRequestModal] = useState<{ open: boolean; order: BillingRequestOrder | null; submitting: boolean }>({ open: false, order: null, submitting: false })
  const [slipReceiverAccount, setSlipReceiverAccount] = useState<string | null>(null)
  /** รายการตรวจสลิป (เมนู รายการการตรวจสลิป) */
  const [verifiedSlipsList, setVerifiedSlipsList] = useState<VerifiedSlipRow[]>([])
  const [verifiedSlipsLoading, setVerifiedSlipsLoading] = useState(false)
  /** ตัวกรองรายการตรวจสลิป */
  const [slipFilterOrderTaker, setSlipFilterOrderTaker] = useState<string>('')
  const [slipFilterChannel, setSlipFilterChannel] = useState<string>('')
  const [slipFilterDateFrom, setSlipFilterDateFrom] = useState<string>(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [slipFilterDateTo, setSlipFilterDateTo] = useState<string>(() => new Date().toISOString().split('T')[0])

  /** ป้องกันกระพริบ: แสดง spinner เฉพาะครั้งแรกเท่านั้น */
  const initialLoadDone = useRef(false)

  const [manualSlipPendingOrdersCount, setManualSlipPendingOrdersCount] = useState(0)
  const [amendmentPendingCount, setAmendmentPendingCount] = useState(0)
  const [claimPendingCount, setClaimPendingCount] = useState(0)
  const [queueCountsLoading, setQueueCountsLoading] = useState(true)

  async function loadQueueCounts() {
    try {
      const [slipRes, amendRes, claimRes] = await Promise.all([
        supabase.from('ac_manual_slip_checks').select('order_id').eq('status', 'pending'),
        supabase.from('or_order_amendments').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('or_claim_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      ])
      if (slipRes.error) throw slipRes.error
      if (amendRes.error) throw amendRes.error
      if (claimRes.error) throw claimRes.error
      const orderIds = new Set((slipRes.data || []).map((r: { order_id: string }) => r.order_id))
      setManualSlipPendingOrdersCount(orderIds.size)
      setAmendmentPendingCount(amendRes.count ?? 0)
      setClaimPendingCount(claimRes.count ?? 0)
    } catch (e) {
      console.error('Error loading account queue counts:', e)
    } finally {
      setQueueCountsLoading(false)
    }
  }

  async function fetchOrderForView(orderId: string) {
    setViewOrderLoading(true)
    setViewOrder(null)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (error) throw error
      setViewOrder(data as any)
    } catch (e) {
      console.error('Error fetching order:', e)
      setViewOrder(null)
    } finally {
      setViewOrderLoading(false)
    }
  }

  useEffect(() => {
    if (viewOrderId) fetchOrderForView(viewOrderId)
    else setViewOrder(null)
  }, [viewOrderId])

  useEffect(() => {
    if (!viewOrderId || !viewBillRefund) {
      setBillViewSlipUrls([])
      setBillViewSlipFailed(new Set())
      setBillViewSlipLoading(false)
      return
    }
    let cancelled = false
    setBillViewSlipLoading(true)
    setBillViewSlipUrls([])
    setBillViewSlipFailed(new Set())
    fetchSlipImageUrlsForOrder(viewOrderId)
      .then((urls) => {
        if (!cancelled) setBillViewSlipUrls(urls)
      })
      .catch((e) => {
        console.error('Error loading slips for bill modal:', e)
        if (!cancelled) setBillViewSlipUrls([])
      })
      .finally(() => {
        if (!cancelled) setBillViewSlipLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [viewOrderId, viewBillRefund])

  async function loadVerifiedSlipsList() {
    setVerifiedSlipsLoading(true)
    try {
      const { data: slipsData, error: slipsError } = await supabase
        .from('ac_verified_slips')
        .select('id, order_id, verified_amount, verified_at, easyslip_date, easyslip_response, easyslip_receiver_account, validation_status, validation_errors, expected_amount, is_deleted, deletion_reason')
        .order('created_at', { ascending: false })
        .limit(2000)
      if (slipsError) throw slipsError
      const slips = (slipsData || []) as Omit<VerifiedSlipRow, 'or_orders'>[]
      const orderIds = [...new Set(slips.map((s) => s.order_id).filter(Boolean))]
      const orderMap: Record<string, { bill_no: string | null; channel_code: string | null; admin_user: string | null }> = {}
      if (orderIds.length > 0) {
        const { data: ordersData, error: ordersError } = await supabase
          .from('or_orders')
          .select('id, bill_no, channel_code, admin_user')
          .in('id', orderIds)
        if (!ordersError && ordersData) {
          ordersData.forEach((o: { id: string; bill_no: string | null; channel_code: string | null; admin_user: string | null }) => {
            orderMap[o.id] = { bill_no: o.bill_no ?? null, channel_code: o.channel_code ?? null, admin_user: o.admin_user ?? null }
          })
        }
      }
      const rows: VerifiedSlipRow[] = slips.map((s) => ({
        ...s,
        or_orders: orderMap[s.order_id] ?? null,
      }))
      setVerifiedSlipsList(rows)
    } catch (e) {
      console.error('Error loading verified slips:', e)
      setVerifiedSlipsList([])
    } finally {
      setVerifiedSlipsLoading(false)
    }
  }

  useEffect(() => {
    if (accountSection === 'slip-verification') loadVerifiedSlipsList()
  }, [accountSection])

  /** รายการตรวจสลิปหลังกรอง (ผู้ลงออเดอร์, ช่องทาง, ช่วงวันที่) */
  const filteredSlipsList = useMemo(() => {
    let list = verifiedSlipsList
    if (slipFilterOrderTaker.trim()) {
      const q = slipFilterOrderTaker.trim().toLowerCase()
      list = list.filter((r) => (r.or_orders?.admin_user ?? '').toLowerCase().includes(q))
    }
    if (slipFilterChannel.trim()) {
      const q = slipFilterChannel.trim().toLowerCase()
      list = list.filter((r) => (r.or_orders?.channel_code ?? '').toLowerCase().includes(q))
    }
    if (slipFilterDateFrom || slipFilterDateTo) {
      list = list.filter((r) => {
        const dt = r.easyslip_date || r.verified_at || ''
        if (!dt) return false
        const d = new Date(dt)
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        const dateOnly = `${y}-${m}-${day}`
        if (slipFilterDateFrom && dateOnly < slipFilterDateFrom) return false
        if (slipFilterDateTo && dateOnly > slipFilterDateTo) return false
        return true
      })
    }
    return list
  }, [verifiedSlipsList, slipFilterOrderTaker, slipFilterChannel, slipFilterDateFrom, slipFilterDateTo])

  /** ค่าที่ใช้ใน dropdown ตัวกรอง (ผู้ลงออเดอร์, ช่องทาง) */
  const slipFilterOrderTakerOptions = useMemo(() => {
    const set = new Set<string>()
    verifiedSlipsList.forEach((r) => {
      const v = r.or_orders?.admin_user ?? ''
      if (v) set.add(v)
    })
    return Array.from(set).sort()
  }, [verifiedSlipsList])
  const slipFilterChannelOptions = useMemo(() => {
    const set = new Set<string>()
    verifiedSlipsList.forEach((r) => {
      const v = r.or_orders?.channel_code ?? ''
      if (v) set.add(v)
    })
    return Array.from(set).sort()
  }, [verifiedSlipsList])

  async function openSlipPopup(orderId: string, billNo: string) {
    setSlipPopupOrderId(orderId)
    setSlipPopupBillNo(billNo)
    setSlipPopupUrls([])
    setSlipPopupFailed(new Set())
    setSlipPopupLoading(true)
    try {
      const urls = await fetchSlipImageUrlsForOrder(orderId)
      setSlipPopupUrls(urls)
    } catch (e) {
      console.error('Error fetching slip images:', e)
      setSlipPopupUrls([])
    } finally {
      setSlipPopupLoading(false)
    }
  }

  // ── สลิปโอนคืน: โหลด thumbnail (signed URL) ของ refund ที่อนุมัติแล้ว + มีสลิป ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const map: Record<string, string[]> = {}
      for (const r of historyRefunds) {
        const paths = r.refund_slip_paths || []
        if (r.status === 'approved' && paths.length > 0) {
          const urls = await getSignedUrlsFromStoragePaths(paths)
          if (cancelled) return
          map[r.id] = urls
        }
      }
      if (!cancelled) setRefundSlipThumbs(map)
    })()
    return () => { cancelled = true }
  }, [historyRefunds])

  function triggerRefundSlipUpload(refundId: string) {
    setRefundSlipTargetId(refundId)
    refundSlipInputRef.current?.click()
  }

  async function onRefundSlipFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    const refundId = refundSlipTargetId
    if (!refundId || files.length === 0) { setRefundSlipTargetId(null); return }
    setRefundSlipUploadingId(refundId)
    try {
      const newPaths = await uploadMultipleToStorage(files, 'slip-images', `refunds/${refundId}`)
      const existing = historyRefunds.find((r) => r.id === refundId)?.refund_slip_paths || []
      const merged = [...existing, ...newPaths]
      const { error } = await supabase.from('ac_refunds').update({ refund_slip_paths: merged }).eq('id', refundId)
      if (error) throw error
      await loadHistory()
    } catch (err: any) {
      console.error('Error uploading refund slip:', err)
      setRefundResultModal({ open: true, message: 'อัปโหลดสลิปโอนคืนไม่สำเร็จ: ' + (err?.message || err) })
    } finally {
      setRefundSlipUploadingId(null)
      setRefundSlipTargetId(null)
    }
  }

  async function openRefundSlipViewer(refund: Refund) {
    const billNo = (refund as any).or_orders?.bill_no || '–'
    setRefundSlipViewerFailed(new Set())
    setRefundSlipViewer({ billNo, urls: [], loading: true })
    try {
      const urls = await getSignedUrlsFromStoragePaths(refund.refund_slip_paths || [])
      setRefundSlipViewer({ billNo, urls, loading: false })
    } catch (e) {
      console.error('Error loading refund slip images:', e)
      setRefundSlipViewer({ billNo, urls: [], loading: false })
    }
  }

  useEffect(() => {
    Promise.all([
      loadRefunds(),
      loadEasySlipQuota(),
      loadBillingRequests(),
      loadHistory(),
      loadQueueCounts(),
    ]).finally(() => {
      initialLoadDone.current = true
    })
  }, [])

  useEffect(() => {
    void fetchClaimTypeLabelMap().then(setClaimLabels)
  }, [])

  // เรียลไทม์: Realtime เมื่อข้อมูลคิวบัญชีเปลี่ยน
  useEffect(() => {
    const channel = supabase
      .channel('account-counts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_orders' }, () => {
        loadBillingRequests()
        loadQueueCounts()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_refunds' }, () => {
        loadRefunds()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ac_manual_slip_checks' }, () => {
        loadQueueCounts()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_order_amendments' }, () => {
        loadQueueCounts()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'or_claim_requests' }, () => {
        loadQueueCounts()
        loadHistory()
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  useEffect(() => {
    const onRefreshHistory = () => {
      void loadHistory()
    }
    window.addEventListener('account-refresh-history', onRefreshHistory as EventListener)
    return () => window.removeEventListener('account-refresh-history', onRefreshHistory as EventListener)
  }, [])

  // เรียลไทม์: โพลทุก 30 วินาทีเมื่ออยู่ที่ Dashboard และแท็บเปิดอยู่
  useEffect(() => {
    if (accountSection !== 'dashboard') return
    const POLL_MS = 30_000
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadRefunds()
        loadBillingRequests()
        loadQueueCounts()
      }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [accountSection])

  // อัปเดตตัวเลขเมื่อกลับมาเปิดแท็บ
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadRefunds()
        loadBillingRequests()
        loadQueueCounts()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  async function loadRefunds() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setLoading(true)
    try {
      const { data, error } = await supabase
        .from('ac_refunds')
        .select('*, or_orders(bill_no, customer_name, status)')
        .order('created_at', { ascending: false })

      if (error) throw error
      
      // กรองเฉพาะรายการโอนเกิน — แสดงได้ทุกสถานะบิลที่ยังไม่ยกเลิก
      // (เดิมจำกัดแค่ "จัดส่งแล้ว" ทำให้รายการที่สร้างตอน ตรวจสอบแล้ว/คอนเฟิร์ม ฯลฯ ไม่ขึ้นในเมนูบัญชี)
      const filteredRefunds = (data || []).filter((refund: any) => {
        const reason = refund.reason != null ? String(refund.reason) : ''
        if (!reason.includes('โอนเกิน')) return false
        const st = (refund as any).or_orders?.status as string | undefined
        if (st === 'ยกเลิก') return false
        return true
      })
      
      setRefunds(filteredRefunds)
    } catch (error: any) {
      console.error('Error loading refunds:', error)
    } finally {
      setLoading(false)
    }
  }

  async function loadEasySlipQuota() {
    setQuotaLoading(true)
    try {
      console.log('[Account] Loading EasySlip quota...')
      const result = await getEasySlipQuota()
      console.log('[Account] getEasySlipQuota result:', result)
      
      if (result.success && result.data) {
        console.log('[Account] Quota data received:', result.data)
        setEasyslipQuotaInfo(result.data)
      } else {
        console.error('[Account] Error loading EasySlip quota:', result.error)
        setEasyslipQuotaInfo(null)
      }
    } catch (error: any) {
      console.error('[Account] Exception loading EasySlip quota:', error)
      setEasyslipQuotaInfo(null)
    } finally {
      setQuotaLoading(false)
    }
  }

  async function loadBillingRequests() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setBillingLoading(true)
    try {
      const excludeBillingStatuses = '("รอลงข้อมูล","ลงข้อมูลผิด","ตรวจสอบไม่ผ่าน","ตรวจสอบไม่สำเร็จ")'
      const { data: taxData, error: taxError } = await supabase
        .from('or_orders')
        .select('id, bill_no, customer_name, total_amount, shipping_cost, discount, status, created_at, billing_details, claim_type, channel_code, channel_order_no')
        .contains('billing_details', { request_tax_invoice: true })
        .not('status', 'in', excludeBillingStatuses)
        .order('created_at', { ascending: false })

      if (taxError) throw taxError

      const filteredTax = ((taxData || []) as BillingRequestOrder[]).filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return !bd.account_confirmed_tax
      })

      setTaxInvoiceOrders(filteredTax)
    } catch (error: any) {
      console.error('Error loading billing requests:', error)
    } finally {
      setBillingLoading(false)
    }
  }

  function openRefundActionModal(refund: Refund, action: 'approve' | 'reject') {
    setRefundActionModal({ open: true, refund, action, submitting: false, rejectReason: '' })
  }

  function closeRefundActionModal() {
    if (!refundActionModal.submitting) {
      setRefundActionModal({ open: false, refund: null, action: null, submitting: false, rejectReason: '' })
    }
  }

  async function submitRefundAction() {
    const { refund, action, rejectReason } = refundActionModal
    if (!user || !refund || !action) return
    setRefundActionModal((prev) => ({ ...prev, submitting: true }))
    try {
      const { error } = await supabase
        .from('ac_refunds')
        .update({
          status: action === 'approve' ? 'approved' : 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          rejected_reason: action === 'reject' ? (rejectReason.trim() || null) : null,
        })
        .eq('id', refund.id)

      if (error) throw error
      setRefundActionModal({ open: false, refund: null, action: null, submitting: false, rejectReason: '' })
      setRefundResultModal({
        open: true,
        message: action === 'approve' ? 'อนุมัติการโอนคืนสำเร็จ' : 'ปฏิเสธการโอนคืนสำเร็จ',
      })
      loadRefunds()
      loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error updating refund:', error)
      setRefundActionModal((prev) => ({ ...prev, submitting: false }))
      setRefundResultModal({ open: true, message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  async function loadHistory() {
    // แสดง spinner เฉพาะครั้งแรก — ป้องกันหน้ากระพริบเมื่อ refresh เบื้องหลัง
    if (!initialLoadDone.current) setHistoryLoading(true)
    try {
      const historyExcludeStatuses = '("ตรวจสอบไม่ผ่าน","รอลงข้อมูล","ลงข้อมูลผิด")'
      const [taxRes, refundRes, claimRes] = await Promise.all([
        supabase
          .from('or_orders')
          .select('id, bill_no, customer_name, total_amount, shipping_cost, discount, status, created_at, billing_details, claim_type, channel_code, channel_order_no')
          .contains('billing_details', { request_tax_invoice: true })
          .not('status', 'in', historyExcludeStatuses)
          .order('created_at', { ascending: false }),
        supabase
          .from('ac_refunds')
          .select('*, or_orders(bill_no, customer_name, customer_address)')
          .in('status', ['approved', 'rejected'])
          .order('created_at', { ascending: false }),
        supabase
          .from('or_claim_requests')
          .select(
            'id, ref_order_id, claim_type, status, created_at, reviewed_at, rejected_reason, created_claim_order_id, ref_snapshot',
          )
          .in('status', ['approved', 'rejected'])
          .order('reviewed_at', { ascending: false }),
      ])

      if ((taxRes as any).error) throw (taxRes as any).error
      if ((refundRes as any).error) throw (refundRes as any).error
      if ((claimRes as any).error) throw (claimRes as any).error

      const taxData = ((taxRes as any).data || []) as BillingRequestOrder[]
      const confirmedTax = taxData.filter((o: BillingRequestOrder) => {
        const bd = o.billing_details || {}
        return bd.account_confirmed_tax === true
      })

      setHistoryTaxInvoices(confirmedTax)
      setHistoryRefunds(((refundRes as any).data || []) as Refund[])

      const claimRows = ((claimRes as any).data || []) as Omit<ClaimHistoryRow, 'new_order'>[]
      const claimOrderIds = [
        ...new Set(claimRows.map((r) => r.created_claim_order_id).filter((id): id is string => Boolean(id))),
      ]
      let claimBillById: Record<string, string> = {}
      if (claimOrderIds.length > 0) {
        const { data: ordRows } = await supabase.from('or_orders').select('id, bill_no').in('id', claimOrderIds)
        claimBillById = Object.fromEntries((ordRows || []).map((o: { id: string; bill_no: string }) => [o.id, o.bill_no]))
      }
      setHistoryClaimRequests(
        claimRows.map((r) => ({
          ...r,
          new_order: r.created_claim_order_id
            ? { bill_no: claimBillById[r.created_claim_order_id] ?? null }
            : null,
        })),
      )
    } catch (error: any) {
      console.error('Error loading history:', error)
    } finally {
      setHistoryLoading(false)
    }
  }

  // @ts-ignore TS6133 - kept for future use
  function openConfirmTaxInvoice(order: BillingRequestOrder) {
    setBillingConfirmModal({ open: true, order, type: 'tax-invoice', submitting: false })
  }

  function closeBillingConfirmModal() {
    if (!billingConfirmModal.submitting) {
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
    }
  }

  async function submitBillingConfirm() {
    const { order, type } = billingConfirmModal
    if (!user || !order || !type) return
    setBillingConfirmModal((prev) => ({ ...prev, submitting: true }))

    try {
      const bd = order.billing_details || {}
      const newBillingDetails = { ...bd, account_confirmed_tax: true, account_confirmed_tax_at: new Date().toISOString(), account_confirmed_tax_by: user.id }

      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)

      if (error) throw error
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
      setBillingResultModal({ open: true, title: 'สำเร็จ', message: 'ยืนยันใบกำกับภาษีเรียบร้อย' })
      await loadBillingRequests()
      await loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error confirming tax invoice:', error)
      setBillingConfirmModal({ open: false, order: null, type: null, submitting: false })
      setBillingResultModal({ open: true, title: 'เกิดข้อผิดพลาด', message: 'เกิดข้อผิดพลาดในการยืนยันใบกำกับภาษี: ' + error.message })
    }
  }

  async function confirmTaxInvoice(order: BillingRequestOrder) {
    setSlipReceiverAccount(null)
    setTaxInvoiceModal({ open: true, order, submitting: false, viewOnly: false })
    const { data: slips } = await supabase
      .from('ac_verified_slips')
      .select('easyslip_receiver_account')
      .eq('order_id', order.id)
      .eq('is_deleted', false)
      .not('easyslip_receiver_account', 'is', null)
      .limit(1)
    if (slips && slips.length > 0 && slips[0].easyslip_receiver_account) {
      setSlipReceiverAccount(slips[0].easyslip_receiver_account)
    }
  }

  /** เปิดใบกำกับภาษีแบบดูอย่างเดียว (จากเมนูรายการอนุมัติ) */
  function viewTaxInvoice(order: BillingRequestOrder) {
    setTaxInvoiceModal({ open: true, order, submitting: false, viewOnly: true })
  }

  /** ปิดคำขอใบกำกับภาษีของบิลที่ถูกยกเลิก — mark ใน billing_details เพื่อไม่ให้แสดงซ้ำ (แม้บิลถูกแก้ไขภายหลัง) */
  async function submitCloseTaxRequest() {
    const { order } = closeTaxRequestModal
    if (!user || !order) return
    setCloseTaxRequestModal((prev) => ({ ...prev, submitting: true }))
    try {
      const bd = order.billing_details || {}
      const newBillingDetails = {
        ...bd,
        // ใช้ flag ชุดเดียวกับการยืนยัน เพื่อให้หายจากคิว/badge ทุกจุด (RPC sidebar นับจาก account_confirmed_tax)
        account_confirmed_tax: true,
        account_confirmed_tax_at: new Date().toISOString(),
        account_confirmed_tax_by: user.id,
        // flag แยกไว้บอกว่า "ปิดคำขอเพราะบิลยกเลิก" ไม่ใช่การอนุมัติออกใบกำกับ
        tax_request_closed: true,
        tax_request_closed_reason: 'ยกเลิกบิล',
      }
      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)
      if (error) throw error
      setCloseTaxRequestModal({ open: false, order: null, submitting: false })
      setBillingResultModal({ open: true, title: 'สำเร็จ', message: `ปิดคำขอใบกำกับภาษีของบิล ${order.bill_no} แล้ว — รายการนี้จะไม่แสดงซ้ำอีก` })
      await loadBillingRequests()
      await loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error closing tax invoice request:', error)
      setCloseTaxRequestModal({ open: false, order: null, submitting: false })
      setBillingResultModal({ open: true, title: 'เกิดข้อผิดพลาด', message: 'เกิดข้อผิดพลาดในการปิดคำขอ: ' + error.message })
    }
  }

  async function submitTaxInvoiceConfirm(order: BillingRequestOrder) {
    if (!user) return
    setTaxInvoiceModal((prev) => ({ ...prev, submitting: true }))
    try {
      const bd = order.billing_details || {}
      const newBillingDetails = {
        ...bd,
        account_confirmed_tax: true,
        account_confirmed_tax_at: new Date().toISOString(),
        account_confirmed_tax_by: user.id,
      }
      const { error } = await supabase
        .from('or_orders')
        .update({ billing_details: newBillingDetails })
        .eq('id', order.id)
      if (error) throw error
      setTaxInvoiceModal({ open: false, order: null, submitting: false, viewOnly: false })
      setBillingResultModal({ open: true, title: 'สำเร็จ', message: 'ยืนยันใบกำกับภาษีเรียบร้อย' })
      await loadBillingRequests()
      await loadHistory()
      window.dispatchEvent(new CustomEvent('sidebar-refresh-counts'))
    } catch (error: any) {
      console.error('Error confirming tax invoice:', error)
      setTaxInvoiceModal({ open: false, order: null, submitting: false, viewOnly: false })
      setBillingResultModal({ open: true, title: 'เกิดข้อผิดพลาด', message: 'เกิดข้อผิดพลาดในการยืนยันใบกำกับภาษี: ' + error.message })
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[280px]">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-blue-500 border-t-transparent" />
          <p className="text-sm text-gray-500">กำลังโหลด...</p>
        </div>
      </div>
    )
  }

  const pendingRefunds = refunds.filter((r) => r.status === 'pending')

  function accountTopNavActive(item: (typeof ACCOUNT_TOP_NAV_ITEMS)[number]): boolean {
    if (accountSection !== item.section) return false
    if (item.section !== 'dashboard') return true
    if (item.id === 'nav-dashboard') {
      return activeTab === 'approvals' || (activeTab === 'refunds' && dashboardFromOverview)
    }
    if (item.dashboardTab === 'refunds') return activeTab === 'refunds' && !dashboardFromOverview
    if (item.dashboardTab === 'claim-approval') return activeTab === 'claim-approval' && !dashboardFromOverview
    if (item.dashboardTab === 'tax-invoice') return activeTab === 'tax-invoice'
    return false
  }

  function accountTopNavCountPill(item: (typeof ACCOUNT_TOP_NAV_ITEMS)[number]): { text: string; pillClass: string } | null {
    if (!item.count) return null
    if (item.count === 'manualSlip') {
      return {
        text: queueCountsLoading ? '–' : String(manualSlipPendingOrdersCount),
        pillClass: 'bg-violet-100 text-violet-800',
      }
    }
    if (item.count === 'amendment') {
      return {
        text: queueCountsLoading ? '–' : String(amendmentPendingCount),
        pillClass: 'bg-amber-100 text-amber-800',
      }
    }
    if (item.count === 'refunds') {
      return {
        text: loading ? '–' : String(pendingRefunds.length),
        pillClass: 'bg-amber-100 text-amber-800',
      }
    }
    if (item.count === 'taxInvoice') {
      return {
        text: billingLoading ? '–' : String(taxInvoiceOrders.length),
        pillClass: 'bg-sky-100 text-sky-800',
      }
    }
    if (item.count === 'claimPending') {
      return {
        text: queueCountsLoading ? '–' : String(claimPendingCount),
        pillClass: 'bg-amber-100 text-amber-800',
      }
    }
    return null
  }

  return (
    <div className="space-y-8">
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3 overflow-x-auto">
          {ACCOUNT_TOP_NAV_ITEMS.filter((item) => hasAccess(item.accessKey ?? `account-${item.section}`)).map((item) => {
            const pill = accountTopNavCountPill(item)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setAccountSection(item.section)
                  if (item.id === 'nav-dashboard') {
                    setActiveTab('refunds')
                    setDashboardFromOverview(true)
                  } else if (item.dashboardTab != null) {
                    setActiveTab(item.dashboardTab)
                    setDashboardFromOverview(false)
                  }
                }}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors inline-flex items-center gap-2 ${accountTopNavActive(item) ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
              >
                {item.label}
                {pill && (
                  <span
                    className={`min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold tabular-nums ${pill.pillClass}`}
                  >
                    {pill.text}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {accountSection === 'slip-verification' ? (
        <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">รายการการตรวจสลิป</h2>
              <p className="text-sm text-gray-500 mt-0.5">รายการตรวจสลิปทั้งหมดจากตาราง ac_verified_slips</p>
            </div>
            <button
              type="button"
              onClick={() => {
                const headers = ['วันที่โอน', 'เวลาโอน', 'ชื่อบัญชีผู้โอน', 'เลขบัญชี', 'ชื่อบัญชีผู้รับโอน', 'ช่องทางขาย', 'ผู้ขาย', 'ยอดเงิน', 'สถานะยอด', 'ผลตรวจ', 'เลขบิล', 'สถานะสลิป', 'เหตุผลการลบ']
                const rows = filteredSlipsList.map((row) => {
                  const dt = row.easyslip_date || row.verified_at || ''
                  let dateStr = '–'
                  let timeStr = '–'
                  if (dt) {
                    const formatted = formatDateTime(dt)
                    const parts = formatted.split(' ')
                    timeStr = parts.length > 0 ? (parts[parts.length - 1] || '–') : '–'
                    dateStr = parts.length > 1 ? parts.slice(0, -1).join(' ') : formatted
                  }
                  return [
                    dateStr,
                    timeStr,
                    getPayerName(row.easyslip_response),
                    getPayerAccountNumber(row.easyslip_response),
                    getReceiverName(row.easyslip_response, row.easyslip_receiver_account),
                    row.or_orders?.channel_code ?? '–',
                    row.or_orders?.admin_user ?? '–',
                    row.verified_amount,
                    getTagLogic(row),
                    row.validation_status === 'passed' ? 'ผ่าน' : row.validation_status === 'failed' ? 'ไม่ผ่าน' : row.validation_status ?? '–',
                    row.or_orders?.bill_no ?? '–',
                    row.is_deleted ? 'ลบ' : 'ปกติ',
                    row.deletion_reason ?? '–',
                  ]
                })
                const wb = XLSX.utils.book_new()
                const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
                XLSX.utils.book_append_sheet(wb, ws, 'รายการตรวจสลิป')
                XLSX.writeFile(wb, 'รายการตรวจสลิป.xlsx')
              }}
              disabled={verifiedSlipsLoading || filteredSlipsList.length === 0}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ดาวน์โหลด Excel
            </button>
          </div>
          {/* ตัวกรอง: ผู้ลงออเดอร์, ช่องทาง, ช่วงวันที่ */}
          <div className="px-6 py-3 border-b border-gray-100 bg-gray-50/30 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">ผู้ลงออเดอร์</span>
              <select
                value={slipFilterOrderTaker}
                onChange={(e) => setSlipFilterOrderTaker(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm min-w-[120px] bg-white"
              >
                <option value="">ทั้งหมด</option>
                {slipFilterOrderTakerOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">ช่องทาง</span>
              <select
                value={slipFilterChannel}
                onChange={(e) => setSlipFilterChannel(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm min-w-[120px] bg-white"
              >
                <option value="">ทั้งหมด</option>
                {slipFilterChannelOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <span className="whitespace-nowrap">วันที่</span>
              <input
                type="date"
                value={slipFilterDateFrom}
                onChange={(e) => setSlipFilterDateFrom(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white"
              />
            </label>
            <span className="text-gray-400 text-sm">ถึง</span>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="date"
                value={slipFilterDateTo}
                onChange={(e) => setSlipFilterDateTo(e.target.value)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm bg-white"
              />
            </label>
            {(slipFilterOrderTaker || slipFilterChannel || slipFilterDateFrom || slipFilterDateTo) && (
              <button
                type="button"
                onClick={() => {
                  const now = new Date()
                  setSlipFilterOrderTaker('')
                  setSlipFilterChannel('')
                  setSlipFilterDateFrom(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`)
                  setSlipFilterDateTo(now.toISOString().split('T')[0])
                }}
                className="text-sm text-blue-600 hover:underline"
              >
                ล้างตัวกรอง
              </button>
            )}
          </div>
          {verifiedSlipsLoading ? (
            <div className="flex justify-center items-center py-14">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">วันที่โอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">เวลาโอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">ชื่อบัญชีผู้โอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">เลขบัญชี</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">ชื่อบัญชีผู้รับโอน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ช่องทางขาย</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ผู้ขาย</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ยอดเงิน</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">สถานะยอด</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">ผลตรวจ</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">เลขบิล</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">สถานะสลิป</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700">เหตุผลการลบ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSlipsList.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-4 py-12 text-center text-gray-500">
                        ไม่พบรายการตรวจสลิป
                      </td>
                    </tr>
                  ) : (
                    filteredSlipsList.map((row) => {
                      const dt = row.easyslip_date || row.verified_at || ''
                      let dateStr = '–'
                      let timeStr = '–'
                      if (dt) {
                        const formatted = formatDateTime(dt)
                        const parts = formatted.split(' ')
                        timeStr = parts.length > 0 ? (parts[parts.length - 1] || '–') : '–'
                        dateStr = parts.length > 1 ? parts.slice(0, -1).join(' ') : formatted
                      }
                      return (
                        <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                          <td className="px-4 py-3 text-center text-gray-800 whitespace-nowrap">{dateStr}</td>
                          <td className="px-4 py-3 text-center text-gray-800 whitespace-nowrap">{timeStr}</td>
                          <td className="px-4 py-3 text-center text-gray-700">{getPayerName(row.easyslip_response)}</td>
                          <td className="px-4 py-3 text-center text-gray-700 font-mono text-xs">{getPayerAccountNumber(row.easyslip_response)}</td>
                          <td className="px-4 py-3 text-center text-gray-700">{getReceiverName(row.easyslip_response, row.easyslip_receiver_account)}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{row.or_orders?.channel_code ?? '–'}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{row.or_orders?.admin_user ?? '–'}</td>
                          <td className="px-4 py-3 text-center font-medium text-gray-800 tabular-nums">฿{Number(row.verified_amount).toLocaleString()}</td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{getTagLogic(row)}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={row.validation_status === 'passed' ? 'text-emerald-600' : row.validation_status === 'failed' ? 'text-red-600' : 'text-gray-500'}>
                              {row.validation_status === 'passed' ? 'ผ่าน' : row.validation_status === 'failed' ? 'ไม่ผ่าน' : row.validation_status ?? '–'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center text-gray-700 whitespace-nowrap">{row.or_orders?.bill_no ?? '–'}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={row.is_deleted ? 'text-amber-600 font-medium' : 'text-gray-600'}>{row.is_deleted ? 'ลบ' : 'ปกติ'}</span>
                          </td>
                          <td className="px-4 py-3 text-center text-gray-600 max-w-[200px] truncate" title={row.deletion_reason ?? ''}>{row.deletion_reason ?? '–'}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : accountSection === 'manual-slip-check' ? (
        <ManualSlipCheckSection />
      ) : accountSection === 'bill-edit' ? (
        <BillEditSection
          onRequestAmendment={(order) => {
            setOrderToAmend(order)
            setAccountSection('amendment')
          }}
        />
      ) : accountSection === 'amendment' ? (
        <AmendmentSection
          orderToAmend={orderToAmend || undefined}
          onDone={() => { setOrderToAmend(null) }}
        />
      ) : accountSection === 'claim-approval' ? (
        <ClaimApprovalSection />
      ) : accountSection === 'slip-age' ? (
        <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
            <h2 className="text-lg font-bold text-gray-800">อายุสลิปที่รองรับการตรวจสอบ</h2>
            <p className="text-sm text-gray-500 mt-1">ระยะเวลาที่สลิปสามารถนำมาตรวจสอบได้ แยกตามแอปพลิเคชันธนาคาร</p>
          </div>
          <div className="p-6 space-y-6">
            {/* 30 วัน */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-green-100 text-green-700">
                  <i className="fas fa-calendar-check mr-1.5"></i>30 วัน
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {SLIP_BANK_APPS_30D.map((app) => (
                  <div key={app.name} className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-lg border border-gray-100 hover:border-green-200 hover:bg-green-50/30 transition-colors">
                    <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center p-2" style={{ backgroundColor: app.brandColor }}>
                      <img src={bankLogoUrl(app.logo)} alt={app.bank} className="w-full h-full object-contain" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-800 text-sm">{app.name}</div>
                      <div className="text-xs text-gray-500">{app.bank}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 7 วัน */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-amber-100 text-amber-700">
                  <i className="fas fa-calendar-day mr-1.5"></i>7 วัน
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {SLIP_BANK_APPS_7D.map((app) => (
                  <div key={app.name} className="flex items-center gap-3 p-3.5 bg-gray-50 rounded-lg border border-gray-100 hover:border-amber-200 hover:bg-amber-50/30 transition-colors">
                    <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center p-2" style={{ backgroundColor: app.brandColor }}>
                      <img src={bankLogoUrl(app.logo)} alt={app.bank} className="w-full h-full object-contain" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-800 text-sm">{app.name}</div>
                      <div className="text-xs text-gray-500">{app.bank}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* หมายเหตุ */}
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-blue-800">
              <div className="flex gap-2">
                <i className="fas fa-info-circle mt-0.5 shrink-0"></i>
                <div>
                  <p className="font-semibold mb-1">หมายเหตุ</p>
                  <p>อายุสลิป คือ ระยะเวลาตั้งแต่วันที่ทำรายการโอนเงิน จนถึงวันที่นำสลิปมาตรวจสอบผ่านระบบ EasySlip หากเกินระยะเวลาที่กำหนด สลิปจะไม่สามารถตรวจสอบได้</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : accountSection === 'ecommerce' ? (
        <EcommerceSection />
      ) : accountSection === 'trial-balance' ? (
        <TrialBalanceSection />
      ) : (
        <>
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden flex flex-col">
          <div className="h-1 w-full bg-blue-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">EasySlip โควต้า</p>
            {quotaLoading ? (
              <div className="mt-3 flex items-center gap-2">
                <div className="h-8 w-16 rounded bg-gray-200 animate-pulse" />
                <span className="text-base text-gray-400">โหลด...</span>
              </div>
            ) : easyslipQuotaInfo ? (
              <>
                <p className="mt-3 text-4xl font-bold text-blue-600 tabular-nums">
                  {easyslipQuotaInfo.remainingQuota.toLocaleString()}
                </p>
                <p className="text-sm text-gray-500 mt-1">คงเหลือ</p>
                <div className="mt-4 pt-4 border-t border-gray-100 space-y-1.5 text-sm text-gray-600">
                  <p>ใช้แล้ว {easyslipQuotaInfo.usedQuota.toLocaleString()} / {easyslipQuotaInfo.maxQuota.toLocaleString()}</p>
                  <p>หมดอายุ {formatDateTime(easyslipQuotaInfo.expiredAt)}</p>
                  <p>เครดิต {easyslipQuotaInfo.currentCredit.toLocaleString()}</p>
                </div>
              </>
            ) : (
              <p className="mt-3 text-base text-red-600">โหลดโควต้าไม่ได้</p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => { setActiveTab('refunds'); setDashboardFromOverview(false) }}
          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden text-left hover:shadow-md hover:border-amber-200 transition-all focus:outline-none focus:ring-2 focus:ring-amber-400 focus:ring-offset-1 flex flex-col"
        >
          <div className="h-1 w-full bg-amber-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">รออนุมัติโอนคืน</p>
            <p className="mt-3 text-4xl font-bold text-amber-600 tabular-nums">{pendingRefunds.length}</p>
            <p className="text-sm text-gray-500 mt-1">รายการ</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => { setActiveTab('tax-invoice'); setDashboardFromOverview(false) }}
          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden text-left hover:shadow-md hover:border-sky-200 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-1 flex flex-col"
        >
          <div className="h-1 w-full bg-sky-500 shrink-0" />
          <div className="p-5 flex-1">
            <p className="text-base font-medium text-gray-500 uppercase tracking-wide">ขอใบกำกับภาษี</p>
            <p className="mt-3 text-4xl font-bold text-sky-600 tabular-nums">
              {billingLoading ? '–' : taxInvoiceOrders.length}
            </p>
            <p className="text-sm text-gray-500 mt-1">รายการ</p>
          </div>
        </button>

      </section>

      {/* แถบเมนูย่อย — แสดงตัวเลขแบบเรียลไทม์ */}
      <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max border-b border-surface-200 overflow-x-auto">
        {hasAccess('account-refunds') && (
        <button
          type="button"
          onClick={() => { setActiveTab('refunds'); setDashboardFromOverview(false) }}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'refunds' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          รายการโอนคืน
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {loading ? '–' : pendingRefunds.length}
          </span>
        </button>
        )}
        {hasAccess('account-claim-approval') && (
        <button
          type="button"
          onClick={() => { setActiveTab('claim-approval'); setDashboardFromOverview(false) }}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'claim-approval' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          อนุมัติเคลม
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {queueCountsLoading ? '–' : claimPendingCount}
          </span>
        </button>
        )}
        {hasAccess('account-tax-invoice') && (
        <button
          type="button"
          onClick={() => { setActiveTab('tax-invoice'); setDashboardFromOverview(false) }}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors flex items-center gap-2 ${activeTab === 'tax-invoice' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          ขอใบกำกับภาษี
          <span className="min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center rounded-full text-xs font-bold bg-sky-100 text-sky-800">
            {billingLoading ? '–' : taxInvoiceOrders.length}
          </span>
        </button>
        )}
        {hasAccess('account-approvals') && (
        <button
          type="button"
          onClick={() => { setActiveTab('approvals'); setDashboardFromOverview(true) }}
          className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap transition-colors ${activeTab === 'approvals' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-blue-600'}`}
        >
          รายการอนุมัติ
        </button>
        )}
      </nav>

      {activeTab === 'approvals' && hasAccess('account-approvals') && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการอนุมัติ</h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการที่ยืนยัน/อนุมัติหรือปฏิเสธแล้ว — คลิกรายการเพื่อดูข้อมูลบิล</p>
          <div className="mt-3 flex gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-600">กรองประเภทเอกสาร:</span>
            <button
              type="button"
              onClick={() => setApprovalFilter('refund')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'refund' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              โอนคืน
            </button>
            <button
              type="button"
              onClick={() => setApprovalFilter('claim')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'claim' ? 'bg-amber-100 text-amber-900' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              เคลม
            </button>
            <button
              type="button"
              onClick={() => setApprovalFilter('tax-invoice')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${approvalFilter === 'tax-invoice' ? 'bg-sky-100 text-sky-800' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              ใบกำกับภาษี
            </button>
          </div>
        </div>
        {historyLoading ? (
          <div className="flex justify-center items-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-violet-500 border-t-transparent" />
          </div>
        ) : (
          <div className="p-6">
            {approvalFilter === 'refund' && (historyRefunds.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบรายการโอนคืนที่อนุมัติหรือปฏิเสธแล้ว</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-base">
                    <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ชื่อบัญชีรับคืน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ธนาคาร</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">เลขบัญชี</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ที่อยู่</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">จำนวนเงิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">วันที่ดำเนินการ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap min-w-[20rem] max-w-[28rem]">เหตุผลโอนเกิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyRefunds.map((refund) => (
                        <tr
                          key={refund.id}
                          onClick={() => { setViewOrderId(refund.order_id); setViewBillRefund(refund) }}
                          className="border-b border-gray-100 hover:bg-amber-50/50 transition-colors cursor-pointer"
                        >
                          <td className="px-4 py-3 font-medium text-gray-800">
                          <span>{(refund as any).or_orders?.bill_no || '–'}</span>
                          {((refund as any).or_orders?.bill_no || '').startsWith('REQ') && (
                            <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                          )}
                        </td>
                          <td className="px-4 py-3 text-gray-700">{(refund as any).or_orders?.customer_name || '–'}</td>
                          <td className="px-4 py-3 text-gray-700 text-sm max-w-[120px] truncate" title={refund.refund_recipient_account_name || ''}>{refund.refund_recipient_account_name?.trim() || '–'}</td>
                          <td className="px-4 py-3 text-gray-700 text-sm max-w-[100px] truncate" title={refund.refund_recipient_bank || ''}>{refund.refund_recipient_bank?.trim() || '–'}</td>
                          <td className="px-4 py-3 text-gray-700 text-sm font-mono tabular-nums max-w-[120px] truncate" title={refund.refund_recipient_account_number || ''}>{refund.refund_recipient_account_number?.trim() || '–'}</td>
                          <td className="px-4 py-3 text-gray-600 max-w-[180px] text-sm whitespace-pre-wrap truncate" title={(refund as any).or_orders?.customer_address}>{(refund as any).or_orders?.customer_address || '–'}</td>
                          <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">฿{refund.amount.toLocaleString()}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-medium ${refund.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                              {refund.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}
                            </span>
                            {refund.status === 'rejected' && refund.rejected_reason?.trim() && (
                              <div className="mt-1 text-xs text-red-600 max-w-[160px] whitespace-normal break-words" title={refund.rejected_reason}>
                                เหตุผล: {refund.rejected_reason}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-sm">{refund.approved_at ? formatDateTime(refund.approved_at) : '–'}</td>
                          <td className="px-4 py-3 text-gray-600 text-sm min-w-[20rem] max-w-[28rem] align-top whitespace-normal break-words" title={formatRefundReason(refund.reason)}>
                            <div>{formatRefundReason(refund.reason)}</div>
                            {refund.refund_recipient_reason?.trim() && (
                              <div className="text-gray-800 mt-0.5">{refund.refund_recipient_reason.trim()}</div>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            <div className="flex flex-col items-start gap-1.5">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openSlipPopup(refund.order_id, (refund as any).or_orders?.bill_no || '–') }}
                                className="inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors"
                              >
                                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                ดูสลิปโอน
                              </button>
                              {/* สลิปโอนคืน — เฉพาะรายการที่อนุมัติแล้ว */}
                              {refund.status === 'approved' && (
                                (refund.refund_slip_paths?.length || 0) > 0 ? (
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); openRefundSlipViewer(refund) }}
                                      title="ดูสลิปโอนคืน"
                                      className="relative w-11 h-11 rounded-lg border border-emerald-300 overflow-hidden bg-gray-50 hover:ring-2 hover:ring-emerald-400 transition-all shrink-0"
                                    >
                                      {refundSlipThumbs[refund.id]?.[0] ? (
                                        <img src={refundSlipThumbs[refund.id][0]} alt="สลิปโอนคืน" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                      ) : (
                                        <span className="flex items-center justify-center w-full h-full text-emerald-500"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg></span>
                                      )}
                                      {(refund.refund_slip_paths?.length || 0) > 1 && (
                                        <span className="absolute bottom-0 right-0 px-1 text-[10px] font-bold bg-emerald-600 text-white rounded-tl">{refund.refund_slip_paths!.length}</span>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); triggerRefundSlipUpload(refund.id) }}
                                      disabled={refundSlipUploadingId === refund.id}
                                      className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                                    >
                                      {refundSlipUploadingId === refund.id ? 'กำลังอัป...' : '+ เพิ่มรูป'}
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); triggerRefundSlipUpload(refund.id) }}
                                    disabled={refundSlipUploadingId === refund.id}
                                    className="inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors disabled:opacity-60"
                                  >
                                    {refundSlipUploadingId === refund.id ? (
                                      <><span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-white border-t-transparent" />กำลังอัปโหลด...</>
                                    ) : (
                                      <><svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>อัปโหลดสลิปโอนคืน</>
                                    )}
                                  </button>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            {approvalFilter === 'tax-invoice' && (historyTaxInvoices.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบประวัติใบกำกับภาษีที่ยืนยันแล้ว</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">เลขบิล</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">ชื่อลูกค้า</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">ชื่อบริษัท / TAX ID</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">ที่อยู่</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">ยอดก่อนภาษี</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">มูลค่าภาษี</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">ค่าขนส่ง</th>
                        <th className="px-4 py-3 text-right font-semibold text-gray-700 whitespace-nowrap">ยอดสุทธิ</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 whitespace-nowrap">วันที่ยืนยัน</th>
                        <th className="px-4 py-3 text-center font-semibold text-gray-700 whitespace-nowrap">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyTaxInvoices.map((o) => {
                        const bd = o.billing_details || {}
                        const isClosedRequest = bd.tax_request_closed === true
                        return (
                          <tr
                            key={o.id}
                            onClick={() => { setViewOrderId(o.id); setViewBillRefund(null) }}
                            className={`border-b border-gray-100 transition-colors cursor-pointer align-top ${isClosedRequest ? 'bg-red-50/40 hover:bg-red-50' : 'hover:bg-sky-50/50'}`}
                          >
                            <td className="px-4 py-3 font-semibold text-sky-700 whitespace-nowrap">
                              <span>{o.bill_no}</span>
                              {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                                <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                              )}
                              {isClosedRequest && (
                                <span className="ml-1.5 px-1.5 py-0.5 text-xs font-bold rounded bg-red-100 text-red-700 border border-red-300">ปิดคำขอ (ยกเลิกบิล)</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-gray-800">
                              <span className="block max-w-[140px] truncate" title={o.customer_name || ''}>{o.customer_name || '–'}</span>
                            </td>
                            <td className="px-4 py-3 text-gray-700">
                              <span className="block max-w-[180px] truncate" title={bd.tax_customer_name || ''}>{bd.tax_customer_name || '–'}</span>
                              <span className="block text-xs text-gray-400 tabular-nums mt-0.5">{bd.tax_id ? `TAX ID: ${bd.tax_id}` : '–'}</span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">
                              <span className="block max-w-[220px] text-xs leading-snug line-clamp-2" title={bd.tax_customer_address || ''}>{bd.tax_customer_address || '–'}</span>
                            </td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums text-right whitespace-nowrap">฿{(() => { const t = Number(o.total_amount || 0); const b = t ? t / 1.07 : 0; return b.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); })()}</td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums text-right whitespace-nowrap">฿{(() => { const t = Number(o.total_amount || 0); const b = t ? t / 1.07 : 0; return (t - b).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); })()}</td>
                            <td className="px-4 py-3 text-gray-700 tabular-nums text-right whitespace-nowrap">฿{Number((o as any).shipping_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums text-right whitespace-nowrap">฿{Number(o.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{bd.account_confirmed_tax_at ? formatDateTime(bd.account_confirmed_tax_at) : '–'}</td>
                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <div className="flex flex-col gap-1.5 w-40">
                                {/* คำขอที่ถูกปิดเพราะยกเลิกบิล — บล็อคการออกใบกำกับภาษี */}
                                {!isClosedRequest && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); viewTaxInvoice(o) }}
                                  className="w-full px-3 py-1.5 bg-sky-500 text-white rounded-lg hover:bg-sky-600 text-sm font-medium transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                                >
                                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                  ออกใบกำกับภาษี
                                </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); openSlipPopup(o.id, o.bill_no) }}
                                  className="w-full px-3 py-1.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                                >
                                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                  ดูสลิปโอน
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            {approvalFilter === 'claim' && (historyClaimRequests.length === 0 ? (
                <div className="text-center py-12 text-gray-500 text-base">ไม่พบประวัติการอนุมัติเคลม</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="w-full text-base">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">บิลอ้างอิง</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">บิลเคลม (REQ)</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">หัวข้อเคลม</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">ยอดเดิม</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">สถานะ</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap">วันที่ดำเนินการ</th>
                        <th className="px-4 py-3 text-left font-semibold text-gray-700 text-sm whitespace-nowrap min-w-[12rem]">หมายเหตุ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyClaimRequests.map((row) => (
                        <tr
                          key={row.id}
                          onClick={() => {
                            if (row.status === 'approved' && row.created_claim_order_id) {
                              setViewOrderId(row.created_claim_order_id)
                              setViewBillRefund(null)
                            } else {
                              setViewOrderId(row.ref_order_id)
                              setViewBillRefund(null)
                            }
                          }}
                          className="border-b border-gray-100 hover:bg-amber-50/50 transition-colors cursor-pointer"
                        >
                          <td className="px-4 py-3 font-medium text-gray-800">{row.ref_snapshot?.bill_no || '–'}</td>
                          <td className="px-4 py-3 text-amber-800 font-medium">
                            {row.status === 'approved' ? row.new_order?.bill_no || '–' : '–'}
                          </td>
                          <td className="px-4 py-3 text-gray-700">
                            {claimTypeLabel(claimLabels, row.claim_type)}
                          </td>
                          <td className="px-4 py-3 text-gray-700 tabular-nums">
                            ฿{Number(row.ref_snapshot?.total_amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-medium ${
                                row.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                              }`}
                            >
                              {row.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-sm">
                            {row.reviewed_at ? formatDateTime(row.reviewed_at) : '–'}
                          </td>
                          <td className="px-4 py-3 text-gray-600 text-sm whitespace-pre-wrap break-words">
                            {row.status === 'rejected' && row.rejected_reason ? row.rejected_reason : '–'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
        )}
      </section>
      )}

      {activeTab === 'claim-approval' && hasAccess('account-claim-approval') && <ClaimApprovalSection />}

      {activeTab === 'refunds' && hasAccess('account-refunds') && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการโอนคืน</h2>
          <p className="text-sm text-gray-500 mt-0.5">รายการโอนเกินที่รออนุมัติหรือยืนยัน — คลิกรายการเพื่อดูข้อมูลบิล</p>
        </div>
        {pendingRefunds.length === 0 ? (
          <div className="text-center py-14 text-gray-500 text-sm">
            ไม่พบรายการโอนคืนรออนุมัติ (รายการที่อนุมัติแล้วจะไปแสดงที่เมนู รายการอนุมัติ)
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบิล</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อลูกค้า</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ชื่อบัญชีรับคืน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">ธนาคาร</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">เลขบัญชี</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">จำนวนเงิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">สถานะ</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">วันที่สร้าง</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700 min-w-[20rem] max-w-[28rem]">เหตุผลโอนเกิน</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {pendingRefunds.map((refund) => (
                  <tr
                    key={refund.id}
                    onClick={() => { setViewOrderId(refund.order_id); setViewBillRefund(refund) }}
                    className="border-b border-gray-100 hover:bg-amber-50/50 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      <span>{(refund as any).or_orders?.bill_no || '–'}</span>
                      {((refund as any).or_orders?.bill_no || '').startsWith('REQ') && (
                        <span className="ml-1.5 px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {(refund as any).or_orders?.customer_name || '–'}
                    </td>
                    <td className="px-4 py-3 text-gray-700 text-sm max-w-[120px] truncate" title={refund.refund_recipient_account_name || ''}>{refund.refund_recipient_account_name?.trim() || '–'}</td>
                    <td className="px-4 py-3 text-gray-700 text-sm max-w-[100px] truncate" title={refund.refund_recipient_bank || ''}>{refund.refund_recipient_bank?.trim() || '–'}</td>
                    <td className="px-4 py-3 text-gray-700 text-sm font-mono tabular-nums max-w-[120px] truncate" title={refund.refund_recipient_account_number || ''}>{refund.refund_recipient_account_number?.trim() || '–'}</td>
                    <td className="px-4 py-3 font-semibold text-emerald-600 tabular-nums">
                      ฿{refund.amount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex px-2.5 py-1 rounded-lg text-sm font-medium bg-amber-100 text-amber-700">
                        รออนุมัติ
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-sm">
                      {formatDateTime(refund.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-sm min-w-[20rem] max-w-[28rem] align-top whitespace-normal break-words" title={formatRefundReason(refund.reason)}>
                      <div>{formatRefundReason(refund.reason)}</div>
                      {refund.refund_recipient_reason?.trim() && (
                        <div className="text-gray-800 mt-0.5">{refund.refund_recipient_reason.trim()}</div>
                      )}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); openRefundActionModal(refund, 'approve') }}
                          className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          อนุมัติ
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openRefundActionModal(refund, 'reject') }}
                          className="px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 text-sm font-medium transition-colors"
                        >
                          ปฏิเสธ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {activeTab === 'tax-invoice' && hasAccess('account-tax-invoice') && (
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-sky-50/50">
          <h2 className="text-lg font-semibold text-gray-800">รายการขอใบกำกับภาษี</h2>
          <p className="text-sm text-gray-500 mt-0.5">รอยืนยันจากฝ่ายบัญชี — คลิกรายการเพื่อดูข้อมูลบิล</p>
        </div>
        {billingLoading ? (
          <div className="flex justify-center items-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-sky-500 border-t-transparent" />
          </div>
        ) : taxInvoiceOrders.length === 0 ? (
          <div className="text-center py-14 text-gray-500 text-base">ไม่พบรายการขอใบกำกับภาษี</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">เลขบิล</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ชื่อลูกค้า</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ชื่อบริษัท</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">TAX ID</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ที่อยู่</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ยอดก่อนภาษี</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">มูลค่าภาษี</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ค่าจัดส่ง</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">ยอดสุทธิ</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">สถานะ</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">วันที่สร้าง</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-gray-700 text-xs whitespace-nowrap">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {taxInvoiceOrders.map((o) => {
                  const bd = o.billing_details || {}
                  const total = Number(o.total_amount || 0)
                  const beforeVat = total ? total / 1.07 : 0
                  const vatAmount = total ? total - beforeVat : 0
                  const isCancelledBill = o.status === 'ยกเลิก'
                  return (
                    <tr
                      key={o.id}
                      onClick={() => { setViewOrderId(o.id); setViewBillRefund(null) }}
                      className={`border-b border-gray-100 transition-colors cursor-pointer ${isCancelledBill ? 'bg-red-50/60 hover:bg-red-50' : 'hover:bg-sky-50/50'}`}
                    >
                      <td className="px-3 py-2.5 font-semibold text-sky-700">
                        <span>{o.bill_no}</span>
                        {((o as any).claim_type != null || (o.bill_no || '').startsWith('REQ')) && (
                          <span className="ml-1 px-1 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-800">{o.customer_name || '–'}</td>
                      <td className="px-3 py-2.5 text-gray-700">{bd.tax_customer_name || '–'}</td>
                      <td className="px-3 py-2.5 text-gray-700 tabular-nums">{bd.tax_id || '–'}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[160px] text-xs whitespace-pre-wrap">
                        <span className="truncate block" title={bd.tax_customer_address}>{bd.tax_customer_address || '–'}</span>
                      </td>
                      <td className="px-3 py-2.5 text-gray-700 tabular-nums">
                        ฿{beforeVat ? beforeVat.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
                      </td>
                      <td className="px-3 py-2.5 text-gray-700 tabular-nums">
                        ฿{vatAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 text-gray-700 tabular-nums">
                        ฿{Number(o.shipping_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5 font-semibold text-emerald-600 tabular-nums">
                        ฿{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2.5">
                        {isCancelledBill ? (
                          <span className="inline-flex px-2 py-0.5 rounded-lg text-xs font-bold bg-red-100 text-red-700 border border-red-300">ยกเลิกบิล</span>
                        ) : (
                          <span className={`inline-flex px-2 py-0.5 rounded-lg text-xs font-medium ${o.status === 'ตรวจสอบแล้ว' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'}`}>{o.status}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-500 text-xs whitespace-nowrap">{formatDateTime(o.created_at)}</td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        {isCancelledBill ? (
                          // บิลยกเลิก — บล็อคการยืนยันออกใบกำกับ ให้ปิดคำขอแทน (ปิดแล้วไม่แสดงซ้ำ)
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setCloseTaxRequestModal({ open: true, order: o, submitting: false }) }}
                            className="px-2.5 py-1 bg-white text-red-600 border border-red-300 rounded-lg hover:bg-red-50 text-xs font-medium transition-colors"
                          >
                            ปิดคำขอ
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); confirmTaxInvoice(o) }}
                            className="px-2.5 py-1 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-xs font-medium transition-colors"
                          >
                            ตรวจสอบ
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

      {/* Modal ดูสลิปโอน */}
      {slipPopupOrderId && (
        <Modal
          open
          onClose={() => setSlipPopupOrderId(null)}
          closeOnBackdropClick
          contentClassName="max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col"
        >
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-800">สลิปโอน — บิล {slipPopupBillNo}</h3>
              <button
                type="button"
                onClick={() => setSlipPopupOrderId(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
              >
                ✕
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {slipPopupLoading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-sky-500 border-t-transparent" />
                </div>
              ) : slipPopupUrls.length === 0 ? (
                <p className="text-center text-gray-500 py-6 text-sm">ไม่พบภาพสลิปโอนของบิลนี้</p>
              ) : (
                <div className="space-y-3">
                  {slipPopupUrls.map((url, idx) => (
                    <div key={idx} className="flex justify-center">
                      {slipPopupFailed.has(idx) ? (
                        <div className="flex flex-col items-center justify-center py-8 px-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 min-h-[120px]">
                          <p className="font-medium text-sm">โหลดรูปไม่สำเร็จ</p>
                          <p className="text-xs mt-1">ลิงก์อาจหมดอายุหรือไม่มีสิทธิ์เข้าถึง</p>
                          <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 text-xs text-sky-600 hover:underline">เปิดในแท็บใหม่</a>
                        </div>
                      ) : (
                        <img
                          src={url}
                          alt={`สลิปโอน ${idx + 1}`}
                          className="max-w-full h-auto rounded-lg border border-gray-200 shadow-sm"
                          referrerPolicy="no-referrer"
                          onError={() => setSlipPopupFailed(prev => new Set(prev).add(idx))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
        </Modal>
      )}

      {/* input อัปโหลดสลิปโอนคืน (ซ่อน) */}
      <input
        ref={refundSlipInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onRefundSlipFilesSelected}
      />

      {/* Modal ดูสลิปโอนคืน */}
      {refundSlipViewer && (
        <Modal
          open
          onClose={() => setRefundSlipViewer(null)}
          closeOnBackdropClick
          contentClassName="max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col"
        >
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800">สลิปโอนคืน — บิล {refundSlipViewer.billNo}</h3>
            <button
              type="button"
              onClick={() => setRefundSlipViewer(null)}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
            >
              ✕
            </button>
          </div>
          <div className="p-4 overflow-y-auto flex-1">
            {refundSlipViewer.loading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-emerald-500 border-t-transparent" />
              </div>
            ) : refundSlipViewer.urls.length === 0 ? (
              <p className="text-center text-gray-500 py-6 text-sm">ไม่พบภาพสลิปโอนคืน</p>
            ) : (
              <div className="space-y-4">
                {refundSlipViewer.urls.map((url, idx) => (
                  <div key={idx} className="flex flex-col items-center gap-2">
                    {refundSlipViewerFailed.has(idx) ? (
                      <div className="flex flex-col items-center justify-center py-8 px-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 min-h-[120px]">
                        <p className="font-medium text-sm">โหลดรูปไม่สำเร็จ</p>
                        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 text-xs text-sky-600 hover:underline">เปิดในแท็บใหม่</a>
                      </div>
                    ) : (
                      <>
                        <img
                          src={url}
                          alt={`สลิปโอนคืน ${idx + 1}`}
                          className="max-w-full h-auto rounded-lg border border-gray-200 shadow-sm"
                          referrerPolicy="no-referrer"
                          onError={() => setRefundSlipViewerFailed(prev => new Set(prev).add(idx))}
                        />
                        <button
                          type="button"
                          onClick={() => void downloadFileFromUrl(url, `สลิปโอนคืน-${refundSlipViewer.billNo}-${idx + 1}.jpg`)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 text-sm font-medium transition-colors"
                        >
                          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                          ดาวน์โหลดรูป
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Modal ดูข้อมูลบิล (อ่านอย่างเดียว) */}
      {viewOrderId && (
        <Modal
          open
          onClose={() => { setViewOrderId(null); setViewBillRefund(null) }}
          closeOnBackdropClick
          contentClassName="max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        >
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-800">ข้อมูลบิล (ดูอย่างเดียว)</h3>
              <button
                type="button"
                onClick={() => { setViewOrderId(null); setViewBillRefund(null) }}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-600"
              >
                ✕
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 text-base">
              {viewOrderLoading ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-sky-500 border-t-transparent" />
                </div>
              ) : viewOrder ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <p className="flex items-center gap-2">
                      <span className="font-medium text-gray-600">เลขบิล:</span>
                      <span>{viewOrder.bill_no}</span>
                      {((viewOrder as any).claim_type != null || (viewOrder.bill_no || '').startsWith('REQ')) && (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">เคลม</span>
                      )}
                    </p>
                    <p><span className="font-medium text-gray-600">สถานะ:</span> {viewOrder.status}</p>
                    <p className="col-span-2"><span className="font-medium text-gray-600">ลูกค้า:</span> {viewOrder.customer_name}</p>
                    {(() => {
                      const parts = splitAddressParts(viewOrder.customer_address, (viewOrder as any).recipient_name)
                      const recipient = ((viewOrder as any).recipient_name || '').trim() || parts.recipientName
                      const phone = (viewOrder.billing_details?.mobile_phone || '').trim() || parts.phone
                      const addr = parts.address || viewOrder.customer_address || '–'
                      return (
                        <>
                          {recipient && <p className="col-span-2"><span className="font-medium text-gray-600">ชื่อผู้รับ:</span> {recipient}</p>}
                          <p className="col-span-2"><span className="font-medium text-gray-600">ที่อยู่:</span> {addr}</p>
                          {phone && <p className="col-span-2"><span className="font-medium text-gray-600">เบอร์โทร:</span> {phone}</p>}
                        </>
                      )
                    })()}
                    <p className="col-span-2"><span className="font-medium text-gray-600">วันที่สร้าง:</span> {formatDateTime(viewOrder.created_at)}</p>
                  </div>
                  {viewBillRefund && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
                      <h4 className="font-semibold text-gray-800">รายละเอียดการโอนเกิน</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                        <p className="sm:col-span-2">
                          <span className="font-medium text-gray-600">ชื่อบัญชีรับคืน:</span>{' '}
                          <span className="text-gray-800">{viewBillRefund.refund_recipient_account_name?.trim() || '–'}</span>
                        </p>
                        <p>
                          <span className="font-medium text-gray-600">ธนาคาร:</span>{' '}
                          <span className="text-gray-800">{viewBillRefund.refund_recipient_bank?.trim() || '–'}</span>
                        </p>
                        <p>
                          <span className="font-medium text-gray-600">เลขบัญชี:</span>{' '}
                          <span className="text-gray-800 font-mono tabular-nums">{viewBillRefund.refund_recipient_account_number?.trim() || '–'}</span>
                        </p>
                        <p className="sm:col-span-2">
                          <span className="font-medium text-gray-600">จำนวนเงินคืน:</span>{' '}
                          <span className="text-emerald-700 font-semibold tabular-nums">฿{viewBillRefund.amount.toLocaleString()}</span>
                        </p>
                        <p className="sm:col-span-2">
                          <span className="font-medium text-gray-600">เหตุผลโอนเกิน:</span>{' '}
                          <span className="text-gray-800">{formatRefundReason(viewBillRefund.reason)}</span>
                        </p>
                        {viewBillRefund.refund_recipient_reason?.trim() && (
                          <p className="sm:col-span-2">
                            <span className="font-medium text-gray-600">เหตุผลโอนคืน:</span>{' '}
                            <span className="text-gray-800">{viewBillRefund.refund_recipient_reason.trim()}</span>
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-gray-600 text-sm mb-2">รูปสลิปโอน</p>
                        {billViewSlipLoading ? (
                          <div className="flex justify-center py-6">
                            <div className="animate-spin rounded-full h-8 w-8 border-2 border-amber-500 border-t-transparent" />
                          </div>
                        ) : billViewSlipUrls.length === 0 ? (
                          <p className="text-sm text-gray-500">ไม่พบภาพสลิปของบิลนี้</p>
                        ) : (
                          <div className="space-y-3">
                            {billViewSlipUrls.map((url, idx) => (
                              <div key={idx} className="flex justify-center">
                                {billViewSlipFailed.has(idx) ? (
                                  <div className="flex flex-col items-center justify-center py-6 px-4 rounded-lg border border-amber-200 bg-white text-amber-800 w-full max-w-md">
                                    <p className="font-medium text-sm">โหลดรูปไม่สำเร็จ</p>
                                    <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 text-xs text-sky-600 hover:underline">
                                      เปิดในแท็บใหม่
                                    </a>
                                  </div>
                                ) : (
                                  <img
                                    src={url}
                                    alt={`สลิปโอน ${idx + 1}`}
                                    className="max-w-full max-h-[min(28rem,55vh)] w-auto h-auto rounded-lg border border-gray-200 shadow-sm object-contain"
                                    referrerPolicy="no-referrer"
                                    onError={() => setBillViewSlipFailed((prev) => new Set(prev).add(idx))}
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <div>
                    <h4 className="font-semibold text-gray-700 mb-2">รายการสินค้า</h4>
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">ชื่อสินค้า</th>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">จำนวน</th>
                            <th className="px-3 py-2 text-left font-semibold text-gray-700">ราคา/หน่วย</th>
                            <th className="px-3 py-2 text-right font-semibold text-gray-700">รวม</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((viewOrder as any).or_order_items || (viewOrder as any).order_items || []).map((item: any) => (
                            <tr key={item.id} className="border-t border-gray-100">
                              <td className="px-3 py-2 text-gray-800">{item.product_name || '–'}</td>
                              <td className="px-3 py-2 text-gray-700">{item.quantity ?? '–'}</td>
                              <td className="px-3 py-2 text-gray-700">฿{Number(item.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                              <td className="px-3 py-2 text-right font-medium text-gray-800">฿{Number((item.quantity || 0) * (item.unit_price || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div className="w-64 space-y-1">
                      <div className="flex justify-between py-1 border-b border-gray-100">
                        <span className="font-medium text-gray-600">ส่วนลด</span>
                        <span className={`tabular-nums ${Number((viewOrder as any).discount || 0) > 0 ? 'text-red-600' : 'text-gray-800'}`}>
                          {Number((viewOrder as any).discount || 0) > 0 ? '-' : ''}฿{Number((viewOrder as any).discount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-gray-100">
                        <span className="font-medium text-gray-600">ค่าขนส่ง</span>
                        <span className="tabular-nums text-gray-800">฿{Number((viewOrder as any).shipping_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between py-2 px-3 rounded-lg bg-sky-50">
                        <span className="font-semibold text-gray-700">ยอดรวม</span>
                        <span className="font-bold tabular-nums text-emerald-600">฿{Number(viewOrder.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  </div>
                  {(() => {
                    const bd: any = viewOrder.billing_details || {}
                    const hasTaxInvoice = bd.request_tax_invoice || bd.tax_customer_name || bd.tax_id || bd.tax_customer_address
                    if (!hasTaxInvoice) return null
                    return (
                      <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4 space-y-3">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 text-sky-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                          <h4 className="font-semibold text-gray-800">ข้อมูลใบกำกับภาษี</h4>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                          <p className="sm:col-span-2">
                            <span className="font-medium text-gray-600">ชื่อบริษัท/ผู้เสียภาษี:</span>{' '}
                            <span className="text-gray-800">{bd.tax_customer_name || '–'}</span>
                          </p>
                          <p>
                            <span className="font-medium text-gray-600">เลขประจำตัวผู้เสียภาษี:</span>{' '}
                            <span className="text-gray-800 tabular-nums">{bd.tax_id || '–'}</span>
                          </p>
                          <p>
                            <span className="font-medium text-gray-600">เบอร์โทร:</span>{' '}
                            <span className="text-gray-800">{bd.tax_customer_phone || '–'}</span>
                          </p>
                          <p className="sm:col-span-2">
                            <span className="font-medium text-gray-600">ที่อยู่:</span>{' '}
                            <span className="text-gray-800">{bd.tax_customer_address || '–'}</span>
                          </p>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              ) : (
                <p className="text-gray-500">ไม่พบข้อมูลบิล</p>
              )}
            </div>
        </Modal>
      )}

      {/* Modal แจ้งผลหลังอนุมัติ/ปฏิเสธโอนคืน */}
      <Modal
        open={refundResultModal.open}
        onClose={() => setRefundResultModal({ open: false, message: '' })}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-5">
          <p className="text-gray-800">{refundResultModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setRefundResultModal({ open: false, message: '' })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>


      {/* Modal เปิดใบกำกับภาษี */}
      <TaxInvoiceModal
        open={taxInvoiceModal.open}
        order={taxInvoiceModal.order}
        onClose={() => { if (!taxInvoiceModal.submitting) setTaxInvoiceModal({ open: false, order: null, submitting: false, viewOnly: false }) }}
        onConfirm={(o) => submitTaxInvoiceConfirm(o as BillingRequestOrder)}
        submitting={taxInvoiceModal.submitting}
        hideConfirm={taxInvoiceModal.viewOnly}
        receiverAccount={slipReceiverAccount}
      />

      {/* Modal ยืนยัน ขอใบกำกับภาษี (ใช้สำหรับ tax-invoice เท่านั้น) */}
      {billingConfirmModal.open && billingConfirmModal.order && billingConfirmModal.type && (
        <Modal
          open
          onClose={closeBillingConfirmModal}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">ยืนยัน ขอใบกำกับภาษี</h3>
            <p className="text-gray-700 mb-6">
              {`ต้องการยืนยันว่าออกใบกำกับภาษีสำหรับบิล ${billingConfirmModal.order.bill_no} เรียบร้อยแล้วหรือไม่?`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={closeBillingConfirmModal}
                disabled={billingConfirmModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={submitBillingConfirm}
                disabled={billingConfirmModal.submitting}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {billingConfirmModal.submitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ยืนยัน'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal ยืนยัน ปิดคำขอใบกำกับภาษี (บิลถูกยกเลิก) */}
      {closeTaxRequestModal.open && closeTaxRequestModal.order && (
        <Modal
          open
          onClose={() => { if (!closeTaxRequestModal.submitting) setCloseTaxRequestModal({ open: false, order: null, submitting: false }) }}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">ปิดคำขอใบกำกับภาษี</h3>
            <p className="text-gray-700 mb-2">
              {`บิล ${closeTaxRequestModal.order.bill_no} ถูกยกเลิกแล้ว ต้องการปิดคำขอใบกำกับภาษีของบิลนี้หรือไม่?`}
            </p>
            <p className="text-sm text-red-600 mb-6">ปิดแล้วรายการนี้จะไม่กลับมาแสดงซ้ำอีก และจะไม่มีการออกใบกำกับภาษีให้บิลนี้</p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setCloseTaxRequestModal({ open: false, order: null, submitting: false })}
                disabled={closeTaxRequestModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={submitCloseTaxRequest}
                disabled={closeTaxRequestModal.submitting}
                className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {closeTaxRequestModal.submitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ปิดคำขอ'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal แจ้งผลหลังยืนยันใบกำกับภาษี */}
      <Modal
        open={billingResultModal.open}
        onClose={() => setBillingResultModal({ open: false, title: '', message: '' })}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-5">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{billingResultModal.title}</h3>
          <p className="text-gray-800 text-sm">{billingResultModal.message}</p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setBillingResultModal({ open: false, title: '', message: '' })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal ยืนยัน อนุมัติ/ปฏิเสธ โอนคืน (popup เดียว) */}
      {refundActionModal.open && refundActionModal.refund && refundActionModal.action && (
        <Modal
          open
          onClose={closeRefundActionModal}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">
              {refundActionModal.action === 'approve' ? 'ยืนยันอนุมัติการโอนคืน' : 'ยืนยันปฏิเสธการโอนคืน'}
            </h3>
            <p className="text-gray-700 mb-6">
              {refundActionModal.action === 'approve'
                ? `ต้องการอนุมัติการโอนคืน ฿${refundActionModal.refund.amount.toLocaleString()} หรือไม่?`
                : `ต้องการปฏิเสธการโอนคืน ฿${refundActionModal.refund.amount.toLocaleString()} หรือไม่?`}
            </p>
            {refundActionModal.action === 'reject' && (
              <label className="block mb-6">
                <span className="text-sm font-medium text-gray-700">เหตุผลไม่อนุมัติ</span>
                <textarea
                  value={refundActionModal.rejectReason}
                  onChange={(e) => setRefundActionModal((prev) => ({ ...prev, rejectReason: e.target.value }))}
                  disabled={refundActionModal.submitting}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-red-300 focus:border-red-300 disabled:bg-gray-100 resize-none"
                  placeholder="ระบุเหตุผลที่ไม่อนุมัติการโอนคืน..."
                />
              </label>
            )}
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={closeRefundActionModal}
                disabled={refundActionModal.submitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={submitRefundAction}
                disabled={refundActionModal.submitting}
                className={`px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 ${
                  refundActionModal.action === 'approve'
                    ? 'bg-emerald-500 hover:bg-emerald-600'
                    : 'bg-red-500 hover:bg-red-600'
                }`}
              >
                {refundActionModal.submitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังดำเนินการ...
                  </>
                ) : (
                  'ยืนยัน'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

        </>
      )}

    </div>
  )
}
