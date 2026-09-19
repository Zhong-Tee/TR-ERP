import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import type { Order } from '../../types'
import OrderDetailView from '../order/OrderDetailView'
import Modal from '../ui/Modal'
import { accountDisplay, easySlipAccountDetails } from '../../lib/easySlipAccount'
import { verifySlipFromStorage } from '../../lib/slipVerification'
import {
  normalizeBankAccount,
  parseBankStatementCsv,
  sha256Hex,
  type ParsedBankStatement,
} from '../../lib/bankStatement'

type BankSettingRow = {
  id: string
  account_number: string
  bank_code: string
  bank_name: string | null
  account_name: string | null
}

type ImportRow = {
  id: string
  bank_setting_id: string
  file_name: string
  parser_code: string
  account_number_snapshot: string
  account_name_snapshot: string | null
  period_start: string
  period_end: string
  opening_balance: number | null
  closing_balance: number | null
  declared_credit_total: number | null
  declared_debit_total: number | null
  source_row_count: number
  imported_row_count: number
  duplicate_row_count: number
  warnings: string[] | null
  status: string
  uploaded_at: string
  bank_settings: {
    bank_name: string | null
    account_number: string
    account_name: string | null
  } | null
}

type TransactionRow = {
  id: string
  source_row_number: number
  transaction_at: string
  transaction_type: string
  debit_amount: number
  credit_amount: number
  balance: number | null
  channel: string | null
  description: string | null
  reconciliation_status: 'unmatched' | 'matched' | 'ambiguous' | 'ignored'
}

type AllocationRow = {
  id: string
  transaction_id: string
  order_id: string
  allocated_amount: number
  match_method: string
  or_orders: {
    bill_no: string
    total_amount: number
    status: string
  } | null
}

type MissingPaymentRow = {
  source_type: string
  source_id: string
  order_id: string
  bill_no: string
  payment_at: string
  paid_amount: number
  bill_amount: number
  difference: number
}

type MatchDiagnosticCandidate = {
  source_type: 'verified_slip' | 'manual_slip'
  source_id: string
  order_id: string
  bill_no: string
  bill_created_at: string
  payment_at: string
  paid_amount: number
  source_status: string
  account_match: boolean
  sender_match: boolean
  already_allocated: boolean
  within_auto_window: boolean
  time_diff_minutes: number
  payment_before_bill_hours: number
  sender_name?: string | null
  sender_account?: string | null
  receiver_name?: string | null
  receiver_account?: string | null
}

type MatchDiagnosticRow = {
  transaction_id: string
  reason_code: string
  candidate_count: number
  available_candidate_count: number
  allocated_candidate_count: number
  candidates: MatchDiagnosticCandidate[]
  allocated_candidates: MatchDiagnosticCandidate[]
}

type MatchCandidateListsRow = {
  transaction_id: string
  available_candidate_count: number
  allocated_candidate_count: number
  available_candidates: MatchDiagnosticCandidate[]
  allocated_candidates: MatchDiagnosticCandidate[]
}

type UploadResult = {
  fileName: string
  success: boolean
  message: string
  importId?: string
}

type RetrySlipImage = {
  id: string
  storagePath: string | null
  imageUrl: string
  validationStatus: string | null
  retryStatus?: 'passed' | 'failed'
  retryMessage?: string
}

type ManualRetryDialog = {
  payment: MissingPaymentRow
  images: RetrySlipImage[]
}

type ManualMatchSource = {
  source_type: 'verified_slip' | 'manual_slip'
  source_id: string
  payment_at: string
  paid_amount: number
  time_diff_minutes: number
}

type ManualMatchSourceDialog = {
  transactionId: string
  billNo: string
  candidates: ManualMatchSource[]
}

function readableError(caught: unknown): string {
  if (caught instanceof Error) return caught.message
  if (caught && typeof caught === 'object') {
    const value = caught as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    const parts = [value.message, value.details, value.hint]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    if (parts.length > 0) return [...new Set(parts)].join(' · ')
    try {
      return JSON.stringify(caught)
    } catch {
      return 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'
    }
  }
  return String(caught)
}

function money(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString('th-TH', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function maskedAccount(value: string): string {
  const digits = normalizeBankAccount(value)
  return digits.length > 4 ? `••••${digits.slice(-4)}` : value
}

function statusLabel(status: TransactionRow['reconciliation_status']): string {
  if (status === 'matched') return 'จับคู่แล้ว'
  if (status === 'ambiguous') return 'รอตรวจ'
  if (status === 'ignored') return 'ไม่นำมาคิด'
  return 'ยังจับคู่ไม่ได้'
}

function statusClass(status: TransactionRow['reconciliation_status']): string {
  if (status === 'matched') return 'bg-emerald-100 text-emerald-700'
  if (status === 'ambiguous') return 'bg-amber-100 text-amber-700'
  if (status === 'ignored') return 'bg-gray-100 text-gray-600'
  return 'bg-red-100 text-red-700'
}

function diagnosticLabel(code: string): string {
  if (code === 'receiver_account_mismatch') return 'พบสลิปยอดเดียวกัน แต่บัญชีรับไม่ตรงกับ Statement นี้'
  if (code === 'slip_not_ready') return 'พบสลิปยอดเดียวกัน แต่ยังไม่อนุมัติ ถูกลบ หรือบิลถูกยกเลิก'
  if (code === 'slip_already_allocated') return 'พบสลิปยอดเดียวกัน แต่สลิปถูกจับกับเงินเข้ารายการอื่นแล้ว'
  if (code === 'outside_time_window') return 'พบสลิปยอดเดียวกันและบัญชีถูกต้อง แต่เวลาโอนต่างเกิน 10 นาที'
  if (code === 'multiple_candidates') return 'พบสลิปที่เข้าเงื่อนไขมากกว่า 1 รายการ ต้องเลือกบิลที่ถูกต้อง'
  if (code === 'rerun_auto_match') return 'พบสลิปที่ควรจับคู่ได้ กรุณากดตรวจจับคู่อีกครั้ง'
  return 'ไม่พบสลิปยอดเดียวกันภายใน 7 วันก่อนหรือหลังรายการเงินเข้า'
}

function durationLabel(minutes: number): string {
  const absolute = Math.abs(Number(minutes))
  if (absolute < 60) return `${money(absolute)} นาที`
  if (absolute < 1440) return `${money(absolute / 60)} ชั่วโมง`
  return `${money(absolute / 1440)} วัน`
}

export default function BankReconciliationSection() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const unmatchedSectionRef = useRef<HTMLDivElement>(null)
  const missingPaymentsSectionRef = useRef<HTMLDivElement>(null)
  const [banks, setBanks] = useState<BankSettingRow[]>([])
  const [imports, setImports] = useState<ImportRow[]>([])
  const [selectedImportId, setSelectedImportId] = useState('')
  const [transactions, setTransactions] = useState<TransactionRow[]>([])
  const [allocations, setAllocations] = useState<AllocationRow[]>([])
  const [missingPayments, setMissingPayments] = useState<MissingPaymentRow[]>([])
  const [matchDiagnostics, setMatchDiagnostics] = useState<MatchDiagnosticRow[]>([])
  const [expandedDiagnostics, setExpandedDiagnostics] = useState<Record<string, boolean>>({})
  const [expandedAllocatedDiagnostics, setExpandedAllocatedDiagnostics] = useState<Record<string, boolean>>({})
  const [manualBillNos, setManualBillNos] = useState<Record<string, string>>({})
  const [showDebitTransactions, setShowDebitTransactions] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [actionId, setActionId] = useState('')
  const [error, setError] = useState('')
  const [uploadResults, setUploadResults] = useState<UploadResult[]>([])
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)
  const [detailOrderLoadingId, setDetailOrderLoadingId] = useState('')
  const [manualRetryDialog, setManualRetryDialog] = useState<ManualRetryDialog | null>(null)
  const [manualRetryLoading, setManualRetryLoading] = useState(false)
  const [manualRetryMessage, setManualRetryMessage] = useState('')
  const [manualRetryProgress, setManualRetryProgress] = useState('')
  const [manualMatchSourceDialog, setManualMatchSourceDialog] = useState<ManualMatchSourceDialog | null>(null)

  const loadBaseData = useCallback(async (preferredImportId?: string) => {
    setLoading(true)
    setError('')
    try {
      const [bankResult, importResult] = await Promise.all([
        supabase
          .from('bank_settings')
          .select('id, account_number, bank_code, bank_name, account_name')
          .eq('is_active', true)
          .order('bank_name'),
        supabase
          .from('ac_bank_statement_imports')
          .select('*, bank_settings(bank_name, account_number, account_name)')
          .order('uploaded_at', { ascending: false })
          .limit(52),
      ])
      if (bankResult.error) throw bankResult.error
      if (importResult.error) throw importResult.error
      const loadedBanks = (bankResult.data || []) as BankSettingRow[]
      const loadedImports = (importResult.data || []) as unknown as ImportRow[]
      setBanks(loadedBanks)
      setImports(loadedImports)
      setSelectedImportId((current) => {
        if (preferredImportId && loadedImports.some((row) => row.id === preferredImportId)) return preferredImportId
        if (current && loadedImports.some((row) => row.id === current)) return current
        return loadedImports[0]?.id || ''
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (importId: string) => {
    if (!importId) {
      setTransactions([])
      setAllocations([])
      setMissingPayments([])
      setMatchDiagnostics([])
      return
    }
    setDetailLoading(true)
    setError('')
    try {
      const transactionResult = await supabase
        .from('ac_bank_statement_transactions')
        .select('id, source_row_number, transaction_at, transaction_type, debit_amount, credit_amount, balance, channel, description, reconciliation_status')
        .eq('import_id', importId)
        .order('transaction_at', { ascending: true })
        .order('id', { ascending: true })
      if (transactionResult.error) throw transactionResult.error
      const loadedTransactions = (transactionResult.data || []) as TransactionRow[]
      setTransactions(loadedTransactions)
      const transactionIds = loadedTransactions.map((row) => row.id)
      const [allocationResult, missingResult, diagnosticResult, candidateListsResult] = await Promise.all([
        supabase
          .from('ac_bank_reconciliation_allocations')
          .select('id, transaction_id, order_id, allocated_amount, match_method, or_orders(bill_no, total_amount, status)')
          .in('transaction_id', transactionIds.length > 0 ? transactionIds : ['00000000-0000-0000-0000-000000000000']),
        supabase.rpc('bank_reconciliation_missing_payments', { p_import_id: importId }),
        supabase.rpc('bank_statement_match_diagnostics', { p_import_id: importId }),
        supabase.rpc('bank_statement_match_candidate_lists', { p_import_id: importId }),
      ])
      const detailErrors: string[] = []
      if (allocationResult.error) {
        setAllocations([])
        detailErrors.push(`โหลดผลจับคู่ไม่สำเร็จ: ${readableError(allocationResult.error)}`)
      } else {
        setAllocations((allocationResult.data || []) as unknown as AllocationRow[])
      }
      if (missingResult.error) {
        setMissingPayments([])
        detailErrors.push(`ตรวจสลิปที่ไม่พบในบัญชีไม่สำเร็จ: ${readableError(missingResult.error)}`)
      } else {
        setMissingPayments((missingResult.data || []) as MissingPaymentRow[])
      }
      if (diagnosticResult.error) {
        setMatchDiagnostics([])
        detailErrors.push(`วิเคราะห์รายการที่จับคู่ไม่ได้ไม่สำเร็จ: ${readableError(diagnosticResult.error)}`)
      } else {
        if (candidateListsResult.error) {
          detailErrors.push(`แยกรายการใกล้เคียงไม่สำเร็จ: ${readableError(candidateListsResult.error)}`)
        }
        const candidateListsByTransaction = new Map(
          ((candidateListsResult.data || []) as MatchCandidateListsRow[]).map((row) => [row.transaction_id, row]),
        )
        const loadedDiagnostics = ((diagnosticResult.data || []) as Array<Omit<MatchDiagnosticRow, 'available_candidate_count' | 'allocated_candidate_count' | 'allocated_candidates'>>)
          .map((row) => {
            const lists = candidateListsByTransaction.get(row.transaction_id)
            const fallbackAvailable = row.candidates.filter((candidate) => !candidate.already_allocated)
            const fallbackAllocated = row.candidates.filter((candidate) => candidate.already_allocated)
            return {
              ...row,
              available_candidate_count: lists?.available_candidate_count ?? fallbackAvailable.length,
              allocated_candidate_count: lists?.allocated_candidate_count ?? fallbackAllocated.length,
              candidates: lists?.available_candidates ?? fallbackAvailable,
              allocated_candidates: lists?.allocated_candidates ?? fallbackAllocated,
            }
          })
        const easySlipIds = [...new Set(loadedDiagnostics.flatMap((row) => [...row.candidates, ...row.allocated_candidates])
          .filter((candidate) => candidate.source_type === 'verified_slip')
          .map((candidate) => candidate.source_id))]
        if (easySlipIds.length === 0) {
          setMatchDiagnostics(loadedDiagnostics)
        } else {
          const slipAccountResult = await supabase
            .from('ac_verified_slips')
            .select('id, easyslip_response, easyslip_receiver_account')
            .in('id', easySlipIds)
          if (slipAccountResult.error) {
            setMatchDiagnostics(loadedDiagnostics)
            detailErrors.push(`โหลดชื่อและเลขบัญชีจากสลิปไม่สำเร็จ: ${readableError(slipAccountResult.error)}`)
          } else {
            const accountBySlipId = new Map((slipAccountResult.data || []).map((slip) => [
              slip.id,
              easySlipAccountDetails(slip.easyslip_response, slip.easyslip_receiver_account),
            ]))
            setMatchDiagnostics(loadedDiagnostics.map((row) => ({
              ...row,
              candidates: row.candidates.map((candidate) => {
                const accounts = accountBySlipId.get(candidate.source_id)
                return accounts ? {
                  ...candidate,
                  sender_name: accounts.senderName,
                  sender_account: accounts.senderAccount,
                  receiver_name: accounts.receiverName,
                  receiver_account: accounts.receiverAccount,
                } : candidate
              }),
              allocated_candidates: row.allocated_candidates.map((candidate) => {
                const accounts = accountBySlipId.get(candidate.source_id)
                return accounts ? {
                  ...candidate,
                  sender_name: accounts.senderName,
                  sender_account: accounts.senderAccount,
                  receiver_name: accounts.receiverName,
                  receiver_account: accounts.receiverAccount,
                } : candidate
              }),
            })))
          }
        }
      }
      if (detailErrors.length > 0) setError(detailErrors.join(' | '))
    } catch (caught) {
      setTransactions([])
      setAllocations([])
      setMissingPayments([])
      setMatchDiagnostics([])
      setError(readableError(caught))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => { void loadBaseData() }, [loadBaseData])
  useEffect(() => { void loadDetail(selectedImportId) }, [loadDetail, selectedImportId])

  const selectedImport = imports.find((row) => row.id === selectedImportId) || null
  const allocationByTransaction = useMemo(() => {
    const map = new Map<string, AllocationRow[]>()
    allocations.forEach((row) => map.set(row.transaction_id, [...(map.get(row.transaction_id) || []), row]))
    return map
  }, [allocations])

  const diagnosticByTransaction = useMemo(
    () => new Map(matchDiagnostics.map((row) => [row.transaction_id, row])),
    [matchDiagnostics],
  )

  const orderSummaries = useMemo(() => {
    const map = new Map<string, { orderId: string; billNo: string; billAmount: number; received: number; status: string }>()
    allocations.forEach((row) => {
      if (!row.or_orders) return
      const current = map.get(row.order_id) || {
        orderId: row.order_id,
        billNo: row.or_orders.bill_no,
        billAmount: Number(row.or_orders.total_amount),
        received: 0,
        status: row.or_orders.status,
      }
      current.received += Number(row.allocated_amount)
      map.set(row.order_id, current)
    })
    return [...map.values()].sort((a, b) => a.billNo.localeCompare(b.billNo))
  }, [allocations])

  const totals = useMemo(() => ({
    credit: transactions.reduce((sum, row) => sum + Number(row.credit_amount), 0),
    matched: transactions.filter((row) => row.reconciliation_status === 'matched').reduce((sum, row) => sum + Number(row.credit_amount), 0),
    unmatchedCount: transactions.filter((row) => row.credit_amount > 0 && row.reconciliation_status === 'unmatched').length,
    ambiguousCount: transactions.filter((row) => row.reconciliation_status === 'ambiguous').length,
  }), [transactions])

  const displayedTransactions = useMemo(
    () => showDebitTransactions ? transactions : transactions.filter((row) => Number(row.credit_amount) > 0),
    [showDebitTransactions, transactions],
  )

  async function importOneFile(file: File): Promise<UploadResult> {
    try {
      const csvText = await file.text()
      const parsed: ParsedBankStatement = parseBankStatementCsv(csvText)
      const normalizedAccount = normalizeBankAccount(parsed.accountNumber)
      const bank = banks.find((row) => (
        row.bank_code === parsed.bankCode && normalizeBankAccount(row.account_number) === normalizedAccount
      ))
      if (!bank) {
        throw new Error(`ไม่พบบัญชี ${maskedAccount(parsed.accountNumber)} ในตั้งค่าธนาคาร`)
      }
      const fileHash = await sha256Hex(csvText)
      const { data, error: rpcError } = await supabase.rpc('bank_statement_import', {
        p_bank_setting_id: bank.id,
        p_file_name: file.name,
        p_file_hash: fileHash,
        p_metadata: {
          parser_code: parsed.parserCode,
          statement_reference: parsed.statementReference,
          account_number: parsed.accountNumber,
          account_name: parsed.accountName,
          period_start: parsed.periodStart,
          period_end: parsed.periodEnd,
          opening_balance: parsed.openingBalance,
          closing_balance: parsed.closingBalance,
          declared_credit_total: parsed.declaredCreditTotal,
          declared_debit_total: parsed.declaredDebitTotal,
          warnings: parsed.warnings,
        },
        p_transactions: parsed.transactions.map((row) => ({
          source_row_number: row.sourceRowNumber,
          transaction_at: row.transactionAt,
          effective_date: row.effectiveDate,
          transaction_type: row.transactionType,
          debit_amount: row.debitAmount,
          credit_amount: row.creditAmount,
          balance: row.balance,
          channel: row.channel,
          description: row.description,
          source_fingerprint: row.sourceFingerprint,
          raw_data: row.rawData,
        })),
      })
      if (rpcError) throw rpcError
      const result = data as { import_id?: string; inserted_count?: number; duplicate_count?: number; match_result?: { matched?: number; ambiguous?: number } }
      return {
        fileName: file.name,
        success: true,
        importId: result.import_id,
        message: `นำเข้า ${result.inserted_count ?? 0} รายการ, ซ้ำ ${result.duplicate_count ?? 0}, จับคู่ ${result.match_result?.matched ?? 0}, รอตรวจ ${result.match_result?.ambiguous ?? 0}`,
      }
    } catch (caught) {
      return { fileName: file.name, success: false, message: readableError(caught) }
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    setUploadResults([])
    setError('')
    const results: UploadResult[] = []
    for (const file of Array.from(files)) results.push(await importOneFile(file))
    setUploadResults(results)
    const lastSuccess = [...results].reverse().find((row) => row.success && row.importId)
    await loadBaseData(lastSuccess?.importId)
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function setManualMatch(transactionId: string) {
    const billNo = (manualBillNos[transactionId] || '').trim()
    if (!billNo) return
    setActionId(transactionId)
    setError('')
    const { data, error: rpcError } = await supabase.rpc('bank_reconciliation_set_manual_match', {
      p_transaction_id: transactionId,
      p_bill_no: billNo,
    })
    if (rpcError) setError(rpcError.message)
    else {
      const result = (data || {}) as {
        requires_source_selection?: boolean
        candidates?: ManualMatchSource[]
      }
      if (result.requires_source_selection && (result.candidates || []).length > 1) {
        setManualMatchSourceDialog({ transactionId, billNo, candidates: result.candidates || [] })
      } else {
        setManualBillNos((current) => ({ ...current, [transactionId]: '' }))
        await loadDetail(selectedImportId)
      }
    }
    setActionId('')
  }

  async function confirmManualMatchSource(candidate: ManualMatchSource) {
    if (!manualMatchSourceDialog) return
    setActionId(manualMatchSourceDialog.transactionId)
    setError('')
    const { error: rpcError } = await supabase.rpc('bank_reconciliation_set_manual_match_source', {
      p_transaction_id: manualMatchSourceDialog.transactionId,
      p_bill_no: manualMatchSourceDialog.billNo,
      p_source_type: candidate.source_type,
      p_source_id: candidate.source_id,
    })
    if (rpcError) setError(rpcError.message)
    else {
      setManualBillNos((current) => ({ ...current, [manualMatchSourceDialog.transactionId]: '' }))
      setManualMatchSourceDialog(null)
      await loadDetail(selectedImportId)
    }
    setActionId('')
  }

  async function clearMatch(transactionId: string) {
    setActionId(transactionId)
    setError('')
    const { error: rpcError } = await supabase.rpc('bank_reconciliation_clear_match', { p_transaction_id: transactionId })
    if (rpcError) setError(rpcError.message)
    else await loadDetail(selectedImportId)
    setActionId('')
  }

  async function rerunAutoMatch() {
    if (!selectedImportId) return
    setActionId('auto')
    setError('')
    const { error: rpcError } = await supabase.rpc('bank_statement_auto_match', { p_import_id: selectedImportId })
    if (rpcError) setError(rpcError.message)
    else await loadDetail(selectedImportId)
    setActionId('')
  }

  async function openOrderDetail(orderId: string) {
    if (!orderId || detailOrderLoadingId) return
    setDetailOrderLoadingId(orderId)
    setError('')
    try {
      const { data, error: orderError } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('id', orderId)
        .single()
      if (orderError) throw orderError
      const loadedOrder = data as Order & { or_order_items?: unknown[] }
      if (loadedOrder.or_order_items) loadedOrder.order_items = loadedOrder.or_order_items as Order['order_items']
      setDetailOrder(loadedOrder)
    } catch (caught) {
      setError(`เปิดรายละเอียดบิลไม่สำเร็จ: ${readableError(caught)}`)
    } finally {
      setDetailOrderLoadingId('')
    }
  }

  async function openManualEasySlipRetry(payment: MissingPaymentRow) {
    if (payment.source_type !== 'manual_slip') return
    setManualRetryLoading(true)
    setManualRetryMessage('')
    setError('')
    try {
      const { data, error: imageError } = await supabase
        .from('ac_verified_slips')
        .select('id, slip_image_url, slip_storage_path, validation_status')
        .eq('order_id', payment.order_id)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: true })
      if (imageError) throw imageError
      const images: RetrySlipImage[] = []
      for (const row of data || []) {
        let imageUrl = row.slip_image_url || ''
        if (row.slip_storage_path) {
          const [bucket = 'slip-images', ...pathParts] = row.slip_storage_path.split('/')
          const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(pathParts.join('/'), 3600)
          if (signed?.signedUrl) imageUrl = signed.signedUrl
        }
        if (imageUrl) images.push({
          id: row.id,
          storagePath: row.slip_storage_path,
          imageUrl,
          validationStatus: row.validation_status,
        })
      }
      setManualRetryDialog({ payment, images })
      setManualRetryProgress('')
      if (images.length === 0) setManualRetryMessage('ไม่พบรูปสลิปของบิลนี้ จึงยังตรวจ EasySlip ซ้ำไม่ได้')
    } catch (caught) {
      setError(`โหลดรูปสลิปไม่สำเร็จ: ${readableError(caught)}`)
    } finally {
      setManualRetryLoading(false)
    }
  }

  async function imageUrlToBase64(imageUrl: string): Promise<string> {
    const response = await fetch(imageUrl)
    if (!response.ok) throw new Error('ดาวน์โหลดรูปสลิปไม่สำเร็จ')
    const blob = await response.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
      reader.onerror = () => reject(new Error('อ่านรูปสลิปไม่สำเร็จ'))
      reader.readAsDataURL(blob)
    })
  }

  async function retryManualSlipWithEasySlip() {
    if (!manualRetryDialog || !selectedImport) return
    const bank = banks.find((item) => item.id === selectedImport.bank_setting_id)
    const imagesToCheck = manualRetryDialog.images.filter((item) => item.validationStatus !== 'passed')
    if (!bank || imagesToCheck.length === 0) return
    setManualRetryLoading(true)
    setManualRetryMessage('')
    let passed = 0
    let failed = 0
    let latestImages = [...manualRetryDialog.images]

    for (let index = 0; index < imagesToCheck.length; index += 1) {
      const image = imagesToCheck[index]
      setManualRetryProgress(`กำลังตรวจรูป ${index + 1}/${imagesToCheck.length}`)
      let apiResult: Record<string, unknown>
      try {
        if (image.storagePath) {
          apiResult = await verifySlipFromStorage(
            image.storagePath,
            undefined,
            bank.account_number,
            bank.bank_code,
          ) as Record<string, unknown>
        } else {
          const imageBase64 = await imageUrlToBase64(image.imageUrl)
          const { data, error: invokeError } = await supabase.functions.invoke('verify-slip', {
            body: { imageBase64 },
          })
          if (invokeError) throw invokeError
          apiResult = (data || {}) as Record<string, unknown>
        }
      } catch (caught) {
        apiResult = { success: false, error: readableError(caught) }
      }

      const nestedData = apiResult.data && typeof apiResult.data === 'object' ? apiResult.data : null
      const rawResponse = apiResult.easyslipResponse && typeof apiResult.easyslipResponse === 'object'
        ? apiResult.easyslipResponse
        : nestedData ? { status: 200, data: nestedData } : null
      const { data: saveResult, error: saveError } = await supabase.rpc('bank_manual_slip_retry_easyslip', {
        p_manual_slip_id: manualRetryDialog.payment.source_id,
        p_verified_slip_id: image.id,
        p_bank_setting_id: selectedImport.bank_setting_id,
        p_result: {
          success: apiResult.success === true,
          amount: apiResult.amount,
          message: apiResult.message,
          error: apiResult.error,
          easyslip_response: rawResponse,
        },
      })
      const result = saveResult as { success?: boolean; errors?: string[] } | null
      const success = !saveError && result?.success === true
      const retryMessage = saveError
        ? `บันทึกผลไม่สำเร็จ: ${readableError(saveError)}`
        : success ? 'ตรวจผ่าน EasySlip' : (result?.errors || []).join(' · ') || 'EasySlip ตรวจไม่ผ่าน'
      if (success) passed += 1
      else failed += 1
      latestImages = latestImages.map((item) => item.id === image.id ? {
        ...item,
        validationStatus: success ? 'passed' : 'failed',
        retryStatus: success ? 'passed' : 'failed',
        retryMessage,
      } : item)
      setManualRetryDialog((current) => current ? { ...current, images: latestImages } : current)
    }

    const { error: matchError } = await supabase.rpc('bank_statement_auto_match', { p_import_id: selectedImportId })
    if (matchError) setError(`ตรวจ EasySlip แล้ว แต่จับคู่ Statement ไม่สำเร็จ: ${readableError(matchError)}`)
    setManualRetryProgress('')
    setManualRetryMessage(`ตรวจครบแล้ว: ผ่าน ${passed} รูป${failed > 0 ? ` · ไม่ผ่าน ${failed} รูป` : ''}`)
    await loadDetail(selectedImportId)
    setManualRetryLoading(false)
  }

  function exportWorkbook() {
    if (!selectedImport) return
    const transactionRows = transactions.map((row) => {
      const matches = allocationByTransaction.get(row.id) || []
      return {
        'วันที่เวลา': dateTime(row.transaction_at),
        'รายการ': row.transaction_type,
        'เงินออก': Number(row.debit_amount),
        'เงินเข้า': Number(row.credit_amount),
        'ยอดคงเหลือ': row.balance == null ? '' : Number(row.balance),
        'ช่องทาง': row.channel || '',
        'รายละเอียด': row.description || '',
        'ผลกระทบยอด': statusLabel(row.reconciliation_status),
        'เลขบิล': matches.map((item) => item.or_orders?.bill_no || '').filter(Boolean).join(', '),
        'ยอดบิล': matches.reduce((sum, item) => sum + Number(item.or_orders?.total_amount || 0), 0),
      }
    })
    const missingRows = missingPayments.map((row) => ({
      'วันที่เวลา': dateTime(row.payment_at),
      'เลขบิล': row.bill_no,
      'ยอดสลิป': Number(row.paid_amount),
      'ยอดบิล': Number(row.bill_amount),
      'ส่วนต่าง': Number(row.difference),
      'แหล่งข้อมูล': row.source_type === 'manual_slip' ? 'สลิปมือ' : 'EasySlip',
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(transactionRows), 'Statement')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(missingRows), 'ไม่พบในบัญชี')
    XLSX.writeFile(wb, `กระทบยอด-${selectedImport.period_start}-${maskedAccount(selectedImport.account_number_snapshot)}.xlsx`)
  }

  function renderDiagnosticCandidate(candidate: MatchDiagnosticCandidate, transactionId: string, allowUse: boolean) {
    return <div key={`${candidate.source_type}-${candidate.source_id}`} className="rounded bg-white p-2 text-gray-700 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span><button type="button" onClick={() => void openOrderDetail(candidate.order_id)} disabled={!!detailOrderLoadingId} className="font-mono font-semibold text-blue-700 hover:underline disabled:cursor-wait disabled:opacity-50" title="ดูรายละเอียดบิล">{candidate.bill_no}</button> · ฿{money(candidate.paid_amount)}</span>
        {allowUse && <button
          type="button"
          onClick={() => setManualBillNos((current) => ({ ...current, [transactionId]: candidate.bill_no }))}
          className="font-medium text-blue-700 hover:underline"
        >ใช้เลขบิลนี้</button>}
      </div>
      <div className="mt-1 text-gray-500">
        {candidate.source_type === 'manual_slip' ? 'ตรวจสลิปมือ' : 'EasySlip'} · โอน {dateTime(candidate.payment_at)} · เวลาต่าง {durationLabel(candidate.time_diff_minutes)}
      </div>
      <div className="mt-1 text-gray-600">
        ผู้โอน: {candidate.source_type === 'verified_slip' ? accountDisplay(candidate.sender_name, candidate.sender_account) : 'สลิปมือต้องตรวจจากภาพ'}
      </div>
      <div className="mt-1 text-gray-600">
        ผู้รับ: {candidate.source_type === 'verified_slip' ? accountDisplay(candidate.receiver_name, candidate.receiver_account) : 'สลิปมือต้องตรวจจากภาพ'}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <span className={candidate.account_match ? 'text-emerald-700' : 'text-red-700'}>{candidate.account_match ? 'บัญชีรับตรง' : 'บัญชีรับไม่ตรง'}</span>
        {candidate.sender_match && <span className="text-emerald-700">ผู้โอนตรง</span>}
        {candidate.already_allocated && <span className="text-gray-500">ถูกจับคู่แล้ว</span>}
        {candidate.source_status !== 'approved' && <span className="text-red-700">สถานะ {candidate.source_status}</span>}
        {candidate.payment_before_bill_hours > 0 && <span className="text-blue-700">ลูกค้าโอนก่อนเปิดบิล {durationLabel(candidate.payment_before_bill_hours * 60)}</span>}
      </div>
    </div>
  }

  if (loading) return <div className="rounded-xl border bg-white p-10 text-center text-gray-500">กำลังโหลดข้อมูลกระทบยอด...</div>

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-blue-100 bg-white shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-blue-100 bg-gradient-to-r from-blue-50 to-cyan-50 px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900">กระทบยอดธนาคาร</h2>
            <p className="mt-1 text-sm text-gray-600">อัปโหลด Statement หลายบัญชี แล้วเทียบกับ EasySlip และรายการตรวจสลิปมือ</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              className="hidden"
              onChange={(event) => void handleFiles(event.target.files)}
            />
            <button
              type="button"
              disabled={uploading || banks.length === 0}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? 'กำลังนำเข้า...' : 'อัปโหลด Statement'}
            </button>
            <button
              type="button"
              disabled={!selectedImport || transactions.length === 0}
              onClick={exportWorkbook}
              className="rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              ดาวน์โหลด Excel
            </button>
          </div>
        </div>
        <div className="px-6 py-4 text-sm text-gray-600">
          รองรับ CSV Statement บัญชีออมทรัพย์กสิกรในขณะนี้ ระบบจะอ่านเลขบัญชีจากไฟล์และจับคู่กับบัญชีที่เปิดใช้งานในหน้าตั้งค่าโดยอัตโนมัติ
          {banks.length === 0 && <p className="mt-2 font-medium text-amber-700">ยังไม่มีบัญชีธนาคารที่เปิดใช้งาน กรุณาเพิ่มในหน้าตั้งค่าก่อนนำเข้า</p>}
        </div>
      </section>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {uploadResults.length > 0 && (
        <div className="space-y-2">
          {uploadResults.map((result) => (
            <div key={result.fileName} className={`rounded-lg border px-4 py-3 text-sm ${result.success ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
              <span className="font-semibold">{result.fileName}</span>: {result.message}
            </div>
          ))}
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <label className="flex min-w-0 flex-1 items-center gap-3 text-sm font-medium text-gray-700">
            <span className="whitespace-nowrap">รอบ Statement</span>
            <select
              value={selectedImportId}
              onChange={(event) => setSelectedImportId(event.target.value)}
              className="min-w-0 max-w-2xl flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2"
            >
              {imports.length === 0 && <option value="">ยังไม่มีข้อมูล</option>}
              {imports.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.period_start} ถึง {row.period_end} · {row.bank_settings?.bank_name || 'ธนาคาร'} {maskedAccount(row.account_number_snapshot)} · {row.file_name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!selectedImportId || actionId === 'auto'}
            onClick={() => void rerunAutoMatch()}
            className="rounded-lg border border-blue-200 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {actionId === 'auto' ? 'กำลังตรวจ...' : 'ตรวจจับคู่อีกครั้ง'}
          </button>
        </div>

        {!selectedImport ? (
          <div className="px-6 py-12 text-center text-gray-500">อัปโหลด Statement เพื่อเริ่มกระทบยอด</div>
        ) : (
          <div className="space-y-5 p-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <SummaryCard label="เงินเข้าตาม Statement" value={`฿${money(totals.credit)}`} tone="blue" />
              <SummaryCard label="จับคู่บิลแล้ว" value={`฿${money(totals.matched)}`} tone="green" />
              <SummaryCard label="เงินเข้าที่ยังจับคู่ไม่ได้" value={String(totals.unmatchedCount)} tone="red" onClick={() => unmatchedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
              <SummaryCard label="รายการรอตรวจ" value={String(totals.ambiguousCount)} tone="amber" />
              <SummaryCard label="สลิปไม่พบในบัญชี" value={String(missingPayments.length)} tone="violet" onClick={() => missingPaymentsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
            </div>

            <div className="grid gap-3 rounded-lg bg-gray-50 p-4 text-sm text-gray-700 md:grid-cols-4">
              <div><span className="text-gray-500">บัญชี:</span> {selectedImport.bank_settings?.bank_name || '–'} {maskedAccount(selectedImport.account_number_snapshot)}</div>
              <div><span className="text-gray-500">ยอดยกมา:</span> ฿{money(selectedImport.opening_balance)}</div>
              <div><span className="text-gray-500">ยอดปลายงวด:</span> ฿{money(selectedImport.closing_balance)}</div>
              <div><span className="text-gray-500">นำเข้า:</span> {selectedImport.imported_row_count}/{selectedImport.source_row_count} รายการ</div>
            </div>

            {Array.isArray(selectedImport.warnings) && selectedImport.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {selectedImport.warnings.map((warning) => <p key={warning}>{warning}</p>)}
              </div>
            )}

            <div>
              <h3 className="mb-2 font-semibold text-gray-900">สรุปยอดต่อบิล</h3>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-3 py-2 text-left">เลขบิล</th><th className="px-3 py-2 text-right">ยอดบิล</th>
                      <th className="px-3 py-2 text-right">เงินเข้า</th><th className="px-3 py-2 text-right">ส่วนต่าง</th><th className="px-3 py-2 text-center">ผลตรวจ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderSummaries.length === 0 ? <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">ยังไม่มีรายการที่จับคู่บิล</td></tr> : orderSummaries.map((row) => {
                      const difference = row.received - row.billAmount
                      const label = Math.abs(difference) <= 0.01 ? 'ยอดตรง' : difference > 0 ? 'โอนเกิน' : 'ยอดไม่ครบ'
                      const tone = Math.abs(difference) <= 0.01 ? 'text-emerald-700' : difference > 0 ? 'text-amber-700' : 'text-red-700'
                      return <tr key={row.orderId} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-mono"><button type="button" onClick={() => void openOrderDetail(row.orderId)} disabled={!!detailOrderLoadingId} className="font-semibold text-blue-700 hover:underline disabled:cursor-wait disabled:opacity-50" title="ดูรายละเอียดบิล">{row.billNo}</button></td><td className="px-3 py-2 text-right">฿{money(row.billAmount)}</td>
                        <td className="px-3 py-2 text-right">฿{money(row.received)}</td><td className={`px-3 py-2 text-right ${tone}`}>฿{money(difference)}</td>
                        <td className={`px-3 py-2 text-center font-medium ${tone}`}>{label}</td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div ref={unmatchedSectionRef} className="scroll-mt-24">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-gray-900">รายการเงินเข้าเพื่อจับคู่บิล</h3>
                </div>
                <label className="inline-flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={showDebitTransactions}
                    onChange={(event) => setShowDebitTransactions(event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                  />
                  แสดงรายการเงินออก
                </label>
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-[1050px] w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600"><tr>
                    <th className="px-3 py-2 text-left">วันเวลา</th><th className="px-3 py-2 text-left">รายละเอียด</th><th className="px-3 py-2 text-right">เงินเข้า</th>
                    <th className="px-3 py-2 text-right">เงินออก</th><th className="px-3 py-2 text-center">ผล</th><th className="px-3 py-2 text-left">บิล/การตรวจสอบ</th>
                  </tr></thead>
                  <tbody>
                    {detailLoading ? <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-500">กำลังตรวจสอบ...</td></tr> : displayedTransactions.length === 0 ? <tr><td colSpan={6} className="px-3 py-10 text-center text-gray-500">ไม่พบรายการเงินเข้า</td></tr> : displayedTransactions.map((row) => {
                      const matches = allocationByTransaction.get(row.id) || []
                      const diagnostic = diagnosticByTransaction.get(row.id)
                      const isDebit = Number(row.credit_amount) <= 0 && Number(row.debit_amount) > 0
                      return <tr key={row.id} className="border-t border-gray-100 align-top">
                        <td className="whitespace-nowrap px-3 py-3">{dateTime(row.transaction_at)}</td>
                        <td className="max-w-sm px-3 py-3"><div>{row.transaction_type}</div><div className="text-xs text-gray-500">{row.channel || '–'} · {row.description || '–'}</div></td>
                        <td className="px-3 py-3 text-right font-medium text-emerald-700">{row.credit_amount > 0 ? `฿${money(row.credit_amount)}` : '–'}</td>
                        <td className="px-3 py-3 text-right text-red-700">{row.debit_amount > 0 ? `฿${money(row.debit_amount)}` : '–'}</td>
                        <td className="px-3 py-3 text-center">
                          {isDebit
                            ? <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">เงินออก</span>
                            : <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusClass(row.reconciliation_status)}`}>{statusLabel(row.reconciliation_status)}</span>}
                        </td>
                        <td className="px-3 py-3">
                          {matches.length > 0 ? <div className="flex items-center gap-2">
                            <span className="flex flex-wrap gap-1">{matches.filter((item) => item.or_orders?.bill_no).map((item) => <button key={item.id} type="button" onClick={() => void openOrderDetail(item.order_id)} disabled={!!detailOrderLoadingId} className="font-mono font-semibold text-blue-700 hover:underline disabled:cursor-wait disabled:opacity-50" title="ดูรายละเอียดบิล">{item.or_orders?.bill_no}</button>)}</span>
                            <button disabled={actionId === row.id} onClick={() => void clearMatch(row.id)} className="text-xs text-red-600 hover:underline">ยกเลิกคู่</button>
                          </div> : row.credit_amount > 0 ? <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <input value={manualBillNos[row.id] || ''} onChange={(event) => setManualBillNos((current) => ({ ...current, [row.id]: event.target.value }))} placeholder="กรอกเลขบิล" className="w-40 rounded border border-gray-300 px-2 py-1.5 font-mono text-xs" />
                              <button disabled={actionId === row.id || !(manualBillNos[row.id] || '').trim()} onClick={() => void setManualMatch(row.id)} className="rounded bg-blue-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-50">จับคู่</button>
                            </div>
                            {diagnostic && <div className="max-w-xl rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span>{diagnosticLabel(diagnostic.reason_code)}</span>
                                {diagnostic.available_candidate_count > 0 && <button
                                  type="button"
                                  onClick={() => setExpandedDiagnostics((current) => ({ ...current, [row.id]: !current[row.id] }))}
                                  className="font-medium text-blue-700 hover:underline"
                                >
                                  {expandedDiagnostics[row.id] ? 'ซ่อนรายการที่ใช้ได้' : `ดูรายการใกล้เคียงที่ใช้ได้ (${diagnostic.available_candidate_count})`}
                                </button>}
                              </div>
                              {diagnostic.available_candidate_count === 0 && diagnostic.allocated_candidate_count > 0 && <p className="mt-1 text-gray-600">
                                พบยอดเดียวกัน {diagnostic.allocated_candidate_count} รายการ แต่ถูกจับคู่แล้วทั้งหมด
                              </p>}
                              {expandedDiagnostics[row.id] && diagnostic.candidates.length > 0 && <div className="mt-2 space-y-2 border-t border-amber-200 pt-2">
                                {diagnostic.candidates.map((candidate) => renderDiagnosticCandidate(candidate, row.id, true))}
                                {diagnostic.available_candidate_count > diagnostic.candidates.length && <p className="text-gray-500">
                                  แสดง {diagnostic.candidates.length} อันดับแรกจากทั้งหมด {diagnostic.available_candidate_count} รายการที่ยังใช้ได้
                                </p>}
                              </div>}
                              {diagnostic.allocated_candidate_count > 0 && <div className="mt-2 border-t border-amber-200 pt-2">
                                <button
                                  type="button"
                                  onClick={() => setExpandedAllocatedDiagnostics((current) => ({ ...current, [row.id]: !current[row.id] }))}
                                  className="font-medium text-gray-600 hover:underline"
                                >
                                  {expandedAllocatedDiagnostics[row.id] ? 'ซ่อนรายการที่ถูกใช้แล้ว' : `ดูรายการที่ถูกใช้แล้ว (${diagnostic.allocated_candidate_count})`}
                                </button>
                                {expandedAllocatedDiagnostics[row.id] && diagnostic.allocated_candidates.length > 0 && <div className="mt-2 space-y-2">
                                  {diagnostic.allocated_candidates.map((candidate) => renderDiagnosticCandidate(candidate, row.id, false))}
                                </div>}
                                {expandedAllocatedDiagnostics[row.id] && diagnostic.allocated_candidate_count > diagnostic.allocated_candidates.length && <p className="mt-2 text-gray-500">
                                  แสดง {diagnostic.allocated_candidates.length} อันดับแรกจากทั้งหมด {diagnostic.allocated_candidate_count} รายการ
                                </p>}
                              </div>}
                            </div>}
                          </div> : <span className="text-gray-400">ไม่นำเงินออกไปเทียบบิล</span>}
                        </td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div ref={missingPaymentsSectionRef} className="scroll-mt-24">
              <h3 className="mb-2 font-semibold text-gray-900">มีสลิปในระบบ แต่ไม่พบรายการเงินเข้าใน Statement</h3>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-red-50 text-red-700"><tr><th className="px-3 py-2 text-left">วันเวลา</th><th className="px-3 py-2 text-left">เลขบิล</th><th className="px-3 py-2 text-right">ยอดสลิป</th><th className="px-3 py-2 text-right">ยอดบิล</th><th className="px-3 py-2 text-left">แหล่งข้อมูล</th></tr></thead>
                  <tbody>
                    {missingPayments.length === 0 ? <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-500">ไม่พบรายการผิดปกติ</td></tr> : missingPayments.map((row) => <tr key={`${row.source_type}-${row.source_id}`} className="border-t border-gray-100">
                      <td className="whitespace-nowrap px-3 py-2">{dateTime(row.payment_at)}</td><td className="px-3 py-2 font-mono"><button type="button" onClick={() => void openOrderDetail(row.order_id)} disabled={!!detailOrderLoadingId} className="font-semibold text-blue-700 hover:underline disabled:cursor-wait disabled:opacity-50" title="ดูรายละเอียดบิล">{row.bill_no}</button></td>
                      <td className="px-3 py-2 text-right">฿{money(row.paid_amount)}</td><td className="px-3 py-2 text-right">฿{money(row.bill_amount)}</td>
                      <td className="px-3 py-2">
                        <div>{row.source_type === 'manual_slip' ? 'ตรวจสลิปมือ' : 'EasySlip'}</div>
                        {row.source_type === 'manual_slip' && <button
                          type="button"
                          disabled={manualRetryLoading}
                          onClick={() => void openManualEasySlipRetry(row)}
                          className="mt-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          ตรวจ EasySlip อีกครั้ง
                        </button>}
                      </td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </section>
      <Modal open={detailOrder != null} onClose={() => setDetailOrder(null)} contentClassName="max-w-[96vw] w-full">
        {detailOrder && <OrderDetailView order={detailOrder} onClose={() => setDetailOrder(null)} readOnly />}
      </Modal>
      <Modal open={manualMatchSourceDialog != null} onClose={() => !actionId && setManualMatchSourceDialog(null)} contentClassName="max-w-2xl w-full">
        {manualMatchSourceDialog && <div className="p-6">
          <h3 className="text-lg font-bold text-gray-900">เลือกสลิปที่ตรงกับรายการเงินเข้า</h3>
          <p className="mt-1 text-sm text-gray-600">
            บิล <span className="font-mono font-semibold text-blue-700">{manualMatchSourceDialog.billNo}</span> มีสลิปยอดเดียวกันหลายรายการ ระบบจึงไม่เลือกแทนโดยอัตโนมัติ
          </p>
          <div className="mt-4 space-y-2">
            {manualMatchSourceDialog.candidates.map((candidate, index) => <button
              key={`${candidate.source_type}-${candidate.source_id}`}
              type="button"
              disabled={!!actionId}
              onClick={() => void confirmManualMatchSource(candidate)}
              className="flex w-full items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-left hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
            >
              <div>
                <p className="font-semibold text-gray-900">สลิป {index + 1} · {candidate.source_type === 'manual_slip' ? 'ตรวจสลิปมือ' : 'EasySlip'}</p>
                <p className="mt-1 text-sm text-gray-600">โอน {dateTime(candidate.payment_at)} · เวลาต่าง {durationLabel(candidate.time_diff_minutes)}</p>
              </div>
              <span className="whitespace-nowrap font-bold text-emerald-700">฿{money(candidate.paid_amount)}</span>
            </button>)}
          </div>
          <div className="mt-5 flex justify-end">
            <button type="button" disabled={!!actionId} onClick={() => setManualMatchSourceDialog(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">ยกเลิก</button>
          </div>
        </div>}
      </Modal>
      <Modal open={manualRetryDialog != null} onClose={() => !manualRetryLoading && setManualRetryDialog(null)} contentClassName="max-w-3xl w-full">
        {manualRetryDialog && <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900">ตรวจ EasySlip อีกครั้ง</h3>
              <p className="mt-1 text-sm text-gray-600">บิล <span className="font-mono font-semibold text-blue-700">{manualRetryDialog.payment.bill_no}</span> · ยอดตรวจมือ ฿{money(manualRetryDialog.payment.paid_amount)}</p>
            </div>
            <button type="button" disabled={manualRetryLoading} onClick={() => setManualRetryDialog(null)} className="text-2xl leading-none text-gray-400 hover:text-gray-700 disabled:opacity-50" aria-label="ปิด">×</button>
          </div>
          <div className="mt-5">
            <p className="mb-2 text-sm font-semibold text-gray-700">ระบบจะตรวจทุกรูปที่ยังไม่เคยผ่าน EasySlip</p>
            {manualRetryDialog.images.length === 0 ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">ไม่พบรูปสลิปที่สามารถตรวจซ้ำได้</div> : <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              {manualRetryDialog.images.map((image, index) => <div
                key={image.id}
                className={`rounded-lg border-2 p-2 ${image.validationStatus === 'passed' ? 'border-emerald-300 bg-emerald-50' : image.retryStatus === 'failed' ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}
              >
                <img src={image.imageUrl} alt={`สลิป ${index + 1}`} className="h-40 w-full rounded object-contain bg-gray-50" />
                <p className="mt-2 text-center text-sm font-semibold">สลิป {index + 1} · {image.validationStatus === 'passed' ? 'ผ่านแล้ว' : image.retryStatus === 'failed' ? 'ไม่ผ่าน' : 'รอตรวจ'}</p>
                {image.retryMessage && <p className={`mt-1 text-center text-xs ${image.retryStatus === 'passed' ? 'text-emerald-700' : 'text-red-700'}`}>{image.retryMessage}</p>}
              </div>)}
            </div>}
          </div>
          {manualRetryProgress && <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">{manualRetryProgress}</div>}
          {manualRetryMessage && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{manualRetryMessage}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={manualRetryLoading} onClick={() => setManualRetryDialog(null)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50">ยกเลิก</button>
            <button type="button" disabled={manualRetryLoading || manualRetryDialog.images.every((image) => image.validationStatus === 'passed')} onClick={() => void retryManualSlipWithEasySlip()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              {manualRetryLoading ? manualRetryProgress || 'กำลังตรวจ EasySlip...' : `ตรวจทุกรูปที่ยังไม่ผ่าน (${manualRetryDialog.images.filter((image) => image.validationStatus !== 'passed').length})`}
            </button>
          </div>
        </div>}
      </Modal>
    </div>
  )
}

function SummaryCard({ label, value, tone, onClick }: { label: string; value: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'violet'; onClick?: () => void }) {
  const styles = {
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    red: 'border-red-200 bg-red-50 text-red-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
  }
  const content = <><p className="text-xs font-medium opacity-80">{label}</p><p className="mt-1 text-xl font-bold tabular-nums">{value}</p></>
  if (onClick) return <button type="button" onClick={onClick} className={`rounded-lg border p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 ${styles[tone]}`} title={`ไปยัง ${label}`}>{content}</button>
  return <div className={`rounded-lg border p-4 ${styles[tone]}`}>{content}</div>
}
