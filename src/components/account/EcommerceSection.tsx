import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { FiSettings, FiUpload } from 'react-icons/fi'
import { supabase } from '../../lib/supabase'
import { useAuthContext } from '../../contexts/AuthContext'
import {
  buildColIndexByField,
  ECOMMERCE_FIELD_LABELS,
  ECOMMERCE_FIELD_ORDER,
  parseWorksheetRows,
  type ChannelMapRow,
  type EcommerceFieldKey,
} from '../../lib/ecommerceImport'

const MAX_FILE_ROWS = 25_000
/** แถวต่อคำขอ — ลดจำนวนรอบ HTTP / pool เมื่อไฟล์ใหญ่ */
const INSERT_CHUNK = 1500
const PAGE_SIZE = 50

type Channel = {
  id: string
  code: string
  display_name: string
  is_active: boolean
  default_sheet_name: string | null
  header_rows_to_skip: number
}

type EnrichedLine = {
  id: string
  batch_id: string
  row_index: number
  order_no: string | null
  payment_at: string | null
  sku_ref: string | null
  price_orig: number | null
  price_sell: number | null
  qty: number | null
  line_total: number | null
  commission: number | null
  transaction_fee: number | null
  platform_fees_plus1: number | null
  buyer_note: string | null
  province: string | null
  district: string | null
  postal_code: string | null
  channel_id: string
  channel_code: string
  channel_name: string
  file_name: string
  uploaded_at: string
  product_name_from_sku: string | null
  erp_order_id: string | null
  erp_bill_no: string | null
  erp_order_status: string | null
  erp_order_total: number | null
  erp_line_amount_for_sku: number | null
  erp_order_found: boolean
  erp_sku_line_found: boolean
  erp_amount_matches_line: boolean | null
}

const SELECT_ENRICHED =
  'id, batch_id, row_index, order_no, payment_at, sku_ref, price_orig, price_sell, qty, line_total, commission, transaction_fee, platform_fees_plus1, buyer_note, province, district, postal_code, channel_id, channel_code, channel_name, file_name, uploaded_at, product_name_from_sku, erp_order_id, erp_bill_no, erp_order_status, erp_order_total, erp_line_amount_for_sku, erp_order_found, erp_sku_line_found, erp_amount_matches_line'

type ReconcileFilter = 'all' | 'no_bill' | 'no_sku_line' | 'amount_wrong' | 'any_issue'

type MapDraftRow = ChannelMapRow & { clientKey: string }

const SOURCE_TYPE_OPTIONS: { value: ChannelMapRow['source_type']; label: string; hint: string }[] = [
  { value: 'excel_column_letter', label: 'ตัวอักษรคอลัมน์ Excel', hint: 'เช่น A, H, AM' },
  { value: 'header_exact', label: 'หัวคอลัมน์ตรงทั้งข้อความ', hint: 'เทียบแถวหัวแรก (ไม่สนตัวพิมพ์)' },
  { value: 'header_contains', label: 'หัวคอลัมน์มีข้อความนี้', hint: 'เหมาะกับหัวยาว/ไม่คงที่' },
]

function newMapDraftRow(partial?: Partial<ChannelMapRow>): MapDraftRow {
  return {
    field_key: partial?.field_key ?? 'order_no',
    source_type: partial?.source_type ?? 'excel_column_letter',
    source_value: partial?.source_value ?? '',
    priority: partial?.priority ?? 0,
    clientKey: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}-${Math.random()}`,
  }
}

const EXPORT_MAX_ROWS = 50_000
const EXPORT_PAGE = 1000
const ORDER_NO_RPC_CHUNK = 2000
/** ใช้กับ .in() บน view — ลดความยาว URL เมื่อเลขคำสั่งซื้อยาว/จำนวนมาก */
const ORDER_NO_FALLBACK_IN_CHUNK = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** PostgREST / Postgres errors are plain objects — String(err) becomes "[object Object]" */
function formatSupabaseError(err: unknown): string {
  if (err == null) return 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    const code = typeof o.code === 'string' ? o.code : ''
    const msg = typeof o.message === 'string' ? o.message : ''
    const details = typeof o.details === 'string' ? o.details : ''
    const hint = typeof o.hint === 'string' ? o.hint : ''
    const combined = `${msg} ${details}`.toLowerCase()
    if (
      code === '53300' ||
      combined.includes('53300') ||
      combined.includes('connection slots') ||
      combined.includes('too many clients')
    ) {
      return 'ฐานข้อมูลรับการเชื่อมต่อเต็มชั่วคราว — รอ 1–2 นาทีแล้วลองใหม่ ลดแท็บที่เปิด Supabase Dashboard / แอปพร้อมกัน หรือตรวจสอบ max_connections ที่โฮสต์'
    }
    if (
      msg.includes('ac_ecommerce_existing_order_nos') &&
      (msg.includes('Could not find the function') || msg.includes('schema cache'))
    ) {
      return `${msg} — แก้ถาวร: deploy migration ไฟล์ supabase/migrations/246_ac_ecommerce_dup_check.sql (เช่น supabase db push) แล้วรอ PostgREST โหลด schema ใหม่`
    }
    const parts = [msg, details, hint].filter(Boolean)
    if (parts.length) return parts.join(' — ')
    try {
      return JSON.stringify(err)
    } catch {
      return 'เกิดข้อผิดพลาด (ไม่สามารถแสดงรายละเอียด)'
    }
  }
  return String(err)
}

function isTransientConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const o = err as Record<string, unknown>
  const code = typeof o.code === 'string' ? o.code : ''
  const msg = (typeof o.message === 'string' ? o.message : '').toLowerCase()
  if (code === '53300' || code === '57P01' || code === '57P02' || code === '57P03') return true
  if (
    msg.includes('connection') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('socket') ||
    msg.includes('fetch failed')
  ) {
    return true
  }
  return false
}

function isMissingDupCheckRpcError(err: unknown): boolean {
  const msg = formatSupabaseError(err).toLowerCase()
  return (
    msg.includes('ac_ecommerce_existing_order_nos') &&
    (msg.includes('could not find') || msg.includes('schema cache') || msg.includes('does not exist'))
  )
}

function reconcileRowBg(r: EnrichedLine): string {
  if (!r.erp_order_found) return 'bg-red-50'
  if (!r.erp_sku_line_found) return 'bg-amber-50'
  if (r.erp_amount_matches_line === false) return 'bg-yellow-50'
  return ''
}

/** ตรวจเลขคำสั่งซื้อที่มีในช่องทางแล้ว — RPC (migration 246) ถ้าไม่มีฟังก์ชันบน DB ใช้ view สำรอง */
async function fetchExistingOrderNoConflicts(channelId: string, orderNos: string[]): Promise<string[]> {
  if (orderNos.length === 0) return []
  const found = new Set<string>()
  let useViewFallback = false

  for (let i = 0; i < orderNos.length; i += ORDER_NO_RPC_CHUNK) {
    const chunk = orderNos.slice(i, i + ORDER_NO_RPC_CHUNK)
    const { data, error } = await supabase.rpc('ac_ecommerce_existing_order_nos', {
      p_channel_id: channelId,
      p_order_nos: chunk,
    })
    if (error) {
      if (isMissingDupCheckRpcError(error)) {
        useViewFallback = true
        break
      }
      throw error
    }
    const rows = data as { order_no: string }[] | string[] | null
    if (!rows) continue
    if (typeof rows[0] === 'string') {
      for (const s of rows as string[]) if (s) found.add(String(s).trim())
    } else {
      for (const r of rows as { order_no: string }[]) {
        if (r?.order_no) found.add(String(r.order_no).trim())
      }
    }
  }

  if (!useViewFallback) return [...found]

  found.clear()
  const wanted = new Set(orderNos)
  for (let i = 0; i < orderNos.length; i += ORDER_NO_FALLBACK_IN_CHUNK) {
    const chunk = orderNos.slice(i, i + ORDER_NO_FALLBACK_IN_CHUNK)
    const { data, error } = await supabase
      .from('ac_v_ecommerce_sale_lines_enriched')
      .select('order_no')
      .eq('channel_id', channelId)
      .in('order_no', chunk)
    if (error) throw error
    for (const row of data ?? []) {
      const o = row?.order_no != null ? String(row.order_no).trim() : ''
      if (o && wanted.has(o)) found.add(o)
    }
  }
  return [...found]
}

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '–'
  return Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDt(s: string | null | undefined): string {
  if (!s) return '–'
  try {
    return new Date(s).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return s
  }
}

export default function EcommerceSection() {
  const { user } = useAuthContext()
  const canManageChannels = user?.role === 'superadmin' || user?.role === 'admin' || user?.role === 'account'

  const [channels, setChannels] = useState<Channel[]>([])
  const [mapsByChannel, setMapsByChannel] = useState<Record<string, ChannelMapRow[]>>({})
  /** กรองตาราง/สรุป — ว่าง = ทุกช่องทาง */
  const [filterChannelId, setFilterChannelId] = useState<string>('')
  /** อัปโหลดต้องระบุช่องทางเสมอ (ไม่มี "ทั้งหมด") */
  const [uploadChannelId, setUploadChannelId] = useState<string>('')
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [reconcileFilter, setReconcileFilter] = useState<ReconcileFilter>('all')
  const [summary, setSummary] = useState<{ noBill: number; noSku: number; amountWrong: number } | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [lastChosenFileName, setLastChosenFileName] = useState<string | null>(null)

  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [rows, setRows] = useState<EnrichedLine[]>([])
  const [loading, setLoading] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')

  const [mapOpen, setMapOpen] = useState(false)
  const [mapEditChannelId, setMapEditChannelId] = useState('')
  const [mapDraft, setMapDraft] = useState<MapDraftRow[]>([])
  const [channelMetaDraft, setChannelMetaDraft] = useState({ header_rows_to_skip: 1, default_sheet_name: '' })
  const [mapSaveBusy, setMapSaveBusy] = useState(false)
  const [textPreview, setTextPreview] = useState<{ title: string; body: string } | null>(null)

  const selectedUploadChannel = useMemo(
    () => channels.find((c) => c.id === uploadChannelId),
    [channels, uploadChannelId],
  )

  useEffect(() => {
    if (channels.length === 0) return
    setUploadChannelId((prev) => (prev && channels.some((c) => c.id === prev) ? prev : channels[0].id))
  }, [channels])

  const loadChannelsAndMaps = useCallback(async () => {
    const { data: ch, error: e1 } = await supabase
      .from('ac_ecommerce_channels')
      .select('id, code, display_name, is_active, default_sheet_name, header_rows_to_skip')
      .eq('is_active', true)
      .order('display_name')
    if (e1) {
      setError(formatSupabaseError(e1))
      return
    }
    const list = (ch ?? []) as Channel[]
    setChannels(list)
    const mapEntries: Record<string, ChannelMapRow[]> = {}
    for (const c of list) mapEntries[c.id] = []
    if (list.length > 0) {
      const ids = list.map((c) => c.id)
      const { data: mapsRows, error: e2 } = await supabase
        .from('ac_ecommerce_channel_maps')
        .select('channel_id, field_key, source_type, source_value, priority')
        .in('channel_id', ids)
        .order('priority', { ascending: false })
      if (e2) {
        setError(formatSupabaseError(e2))
        return
      }
      for (const row of mapsRows ?? []) {
        const cid = row.channel_id as string
        if (!mapEntries[cid]) mapEntries[cid] = []
        mapEntries[cid].push({
          field_key: row.field_key as EcommerceFieldKey,
          source_type: row.source_type as ChannelMapRow['source_type'],
          source_value: String(row.source_value),
          priority: Number(row.priority) || 0,
        })
      }
    }
    setMapsByChannel(mapEntries)
  }, [])

  useEffect(() => {
    void loadChannelsAndMaps()
  }, [loadChannelsAndMaps])

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true)
    const fromIso = `${dateFrom}T00:00:00.000+07:00`
    const toIso = `${dateTo}T23:59:59.999+07:00`

    const makeBase = () => {
      let q = supabase
        .from('ac_v_ecommerce_sale_lines_enriched')
        .select('id', { count: 'exact', head: true })
        .gte('uploaded_at', fromIso)
        .lte('uploaded_at', toIso)
      if (filterChannelId) q = q.eq('channel_id', filterChannelId)
      return q
    }

    try {
      const a = await makeBase().eq('erp_order_found', false)
      if (a.error) throw a.error
      const b = await makeBase().eq('erp_order_found', true).eq('erp_sku_line_found', false)
      if (b.error) throw b.error
      const c = await makeBase().eq('erp_amount_matches_line', false)
      if (c.error) throw c.error
      setSummary({
        noBill: a.count ?? 0,
        noSku: b.count ?? 0,
        amountWrong: c.count ?? 0,
      })
    } catch {
      setSummary(null)
    } finally {
      setSummaryLoading(false)
    }
  }, [filterChannelId, dateFrom, dateTo])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  const loadLines = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fromIso = `${dateFrom}T00:00:00.000+07:00`
      const toIso = `${dateTo}T23:59:59.999+07:00`

      let q = supabase
        .from('ac_v_ecommerce_sale_lines_enriched')
        .select(SELECT_ENRICHED, { count: 'exact' })
        .gte('uploaded_at', fromIso)
        .lte('uploaded_at', toIso)

      if (filterChannelId) q = q.eq('channel_id', filterChannelId)

      switch (reconcileFilter) {
        case 'no_bill':
          q = q.eq('erp_order_found', false)
          break
        case 'no_sku_line':
          q = q.eq('erp_order_found', true).eq('erp_sku_line_found', false)
          break
        case 'amount_wrong':
          q = q.eq('erp_amount_matches_line', false)
          break
        case 'any_issue':
          q = q.or(
            'erp_order_found.eq.false,and(erp_order_found.eq.true,erp_sku_line_found.eq.false),erp_amount_matches_line.eq.false',
          )
          break
        default:
          break
      }

      q = q.order('uploaded_at', { ascending: false }).range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

      const { data, error: e, count } = await q
      if (e) throw e
      setRows((data ?? []) as EnrichedLine[])
      setTotalCount(count ?? 0)
    } catch (err: unknown) {
      setError(formatSupabaseError(err))
      setRows([])
      setTotalCount(0)
    } finally {
      setLoading(false)
    }
  }, [filterChannelId, dateFrom, dateTo, page, reconcileFilter])

  useEffect(() => {
    void loadLines()
  }, [loadLines])

  async function exportMismatchCsv() {
    setExportBusy(true)
    setError(null)
    try {
      const fromIso = `${dateFrom}T00:00:00.000+07:00`
      const toIso = `${dateTo}T23:59:59.999+07:00`
      const headerCols = [
        'channel_name',
        'file_name',
        'order_no',
        'payment_at',
        'sku_ref',
        'line_total',
        'erp_bill_no',
        'erp_order_found',
        'erp_sku_line_found',
        'erp_amount_matches_line',
        'erp_line_amount_for_sku',
      ] as const
      const lines: string[] = [headerCols.join(',')]
      let offset = 0
      let total = 0
      while (offset < EXPORT_MAX_ROWS) {
        let q = supabase
          .from('ac_v_ecommerce_sale_lines_enriched')
          .select(SELECT_ENRICHED)
          .gte('uploaded_at', fromIso)
          .lte('uploaded_at', toIso)
          .or('erp_order_found.eq.false,erp_amount_matches_line.eq.false')
          .order('uploaded_at', { ascending: false })
          .range(offset, offset + EXPORT_PAGE - 1)
        if (filterChannelId) q = q.eq('channel_id', filterChannelId)
        const { data, error: e } = await q
        if (e) throw e
        const batch = (data ?? []) as EnrichedLine[]
        if (batch.length === 0) break
        for (const r of batch) {
          const row = [
            csvEscape(r.channel_name),
            csvEscape(r.file_name),
            csvEscape(r.order_no),
            csvEscape(r.payment_at),
            csvEscape(r.sku_ref),
            csvEscape(r.line_total),
            csvEscape(r.erp_bill_no),
            csvEscape(r.erp_order_found),
            csvEscape(r.erp_sku_line_found),
            csvEscape(r.erp_amount_matches_line),
            csvEscape(r.erp_line_amount_for_sku),
          ]
          lines.push(row.join(','))
        }
        total += batch.length
        offset += EXPORT_PAGE
        if (batch.length < EXPORT_PAGE) break
      }
      const csv = `\uFEFF${lines.join('\r\n')}`
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ch = filterChannelId ? channels.find((c) => c.id === filterChannelId)?.code ?? 'all' : 'all'
      a.download = `ecommerce_mismatch_${ch}_${dateFrom}_${dateTo}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setInfo(total > 0 ? `ส่งออก CSV แล้ว ${total.toLocaleString()} แถว` : 'ไม่มีแถวที่ตรงเงื่อนไขส่งออก')
    } catch (err: unknown) {
      setError(formatSupabaseError(err))
    } finally {
      setExportBusy(false)
    }
  }

  async function handleUpload(file: File) {
    if (!uploadChannelId || !selectedUploadChannel) {
      setError('เลือกช่องทางสำหรับอัปโหลด')
      return
    }
    const maps = mapsByChannel[uploadChannelId] ?? []
    if (maps.length === 0) {
      setError('ยังไม่มีการ map คอลัมน์สำหรับช่องทางนี้')
      return
    }

    setLastChosenFileName(file.name)
    setUploadBusy(true)
    setError(null)
    setInfo(null)

    let batchId: string | null = null
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true })
      let sheetName = wb.SheetNames[0]
      if (selectedUploadChannel.default_sheet_name && wb.SheetNames.includes(selectedUploadChannel.default_sheet_name)) {
        sheetName = selectedUploadChannel.default_sheet_name
      }
      const ws = wb.Sheets[sheetName]
      if (!ws) throw new Error('ไม่พบชีตในไฟล์')

      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][]
      if (rows.length < 2) throw new Error('ไฟล์ไม่มีข้อมูล')

      const headerRow = rows[0] as unknown[]
      const needsHeaderRow = maps.some((m) => m.source_type === 'header_exact' || m.source_type === 'header_contains')
      const colMap = buildColIndexByField(maps, needsHeaderRow ? headerRow : null)

      const missing: EcommerceFieldKey[] = []
      const keys: EcommerceFieldKey[] = [
        'order_no',
        'payment_at',
        'sku_ref',
        'price_orig',
        'price_sell',
        'qty',
        'line_total',
        'commission',
        'transaction_fee',
        'platform_fees_plus1',
        'buyer_note',
        'province',
        'district',
        'postal_code',
      ]
      for (const k of keys) {
        if (colMap[k] === undefined) missing.push(k)
      }
      if (missing.length) {
        throw new Error(`ยัง map ไม่ครบ: ${missing.join(', ')}`)
      }

      const parsed = parseWorksheetRows(rows, colMap, selectedUploadChannel.header_rows_to_skip, MAX_FILE_ROWS)
      if (parsed.length === 0) throw new Error('ไม่มีแถวข้อมูลหลัง parse')

      const uniqueOrderNos = [
        ...new Set(parsed.map((r) => (r.order_no ?? '').trim()).filter((s) => s.length > 0)),
      ]
      if (uniqueOrderNos.length > 0) {
        const conflicts = await fetchExistingOrderNoConflicts(uploadChannelId, uniqueOrderNos)
        if (conflicts.length > 0) {
          const preview = conflicts.slice(0, 12).join(', ')
          throw new Error(
            `ไม่สามารถอัปโหลดซ้ำ: พบเลขคำสั่งซื้อที่มีในช่องทางนี้แล้ว ${conflicts.length} เลข เช่น ${preview}${conflicts.length > 12 ? ' …' : ''}`,
          )
        }
      }

      const { data: batch, error: be } = await supabase
        .from('ac_ecommerce_import_batches')
        .insert({
          channel_id: uploadChannelId,
          file_name: file.name,
          row_count: 0,
          uploaded_by: user?.id ?? null,
        })
        .select('id')
        .single()
      if (be || !batch) throw be ?? new Error('สร้าง batch ไม่สำเร็จ')
      batchId = batch.id

      const INSERT_MAX_ATTEMPTS = 4
      for (let i = 0; i < parsed.length; i += INSERT_CHUNK) {
        const slice = parsed.slice(i, i + INSERT_CHUNK)
        const payload = slice.map((r) => ({
          batch_id: batchId,
          row_index: r.row_index,
          order_no: r.order_no,
          payment_at: r.payment_at,
          sku_ref: r.sku_ref,
          price_orig: r.price_orig,
          price_sell: r.price_sell,
          qty: r.qty,
          line_total: r.line_total,
          commission: r.commission,
          transaction_fee: r.transaction_fee,
          platform_fees_plus1: r.platform_fees_plus1,
          buyer_note: r.buyer_note,
          province: r.province,
          district: r.district,
          postal_code: r.postal_code,
          raw_snapshot: r.raw_snapshot,
        }))
        for (let attempt = 0; attempt < INSERT_MAX_ATTEMPTS; attempt++) {
          const { error: ie } = await supabase.from('ac_ecommerce_sale_lines').insert(payload)
          if (!ie) break
          if (attempt < INSERT_MAX_ATTEMPTS - 1 && isTransientConnectionError(ie)) {
            await sleep(700 * (attempt + 1))
            continue
          }
          throw ie
        }
      }

      const { error: ue } = await supabase.from('ac_ecommerce_import_batches').update({ row_count: parsed.length }).eq('id', batchId)
      if (ue) throw ue

      setError(null)
      setInfo(`อัปโหลดสำเร็จ ${parsed.length.toLocaleString()} แถว`)
      setPage(0)
      await loadLines()
      await loadSummary()
      await loadChannelsAndMaps()
    } catch (err: unknown) {
      setError(formatSupabaseError(err))
      setLastChosenFileName(null)
      if (batchId) {
        await supabase.from('ac_ecommerce_import_batches').delete().eq('id', batchId)
      }
    } finally {
      setUploadBusy(false)
    }
  }

  async function createChannelFromTemplate() {
    const code = newCode.trim().toLowerCase().replace(/\s+/g, '_')
    const name = newName.trim()
    if (!code || !name) {
      setError('กรอกรหัสและชื่อช่องทาง')
      return
    }
    const template = channels.find((c) => c.code === 'shopee')
    if (!template) {
      setError('ไม่พบแม่แบบ Shopee ในระบบ')
      return
    }
    const { data: created, error: ce } = await supabase
      .from('ac_ecommerce_channels')
      .insert({
        code,
        display_name: name,
        is_active: true,
        default_sheet_name: null,
        header_rows_to_skip: 1,
      })
      .select('id')
      .single()
    if (ce || !created) {
      setError(ce?.message ?? 'สร้างช่องทางไม่สำเร็จ')
      return
    }
    const { data: tplMaps, error: me } = await supabase
      .from('ac_ecommerce_channel_maps')
      .select('field_key, source_type, source_value, priority')
      .eq('channel_id', template.id)
    if (me || !tplMaps?.length) {
      setError(me?.message ?? 'ไม่มีแผนที่คอลัมน์แม่แบบ')
      await supabase.from('ac_ecommerce_channels').delete().eq('id', created.id)
      return
    }
    const ins = tplMaps.map((m) => ({
      channel_id: created.id,
      field_key: m.field_key,
      source_type: m.source_type,
      source_value: m.source_value,
      priority: m.priority,
    }))
    const { error: ie } = await supabase.from('ac_ecommerce_channel_maps').insert(ins)
    if (ie) {
      setError(ie.message)
      await supabase.from('ac_ecommerce_channels').delete().eq('id', created.id)
      return
    }
    setNewOpen(false)
    setNewCode('')
    setNewName('')
    setUploadChannelId(created.id)
    setFilterChannelId(created.id)
    await loadChannelsAndMaps()
    setInfo('สร้างช่องทางแล้ว (คัดลอก map จาก Shopee) — เปิด "ตั้งค่า map คอลัมน์" เพื่อปรับให้ตรงไฟล์')
  }

  const openColumnMap = useCallback(() => {
    const id = uploadChannelId || channels[0]?.id || ''
    if (!id) {
      setError('ยังไม่มีช่องทาง')
      return
    }
    setMapEditChannelId(id)
    const ch = channels.find((c) => c.id === id)
    setChannelMetaDraft({
      header_rows_to_skip: Math.min(10, Math.max(0, ch?.header_rows_to_skip ?? 1)),
      default_sheet_name: ch?.default_sheet_name ?? '',
    })
    setMapDraft(
      (mapsByChannel[id] ?? []).map((m) => ({
        ...m,
        clientKey: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}-${Math.random()}`,
      })),
    )
    setMapOpen(true)
    setError(null)
  }, [uploadChannelId, channels, mapsByChannel])

  const syncMapModalToChannel = useCallback(
    (channelId: string) => {
      setMapEditChannelId(channelId)
      const ch = channels.find((c) => c.id === channelId)
      setChannelMetaDraft({
        header_rows_to_skip: Math.min(10, Math.max(0, ch?.header_rows_to_skip ?? 1)),
        default_sheet_name: ch?.default_sheet_name ?? '',
      })
      setMapDraft(
        (mapsByChannel[channelId] ?? []).map((m) => ({
          ...m,
          clientKey: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}-${Math.random()}`,
        })),
      )
    },
    [channels, mapsByChannel],
  )

  async function saveColumnMaps() {
    if (!mapEditChannelId) return
    setMapSaveBusy(true)
    setError(null)
    try {
      const rows = mapDraft
        .map((r) => ({
          field_key: r.field_key,
          source_type: r.source_type,
          source_value: r.source_value.trim(),
          priority: Number(r.priority) || 0,
        }))
        .filter((r) => r.source_value.length > 0)

      const { error: delErr } = await supabase.from('ac_ecommerce_channel_maps').delete().eq('channel_id', mapEditChannelId)
      if (delErr) throw delErr

      if (rows.length > 0) {
        const { error: insErr } = await supabase.from('ac_ecommerce_channel_maps').insert(
          rows.map((r) => ({
            channel_id: mapEditChannelId,
            field_key: r.field_key,
            source_type: r.source_type,
            source_value: r.source_value,
            priority: r.priority,
          })),
        )
        if (insErr) throw insErr
      }

      const skip = Math.min(10, Math.max(0, Math.floor(channelMetaDraft.header_rows_to_skip)))
      const sheet = channelMetaDraft.default_sheet_name.trim()
      const { error: chErr } = await supabase
        .from('ac_ecommerce_channels')
        .update({
          header_rows_to_skip: skip,
          default_sheet_name: sheet.length > 0 ? sheet : null,
        })
        .eq('id', mapEditChannelId)
      if (chErr) throw chErr

      await loadChannelsAndMaps()
      setMapOpen(false)
      setInfo('บันทึกการ map คอลัมน์และตั้งค่าช่องทางแล้ว')
    } catch (err: unknown) {
      setError(formatSupabaseError(err))
    } finally {
      setMapSaveBusy(false)
    }
  }

  const totalPages = totalCount != null ? Math.max(1, Math.ceil(totalCount / PAGE_SIZE)) : 1

  const openTextPreview = (title: string, body: string | null | undefined) => {
    const t = body == null ? '' : String(body).trim()
    if (!t) return
    setTextPreview({ title, body: String(body ?? '') })
  }

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Ecommerce</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            อัปโหลดไฟล์ยอดขายตามช่องทาง · กรองตารางตาม<strong>วันที่อัปโหลด</strong>ในระบบ (คอลัมน์ &quot;ชำระเงิน&quot; จากไฟล์ยังแสดงในตารางสำหรับกระทบยอด)
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">ช่องทาง (กรองตาราง)</span>
            <select
              value={filterChannelId}
              onChange={(e) => {
                setFilterChannelId(e.target.value)
                setPage(0)
              }}
              className="border rounded-lg px-3 py-2 min-w-[180px]"
            >
              <option value="">ทั้งหมด</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">อัปโหลดเข้า</span>
            <select
              value={uploadChannelId}
              onChange={(e) => setUploadChannelId(e.target.value)}
              disabled={channels.length === 0}
              className="border rounded-lg px-3 py-2 min-w-[160px]"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">จากวันที่</span>
            <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0) }} className="border rounded-lg px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">ถึงวันที่</span>
            <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0) }} className="border rounded-lg px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 mb-1">กระทบยอด</span>
            <select
              value={reconcileFilter}
              onChange={(e) => {
                setReconcileFilter(e.target.value as ReconcileFilter)
                setPage(0)
              }}
              className="border rounded-lg px-3 py-2 min-w-[220px]"
            >
              <option value="all">ทั้งหมด</option>
              <option value="any_issue">เฉพาะที่มีปัญหา (รวม)</option>
              <option value="no_bill">ไม่พบบิล ERP</option>
              <option value="no_sku_line">พบบิลแต่ไม่พบบรรทัด SKU</option>
              <option value="amount_wrong">ยอดไม่ตรง</option>
            </select>
          </label>
          <div className="text-sm flex flex-col gap-1.5">
            <span className="block text-gray-600">อัปโหลด (.xlsx)</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="sr-only"
                disabled={uploadBusy || !uploadChannelId || channels.length === 0}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void handleUpload(f)
                }}
              />
              <button
                type="button"
                disabled={uploadBusy || !uploadChannelId || channels.length === 0}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-emerald-500 hover:to-teal-500 disabled:cursor-not-allowed disabled:opacity-45 disabled:from-gray-400 disabled:to-gray-400"
              >
                <FiUpload className="h-4 w-4 shrink-0" aria-hidden />
                {uploadBusy ? 'กำลังอัปโหลด…' : 'เลือกไฟล์ Excel'}
              </button>
              <span className="text-xs text-gray-500 max-w-[220px] truncate" title={lastChosenFileName ?? undefined}>
                {lastChosenFileName ?? 'ยังไม่ได้เลือกไฟล์'}
              </span>
            </div>
          </div>
          {canManageChannels && (
            <>
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                className="px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
              >
                + ช่องทางใหม่
              </button>
              <button
                type="button"
                onClick={openColumnMap}
                disabled={channels.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100 disabled:opacity-45"
              >
                <FiSettings className="h-4 w-4 shrink-0" aria-hidden />
                ตั้งค่า map คอลัมน์
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              void loadLines()
              void loadSummary()
            }}
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            โหลดใหม่
          </button>
          <button
            type="button"
            onClick={() => void exportMismatchCsv()}
            disabled={exportBusy || loading}
            className="px-4 py-2 text-sm rounded-lg border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            title="ส่งออกแถวที่ไม่พบบิล หรือยอดไม่ตรง (ตามช่วงวันที่และช่องทาง)"
          >
            {exportBusy ? 'กำลังส่งออก…' : 'Export CSV ไม่ตรง'}
          </button>
        </div>
      </div>

      {selectedUploadChannel && (
        <div className="px-6 py-2 text-xs text-gray-500 border-b border-gray-50">
          ช่องที่อัปโหลด: <strong>{selectedUploadChannel.display_name}</strong> — ชีตเริ่มต้น:{' '}
          {selectedUploadChannel.default_sheet_name ?? '(ชีตแรก)'} · ข้ามหัวตาราง {selectedUploadChannel.header_rows_to_skip} แถว · สูงสุด{' '}
          {MAX_FILE_ROWS.toLocaleString()} แถวต่อไฟล์ · บันทึกทีละ {INSERT_CHUNK} แถวต่อคำขอ
        </div>
      )}

      {(error || info) && (
        <div className={`px-6 py-2 text-sm ${error ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}>
          {error ?? info}
        </div>
      )}

      <div className="px-6 py-3 border-b border-amber-100 bg-amber-50/90 text-sm text-amber-950">
        <span className="font-semibold">สรุปกระทบยอด</span>
        <span className="text-amber-800/90"> (ช่วงวันที่ = วันที่อัปโหลดในระบบ · ช่องทาง = ตัวกรองตารางด้านบน)</span>
        {summaryLoading ? (
          <span className="ml-2 text-amber-800">กำลังนับ…</span>
        ) : summary ? (
          <span className="ml-2 block sm:inline sm:ml-2 mt-1 sm:mt-0">
            ไม่พบบิล <strong className="tabular-nums text-red-700">{summary.noBill.toLocaleString()}</strong> แถว · พบบิลแต่ไม่พบบรรทัด SKU{' '}
            <strong className="tabular-nums text-amber-900">{summary.noSku.toLocaleString()}</strong> แถว · ยอดไม่ตรง{' '}
            <strong className="tabular-nums text-yellow-800">{summary.amountWrong.toLocaleString()}</strong> แถว
          </span>
        ) : (
          <span className="ml-2 text-amber-800">ไม่สามารถโหลดสรุปได้</span>
        )}
      </div>

      <div className="px-6 py-2 text-xs text-gray-500 border-b border-gray-50">
        ไฮไลต์: <span className="inline-block w-3 h-3 rounded-sm bg-red-50 border border-red-200 align-middle mr-1" /> ไม่พบบิล ·{' '}
        <span className="inline-block w-3 h-3 rounded-sm bg-amber-50 border border-amber-200 align-middle mx-1" /> พบบิลแต่ไม่พบ SKU ·{' '}
        <span className="inline-block w-3 h-3 rounded-sm bg-yellow-50 border border-yellow-200 align-middle mx-1" /> ยอดไม่ตรง
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1400px] w-full text-sm">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th className="text-left px-3 py-2 whitespace-nowrap">ช่องทาง</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">ไฟล์</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">เลขคำสั่งซื้อ</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">เลขบิล ERP</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">ชำระเงิน</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">รหัส SKU</th>
              <th className="text-left px-3 py-2 whitespace-nowrap">ชื่อสินค้า</th>
              <th className="text-right px-3 py-2">ราคาตั้ง</th>
              <th className="text-right px-3 py-2">ราคาขาย</th>
              <th className="text-right px-3 py-2">จำนวน</th>
              <th className="text-right px-3 py-2">ยอดชำระ</th>
              <th className="text-right px-3 py-2">คอม</th>
              <th className="text-right px-3 py-2">Txn fee</th>
              <th className="text-right px-3 py-2">ค่า+1</th>
              <th className="text-left px-3 py-2">หมายเหตุผู้ซื้อ</th>
              <th className="text-left px-3 py-2">จังหวัด</th>
              <th className="text-left px-3 py-2">อำเภอ</th>
              <th className="text-left px-3 py-2">ไปรษณีย์</th>
              <th className="text-center px-3 py-2">พบบิล</th>
              <th className="text-center px-3 py-2" title="พบบรรทัด SKU ใน ERP">
                SKU
              </th>
              <th className="text-right px-3 py-2">ยอด ERP</th>
              <th className="text-center px-3 py-2">ยอดตรง</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={22} className="px-6 py-12 text-center text-gray-500">
                  กำลังโหลด...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={22} className="px-6 py-12 text-center text-gray-500">
                  ไม่มีข้อมูลในช่วงวันที่อัปโหลด / เงื่อนไขที่เลือก
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={`border-t border-gray-100 ${reconcileRowBg(r)}`}>
                  <td
                    className="px-3 py-2 whitespace-nowrap max-w-[140px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('ช่องทาง', r.channel_name)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.channel_name}
                  </td>
                  <td
                    className="px-3 py-2 max-w-[120px] truncate cursor-pointer hover:bg-black/[0.03] font-mono text-xs"
                    onClick={() => openTextPreview('ไฟล์', r.file_name)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.file_name}
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs max-w-[120px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('เลขคำสั่งซื้อ', r.order_no)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.order_no ?? '–'}
                  </td>
                  <td
                    className="px-3 py-2 font-mono text-xs max-w-[100px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('เลขบิล ERP', r.erp_bill_no)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.erp_bill_no ?? '–'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDt(r.payment_at)}</td>
                  <td
                    className="px-3 py-2 font-mono text-xs max-w-[100px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('รหัส SKU', r.sku_ref)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.sku_ref ?? '–'}
                  </td>
                  <td
                    className="px-3 py-2 max-w-[160px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('ชื่อสินค้า', r.product_name_from_sku)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.product_name_from_sku ?? '–'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.price_orig)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.price_sell)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty != null ? String(r.qty) : '–'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.line_total)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.commission)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.transaction_fee)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.platform_fees_plus1)}</td>
                  <td
                    className="px-3 py-2 max-w-[120px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('หมายเหตุผู้ซื้อ', r.buyer_note)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.buyer_note ?? '–'}
                  </td>
                  <td
                    className="px-3 py-2 max-w-[100px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('จังหวัด', r.province)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.province ?? '–'}
                  </td>
                  <td
                    className="px-3 py-2 max-w-[120px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('อำเภอ', r.district)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.district ?? '–'}
                  </td>
                  <td
                    className="px-3 py-2 font-mono max-w-[90px] truncate cursor-pointer hover:bg-black/[0.03]"
                    onClick={() => openTextPreview('ไปรษณีย์', r.postal_code)}
                    title="คลิกดูข้อความเต็ม"
                  >
                    {r.postal_code ?? '–'}
                  </td>
                  <td className="px-3 py-2 text-center">{r.erp_order_found ? '✓' : '–'}</td>
                  <td className="px-3 py-2 text-center">{r.erp_sku_line_found ? '✓' : '–'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.erp_line_amount_for_sku)}</td>
                  <td className="px-3 py-2 text-center">
                    {r.erp_amount_matches_line === true ? '✓' : r.erp_amount_matches_line === false ? '✗' : '–'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="px-6 py-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 text-sm text-gray-600">
        <span>
          {totalCount != null ? `ทั้งหมด ${totalCount.toLocaleString()} แถว` : '–'} · หน้า {page + 1} / {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="px-3 py-1 rounded border border-gray-200 disabled:opacity-40"
          >
            ก่อนหน้า
          </button>
          <button
            type="button"
            disabled={loading || (totalCount != null && (page + 1) * PAGE_SIZE >= totalCount)}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 rounded border border-gray-200 disabled:opacity-40"
          >
            ถัดไป
          </button>
        </div>
      </div>

      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">สร้างช่องทางใหม่</h3>
            <p className="text-sm text-gray-500">
              คัดลอกการ map จาก Shopee เป็นจุดเริ่มต้น — จากนั้นใช้ปุ่ม &quot;ตั้งค่า map คอลัมน์&quot; ปรับให้ตรงไฟล์ของช่องทางนั้น
            </p>
            <label className="block text-sm">
              <span className="text-gray-600">รหัส (ภาษาอังกฤษ เช่น lazada)</span>
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-gray-600">ชื่อแสดง</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setNewOpen(false)} className="px-4 py-2 rounded-lg border border-gray-200">
                ยกเลิก
              </button>
              <button type="button" onClick={() => void createChannelFromTemplate()} className="px-4 py-2 rounded-lg bg-blue-600 text-white">
                สร้าง
              </button>
            </div>
          </div>
        </div>
      )}

      {mapOpen && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/45 p-3 sm:p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ecom-map-title"
          onClick={() => !mapSaveBusy && setMapOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-4xl my-4 sm:my-8 border border-gray-100 flex flex-col max-h-[min(92vh,calc(100vh-2rem))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-gray-100 shrink-0">
              <h3 id="ecom-map-title" className="text-lg font-semibold text-gray-900">
                ตั้งค่า map คอลัมน์
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                ระบุว่าแต่ละฟิลด์ในระบบอ่านจากคอลัมน์ใด — ตัวอักษร Excel (A, H…) หรือจับจากหัวแถวแรกของชีต
              </p>
            </div>
            <div className="px-4 sm:px-5 py-3 overflow-y-auto flex-1 min-h-0 space-y-4">
              <label className="block text-sm max-w-md">
                <span className="text-gray-600 font-medium">ช่องทาง</span>
                <select
                  value={mapEditChannelId}
                  onChange={(e) => syncMapModalToChannel(e.target.value)}
                  className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 bg-white"
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block text-sm">
                  <span className="text-gray-600">ข้ามแถวหัวก่อนข้อมูล (0–10)</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={channelMetaDraft.header_rows_to_skip}
                    onChange={(e) =>
                      setChannelMetaDraft((d) => ({
                        ...d,
                        header_rows_to_skip: Math.min(10, Math.max(0, Number(e.target.value) || 0)),
                      }))
                    }
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-gray-600">ชื่อชีตเริ่มต้น (ว่าง = ชีตแรก)</span>
                  <input
                    value={channelMetaDraft.default_sheet_name}
                    onChange={(e) => setChannelMetaDraft((d) => ({ ...d, default_sheet_name: e.target.value }))}
                    placeholder="เช่น orders"
                    className="mt-1 w-full border border-gray-200 rounded-lg px-3 py-2 font-mono text-sm"
                  />
                </label>
              </div>
              <p className="text-xs text-amber-900/90 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                ถ้ามีแถวใดใช้วิธี &quot;หัวคอลัมน์…&quot; ระบบจะใช้<strong>แถวแรกของชีต</strong>เป็นหัวตาราง (หลังข้ามตามจำนวนด้านบน) แล้วจับคู่ชื่อคอลัมน์ — ลำดับความสำคัญมากกว่าจะถูกใช้ก่อนเมื่อมีหลายแถวต่อฟิลด์เดียวกัน
              </p>
              <div className="border border-gray-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="text-left px-2 sm:px-3 py-2 whitespace-nowrap">ฟิลด์</th>
                      <th className="text-left px-2 sm:px-3 py-2 whitespace-nowrap min-w-[11rem]">วิธีอ่าน</th>
                      <th className="text-left px-2 sm:px-3 py-2">ค่า (ตัวอักษร / ข้อความหัวคอลัมน์)</th>
                      <th className="text-right px-2 py-2 w-16">ลำดับ</th>
                      <th className="w-12 px-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {mapDraft.map((row) => {
                      const stHint = SOURCE_TYPE_OPTIONS.find((o) => o.value === row.source_type)?.hint ?? ''
                      return (
                        <tr key={row.clientKey} className="border-t border-gray-100 align-top">
                          <td className="px-2 py-1.5">
                            <select
                              value={row.field_key}
                              onChange={(e) =>
                                setMapDraft((d) =>
                                  d.map((x) =>
                                    x.clientKey === row.clientKey
                                      ? { ...x, field_key: e.target.value as EcommerceFieldKey }
                                      : x,
                                  ),
                                )
                              }
                              className="w-full max-w-[11rem] sm:max-w-none border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                            >
                              {ECOMMERCE_FIELD_ORDER.map((fk) => (
                                <option key={fk} value={fk}>
                                  {ECOMMERCE_FIELD_LABELS[fk]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-1.5">
                            <select
                              value={row.source_type}
                              onChange={(e) =>
                                setMapDraft((d) =>
                                  d.map((x) =>
                                    x.clientKey === row.clientKey
                                      ? { ...x, source_type: e.target.value as ChannelMapRow['source_type'] }
                                      : x,
                                  ),
                                )
                              }
                              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                            >
                              {SOURCE_TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                            <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{stHint}</p>
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              value={row.source_value}
                              onChange={(e) =>
                                setMapDraft((d) =>
                                  d.map((x) =>
                                    x.clientKey === row.clientKey ? { ...x, source_value: e.target.value } : x,
                                  ),
                                )
                              }
                              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 font-mono text-xs"
                              placeholder={row.source_type === 'excel_column_letter' ? 'เช่น A' : 'ข้อความในหัวคอลัมน์'}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              value={row.priority}
                              onChange={(e) =>
                                setMapDraft((d) =>
                                  d.map((x) =>
                                    x.clientKey === row.clientKey
                                      ? { ...x, priority: Number(e.target.value) || 0 }
                                      : x,
                                  ),
                                )
                              }
                              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-right"
                            />
                          </td>
                          <td className="px-1 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => setMapDraft((d) => d.filter((x) => x.clientKey !== row.clientKey))}
                              className="text-xs text-red-600 hover:underline px-1"
                            >
                              ลบ
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                onClick={() => setMapDraft((d) => [...d, newMapDraftRow()])}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
              >
                + เพิ่มแถว map
              </button>
            </div>
            <div className="px-4 sm:px-5 py-3 border-t border-gray-100 flex flex-wrap justify-end gap-2 bg-gray-50/70 shrink-0">
              <button
                type="button"
                onClick={() => setMapOpen(false)}
                className="px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-sm"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={mapSaveBusy}
                onClick={() => void saveColumnMaps()}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {mapSaveBusy ? 'กำลังบันทึก…' : 'บันทึก'}
              </button>
            </div>
          </div>
        </div>
      )}

      {textPreview && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ecom-text-preview-title"
          onClick={() => setTextPreview(null)}
          onKeyDown={(e) => e.key === 'Escape' && setTextPreview(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[min(85vh,32rem)] flex flex-col overflow-hidden border border-gray-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center gap-2 shrink-0">
              <h4 id="ecom-text-preview-title" className="font-semibold text-gray-900 truncate pr-2 text-sm sm:text-base">
                {textPreview.title}
              </h4>
              <button
                type="button"
                className="shrink-0 px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-gray-50"
                onClick={() => setTextPreview(null)}
              >
                ปิด
              </button>
            </div>
            <div className="px-4 py-3 overflow-y-auto text-sm text-gray-800 whitespace-pre-wrap break-words">
              {textPreview.body}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
