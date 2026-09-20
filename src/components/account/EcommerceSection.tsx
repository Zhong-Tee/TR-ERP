import { useCallback, useEffect, useRef, useState } from 'react'
import { FiCheckCircle, FiChevronRight, FiEdit2, FiFileText, FiRefreshCw, FiUpload, FiX } from 'react-icons/fi'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  TIKTOK_REPORT_FEE_TYPE,
  TIKTOK_REPORT_TOTAL_TYPE,
  TIKTOK_WITHDRAWAL_TYPE,
  type EcommerceFileKind,
  type ShopeeParsedFile,
  type ShopeeWalletTransaction,
} from '../../lib/ecommerceReconciliation'

const PAGE_SIZE = 50
const WRITE_CHUNK = 500

type Channel = {
  id: string
  code: string
  display_name: string
}

type ReconciliationStatus =
  | 'paid'
  | 'paid_zero'
  | 'waiting_wallet'
  | 'waiting_settlement'
  | 'amount_mismatch'
  | 'in_transit'
  | 'cancelled'
  | 'returned'
  | 'not_found_order'
  | 'waiting_delivery'
  | 'needs_review'

type ReconciliationRow = {
  channel_id: string
  channel_code: string
  channel_name: string
  order_no: string
  marketplace_work_id: string | null
  marketplace_status: string | null
  marketplace_order_total: number | null
  marketplace_billed_at: string | null
  ecommerce_order_id: string | null
  platform_status: string | null
  delivery_status: string
  refund_status: string | null
  buyer_username: string | null
  ordered_at: string | null
  paid_at: string | null
  shipped_at: string | null
  completed_at: string | null
  tracking_no: string | null
  buyer_paid: number | null
  merchandise_total: number | null
  order_total: number | null
  province: string | null
  line_count: number
  item_qty: number
  returned_qty: number
  settled_at: string | null
  gross_sales: number | null
  platform_fee_total: number | null
  seller_cost_total: number | null
  fee_category_count: number | null
  payout_amount: number | null
  fee_breakdown: Record<string, number> | null
  wallet_amount: number | null
  wallet_received_at: string | null
  erp_order_id: string | null
  erp_bill_no: string | null
  erp_order_total: number | null
  order_matched: boolean
  income_matched: boolean
  balance_matched: boolean
  reconciliation_status: ReconciliationStatus
  payout_variance: number | null
  manual_status: 'cancelled' | 'returned' | null
  manual_note: string | null
  manual_updated_at: string | null
}

type PendingImport = {
  file: File
  parsed: ShopeeParsedFile
}

type OperationProgress = {
  status: 'working' | 'success' | 'error'
  title: string
  message: string
  fileName?: string
  current: number
  total: number
}

type EcommerceMetrics = {
  orders: number
  delivered: number
  cancelled: number
  shipping: number
  paid: number
  issues: number
  sales: number
  fees: number
  payout: number
  wallet: number
  paidZero: number
  waitingSettlement: number
  waitingWallet: number
  mismatch: number
  orderMatched: number
  incomeMatched: number
  balanceMatched: number
  missingOrder: number
  returned: number
  deliveredValue: number
  withinCycle: number
  overdueCycle: number
  overdueTwoCycles: number
  withinCycleValue: number
  overdueCycleValue: number
  overdueTwoCyclesValue: number
  paidValue: number
  mismatchValue: number
}

const EMPTY_METRICS: EcommerceMetrics = {
  orders: 0,
  delivered: 0,
  cancelled: 0,
  shipping: 0,
  paid: 0,
  issues: 0,
  sales: 0,
  fees: 0,
  payout: 0,
  wallet: 0,
  paidZero: 0,
  waitingSettlement: 0,
  waitingWallet: 0,
  mismatch: 0,
  orderMatched: 0,
  incomeMatched: 0,
  balanceMatched: 0,
  missingOrder: 0,
  returned: 0,
  deliveredValue: 0,
  withinCycle: 0,
  overdueCycle: 0,
  overdueTwoCycles: 0,
  withinCycleValue: 0,
  overdueCycleValue: 0,
  overdueTwoCyclesValue: 0,
  paidValue: 0,
  mismatchValue: 0,
}

type DateBasis = 'ordered_at' | 'billed_at' | 'completed_at' | 'settled_at' | 'wallet_received_at'
type AgingFilter = 'all' | 'within_7' | 'days_8_14' | 'over_14'
type StatusFilter = ReconciliationStatus | 'all' | 'issues' | 'delivered' | 'income_found' | 'balance_found' | 'cancelled_returned'
type ViewTab = 'dashboard' | 'records' | 'imports'

const FILE_KIND_META: Record<EcommerceFileKind, { title: string; subtitle: string; tone: string }> = {
  orders: { title: '1. คำสั่งซื้อและการจัดส่ง', subtitle: 'Order.shipping…xlsx', tone: 'blue' },
  income: { title: '2. รายได้และค่าธรรมเนียม', subtitle: 'Income.โอนเงินสำเร็จ…xlsx', tone: 'violet' },
  balance: { title: '3. เงินเข้ากระเป๋า', subtitle: 'my_balance_transaction_report…xlsx', tone: 'emerald' },
}

const STATUS_META: Record<ReconciliationStatus, { label: string; className: string }> = {
  paid: { label: 'รับเงินครบ', className: 'bg-emerald-100 text-emerald-800' },
  paid_zero: { label: 'เคลียร์ยอด 0', className: 'bg-slate-100 text-slate-700' },
  waiting_wallet: { label: 'รอเงินเข้ากระเป๋า', className: 'bg-amber-100 text-amber-900' },
  waiting_settlement: { label: 'ส่งสำเร็จ รอคิดเงิน', className: 'bg-orange-100 text-orange-900' },
  amount_mismatch: { label: 'ยอดโอนไม่ตรง', className: 'bg-red-100 text-red-800' },
  in_transit: { label: 'กำลังจัดส่ง', className: 'bg-blue-100 text-blue-800' },
  cancelled: { label: 'ยกเลิก', className: 'bg-gray-200 text-gray-700' },
  returned: { label: 'คืนสินค้า/คืนเงิน', className: 'bg-rose-100 text-rose-800' },
  not_found_order: { label: 'เปิดบิลแล้ว ไม่พบในไฟล์ Order', className: 'bg-red-100 text-red-800' },
  waiting_delivery: { label: 'รอจัดส่งสำเร็จ', className: 'bg-blue-100 text-blue-800' },
  needs_review: { label: 'ต้องตรวจสอบ', className: 'bg-yellow-100 text-yellow-900' },
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    const message = [value.message, value.details, value.hint].filter(Boolean).join(' — ')
    if (message.toLowerCase().includes('statement timeout')) {
      return 'ฐานข้อมูลใช้เวลาประมวลผลนานเกินกำหนด กรุณา deploy migration 585_ecommerce_reconciliation_performance.sql แล้วโหลดใหม่'
    }
    if (message.includes('ac_v_ecommerce_order_reconciliation') || message.includes('ac_ecommerce_orders')) {
      return `${message} — กรุณา deploy migration 584_ecommerce_reconciliation_hub.sql ก่อนใช้งานหน้านี้`
    }
    return message || JSON.stringify(error)
  }
  return 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ'
}

function money(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return '–'
  return Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function statusFilterLabel(value: StatusFilter): string {
  if (value === 'all') return 'ทุกสถานะ'
  if (value === 'issues') return 'เฉพาะที่ต้องติดตาม'
  if (value === 'delivered') return 'จัดส่งสำเร็จทั้งหมด'
  if (value === 'income_found') return 'พบใน Income'
  if (value === 'balance_found') return 'พบใน Balance'
  if (value === 'cancelled_returned') return 'ยกเลิก/คืนสินค้า'
  return STATUS_META[value]?.label ?? value
}

function agingFilterLabel(value: AgingFilter): string {
  if (value === 'within_7') return 'ยังอยู่ในรอบ 0–7 วัน'
  if (value === 'days_8_14') return 'เสี่ยง: เกินรอบ 7 วัน'
  if (value === 'over_14') return 'เสี่ยงสูง: เกิน 14 วัน'
  return 'ทุกช่วงอายุ'
}

function percent(value: number, total: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return '0%'
  return `${((value / total) * 100).toLocaleString('th-TH', { maximumFractionDigits: 1 })}%`
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '–'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' })
}

function pendingSummary(item: PendingImport): string {
  if (item.parsed.kind === 'orders') {
    const delivered = item.parsed.orders.filter((order) => order.deliveryStatus === 'delivered').length
    const shipping = item.parsed.orders.filter((order) => order.deliveryStatus === 'shipping').length
    return `${item.parsed.orders.length.toLocaleString()} ออเดอร์ · ส่งสำเร็จ ${delivered} · กำลังส่ง ${shipping}`
  }
  if (item.parsed.kind === 'income') {
    const reportTotal = (item.parsed.walletTransactions ?? [])
      .filter((row) => row.transactionType === TIKTOK_REPORT_TOTAL_TYPE)
      .reduce((total, row) => total + row.amount, 0)
    const orderPayout = item.parsed.settlements.reduce((total, row) => total + row.payoutAmount, 0)
    return `${item.parsed.settlements.length.toLocaleString()} รายการรายบิล · ยอดรอบ ${money(reportTotal || orderPayout)} บาท`
  }
  const amount = item.parsed.transactions.reduce((total, row) => total + row.amount, 0)
  return `${item.parsed.transactions.length.toLocaleString()} รายการ · เงินเข้า ${money(amount)} บาท`
}

function parseFileInWorker(file: File, platform: string, onStage: (message: string) => void): Promise<ShopeeParsedFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/ecommerceParse.worker.ts', import.meta.url), { type: 'module' })
    const timeout = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('ใช้เวลาอ่านไฟล์เกิน 2 นาที กรุณาตรวจสอบว่าไฟล์ไม่เสียหายแล้วลองใหม่'))
    }, 120_000)

    const finish = () => {
      window.clearTimeout(timeout)
      worker.terminate()
    }

    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'ตัวอ่านไฟล์ Excel หยุดทำงาน'))
    }

    worker.onmessage = (event: MessageEvent<{ type: string; stage?: string; parsed?: ShopeeParsedFile; message?: string }>) => {
      if (event.data.type === 'stage') {
        onStage(event.data.stage === 'parsing' ? 'กำลังตรวจรูปแบบและประมวลผลข้อมูล…' : 'กำลังอ่านไฟล์…')
        return
      }
      if (event.data.type === 'result' && event.data.parsed) {
        finish()
        resolve(event.data.parsed)
        return
      }
      if (event.data.type === 'error') {
        finish()
        reject(new Error(event.data.message || 'ไม่สามารถอ่านไฟล์ Excel ได้'))
      }
    }

    void file.arrayBuffer()
      .then((buffer) => {
        onStage('อ่านไฟล์แล้ว กำลังส่งไปตรวจสอบ…')
        worker.postMessage({ buffer, platform }, [buffer])
      })
      .catch((error) => {
        finish()
        reject(error)
      })
  })
}

async function insertChunks(table: string, rows: Record<string, unknown>[]) {
  for (let index = 0; index < rows.length; index += WRITE_CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(index, index + WRITE_CHUNK))
    if (error) throw error
  }
}

export default function EcommerceSection() {
  const { user } = useAuthContext()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<ViewTab>('dashboard')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelId, setChannelId] = useState('')
  const [dateBasis, setDateBasis] = useState<DateBasis>('billed_at')
  const [dateFrom, setDateFrom] = useState(() => {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [agingFilter, setAgingFilter] = useState<AgingFilter>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<ReconciliationRow[]>([])
  const [serverMetrics, setServerMetrics] = useState<EcommerceMetrics | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<Partial<Record<EcommerceFileKind, PendingImport>>>({})
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<OperationProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [selectedRow, setSelectedRow] = useState<ReconciliationRow | null>(null)
  const [detailLines, setDetailLines] = useState<Record<string, unknown>[]>([])
  const [detailLineSource, setDetailLineSource] = useState<'platform' | 'erp' | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editingRow, setEditingRow] = useState<ReconciliationRow | null>(null)
  const [manualStatus, setManualStatus] = useState<'cancelled' | 'returned'>('cancelled')
  const [manualNote, setManualNote] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)
  const [importHistory, setImportHistory] = useState<Record<string, unknown>[]>([])
  const rowsCacheKeyRef = useRef('')
  const summaryCacheKeyRef = useRef('')
  const historyCacheKeyRef = useRef('')
  const rowsRequestRef = useRef(0)
  const summaryRequestRef = useRef(0)

  const selectedChannel = channels.find((channel) => channel.id === channelId)
  const isTikTok = selectedChannel?.code === 'tiktok'
  const acceptedFileKinds: EcommerceFileKind[] = isTikTok ? ['orders', 'income'] : ['orders', 'income', 'balance']
  const receivedSourceLabel = isTikTok ? 'บัญชี TikTok' : 'Balance'

  const loadChannels = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('ac_ecommerce_channels')
      .select('id, code, display_name')
      .eq('is_active', true)
      .order('display_name')
    if (loadError) throw loadError
    const list = (data ?? []) as Channel[]
    setChannels(list)
    setChannelId((current) => current || list.find((channel) => channel.code === 'shopee')?.id || list[0]?.id || '')
  }, [])

  const loadRows = useCallback(async (force = false) => {
    if (!channelId) return
    const cacheKey = [tab, channelId, dateBasis, dateFrom, dateTo, statusFilter, agingFilter, debouncedSearch.trim(), page].join('|')
    if (!force && rowsCacheKeyRef.current === cacheKey) return
    const requestId = ++rowsRequestRef.current
    setLoading(true)
    setError(null)
    try {
      const from = page * PAGE_SIZE
      const detailResult = await supabase.rpc('ac_ecommerce_marketplace_bill_page_v2', {
        p_channel_id: channelId,
        p_date_basis: dateBasis,
        p_date_from: `${dateFrom}T00:00:00+07:00`,
        p_date_to: `${dateTo}T23:59:59.999+07:00`,
        p_search: debouncedSearch.trim() || null,
        p_status_filter: statusFilter,
        p_aging: agingFilter,
        p_offset: from,
        p_limit: PAGE_SIZE + 1,
      })
      if (detailResult.error) {
        const message = formatError(detailResult.error)
        throw new Error(
          message.includes('ac_ecommerce_marketplace_bill_page_v2')
            ? `${message} — กรุณารัน migration 588_ecommerce_executive_dashboard.sql และ 589_ecommerce_payout_aging_by_billed_date.sql`
            : message,
        )
      }
      if (requestId !== rowsRequestRef.current) return
      const loadedRows = (Array.isArray(detailResult.data) ? detailResult.data : []) as ReconciliationRow[]
      setRows(loadedRows.slice(0, PAGE_SIZE))
      setHasNextPage(loadedRows.length > PAGE_SIZE)
      rowsCacheKeyRef.current = cacheKey
    } catch (loadError) {
      if (requestId !== rowsRequestRef.current) return
      setRows([])
      setHasNextPage(false)
      setError(formatError(loadError))
    } finally {
      if (requestId === rowsRequestRef.current) setLoading(false)
    }
  }, [agingFilter, channelId, dateBasis, dateFrom, dateTo, debouncedSearch, page, statusFilter, tab])

  const loadSummary = useCallback(async (force = false) => {
    if (!channelId) return
    const cacheKey = [tab, channelId, dateBasis, dateFrom, dateTo, statusFilter, agingFilter, debouncedSearch.trim()].join('|')
    if (!force && summaryCacheKeyRef.current === cacheKey) return
    const requestId = ++summaryRequestRef.current

    const summaryRequest = supabase.rpc('ac_ecommerce_marketplace_bill_summary_v2', {
      p_channel_id: channelId,
      p_date_basis: dateBasis,
      p_date_from: `${dateFrom}T00:00:00+07:00`,
      p_date_to: `${dateTo}T23:59:59.999+07:00`,
      p_search: debouncedSearch.trim() || null,
      p_status_filter: statusFilter,
      p_aging: agingFilter,
    })
    const useTikTokRoundTotals = selectedChannel?.code === 'tiktok'
      && statusFilter === 'all'
      && agingFilter === 'all'
      && !debouncedSearch.trim()
    const roundTotalsRequest = useTikTokRoundTotals
      ? supabase
          .from('ac_ecommerce_wallet_transactions')
          .select('amount,transaction_type,raw_snapshot,created_at')
          .eq('channel_id', channelId)
          .in('transaction_type', [TIKTOK_REPORT_TOTAL_TYPE, TIKTOK_REPORT_FEE_TYPE, TIKTOK_WITHDRAWAL_TYPE])
          .gte('transaction_at', `${dateFrom}T00:00:00+07:00`)
          .lte('transaction_at', `${dateTo}T23:59:59.999+07:00`)
      : Promise.resolve({ data: null, error: null })
    const [summaryResult, roundTotalsResult] = await Promise.all([summaryRequest, roundTotalsRequest])
    const { data: aggregateData, error: aggregateError } = summaryResult
    if (requestId !== summaryRequestRef.current) return
    if (!aggregateError && aggregateData?.[0]) {
      const row = aggregateData[0] as Record<string, unknown>
      const roundTotals = (roundTotalsResult.data ?? []) as Array<{
        amount: number | string
        transaction_type: string | null
        raw_snapshot: Record<string, unknown> | null
        created_at: string
      }>
      const exactReportRows = roundTotals.filter((item) => (
        item.raw_snapshot?.report_from === dateFrom
        && item.raw_snapshot?.report_to === dateTo
      ))
      const reportedTotal = Number(
        exactReportRows.find((item) => item.transaction_type === TIKTOK_REPORT_TOTAL_TYPE)?.amount ?? 0,
      )
      const transferredTotal = roundTotals
        .filter((item) => item.transaction_type === TIKTOK_WITHDRAWAL_TYPE)
        .reduce((sum, item) => sum + Number(item.amount ?? 0), 0)
      const reportedFeeTotal = Number(
        exactReportRows.find((item) => item.transaction_type === TIKTOK_REPORT_FEE_TYPE)?.amount ?? 0,
      )
      setServerMetrics({
        orders: Number(row.order_count ?? 0),
        delivered: Number(row.delivered_count ?? 0),
        cancelled: Number(row.cancelled_count ?? 0),
        shipping: Number(row.shipping_count ?? 0),
        paid: Number(row.paid_count ?? 0),
        issues: Number(row.issue_count ?? 0),
        sales: Number(row.sales_total ?? 0),
        fees: useTikTokRoundTotals && reportedFeeTotal !== 0 ? reportedFeeTotal : Number(row.fee_total ?? 0),
        payout: useTikTokRoundTotals && reportedTotal !== 0 ? reportedTotal : Number(row.payout_total ?? 0),
        wallet: useTikTokRoundTotals && transferredTotal !== 0 ? transferredTotal : Number(row.wallet_total ?? 0),
        paidZero: Number(row.paid_zero_count ?? 0),
        waitingSettlement: Number(row.waiting_settlement_count ?? 0),
        waitingWallet: Number(row.waiting_wallet_count ?? 0),
        mismatch: Number(row.mismatch_count ?? 0),
        orderMatched: Number(row.order_match_count ?? 0),
        incomeMatched: Number(row.income_match_count ?? 0),
        balanceMatched: Number(row.balance_match_count ?? 0),
        missingOrder: Number(row.missing_order_count ?? 0),
        returned: Number(row.returned_count ?? 0),
        deliveredValue: Number(row.delivered_total ?? 0),
        withinCycle: Number(row.within_cycle_count ?? 0),
        overdueCycle: Number(row.overdue_cycle_count ?? 0),
        overdueTwoCycles: Number(row.overdue_two_cycles_count ?? 0),
        withinCycleValue: Number(row.within_cycle_total ?? 0),
        overdueCycleValue: Number(row.overdue_cycle_total ?? 0),
        overdueTwoCyclesValue: Number(row.overdue_two_cycles_total ?? 0),
        paidValue: Number(row.paid_total ?? 0),
        mismatchValue: Number(row.mismatch_total ?? 0),
      })
      summaryCacheKeyRef.current = cacheKey
      return
    }

    setServerMetrics(null)
    const aggregateMessage = formatError(aggregateError)
    setError(
      aggregateMessage.includes('ac_ecommerce_marketplace_bill_summary_v2')
        ? `${aggregateMessage} — กรุณา deploy migration 588_ecommerce_executive_dashboard.sql และ 589_ecommerce_payout_aging_by_billed_date.sql`
        : aggregateMessage,
    )
  }, [agingFilter, channelId, dateBasis, dateFrom, dateTo, debouncedSearch, selectedChannel?.code, statusFilter, tab])

  const loadImportHistory = useCallback(async (force = false) => {
    if (!channelId) return
    if (!force && historyCacheKeyRef.current === channelId) return
    let query = supabase
      .from('ac_ecommerce_import_batches')
      .select('id,file_name,file_kind,report_from,report_to,row_count,import_status,uploaded_at,channel_id')
      .order('uploaded_at', { ascending: false })
      .limit(30)
    if (channelId) query = query.eq('channel_id', channelId)
    const { data, error: historyError } = await query
    if (historyError) return
    setImportHistory((data ?? []) as Record<string, unknown>[])
    historyCacheKeyRef.current = channelId
  }, [channelId])

  useEffect(() => {
    void loadChannels().catch((loadError) => setError(formatError(loadError)))
  }, [loadChannels])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 350)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    if (tab === 'records') void loadRows()
  }, [tab, loadRows])

  useEffect(() => {
    if (tab !== 'imports') void loadSummary()
  }, [tab, loadSummary])

  useEffect(() => {
    if (tab === 'imports') void loadImportHistory()
  }, [tab, loadImportHistory])

  const metrics = serverMetrics ?? EMPTY_METRICS

  async function chooseFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files).filter((file) => {
      const name = file.name.toLowerCase()
      return name.endsWith('.xlsx') || name.endsWith('.xls')
    })
    if (selectedFiles.length === 0) {
      setProgress({ status: 'error', title: 'อ่านไฟล์ไม่สำเร็จ', message: 'กรุณาเลือกไฟล์ Excel นามสกุล .xlsx หรือ .xls', current: 0, total: 1 })
      return
    }
    setParsing(true)
    setError(null)
    setInfo(null)
    setProgress({
      status: 'working',
      title: 'กำลังอ่านไฟล์ Excel',
      message: 'กำลังเปิดไฟล์…',
      fileName: selectedFiles[0].name,
      current: 0,
      total: selectedFiles.length,
    })
    try {
      const next = { ...pending }
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index]
        setProgress({ status: 'working', title: 'กำลังอ่านไฟล์ Excel', message: 'กำลังอ่านข้อมูลจากไฟล์…', fileName: file.name, current: index, total: selectedFiles.length })
        const parsed = await parseFileInWorker(file, selectedChannel?.code ?? 'shopee', (message) => {
          setProgress({ status: 'working', title: 'กำลังอ่านไฟล์ Excel', message, fileName: file.name, current: index, total: selectedFiles.length })
        })
        next[parsed.kind] = { file, parsed }
        setPending({ ...next })
      }
      setProgress({
        status: 'success',
        title: 'อ่านไฟล์สำเร็จ',
        message: `ตรวจสอบแล้ว ${selectedFiles.length.toLocaleString()} ไฟล์ พร้อมกด “นำเข้าไฟล์”`,
        current: selectedFiles.length,
        total: selectedFiles.length,
      })
    } catch (parseError) {
      const message = formatError(parseError)
      setError(message)
      setProgress({ status: 'error', title: 'อ่านไฟล์ไม่สำเร็จ', message, current: 0, total: selectedFiles.length })
    } finally {
      setParsing(false)
    }
  }

  async function createBatch(item: PendingImport): Promise<string> {
    const parsedCount = item.parsed.kind === 'orders'
      ? item.parsed.orders.length
      : item.parsed.kind === 'income'
        ? item.parsed.settlements.length
        : item.parsed.transactions.length
    const { data, error: batchError } = await supabase
      .from('ac_ecommerce_import_batches')
      .insert({
        channel_id: channelId,
        file_name: item.file.name,
        file_kind: item.parsed.kind,
        report_from: item.parsed.reportFrom,
        report_to: item.parsed.reportTo,
        row_count: parsedCount,
        import_status: 'processing',
        uploaded_by: user?.id ?? null,
        metadata: { sheet_name: item.parsed.sheetName },
      })
      .select('id')
      .single()
    if (batchError || !data) throw batchError ?? new Error('สร้างรอบนำเข้าไม่สำเร็จ')
    return data.id as string
  }

  async function importOrders(item: PendingImport, batchId: string) {
    if (item.parsed.kind !== 'orders') return
    const orders = item.parsed.orders
    const orderIds = new Map<string, string>()
    for (let index = 0; index < orders.length; index += WRITE_CHUNK) {
      const chunk = orders.slice(index, index + WRITE_CHUNK)
      const { data, error: upsertError } = await supabase
        .from('ac_ecommerce_orders')
        .upsert(
          chunk.map((order) => ({
            channel_id: channelId,
            source_batch_id: batchId,
            order_no: order.orderNo,
            platform_status: order.platformStatus,
            delivery_status: order.deliveryStatus,
            refund_status: order.refundStatus,
            buyer_username: order.buyerUsername,
            ordered_at: order.orderedAt,
            paid_at: order.paidAt,
            shipped_at: order.shippedAt,
            completed_at: order.completedAt,
            tracking_no: order.trackingNo,
            buyer_paid: order.buyerPaid,
            merchandise_total: order.merchandiseTotal,
            order_total: order.orderTotal,
            estimated_commission: order.estimatedCommission,
            estimated_transaction_fee: order.estimatedTransactionFee,
            estimated_service_fee: order.estimatedServiceFee,
            estimated_shipping_cost: order.estimatedShippingCost,
            province: order.province,
            district: order.district,
            postal_code: order.postalCode,
            raw_snapshot: order.rawSnapshot,
          })),
          { onConflict: 'channel_id,order_no' },
        )
        .select('id,order_no')
      if (upsertError) throw upsertError
      for (const row of data ?? []) orderIds.set(String(row.order_no), String(row.id))
    }

    const ids = [...orderIds.values()]
    for (let index = 0; index < ids.length; index += WRITE_CHUNK) {
      const { error: deleteError } = await supabase
        .from('ac_ecommerce_order_lines')
        .delete()
        .in('order_id', ids.slice(index, index + WRITE_CHUNK))
      if (deleteError) throw deleteError
    }
    const lines = orders.flatMap((order) => {
      const orderId = orderIds.get(order.orderNo)
      if (!orderId) return []
      return order.lines.map((line) => ({
        order_id: orderId,
        source_line_index: line.sourceLineIndex,
        sku_ref: line.skuRef,
        product_name: line.productName,
        variation: line.variation,
        qty: line.qty,
        returned_qty: line.returnedQty,
        original_price: line.originalPrice,
        sale_price: line.salePrice,
        net_line_amount: line.netLineAmount,
        raw_snapshot: line.rawSnapshot,
      }))
    })
    await insertChunks('ac_ecommerce_order_lines', lines)
  }

  async function importIncome(item: PendingImport, batchId: string) {
    if (item.parsed.kind !== 'income') return
    for (let index = 0; index < item.parsed.settlements.length; index += WRITE_CHUNK) {
      const chunk = item.parsed.settlements.slice(index, index + WRITE_CHUNK)
      const { error: upsertError } = await supabase
        .from('ac_ecommerce_settlements')
        .upsert(
          chunk.map((row) => ({
            channel_id: channelId,
            source_batch_id: batchId,
            order_no: row.orderNo,
            settled_at: row.settledAt,
            ordered_at: row.orderedAt,
            buyer_username: row.buyerUsername,
            gross_sales: row.grossSales,
            seller_discounts: row.sellerDiscounts,
            refunds: row.refunds,
            shipping_net: row.shippingNet,
            platform_fee_total: row.platformFeeTotal,
            seller_cost_total: row.sellerCostTotal,
            fee_category_count: row.feeCategoryCount,
            payout_amount: row.payoutAmount,
            fee_breakdown: row.feeBreakdown,
            raw_snapshot: row.rawSnapshot,
          })),
          { onConflict: 'channel_id,order_no' },
        )
      if (upsertError) throw upsertError
    }
    if (item.parsed.walletTransactions?.length) {
      await importWalletTransactions(item.parsed.walletTransactions, batchId)
    }
  }

  async function importWalletTransactions(transactions: ShopeeWalletTransaction[], batchId: string) {
    for (let index = 0; index < transactions.length; index += WRITE_CHUNK) {
      const chunk = transactions.slice(index, index + WRITE_CHUNK)
      const { error: upsertError } = await supabase
        .from('ac_ecommerce_wallet_transactions')
        .upsert(
          chunk.map((row) => ({
            channel_id: channelId,
            source_batch_id: batchId,
            source_row_index: row.sourceRowIndex,
            source_key: row.sourceKey ?? [row.transactionAt, row.orderNo, row.direction, row.amount.toFixed(4), row.transactionType].join('|'),
            order_no: row.orderNo,
            transaction_at: row.transactionAt,
            transaction_type: row.transactionType,
            description: row.description,
            direction: row.direction,
            amount: row.amount,
            status: row.status,
            balance_after: row.balanceAfter,
            raw_snapshot: row.rawSnapshot,
          })),
          { onConflict: 'channel_id,source_key' },
        )
      if (upsertError) throw upsertError
    }
  }

  async function importBalance(item: PendingImport, batchId: string) {
    if (item.parsed.kind !== 'balance') return
    await importWalletTransactions(item.parsed.transactions, batchId)
  }

  async function runImport() {
    if (!channelId || !selectedChannel) {
      setError('เลือกแพลตฟอร์มก่อนนำเข้า')
      return
    }
    if (!['shopee', 'tiktok'].includes(selectedChannel.code)) {
      setError('แพลตฟอร์มนี้ยังไม่รองรับการนำเข้าไฟล์กระทบยอด')
      return
    }
    const items = acceptedFileKinds
      .map((kind) => pending[kind])
      .filter((item): item is PendingImport => Boolean(item))
    if (!items.length) {
      setError('เลือกไฟล์อย่างน้อย 1 ไฟล์')
      return
    }
    const importWarnings = items.flatMap((item) => item.parsed.kind === 'income' ? item.parsed.warnings ?? [] : [])
    if (importWarnings.length > 0) {
      const message = importWarnings.join(' · ')
      setError(message)
      setProgress({
        status: 'error',
        title: 'ข้อมูลในไฟล์ Income ไม่ครบ',
        message,
        current: 0,
        total: items.length,
      })
      return
    }

    setImporting(true)
    setError(null)
    setInfo(null)
    setProgress({ status: 'working', title: 'กำลังนำเข้าข้อมูล', message: 'กำลังเตรียมรอบนำเข้า…', current: 0, total: items.length })
    let completed = 0
    try {
      for (const item of items) {
        setProgress({ status: 'working', title: 'กำลังนำเข้าข้อมูล', message: 'กำลังบันทึกและเชื่อมเลขคำสั่งซื้อ…', fileName: item.file.name, current: completed, total: items.length })
        const batchId = await createBatch(item)
        try {
          if (item.parsed.kind === 'orders') await importOrders(item, batchId)
          if (item.parsed.kind === 'income') await importIncome(item, batchId)
          if (item.parsed.kind === 'balance') await importBalance(item, batchId)
          const { error: finishError } = await supabase
            .from('ac_ecommerce_import_batches')
            .update({ import_status: 'completed' })
            .eq('id', batchId)
          if (finishError) throw finishError
          completed += 1
        } catch (importError) {
          await supabase.from('ac_ecommerce_import_batches').update({ import_status: 'failed' }).eq('id', batchId)
          throw importError
        }
      }
      setPending({})
      setInfo(`นำเข้าสำเร็จ ${completed} ไฟล์ ระบบเชื่อมข้อมูลด้วยเลขคำสั่งซื้อแล้ว`)
      setProgress({ status: 'success', title: 'นำเข้าสำเร็จ', message: `บันทึกข้อมูลครบ ${completed.toLocaleString()} ไฟล์แล้ว`, current: completed, total: items.length })
      await Promise.all([loadRows(true), loadSummary(true), loadImportHistory(true)])
    } catch (importError) {
      const message = formatError(importError)
      setError(message)
      setProgress({ status: 'error', title: 'นำเข้าไม่สำเร็จ', message, current: completed, total: items.length })
    } finally {
      setImporting(false)
    }
  }

  async function openOrder(row: ReconciliationRow) {
    setSelectedRow(row)
    setDetailLines([])
    setDetailLineSource(null)
    setDetailLoading(true)
    try {
      if (row.ecommerce_order_id) {
        const { data } = await supabase
          .from('ac_ecommerce_order_lines')
          .select('id,sku_ref,product_name,variation,qty,returned_qty,sale_price,net_line_amount')
          .eq('order_id', row.ecommerce_order_id)
          .order('source_line_index')
        if (data?.length) {
          setDetailLines(data as Record<string, unknown>[])
          setDetailLineSource('platform')
          return
        }
      }

      // Income/Balance reports do not contain product names. When the matching
      // Order report is not imported, use the already-linked ERP bill instead.
      if (row.erp_order_id) {
        const { data } = await supabase
          .from('or_order_items')
          .select('id,product_id,product_name,quantity,unit_price,pr_products(product_code)')
          .eq('order_id', row.erp_order_id)
          .order('created_at')
        if (data?.length) {
          const lines = data.map((line) => {
            const product = Array.isArray(line.pr_products) ? line.pr_products[0] : line.pr_products
            const qty = Number(line.quantity ?? 0)
            const unitPrice = Number(line.unit_price ?? 0)
            return {
              id: line.id,
              sku_ref: product?.product_code ?? line.product_id,
              product_name: line.product_name,
              variation: null,
              qty,
              returned_qty: 0,
              sale_price: unitPrice,
              net_line_amount: qty * unitPrice,
            }
          })
          setDetailLines(lines)
          setDetailLineSource('erp')
        }
      }
    } finally {
      setDetailLoading(false)
    }
  }

  function openManualStatusEditor(row: ReconciliationRow) {
    setEditingRow(row)
    setManualStatus(row.manual_status ?? 'cancelled')
    setManualNote(row.manual_note ?? '')
    setManualError(null)
  }

  async function saveManualStatus() {
    if (!editingRow) return
    setManualSaving(true)
    setManualError(null)
    try {
      const { error: saveError } = await supabase.rpc('ac_ecommerce_set_manual_status', {
        p_channel_id: editingRow.channel_id,
        p_order_no: editingRow.order_no,
        p_status: manualStatus,
        p_note: manualNote.trim() || null,
      })
      if (saveError) {
        const message = formatError(saveError)
        throw new Error(
          message.includes('ac_ecommerce_set_manual_status')
            ? `${message} — กรุณา deploy migration 587_ecommerce_reconciliation_manual_status.sql`
            : message,
        )
      }

      rowsCacheKeyRef.current = ''
      summaryCacheKeyRef.current = ''
      setEditingRow(null)
      setInfo(`บันทึกสถานะออเดอร์ ${editingRow.order_no} สำเร็จ`)
      await Promise.all([loadRows(true), loadSummary(true)])
    } catch (saveError) {
      setManualError(formatError(saveError))
    } finally {
      setManualSaving(false)
    }
  }

  function openRecords(status: StatusFilter = 'all', aging: AgingFilter = 'all') {
    setTab('records')
    setDateBasis('billed_at')
    setStatusFilter(status)
    setAgingFilter(aging)
    setSearch('')
    setDebouncedSearch('')
    setPage(0)
  }

  const tabs: { id: ViewTab; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard ผู้บริหาร' },
    { id: 'records', label: 'ตรวจสอบรายการ' },
    { id: 'imports', label: 'ประวัตินำเข้า' },
  ]

  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:px-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900">E-Commerce Reconciliation</h2>
            <p className="mt-1 text-sm text-slate-500">ติดตามตั้งแต่เปิดออเดอร์ จัดส่ง ค่าธรรมเนียม จนถึงเงินเข้าจริง</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => { setChannelId(channel.id); setPending({}); setPage(0) }}
                className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition ${channelId === channel.id ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {channel.display_name}
              </button>
            ))}
            {!channels.some((channel) => channel.code === 'lazada') && <span className="rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-400">Lazada · เร็ว ๆ นี้</span>}
            {!channels.some((channel) => channel.code === 'tiktok') && <span className="rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-400">TikTok · เร็ว ๆ นี้</span>}
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto border-t border-slate-100 px-4 pt-2 sm:px-6">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => { setTab(item.id); setStatusFilter('all'); setAgingFilter('all'); setDateBasis('billed_at'); setPage(0) }} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold ${tab === item.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'dashboard' && (
        <>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h3 className="font-bold text-slate-900">Dashboard ผู้บริหาร</h3>
                <p className="mt-1 text-xs text-slate-500">นับอายุจากวันที่เปิดบิลถึงวันปัจจุบัน · เกณฑ์ติดตาม 7 วัน · คลิกการ์ดหรือกราฟเพื่อดูรายการ</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-slate-600">จากวันที่<input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(0) }} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
                <label className="text-xs font-medium text-slate-600">ถึงวันที่<input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(0) }} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
                <button type="button" onClick={() => void loadSummary(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><FiRefreshCw /> โหลดใหม่</button>
              </div>
            </div>
          </div>

          {(error || info) && <div className={`rounded-xl border px-5 py-3 text-sm ${error ? 'border-red-100 bg-red-50 text-red-800' : 'border-emerald-100 bg-emerald-50 text-emerald-800'}`}>{error ?? info}</div>}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {([
              { label: 'ยอดบิล ERP', count: metrics.orders, value: metrics.sales, tone: 'text-slate-900', status: 'all', aging: 'all' },
              { label: 'รับเงินครบ', count: metrics.paid + metrics.paidZero, value: metrics.paidValue, tone: 'text-emerald-700', status: 'paid', aging: 'all' },
              { label: 'ยังอยู่ในรอบ 0–7 วัน', count: metrics.withinCycle, value: metrics.withinCycleValue, tone: 'text-blue-700', status: 'all', aging: 'within_7' },
              { label: 'เสี่ยง: เกินรอบ 7 วัน', count: metrics.overdueCycle, value: metrics.overdueCycleValue, tone: 'text-orange-700', status: 'all', aging: 'days_8_14' },
              { label: 'เสี่ยงสูง: เกิน 14 วัน', count: metrics.overdueTwoCycles, value: metrics.overdueTwoCyclesValue, tone: 'text-red-700', status: 'all', aging: 'over_14' },
              { label: `Income/${receivedSourceLabel} ไม่ตรง`, count: metrics.mismatch, value: metrics.mismatchValue, tone: 'text-rose-700', status: 'amount_mismatch', aging: 'all' },
            ] as Array<{ label: string; count: number; value: number; tone: string; status: StatusFilter; aging: AgingFilter }>).map((item) => (
              <button key={item.label} type="button" onClick={() => openRecords(item.status, item.aging)} className="rounded-xl border border-slate-200 bg-white px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md">
                <p className="text-xs font-medium text-slate-500">{item.label}</p>
                <p className={`mt-1 text-2xl font-bold tabular-nums ${item.tone}`}>{item.count.toLocaleString()} <span className="text-xs font-semibold text-slate-400">บิล</span></p>
                <p className="mt-1 text-sm font-semibold tabular-nums text-slate-700">฿{money(item.value)}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5"><h3 className="font-bold text-slate-900">เส้นทางจากยอดขายถึงเงินเข้า</h3><p className="mt-1 text-xs text-slate-500">มูลค่าของบิลในช่วงที่เลือก</p></div>
              <div className="space-y-4">
                {([
                  { label: 'ยอดเปิดบิล ERP', value: metrics.sales, color: 'bg-slate-600', status: 'all' },
                  { label: 'จัดส่งสำเร็จ', value: metrics.deliveredValue, color: 'bg-blue-500', status: 'delivered' },
                  { label: 'ยอดสุทธิจาก Income', value: metrics.payout, color: 'bg-violet-500', status: 'income_found' },
                  { label: `เงินเข้า ${receivedSourceLabel}`, value: metrics.wallet, color: 'bg-emerald-500', status: 'balance_found' },
                ] as Array<{ label: string; value: number; color: string; status: StatusFilter }>).map((item) => {
                  const width = item.value > 0 ? Math.max(3, (item.value / Math.max(metrics.sales, 1)) * 100) : 0
                  return <button key={item.label} type="button" onClick={() => openRecords(item.status)} className="block w-full text-left">
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="font-medium text-slate-600">{item.label}</span><span className="font-bold tabular-nums text-slate-900">฿{money(item.value)}</span></div>
                    <div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all ${item.color}`} style={{ width: `${Math.min(width, 100)}%` }} /></div>
                  </button>
                })}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm">
                <div><p className="text-xs text-slate-400">ค่าธรรมเนียมแพลตฟอร์ม</p><p className="mt-1 font-bold text-rose-700">฿{money(metrics.fees)} <span className="text-xs font-medium text-slate-400">({percent(metrics.fees, metrics.sales)})</span></p></div>
                <div><p className="text-xs text-slate-400">Income ลบ {receivedSourceLabel}</p><p className={`mt-1 font-bold ${Math.abs(metrics.payout - metrics.wallet) > 0.02 ? 'text-red-700' : 'text-emerald-700'}`}>฿{money(metrics.payout - metrics.wallet)}</p></div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5"><h3 className="font-bold text-slate-900">สถานะที่ต้องติดตาม</h3><p className="mt-1 text-xs text-slate-500">คลิกแต่ละแถบเพื่อเปิดรายการที่เกี่ยวข้อง</p></div>
              <div className="space-y-4">
                {([
                  { label: 'เปิดบิลแล้ว ไม่พบในไฟล์ Order', value: metrics.missingOrder, color: 'bg-red-500', status: 'not_found_order' },
                  { label: 'ส่งสำเร็จ รอ Income', value: metrics.waitingSettlement, color: 'bg-orange-500', status: 'waiting_settlement' },
                  { label: `พบ Income รอ ${receivedSourceLabel}`, value: metrics.waitingWallet, color: 'bg-amber-500', status: 'waiting_wallet' },
                  { label: `Income กับ ${receivedSourceLabel} ไม่ตรง`, value: metrics.mismatch, color: 'bg-rose-500', status: 'amount_mismatch' },
                  { label: 'ยกเลิก/คืนสินค้า', value: metrics.cancelled + metrics.returned, color: 'bg-slate-500', status: 'cancelled_returned' },
                ] as Array<{ label: string; value: number; color: string; status: StatusFilter }>).map((item) => {
                  const width = item.value > 0 ? Math.max(3, (item.value / Math.max(metrics.orders, 1)) * 100) : 0
                  return <button key={item.label} type="button" onClick={() => openRecords(item.status)} className="block w-full text-left">
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="font-medium text-slate-600">{item.label}</span><span className="font-bold tabular-nums text-slate-900">{item.value.toLocaleString()} <span className="text-xs font-medium text-slate-400">({percent(item.value, metrics.orders)})</span></span></div>
                    <div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all ${item.color}`} style={{ width: `${Math.min(width, 100)}%` }} /></div>
                  </button>
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'records' && (
        <>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-900">นำเข้าไฟล์ประจำวัน</h3>
                <p className="mt-1 text-xs text-slate-500">{selectedChannel?.code === 'tiktok' ? 'TikTok ใช้ 2 ไฟล์: คำสั่งซื้อที่จัดส่งแล้ว และ Income' : 'Shopee ใช้ 3 ไฟล์: Order, Income และ Balance'} ระบบตรวจชนิดไฟล์และเชื่อมเลขคำสั่งซื้อให้อัตโนมัติ</p>
              </div>
              <div className="flex gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".xlsx,.xls"
                  className="sr-only"
                  onChange={(event) => {
                    // FileList is live and becomes empty as soon as the input is reset.
                    // Take a snapshot first so selecting a file always reaches the parser.
                    const files = Array.from(event.currentTarget.files ?? [])
                    event.currentTarget.value = ''
                    if (files.length > 0) void chooseFiles(files)
                  }}
                />
                <button type="button" disabled={parsing || importing || !channelId} onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                  <FiUpload /> {parsing ? 'กำลังอ่านไฟล์…' : 'เลือกไฟล์'}
                </button>
                <button type="button" disabled={importing || Object.keys(pending).length === 0} onClick={() => void runImport()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                  {importing ? 'กำลังนำเข้า…' : `นำเข้า ${Object.keys(pending).length || ''} ไฟล์`}
                </button>
              </div>
            </div>
            <div className={`mt-4 grid gap-3 ${selectedChannel?.code === 'tiktok' ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}>
              {acceptedFileKinds.map((kind) => {
                const item = pending[kind]
                const warning = item?.parsed.kind === 'income' ? item.parsed.warnings?.[0] : null
                const defaultMeta = FILE_KIND_META[kind]
                const meta = selectedChannel?.code === 'tiktok'
                  ? kind === 'orders'
                    ? { ...defaultMeta, title: '1. คำสั่งซื้อที่จัดส่งแล้ว', subtitle: 'จัดส่งแล้ว คำสั่งซื้อ…xlsx' }
                    : { ...defaultMeta, title: '2. รายได้ ค่าธรรมเนียม และเงินเข้า', subtitle: 'income_…xlsx' }
                  : defaultMeta
                return (
                  <div key={kind} className={`relative min-h-[112px] rounded-xl border transition ${warning ? 'border-amber-300 bg-amber-50/70' : item ? 'border-emerald-300 bg-emerald-50/60' : 'border-dashed border-slate-300 bg-slate-50/60 hover:border-blue-300 hover:bg-blue-50/40'}`}>
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-[110px] w-full items-start gap-3 p-4 text-left">
                      <span className={`rounded-lg p-2 ${item ? 'bg-emerald-100 text-emerald-700' : 'bg-white text-slate-400 shadow-sm'}`}>{item ? <FiCheckCircle /> : <FiFileText />}</span>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-800">{meta.title}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-400">{item?.file.name ?? meta.subtitle}</p>
                        {item && <p className="mt-2 text-xs font-medium text-emerald-800">{pendingSummary(item)}</p>}
                        {warning && <p className="mt-1 text-xs font-medium text-amber-800">{warning}</p>}
                      </div>
                    </button>
                    {item && <button type="button" aria-label={`นำไฟล์ ${meta.title} ออก`} onClick={() => setPending((current) => { const next = { ...current }; delete next[kind]; return next })} className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-white hover:text-red-600"><FiX /></button>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {[
              ['เปิดบิล ERP แล้ว', metrics.orders, 'text-slate-900'],
              ['พบในไฟล์ Order', metrics.orderMatched, 'text-blue-700'],
              ['พบในไฟล์ Income', metrics.incomeMatched, 'text-violet-700'],
              [`พบเงินเข้า ${receivedSourceLabel}`, metrics.balanceMatched, 'text-emerald-700'],
              ['รับเงินครบ', metrics.paid + metrics.paidZero, 'text-emerald-700'],
              ['ต้องติดตาม', metrics.issues, metrics.issues ? 'text-orange-700' : 'text-slate-900'],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs font-medium text-slate-500">{label}</p>
                <p className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>
                  {Number(value).toLocaleString()}
                  <span className="ml-2 text-sm font-semibold text-slate-400">({percent(Number(value), metrics.orders)})</span>
                </p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['ยอดบิล ERP', metrics.sales, 'ยอดบิลขายที่เปิดจากเมนู Marketplace เป็นฐาน 100%'],
              ['ค่าธรรมเนียมแพลตฟอร์ม', metrics.fees, 'สัดส่วนค่าธรรมเนียมเทียบยอดขาย'],
              ['ยอดสุทธิจากรายงาน Income', metrics.payout, `ยอดที่ ${selectedChannel?.display_name ?? 'แพลตฟอร์ม'} คำนวณว่าร้านค้าควรได้รับ`],
              ['ยอดเครดิตเข้าบัญชีผู้ขาย', metrics.wallet, isTikTok ? 'ยอดรายได้ที่ TikTok บันทึกเข้าบัญชีผู้ขายตามออเดอร์' : 'ยอดที่บันทึกเข้า Shopee Balance จริง'],
            ].map(([label, value, description]) => (
              <div key={String(label)} className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                <p className="text-xs font-medium text-slate-500">{label}</p>
                <p className="mt-1 text-xl font-bold tabular-nums text-slate-900">
                  ฿{money(Number(value))}
                  <span className="ml-2 text-xs font-semibold text-slate-400">({percent(Number(value), metrics.sales)})</span>
                </p>
                <p className="mt-1 text-[11px] text-slate-400">{description}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'records' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4">
            <label className="text-xs font-medium text-slate-600">อิงวันที่
              <select value={dateBasis} onChange={(event) => { setDateBasis(event.target.value as DateBasis); setPage(0) }} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="billed_at">วันที่เปิดบิล Marketplace</option>
                <option value="completed_at">วันที่จัดส่งสำเร็จ</option>
                <option value="ordered_at">วันที่สั่งซื้อ</option>
                <option value="settled_at">วันที่แพลตฟอร์มเคลียร์เงิน</option>
                <option value="wallet_received_at">วันที่เงินเข้าบัญชีผู้ขาย</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">จากวันที่<input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(0) }} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
            <label className="text-xs font-medium text-slate-600">ถึงวันที่<input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(0) }} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
            <label className="text-xs font-medium text-slate-600">สถานะ
              <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as typeof statusFilter); setPage(0) }} className="mt-1 block min-w-[190px] rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="all">ทั้งหมด</option><option value="issues">เฉพาะที่ต้องติดตาม</option><option value="delivered">จัดส่งสำเร็จทั้งหมด</option><option value="income_found">พบใน Income</option><option value="balance_found">พบเงินเข้า {receivedSourceLabel}</option><option value="not_found_order">เปิดบิลแล้ว ไม่พบในไฟล์ Order</option><option value="waiting_delivery">รอจัดส่งสำเร็จ</option><option value="paid">รับเงินครบ</option><option value="waiting_settlement">ส่งสำเร็จ รอ Income</option><option value="waiting_wallet">พบ Income รอ {receivedSourceLabel}</option><option value="amount_mismatch">Income กับ {receivedSourceLabel} ไม่ตรง</option><option value="in_transit">กำลังจัดส่ง</option><option value="cancelled_returned">ยกเลิก/คืนสินค้า</option><option value="cancelled">ยกเลิก</option><option value="returned">คืนสินค้า/คืนเงิน</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">รอบรับเงิน
              <select value={agingFilter} onChange={(event) => { setAgingFilter(event.target.value as AgingFilter); setPage(0) }} className="mt-1 block min-w-[150px] rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="all">ทุกช่วงอายุ</option><option value="within_7">ยังอยู่ในรอบ 0–7 วัน</option><option value="days_8_14">เสี่ยง: เกินรอบ 7 วัน</option><option value="over_14">เสี่ยงสูง: เกิน 14 วัน</option>
              </select>
            </label>
            <label className="min-w-[220px] flex-1 text-xs font-medium text-slate-600">ค้นหาเลขออเดอร์<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} placeholder="เช่น 260919…" className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
            <button type="button" onClick={() => void Promise.all([loadRows(true), loadSummary(true)])} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><FiRefreshCw /> โหลดใหม่</button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50/70 px-5 py-3 text-sm text-blue-900">
            <p><span className="font-bold">กำลังแสดง:</span> {selectedChannel?.display_name ?? 'แพลตฟอร์ม'} · {statusFilterLabel(statusFilter)} · {agingFilterLabel(agingFilter)} · {dateFrom} ถึง {dateTo} · <span className="font-bold">{metrics.orders.toLocaleString()} บิล</span></p>
            <div className="flex gap-2">
              {(statusFilter !== 'all' || agingFilter !== 'all' || search) && <button type="button" onClick={() => { setStatusFilter('all'); setAgingFilter('all'); setSearch(''); setDebouncedSearch(''); setPage(0) }} className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100">ล้างตัวกรอง</button>}
              <button type="button" onClick={() => { setTab('dashboard'); setStatusFilter('all'); setAgingFilter('all'); setDateBasis('billed_at'); setPage(0) }} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">กลับ Dashboard</button>
            </div>
          </div>

          {(error || info) && <div className={`border-b px-5 py-3 text-sm ${error ? 'border-red-100 bg-red-50 text-red-800' : 'border-emerald-100 bg-emerald-50 text-emerald-800'}`}>{error ?? info}</div>}

          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-[1380px] w-full text-sm">
              <thead className="sticky top-0 z-20 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(226_232_240)]">
                <tr><th className="px-4 py-3 text-left">เลขคำสั่งซื้อ</th><th className="px-3 py-3 text-left">{dateBasis === 'billed_at' ? 'วันที่เปิดบิล' : dateBasis === 'ordered_at' ? 'วันที่สั่งซื้อ' : dateBasis === 'completed_at' ? 'วันที่ส่งสำเร็จ' : dateBasis === 'settled_at' ? 'วันที่เคลียร์เงิน' : 'วันที่เงินเข้า'}</th><th className="px-3 py-3 text-left">วันที่ Income</th><th className="px-3 py-3 text-left">การจัดส่ง</th><th className="px-3 py-3 text-left">บิล ERP</th><th className="px-3 py-3 text-right">ยอดออเดอร์</th><th className="px-3 py-3 text-center">ค่าที่เก็บ</th><th className="px-3 py-3 text-right">ค่าธรรมเนียม</th><th className="px-3 py-3 text-right">แพลตฟอร์มแจ้งจ่าย</th><th className="px-3 py-3 text-right">เงินเข้าจริง</th><th className="px-3 py-3 text-right">ส่วนต่าง</th><th className="px-3 py-3 text-left">สถานะกระทบยอด</th><th className="w-10" /></tr>
              </thead>
              <tbody>
                {loading ? <tr><td colSpan={13} className="px-4 py-14 text-center text-slate-400">กำลังโหลด…</td></tr> : rows.length === 0 ? <tr><td colSpan={13} className="px-4 py-14 text-center text-slate-400">ไม่พบข้อมูลตามเงื่อนไข</td></tr> : rows.map((row) => {
                  const status = STATUS_META[row.reconciliation_status] ?? STATUS_META.needs_review
                  return <tr key={`${row.channel_id}-${row.order_no}`} onClick={() => void openOrder(row)} className="cursor-pointer border-t border-slate-100 hover:bg-blue-50/40">
                    <td className="px-4 py-3"><p className="font-mono text-xs font-semibold text-slate-800">{row.order_no}</p><p className="mt-0.5 text-xs text-slate-400">{row.channel_name} · {row.line_count || 0} รายการ / {Number(row.item_qty || 0)} ชิ้น</p><p className={`mt-1 text-[11px] font-medium ${row.order_matched ? 'text-blue-600' : 'text-red-600'}`}>{row.order_matched ? 'พบในไฟล์ Order' : 'ไม่พบในไฟล์ Order'}</p></td>
                    <td className="px-3 py-3 whitespace-nowrap text-slate-600">{shortDate(dateBasis === 'billed_at' ? (row.marketplace_billed_at ?? row.ordered_at) : dateBasis === 'ordered_at' ? row.ordered_at : dateBasis === 'completed_at' ? (row.completed_at ?? row.marketplace_billed_at ?? row.ordered_at) : dateBasis === 'settled_at' ? (row.settled_at ?? row.marketplace_billed_at) : (row.wallet_received_at ?? row.marketplace_billed_at))}</td>
                    <td className="px-3 py-3 whitespace-nowrap text-slate-600">{row.income_matched && row.settled_at ? shortDate(row.settled_at) : <span className="text-slate-300">–</span>}</td>
                    <td className="px-3 py-3"><p className={`font-medium ${row.order_matched ? 'text-slate-700' : 'text-red-600'}`}>{row.order_matched ? (row.platform_status ?? row.delivery_status) : 'ไม่พบข้อมูลจัดส่ง'}</p>{row.tracking_no && <p className="mt-0.5 font-mono text-[11px] text-slate-400">{row.tracking_no}</p>}</td>
                    <td className="px-3 py-3 font-mono text-xs text-slate-600">{row.erp_bill_no ?? <span className="text-orange-500">ยังไม่พบ</span>}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{money(row.order_total ?? row.gross_sales)}</td>
                    <td className="px-3 py-3 text-center tabular-nums">{row.fee_category_count ?? '–'}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-rose-700">{row.platform_fee_total != null ? `-${money(row.platform_fee_total)}` : '–'}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{row.income_matched ? money(row.payout_amount) : <span className="text-slate-300">–</span>}</td>
                    <td className="px-3 py-3 text-right tabular-nums font-medium text-emerald-700">{row.balance_matched ? money(row.wallet_amount) : <span className="text-slate-300">–</span>}</td>
                    <td className={`px-3 py-3 text-right tabular-nums ${Math.abs(Number(row.payout_variance ?? 0)) > 0.02 ? 'font-bold text-red-700' : 'text-slate-500'}`}>{row.income_matched && row.balance_matched ? money(row.payout_variance) : <span className="text-slate-300">–</span>}</td>
                    <td className="max-w-[240px] px-3 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${status.className}`}>{status.label}</span>{row.manual_note && <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500" title={row.manual_note}>{row.manual_note}</p>}</td>
                    <td className="pr-3"><div className="flex items-center justify-end gap-1"><button type="button" title="แก้ไขสถานะ" aria-label={`แก้ไขสถานะ ${row.order_no}`} onClick={(event) => { event.stopPropagation(); openManualStatusEditor(row) }} className="rounded-lg p-2 text-slate-400 hover:bg-blue-50 hover:text-blue-700"><FiEdit2 /></button><FiChevronRight className="text-slate-300" /></div></td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-sm text-slate-500"><span>หน้า {page + 1} · แสดง {rows.length.toLocaleString()} ออเดอร์</span><div className="flex gap-2"><button type="button" disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button><button type="button" disabled={!hasNextPage || loading} onClick={() => setPage((value) => value + 1)} className="rounded border px-3 py-1.5 disabled:opacity-40">ถัดไป</button></div></div>
        </div>
      )}

      {tab === 'imports' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-5 py-4"><h3 className="font-bold text-slate-900">ประวัตินำเข้า</h3><p className="mt-1 text-xs text-slate-500">ตรวจสอบไฟล์ ช่วงรายงาน และผลการนำเข้าแต่ละรอบ</p></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">เวลาอัปโหลด</th><th className="px-3 py-3 text-left">ประเภท</th><th className="px-3 py-3 text-left">ชื่อไฟล์</th><th className="px-3 py-3 text-left">ช่วงรายงาน</th><th className="px-3 py-3 text-right">จำนวน</th><th className="px-3 py-3 text-left">สถานะ</th></tr></thead><tbody>{importHistory.length === 0 ? <tr><td colSpan={6} className="py-12 text-center text-slate-400">ยังไม่มีประวัตินำเข้า</td></tr> : importHistory.map((item) => <tr key={String(item.id)} className="border-t border-slate-100"><td className="px-4 py-3">{shortDate(String(item.uploaded_at ?? ''))}</td><td className="px-3 py-3 font-medium">{FILE_KIND_META[(item.file_kind as EcommerceFileKind) ?? 'orders']?.title ?? String(item.file_kind)}</td><td className="max-w-[340px] truncate px-3 py-3 font-mono text-xs" title={String(item.file_name)}>{String(item.file_name)}</td><td className="px-3 py-3">{String(item.report_from ?? '–')} ถึง {String(item.report_to ?? '–')}</td><td className="px-3 py-3 text-right tabular-nums">{Number(item.row_count ?? 0).toLocaleString()}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.import_status === 'completed' ? 'bg-emerald-100 text-emerald-800' : item.import_status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>{item.import_status === 'completed' ? 'สำเร็จ' : item.import_status === 'failed' ? 'ไม่สำเร็จ' : 'กำลังประมวลผล'}</span></td></tr>)}</tbody></table></div>
        </div>
      )}

      {selectedRow && (
        <div className="fixed bottom-0 left-0 right-0 top-[calc(3.5rem+var(--subnav-height,0rem))] z-[70] flex justify-end bg-black/35 md:top-[calc(4rem+var(--subnav-height,0rem))]" onClick={() => setSelectedRow(null)}>
          <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-100 bg-white px-5 py-4"><div><p className="text-xs font-medium text-slate-400">รายละเอียดคำสั่งซื้อ</p><h3 className="mt-1 font-mono text-lg font-bold text-slate-900">{selectedRow.order_no}</h3></div><button type="button" onClick={() => setSelectedRow(null)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><FiX /></button></div>
            <div className="space-y-5 p-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['การจัดส่ง', selectedRow.order_matched ? (selectedRow.platform_status ?? selectedRow.delivery_status) : 'ไม่พบไฟล์ Order'], ['บิล ERP', selectedRow.erp_bill_no ?? 'ยังไม่พบ'], ['แพลตฟอร์มแจ้งจ่าย', selectedRow.income_matched ? money(selectedRow.payout_amount) : 'ยังไม่พบ Income'], ['เงินเข้าจริง', selectedRow.balance_matched ? money(selectedRow.wallet_amount) : 'ยังไม่พบข้อมูลเงินเข้า']].map(([label, value]) => <div key={label} className="rounded-lg bg-slate-50 p-3"><p className="text-[11px] text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-slate-800">{value}</p></div>)}</div>
              <div><div className="mb-2 flex items-center gap-2"><h4 className="text-sm font-bold text-slate-800">รายการสินค้า</h4>{detailLineSource && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${detailLineSource === 'platform' ? 'bg-orange-50 text-orange-700' : 'bg-blue-50 text-blue-700'}`}>{detailLineSource === 'platform' ? 'จากไฟล์ Order' : 'จากบิล ERP'}</span>}</div><div className="overflow-hidden rounded-lg border border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 text-left">SKU / สินค้า</th><th className="px-3 py-2 text-right">จำนวน</th><th className="px-3 py-2 text-right">ยอด</th></tr></thead><tbody>{detailLoading ? <tr><td colSpan={3} className="py-6 text-center text-slate-400">กำลังโหลดรายการสินค้า…</td></tr> : detailLines.length === 0 ? <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">ไม่พบรายละเอียดสินค้าในไฟล์ Order และบิล ERP</td></tr> : detailLines.map((line) => <tr key={String(line.id)} className="border-t border-slate-100"><td className="px-3 py-2"><p className="font-mono text-xs font-semibold">{String(line.sku_ref ?? '–')}</p><p className="mt-0.5 text-xs text-slate-500">{String(line.product_name ?? '')} {line.variation ? `· ${String(line.variation)}` : ''}</p></td><td className="px-3 py-2 text-right">{Number(line.qty ?? 0)}</td><td className="px-3 py-2 text-right tabular-nums">{money(Number(line.net_line_amount ?? 0))}</td></tr>)}</tbody></table></div>{detailLineSource === 'erp' && <p className="mt-1.5 text-[11px] text-slate-400">ไฟล์ Income ไม่มีรายละเอียดสินค้า และไม่พบออเดอร์นี้ในไฟล์ Order ที่นำเข้า จึงแสดงสินค้าจากบิล ERP ที่เชื่อมไว้</p>}</div>
              <div><h4 className="mb-2 text-sm font-bold text-slate-800">ค่าที่แพลตฟอร์มเรียกเก็บ</h4>{selectedRow.fee_breakdown && Object.keys(selectedRow.fee_breakdown).length ? <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">{Object.entries(selectedRow.fee_breakdown).filter(([, value]) => Number(value) !== 0).map(([label, value]) => <div key={label} className="flex items-center justify-between gap-4 px-3 py-2 text-sm"><span className="text-slate-600">{label}</span><span className="font-medium tabular-nums text-rose-700">{money(Number(value))}</span></div>)}<div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-sm font-bold"><span>รวมค่าธรรมเนียมแพลตฟอร์ม</span><span className="text-rose-700">-{money(selectedRow.platform_fee_total)}</span></div></div> : <div className="rounded-lg border border-dashed border-slate-300 py-6 text-center text-sm text-slate-400">ยังไม่มีไฟล์ Income ของออเดอร์นี้</div>}</div>
            </div>
          </aside>
        </div>
      )}

      {editingRow && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-labelledby="manual-status-title" onClick={() => { if (!manualSaving) setEditingRow(null) }}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 id="manual-status-title" className="text-lg font-bold text-slate-900">แก้ไขสถานะบิล</h3>
                <p className="mt-1 font-mono text-xs text-slate-500">{editingRow.order_no} · {editingRow.erp_bill_no ?? 'ไม่พบเลขบิล ERP'}</p>
              </div>
              <button type="button" disabled={manualSaving} onClick={() => setEditingRow(null)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40" aria-label="ปิด"><FiX /></button>
            </div>

            <div className="mt-5 space-y-4">
              <fieldset>
                <legend className="text-sm font-semibold text-slate-700">เลือกสถานะ</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {([
                    ['cancelled', 'ยกเลิก'],
                    ['returned', 'คืนเงิน/คืนสินค้า'],
                  ] as const).map(([value, label]) => (
                    <label key={value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${manualStatus === value ? 'border-blue-400 bg-blue-50 text-blue-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                      <input type="radio" name="manual-reconciliation-status" value={value} checked={manualStatus === value} onChange={() => setManualStatus(value)} className="h-4 w-4" />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block text-sm font-semibold text-slate-700">หมายเหตุ
                <textarea value={manualNote} onChange={(event) => setManualNote(event.target.value)} rows={4} maxLength={500} placeholder="ระบุสาเหตุหรือรายละเอียดเพิ่มเติม" className="mt-2 block w-full resize-y rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
                <span className="mt-1 block text-right text-xs font-normal text-slate-400">{manualNote.length}/500</span>
              </label>

              {manualError && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{manualError}</div>}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" disabled={manualSaving} onClick={() => setEditingRow(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40">ยกเลิก</button>
              <button type="button" disabled={manualSaving} onClick={() => void saveManualStatus()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{manualSaving && <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-white" />}ยืนยันการบันทึก</button>
            </div>
          </div>
        </div>
      )}

      {progress && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-labelledby="ecommerce-progress-title">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-4">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${progress.status === 'success' ? 'bg-emerald-100 text-emerald-700' : progress.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                {progress.status === 'working' ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-700" /> : progress.status === 'success' ? <FiCheckCircle className="h-6 w-6" /> : <FiX className="h-6 w-6" />}
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="ecommerce-progress-title" className="text-lg font-bold text-slate-900">{progress.title}</h3>
                {progress.fileName && <p className="mt-1 truncate font-mono text-xs text-slate-500" title={progress.fileName}>{progress.fileName}</p>}
                <p className={`mt-2 text-sm ${progress.status === 'error' ? 'text-red-700' : 'text-slate-600'}`}>{progress.message}</p>
              </div>
            </div>
            <div className="mt-5">
              <div className="mb-1.5 flex justify-between text-xs text-slate-400">
                <span>{progress.status === 'working' ? `ขั้นตอน ${Math.min(progress.current + 1, progress.total)} จาก ${progress.total}` : progress.status === 'success' ? 'เสร็จสมบูรณ์' : 'หยุดการทำงาน'}</span>
                <span>{progress.status === 'success' ? '100%' : `${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%`}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full transition-all duration-300 ${progress.status === 'error' ? 'bg-red-500' : progress.status === 'success' ? 'bg-emerald-500' : 'bg-blue-600'}`} style={{ width: `${progress.status === 'success' ? 100 : Math.max(8, (progress.current / Math.max(progress.total, 1)) * 100)}%` }} />
              </div>
            </div>
            {progress.status !== 'working' && (
              <div className="mt-5 flex justify-end">
                <button type="button" onClick={() => setProgress(null)} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${progress.status === 'error' ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>{progress.status === 'error' ? 'ปิดและเลือกไฟล์ใหม่' : 'ตกลง'}</button>
              </div>
            )}
            {progress.status === 'working' && <p className="mt-4 text-center text-xs text-slate-400">สามารถรอหน้าต่างนี้ได้ ระบบจะแจ้งผลเมื่อเสร็จ</p>}
          </div>
        </div>
      )}
    </section>
  )
}
