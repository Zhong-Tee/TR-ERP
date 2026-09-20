import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import {
  deliveryFileHash,
  normalizeDeliveryKey,
  parseDeliveryFile,
  type ParsedDeliveryFile,
} from '../../lib/deliveryCheck'
import Modal from '../ui/Modal'

type DeliveryImport = {
  id: string
  carrier: string
  file_name: string
  pickup_date_from: string
  pickup_date_to: string
  source_row_count: number
  matched_count: number
  issue_count: number
  consignment_count: number
  system_only_count: number
  warnings: string[] | null
  uploaded_at: string
}

type LinkedOrder = {
  bill_no: string
  tracking_number: string | null
  customer_name: string
  recipient_name: string | null
  channel_code: string
  shipped_time: string | null
  status: string
}

type DeliveryRow = {
  id: string
  source_kind: 'carrier' | 'system'
  source_row_number: number | null
  pickup_at: string | null
  order_no: string | null
  tracking_no: string | null
  sender: string | null
  consignee: string | null
  consignee_phone: string | null
  consignee_address: string | null
  is_consignment: boolean
  note: string | null
  order_id: string | null
  match_status: 'matched' | 'tracking_only' | 'order_only' | 'ambiguous' | 'unmatched' | 'consignment' | 'system_only' | 'invalid' | 'manual_match'
  match_method: string | null
  match_detail: string | null
  has_duplicate: boolean
  has_previous_import: boolean
  previous_import_id: string | null
  previous_file_name: string | null
  previous_carrier: string | null
  previous_imported_at: string | null
  previous_pickup_at: string | null
  review_status: 'open' | 'resolved'
  reviewed_at: string | null
  raw_data: Record<string, unknown> | null
  or_orders: LinkedOrder | LinkedOrder[] | null
}

type RowFilter = 'all' | 'matched' | 'issues' | 'consignment'

type CarrierOption = { code: string; name: string }

type PreviousDuplicate = {
  tracking_no_normalized: string
  tracking_no: string | null
  previous_import_id: string
  previous_file_name: string
  previous_carrier: string
  previous_imported_at: string
  previous_pickup_at: string | null
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; details?: unknown; hint?: unknown }
    return [value.message, value.details, value.hint]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .join(' / ') || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'
  }
  return String(error)
}

function linkedOrder(row: DeliveryRow): LinkedOrder | null {
  if (Array.isArray(row.or_orders)) return row.or_orders[0] || null
  return row.or_orders || null
}

function statusLabel(row: DeliveryRow): string {
  if (row.has_duplicate) return 'Tracking ซ้ำในไฟล์'
  if (row.has_previous_import) return 'เคยนำเข้าแล้ว'
  if (row.match_status === 'matched') return 'ตรงสมบูรณ์'
  if (row.match_status === 'manual_match') return 'จับคู่ด้วยตนเอง'
  if (row.match_status === 'tracking_only') return 'ตรงด้วย Tracking'
  if (row.match_status === 'order_only') return 'ตรงด้วย Order No.'
  if (row.match_status === 'ambiguous') return 'พบมากกว่า 1 บิล'
  if (row.match_status === 'consignment') return 'ฝากส่ง'
  if (row.match_status === 'system_only') return 'ไม่มีในไฟล์ขนส่ง'
  if (row.match_status === 'invalid') return 'ข้อมูลไม่ครบ'
  return 'ไม่พบในระบบ'
}

function statusClass(row: DeliveryRow): string {
  if (row.review_status === 'resolved') return 'bg-slate-100 text-slate-600 border-slate-200'
  if (row.has_duplicate || row.match_status === 'invalid' || row.match_status === 'system_only') return 'bg-red-50 text-red-700 border-red-200'
  if (row.has_previous_import) return 'bg-orange-50 text-orange-700 border-orange-200'
  if (row.match_status === 'matched' || row.match_status === 'manual_match') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (row.match_status === 'consignment') return 'bg-violet-50 text-violet-700 border-violet-200'
  return 'bg-amber-50 text-amber-700 border-amber-200'
}

function isOpenIssue(row: DeliveryRow): boolean {
  if (row.source_kind !== 'carrier' || row.review_status === 'resolved') return false
  const isMatched = row.match_status === 'matched' || row.match_status === 'manual_match'
  return (!isMatched && row.match_status !== 'consignment') || row.has_duplicate || row.has_previous_import
}

function pickupStatus(row: DeliveryRow): string {
  const value = row.raw_data?.['สถานะงานรับ']
  return typeof value === 'string' && value.trim() ? value.trim() : '-'
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export default function DeliveryCheckPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [carriers, setCarriers] = useState<CarrierOption[]>([])
  const [carrier, setCarrier] = useState('')
  const [imports, setImports] = useState<DeliveryImport[]>([])
  const [selectedImportId, setSelectedImportId] = useState('')
  const [rows, setRows] = useState<DeliveryRow[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<ParsedDeliveryFile | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [fileHash, setFileHash] = useState('')
  const [filter, setFilter] = useState<RowFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [savingRowId, setSavingRowId] = useState<string | null>(null)
  const [duplicateWarning, setDuplicateWarning] = useState<PreviousDuplicate[]>([])
  const [deleteImportOpen, setDeleteImportOpen] = useState(false)
  const [deletingImport, setDeletingImport] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null)

  const loadImports = useCallback(async (preferredId?: string) => {
    const { data, error } = await supabase
      .from('tr_delivery_check_imports')
      .select('id,carrier,file_name,pickup_date_from,pickup_date_to,source_row_count,matched_count,issue_count,consignment_count,system_only_count,warnings,uploaded_at')
      .order('uploaded_at', { ascending: false })
      .limit(60)
    if (error) throw error
    const next = (data || []) as DeliveryImport[]
    setImports(next)
    setSelectedImportId((current) => {
      if (preferredId && next.some((item) => item.id === preferredId)) return preferredId
      if (current && next.some((item) => item.id === current)) return current
      return next[0]?.id || ''
    })
  }, [])

  const loadRows = useCallback(async (importId: string) => {
    if (!importId) {
      setRows([])
      return
    }
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('tr_delivery_check_rows')
        .select('id,source_kind,source_row_number,pickup_at,order_no,tracking_no,sender,consignee,consignee_phone,consignee_address,is_consignment,note,order_id,match_status,match_method,match_detail,has_duplicate,has_previous_import,previous_import_id,previous_file_name,previous_carrier,previous_imported_at,previous_pickup_at,review_status,reviewed_at,raw_data,or_orders(bill_no,tracking_number,customer_name,recipient_name,channel_code,shipped_time,status)')
        .eq('import_id', importId)
        .order('source_kind', { ascending: true })
        .order('source_row_number', { ascending: true, nullsFirst: false })
      if (error) throw error
      const next = (data || []) as unknown as DeliveryRow[]
      setRows(next)
      setNotes(Object.fromEntries(next.map((row) => [row.id, row.note || ''])))
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) })
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    Promise.all([
      supabase.from('tr_shipping_carriers').select('code,name').eq('is_active', true).order('sort_order').order('code'),
      loadImports(),
    ]).then(([carrierResult]) => {
      if (carrierResult.error) throw carrierResult.error
      const values = (carrierResult.data || []) as CarrierOption[]
      setCarriers(values)
      if (values.length === 1) setCarrier(values[0].code)
    }).catch((error) => setMessage({ tone: 'error', text: errorMessage(error) }))
  }, [loadImports])

  useEffect(() => {
    loadRows(selectedImportId).catch(() => null)
  }, [selectedImportId, loadRows])

  async function handleFile(file: File | null) {
    if (!file) return
    setMessage(null)
    setSelectedFile(file)
    try {
      const [parsed, hash] = await Promise.all([parseDeliveryFile(file), deliveryFileHash(file)])
      setPreview(parsed)
      setFileHash(hash)
    } catch (error) {
      setPreview(null)
      setFileHash('')
      setMessage({ tone: 'error', text: errorMessage(error) })
    }
  }

  async function findPreviousDuplicates(): Promise<PreviousDuplicate[]> {
    if (!preview) return []
    const trackingKeys = [...new Set(preview.rows
      .map((row) => normalizeDeliveryKey(row.tracking_no))
      .filter(Boolean))]
    if (trackingKeys.length === 0) return []
    const { data, error } = await supabase.rpc('tr_delivery_check_find_previous_duplicates', {
      p_tracking_keys: trackingKeys,
    })
    if (error) throw error
    return (data || []) as PreviousDuplicate[]
  }

  async function importFile(confirmedDuplicates = false) {
    if (!selectedFile || !preview || !fileHash) return
    if (!carrier) {
      setMessage({ tone: 'error', text: 'กรุณาเลือกบริษัทขนส่งก่อนนำเข้า' })
      return
    }
    setImporting(true)
    setMessage(null)
    try {
      if (!confirmedDuplicates) {
        const duplicates = await findPreviousDuplicates()
        if (duplicates.length > 0) {
          setDuplicateWarning(duplicates)
          return
        }
      }
      const { data, error } = await supabase.rpc('tr_delivery_check_import', {
        p_carrier: carrier,
        p_file_name: selectedFile.name,
        p_file_hash: fileHash,
        p_sheet_name: preview.sheetName,
        p_pickup_date_from: preview.pickupDateFrom,
        p_pickup_date_to: preview.pickupDateTo,
        p_warnings: preview.warnings,
        p_rows: preview.rows,
      })
      if (error) throw error
      const result = data as { import_id?: string; matched_count?: number; issue_count?: number; consignment_count?: number }
      if (!result?.import_id) throw new Error('ระบบไม่คืนเลขอ้างอิงการนำเข้า')
      const rebuildResult = await supabase.rpc('tr_delivery_check_rebuild_system_only', {
        p_import_id: result.import_id,
      })
      if (rebuildResult.error) throw rebuildResult.error
      const finalCounts = rebuildResult.data as { issue_count?: number } | null
      await loadImports(result.import_id)
      setPreview(null)
      setSelectedFile(null)
      setFileHash('')
      setDuplicateWarning([])
      if (fileInputRef.current) fileInputRef.current.value = ''
      setMessage({
        tone: 'success',
        text: `นำเข้าสำเร็จ: ตรง ${result.matched_count || 0} รายการ, ฝากส่ง ${result.consignment_count || 0} รายการ, ต้องตรวจ ${finalCounts?.issue_count ?? result.issue_count ?? 0} รายการ`,
      })
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) })
    } finally {
      setImporting(false)
    }
  }

  async function saveReview(row: DeliveryRow, resolved: boolean) {
    setSavingRowId(row.id)
    try {
      const { error } = await supabase.rpc('tr_delivery_check_review_row', {
        p_row_id: row.id,
        p_note: notes[row.id] || '',
        p_resolved: resolved,
      })
      if (error) throw error
      await loadRows(selectedImportId)
      setMessage({ tone: 'success', text: resolved ? 'บันทึกและปิดรายการแล้ว' : 'บันทึกหมายเหตุแล้ว' })
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) })
    } finally {
      setSavingRowId(null)
    }
  }

  async function deleteSelectedImport() {
    if (!selectedImport) return
    setDeletingImport(true)
    try {
      const deletedName = selectedImport.file_name
      const { error } = await supabase.rpc('tr_delivery_check_delete_import', {
        p_import_id: selectedImport.id,
      })
      if (error) throw error
      setDeleteImportOpen(false)
      setSelectedImportId('')
      await loadImports()
      setMessage({ tone: 'success', text: `ลบประวัติ ${deletedName} และผลตรวจของรอบนั้นแล้ว` })
    } catch (error) {
      setMessage({ tone: 'error', text: errorMessage(error) })
    } finally {
      setDeletingImport(false)
    }
  }

  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (row.source_kind !== 'carrier') return false
      const isMatched = row.match_status === 'matched' || row.match_status === 'manual_match'
      if (filter === 'matched' && !isMatched) return false
      if (filter === 'issues' && !isOpenIssue(row)) return false
      if (filter === 'consignment' && row.match_status !== 'consignment') return false
      if (!search) return true
      const order = linkedOrder(row)
      return [row.order_no, row.tracking_no, row.sender, row.consignee, row.consignee_phone, row.note, order?.bill_no]
        .some((value) => String(value || '').toLowerCase().includes(search))
    })
  }, [rows, filter, query])

  const summary = useMemo(() => ({
    total: rows.filter((row) => row.source_kind === 'carrier').length,
    matched: rows.filter((row) => row.source_kind === 'carrier' && (row.match_status === 'matched' || row.match_status === 'manual_match')).length,
    consignment: rows.filter((row) => row.source_kind === 'carrier' && row.match_status === 'consignment').length,
    issues: rows.filter(isOpenIssue).length,
  }), [rows])

  function exportResult() {
    const selected = imports.find((item) => item.id === selectedImportId)
    if (!selected || rows.length === 0) return
    const output = rows.filter((row) => row.source_kind === 'carrier').map((row) => {
      const order = linkedOrder(row)
      return {
        สถานะ: statusLabel(row),
        ตรวจแล้ว: row.review_status === 'resolved' ? 'ใช่' : 'ไม่',
        สถานะงานรับ: pickupStatus(row),
        'Order No. จากไฟล์': row.order_no || '',
        'เลขบิลในระบบ': order?.bill_no || '',
        'Tracking จากไฟล์': row.tracking_no || '',
        'Tracking ในระบบ': order?.tracking_number || '',
        ผู้ส่ง: row.sender || '',
        ผู้รับ: row.consignee || order?.recipient_name || order?.customer_name || '',
        เบอร์โทร: row.consignee_phone || '',
        หมายเหตุ: notes[row.id] ?? row.note ?? '',
        รายละเอียด: row.match_detail || '',
        'เคยนำเข้าแล้ว': row.has_previous_import ? 'ใช่' : 'ไม่',
        'ไฟล์ที่เคยนำเข้า': row.previous_file_name || '',
        'ขนส่งครั้งก่อน': row.previous_carrier || '',
        'นำเข้าครั้งก่อนเมื่อ': row.previous_imported_at ? formatDateTime(row.previous_imported_at) : '',
      }
    })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(output), 'ผลตรวจสอบการส่ง')
    XLSX.writeFile(workbook, `ตรวจสอบการส่ง_${selected.carrier}_${selected.pickup_date_from}.xlsx`)
  }

  const selectedImport = imports.find((item) => item.id === selectedImportId)

  return (
    <div className="space-y-4">
      {message && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${
          message.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700'
            : message.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-blue-200 bg-blue-50 text-blue-700'
        }`}>
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.8fr)]">
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-gray-900">นำเข้าไฟล์รับพัสดุจากขนส่ง</h2>
            <p className="mt-1 text-sm text-gray-500">ระบบจะเทียบ Tracking และ Order No. กับบิลที่ส่งแล้ว พร้อมแยกรายการฝากส่ง</p>
          </div>
          <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-gray-700">บริษัทขนส่ง</span>
              <select value={carrier} onChange={(event) => setCarrier(event.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-3 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100">
                <option value="">เลือกขนส่ง</option>
                {carriers.map((item) => <option key={item.code} value={item.code}>{item.code} — {item.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-semibold text-gray-700">ไฟล์ขนส่ง (.xlsx / .xls)</span>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="flex w-full items-center justify-between rounded-xl border border-dashed border-blue-300 bg-blue-50 px-4 py-3 text-left hover:bg-blue-100">
                <span className="truncate text-sm font-semibold text-blue-700">{selectedFile?.name || 'คลิกเพื่อเลือกไฟล์ขนส่งประจำวัน'}</span>
                <span className="ml-3 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">เลือกไฟล์</span>
              </button>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(event) => void handleFile(event.target.files?.[0] || null)} />
            </label>
          </div>

          {preview && (
            <div className="mt-4 rounded-xl border border-gray-200">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-3">
                <div className="text-sm text-gray-700">
                  พบ <strong>{preview.rows.length}</strong> รายการ · วันที่ {preview.pickupDateFrom}{preview.pickupDateTo !== preview.pickupDateFrom ? ` ถึง ${preview.pickupDateTo}` : ''} · ฝากส่ง <strong>{preview.rows.filter((row) => row.is_consignment).length}</strong>
                </div>
                <button type="button" onClick={() => void importFile()} disabled={importing || !carrier} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {importing ? 'กำลังนำเข้า...' : 'ยืนยันนำเข้าและตรวจสอบ'}
                </button>
              </div>
              {preview.warnings.length > 0 && (
                <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">{preview.warnings.join(' · ')}</div>
              )}
              <div className="max-h-56 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-white text-gray-500"><tr><th className="px-3 py-2 text-left">แถว</th><th className="px-3 py-2 text-left">Order No.</th><th className="px-3 py-2 text-left">Tracking</th><th className="px-3 py-2 text-left">สถานะงานรับ</th><th className="px-3 py-2 text-left">ผู้ส่ง</th><th className="px-3 py-2 text-left">ประเภท</th><th className="px-3 py-2 text-left">หมายเหตุ</th></tr></thead>
                  <tbody>{preview.rows.slice(0, 12).map((row) => <tr key={row.source_row_number} className="border-t border-gray-100"><td className="px-3 py-2">{row.source_row_number}</td><td className="px-3 py-2">{row.order_no || '-'}</td><td className="px-3 py-2 font-mono">{row.tracking_no || '-'}</td><td className="px-3 py-2">{row.pickup_status || '-'}</td><td className="px-3 py-2">{row.sender}</td><td className="px-3 py-2">{row.is_consignment ? <span className="font-bold text-violet-700">ฝากส่ง</span> : 'บิลในระบบ'}</td><td className="px-3 py-2">{row.is_consignment ? (row.note || <span className="text-amber-600">รอกรอก</span>) : '-'}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-gray-700">ประวัติการนำเข้า</span>
            <select value={selectedImportId} onChange={(event) => setSelectedImportId(event.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-3 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100">
              <option value="">ยังไม่มีประวัติ</option>
              {imports.map((item) => <option key={item.id} value={item.id}>{item.pickup_date_from} · {item.carrier} · {item.file_name}</option>)}
            </select>
          </label>
          {selectedImport && (
            <div className="mt-4 space-y-2 text-sm text-gray-600">
              <div className="flex justify-between"><span>ไฟล์</span><strong className="max-w-[190px] truncate text-gray-800" title={selectedImport.file_name}>{selectedImport.file_name}</strong></div>
              <div className="flex justify-between"><span>วันที่เข้ารับ</span><strong className="text-gray-800">{selectedImport.pickup_date_from}</strong></div>
              <div className="flex justify-between"><span>นำเข้าเมื่อ</span><strong className="text-gray-800">{formatDateTime(selectedImport.uploaded_at)}</strong></div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <button type="button" onClick={exportResult} disabled={rows.length === 0} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">ส่งออกผลตรวจสอบ</button>
                <button type="button" onClick={() => setDeleteImportOpen(true)} className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-bold text-red-700 hover:bg-red-100">ลบประวัติรอบนี้</button>
              </div>
            </div>
          )}
        </section>
      </div>

      {selectedImportId && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['รายการในไฟล์', summary.total, 'text-gray-900'],
              ['ตรงสมบูรณ์', summary.matched, 'text-emerald-600'],
              ['ฝากส่ง', summary.consignment, 'text-violet-600'],
              ['ต้องตรวจ', summary.issues, 'text-amber-600'],
            ].map(([label, value, tone]) => <div key={String(label)} className="rounded-xl border border-gray-200 bg-white p-4"><div className="text-xs font-semibold text-gray-500">{label}</div><div className={`mt-1 text-2xl font-black ${tone}`}>{value}</div></div>)}
          </div>

          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex flex-col gap-3 border-b border-gray-200 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {([
                  ['all', 'ทั้งหมด'], ['matched', 'ตรงแล้ว'], ['issues', 'ต้องตรวจ'], ['consignment', 'ฝากส่ง'],
                ] as [RowFilter, string][]).map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-lg border px-3 py-2 text-xs font-bold ${filter === value ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'}`}>{label}</button>)}
              </div>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาเลขบิล Tracking ผู้รับ หรือหมายเหตุ" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none lg:max-w-sm" />
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1280px] w-full text-sm">
                <thead><tr className="bg-slate-800 text-white"><th className="px-3 py-3 text-left">สถานะ</th><th className="px-3 py-3 text-left">สถานะงานรับ</th><th className="px-3 py-3 text-left">Order No. / เลขบิล</th><th className="px-3 py-3 text-left">Tracking</th><th className="px-3 py-3 text-left">ผู้ส่ง / ผู้รับ</th><th className="px-3 py-3 text-left min-w-[260px]">หมายเหตุ</th><th className="px-3 py-3 text-center">ดำเนินการ</th></tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={7} className="py-12 text-center text-gray-400">กำลังโหลดผลตรวจสอบ...</td></tr>
                    : filteredRows.length === 0 ? <tr><td colSpan={7} className="py-12 text-center text-gray-400">ไม่พบรายการตามตัวกรอง</td></tr>
                      : filteredRows.map((row) => {
                        const order = linkedOrder(row)
                        return <tr key={row.id} className={`border-t border-gray-100 align-top ${row.review_status === 'resolved' ? 'bg-gray-50 opacity-75' : 'hover:bg-blue-50/40'}`}>
                          <td className="px-3 py-3"><span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(row)}`}>{statusLabel(row)}</span>{row.review_status === 'resolved' && <div className="mt-1 text-[11px] text-gray-500">ตรวจแล้ว</div>}{row.match_detail && <div className="mt-1 max-w-[210px] text-xs text-gray-500">{row.match_detail}</div>}{row.has_previous_import && <div className="mt-1 max-w-[230px] rounded-md bg-orange-50 px-2 py-1 text-[11px] text-orange-700">เคยพบ: {row.previous_file_name || '-'} · {row.previous_carrier || '-'}<br />นำเข้า {formatDateTime(row.previous_imported_at)}{row.previous_pickup_at ? ` · PU ${formatDateTime(row.previous_pickup_at)}` : ''}</div>}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-gray-600">{pickupStatus(row)}</td>
                          <td className="px-3 py-3"><div className="font-semibold text-gray-900">{row.order_no || <span className="font-normal text-gray-400">ไม่มี Order No.</span>}</div>{order && <div className="mt-1 text-xs text-blue-700">ระบบ: {order.bill_no}</div>}</td>
                          <td className="px-3 py-3"><div className="font-mono text-gray-900">{row.tracking_no || '-'}</div>{order?.tracking_number && order.tracking_number !== row.tracking_no && <div className="mt-1 font-mono text-xs text-blue-700">ระบบ: {order.tracking_number}</div>}</td>
                          <td className="px-3 py-3"><div className="font-semibold text-gray-800">{row.sender || order?.channel_code || '-'}</div><div className="mt-1 max-w-[220px] text-xs text-gray-500">{row.consignee || order?.recipient_name || order?.customer_name || '-'}</div>{row.consignee_phone && <div className="mt-1 text-xs text-gray-500">{row.consignee_phone}</div>}</td>
                          <td className="px-3 py-3">{row.is_consignment ? <textarea value={notes[row.id] ?? ''} onChange={(event) => setNotes((previous) => ({ ...previous, [row.id]: event.target.value }))} placeholder="กรอกหมายเหตุสินค้าฝากส่ง" rows={2} className="w-full resize-y rounded-lg border border-gray-300 px-2.5 py-2 text-sm focus:border-blue-500 focus:outline-none" /> : <span className="text-gray-400">-</span>}</td>
                          <td className="px-3 py-3"><div className="flex min-w-[150px] flex-col gap-2">{row.is_consignment && <button type="button" disabled={savingRowId === row.id} onClick={() => void saveReview(row, false)} className="rounded-lg border border-blue-300 px-3 py-2 text-xs font-bold text-blue-700 hover:bg-blue-50 disabled:opacity-50">บันทึกหมายเหตุ</button>}{isOpenIssue(row) && <button type="button" disabled={savingRowId === row.id} onClick={() => void saveReview(row, true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">ตรวจแล้ว</button>}{!row.is_consignment && !isOpenIssue(row) && <span className="text-center text-xs text-gray-400">-</span>}</div></td>
                        </tr>
                      })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <Modal
        open={duplicateWarning.length > 0}
        onClose={() => !importing && setDuplicateWarning([])}
        contentClassName="max-w-3xl"
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-100 text-xl">!</div>
            <div>
              <h3 className="text-lg font-bold text-gray-900">พบ Tracking ที่เคยนำเข้าแล้ว</h3>
              <p className="mt-1 text-sm text-gray-600">
                พบรายการซ้ำข้ามประวัติ {duplicateWarning.length} รายการ กรุณาตรวจสอบก่อนยืนยัน การยืนยันจะนำเข้ารายการเหล่านี้และติดป้าย “เคยนำเข้าแล้ว”
              </p>
            </div>
          </div>
          <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-orange-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-orange-50 text-orange-900">
                <tr><th className="px-3 py-2 text-left">Tracking</th><th className="px-3 py-2 text-left">ไฟล์ครั้งก่อน</th><th className="px-3 py-2 text-left">ขนส่ง</th><th className="px-3 py-2 text-left">นำเข้าเมื่อ</th></tr>
              </thead>
              <tbody>
                {duplicateWarning.map((item) => (
                  <tr key={item.tracking_no_normalized} className="border-t border-orange-100">
                    <td className="px-3 py-2 font-mono font-semibold">{item.tracking_no || item.tracking_no_normalized}</td>
                    <td className="max-w-[240px] truncate px-3 py-2" title={item.previous_file_name}>{item.previous_file_name}</td>
                    <td className="px-3 py-2">{item.previous_carrier}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDateTime(item.previous_imported_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" disabled={importing} onClick={() => setDuplicateWarning([])} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50">ยกเลิกและกลับไปตรวจไฟล์</button>
            <button type="button" disabled={importing} onClick={() => void importFile(true)} className="rounded-lg bg-orange-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-50">{importing ? 'กำลังนำเข้า...' : `ยืนยันนำเข้ารายการซ้ำ ${duplicateWarning.length} รายการ`}</button>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteImportOpen && Boolean(selectedImport)}
        onClose={() => !deletingImport && setDeleteImportOpen(false)}
        contentClassName="max-w-lg"
      >
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-900">ยืนยันลบประวัติการนำเข้า</h3>
          <p className="mt-2 text-sm text-gray-600">ระบบจะลบรอบนำเข้าและผลตรวจของรอบนี้เท่านั้น บิลและ Tracking ในระบบออเดอร์จะไม่ถูกลบ</p>
          {selectedImport && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
              <div className="flex justify-between gap-4"><span className="text-gray-600">วันที่</span><strong>{selectedImport.pickup_date_from}</strong></div>
              <div className="mt-2 flex justify-between gap-4"><span className="text-gray-600">บริษัทขนส่ง</span><strong>{selectedImport.carrier}</strong></div>
              <div className="mt-2 flex justify-between gap-4"><span className="text-gray-600">ไฟล์</span><strong className="max-w-[270px] truncate" title={selectedImport.file_name}>{selectedImport.file_name}</strong></div>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={deletingImport} onClick={() => setDeleteImportOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50">ยกเลิก</button>
            <button type="button" disabled={deletingImport} onClick={() => void deleteSelectedImport()} className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-50">{deletingImport ? 'กำลังลบ...' : 'ยืนยันลบประวัติ'}</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
