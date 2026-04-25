import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'

type OperationType = 'annual_close' | 'reset_only' | 'backup_only'
type StockStrategy = 'opening' | 'zero'
type PanelTab = 'actions' | 'backups'
type BackupTableGroup = 'all' | 'orders' | 'warehouse' | 'purchase' | 'account' | 'wms_qc' | 'hr' | 'settings'

type TableCount = {
  table_name: string
  row_count: number | null
  error?: string
}

type PreviewResult = {
  success: boolean
  operation_id: string
  operation_type: OperationType
  stock_strategy: StockStrategy
  target_year: number | null
  total_rows: number
  table_counts: TableCount[]
  blockers: Record<string, number | string>
  hr_policy: {
    preserve_default: boolean
    message: string
  }
}

type OperationResult = {
  mode: OperationType
  operationId: string
  status: 'success' | 'error'
  message: string
  details?: unknown
}

type BackupListItem = {
  id: string
  operation_type: OperationType
  target_year: number | null
  status: string
  requested_by: string | null
  requested_at: string
  backup_verified_at: string | null
  manifest_path: string
  exported_table_count: number
}

type BackupTableFile = {
  path: string
  rows: number
}

type BackupTableExport = {
  table_name: string
  success: boolean
  total_rows?: number
  error?: string
  files?: BackupTableFile[]
}

type BackupManifest = {
  operation_id: string
  operation_type: OperationType
  target_year: number | null
  created_at: string
  created_by: string
  note?: string
  exported_tables: BackupTableExport[]
  storage?: {
    bucket?: string
    object_prefix?: string
    manifest_path?: string
  }
  hr_policy?: {
    preserve_default: boolean
    message: string
  }
}

type TablePageResult = {
  success: boolean
  table_name: string
  page_index: number
  page_count: number
  file_path: string
  rows: Record<string, unknown>[]
}

const currentYear = new Date().getFullYear()

const TABLE_GROUP_OPTIONS: Array<{ key: BackupTableGroup; label: string; prefixes?: string[]; tables?: string[] }> = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'orders', label: 'ออเดอร์/งานขาย', prefixes: ['or_'] },
  { key: 'warehouse', label: 'คลัง/สต๊อก', prefixes: ['inv_stock', 'inv_lot', 'wh_sub', 'roll_'] },
  { key: 'purchase', label: 'จัดซื้อ/รับสินค้า', prefixes: ['inv_pr', 'inv_po', 'inv_gr', 'inv_sample'] },
  { key: 'account', label: 'บัญชี/สลิป/Ecommerce', prefixes: ['ac_'] },
  { key: 'wms_qc', label: 'WMS/QC/Packing/Plan', prefixes: ['wms_', 'qc_', 'pk_', 'plan_', 'pp_'] },
  { key: 'hr', label: 'HR', prefixes: ['hr_'] },
  {
    key: 'settings',
    label: 'Master/ตั้งค่า',
    tables: [
      'us_users',
      'pr_products',
      'channels',
      'bank_settings',
      'bill_header_settings',
      'st_user_menus',
      'settings_reasons',
      'ac_ecommerce_channels',
      'ac_ecommerce_channel_maps',
    ],
  },
]

const TABLE_LABELS: Record<string, string> = {
  or_orders: 'ออเดอร์/บิลขาย',
  or_order_items: 'รายการสินค้าในออเดอร์',
  or_work_orders: 'ใบสั่งงาน',
  or_claim_requests: 'คำขอเคลม',
  or_issues: 'Issue ออเดอร์',
  or_issue_messages: 'ข้อความ Issue',
  or_order_chat_logs: 'ประวัติแชทออเดอร์',
  wms_orders: 'งานจัดสินค้า',
  wms_requisitions: 'ใบเบิก WMS',
  wms_return_requisitions: 'ใบคืน WMS',
  wms_borrow_requisitions: 'ใบยืม WMS',
  qc_sessions: 'รอบตรวจ QC',
  qc_records: 'ผลตรวจ QC',
  pk_packing_logs: 'ประวัติจัดของ',
  pk_packing_unit_scans: 'สแกนจัดของรายชิ้น',
  inv_stock_movements: 'ประวัติเคลื่อนไหวสต๊อก',
  inv_stock_lots: 'Lot สต๊อก FIFO',
  inv_stock_balances: 'ยอดคงเหลือสต๊อก',
  inv_lot_consumptions: 'การตัด Lot FIFO',
  inv_pr: 'ใบขอซื้อ PR',
  inv_pr_items: 'รายการ PR',
  inv_po: 'ใบสั่งซื้อ PO',
  inv_po_items: 'รายการ PO',
  inv_gr: 'ใบรับสินค้า GR',
  inv_gr_items: 'รายการรับสินค้า GR',
  inv_adjustments: 'เอกสารปรับสต๊อก',
  inv_adjustment_items: 'รายการปรับสต๊อก',
  inv_returns: 'รับสินค้าตีกลับ',
  inv_return_items: 'รายการรับคืน',
  ac_verified_slips: 'สลิปที่ตรวจแล้ว',
  ac_refunds: 'รายการโอนคืน',
  ac_credit_notes: 'Credit Note',
  ac_ecommerce_sale_lines: 'รายการขาย Ecommerce',
  ac_ecommerce_import_batches: 'ไฟล์นำเข้า Ecommerce',
  pr_products: 'Master สินค้า',
  us_users: 'ผู้ใช้ระบบ',
  st_user_menus: 'สิทธิ์เมนู',
  channels: 'ช่องทางขาย',
  bank_settings: 'ข้อมูลธนาคาร',
  bill_header_settings: 'หัวบิล',
  hr_employees: 'ทะเบียนพนักงาน',
  hr_departments: 'แผนก',
  hr_positions: 'ตำแหน่ง',
  hr_assets: 'ทรัพย์สิน HR',
}

const COLUMN_LABELS: Record<string, string> = {
  id: 'รหัสระบบ',
  created_at: 'วันที่สร้าง',
  updated_at: 'วันที่แก้ไข',
  created_by: 'ผู้สร้าง',
  updated_by: 'ผู้แก้ไข',
  order_id: 'ออเดอร์',
  order_no: 'เลขออเดอร์',
  bill_no: 'เลขบิล',
  channel_code: 'ช่องทาง',
  status: 'สถานะ',
  customer_name: 'ลูกค้า',
  customer_address: 'ที่อยู่',
  total_amount: 'ยอดรวม',
  price: 'ราคา',
  shipping_cost: 'ค่าส่ง',
  discount: 'ส่วนลด',
  payment_method: 'วิธีชำระเงิน',
  payment_date: 'วันที่ชำระ',
  shipped_time: 'เวลาจัดส่ง',
  tracking_number: 'เลข Tracking',
  product_id: 'สินค้า',
  product_code: 'รหัสสินค้า',
  product_name: 'ชื่อสินค้า',
  product_category: 'หมวดสินค้า',
  product_type: 'ประเภทสินค้า',
  qty: 'จำนวน',
  quantity: 'จำนวน',
  unit_price: 'ราคา/หน่วย',
  unit_cost: 'ต้นทุน/หน่วย',
  total_cost: 'ต้นทุนรวม',
  movement_type: 'ประเภทเคลื่อนไหว',
  ref_type: 'เอกสารอ้างอิง',
  ref_id: 'รหัสอ้างอิง',
  note: 'หมายเหตุ',
  notes: 'หมายเหตุ',
  on_hand: 'คงเหลือ',
  reserved: 'จอง',
  safety_stock: 'Safety stock',
  qty_initial: 'จำนวนตั้งต้น',
  qty_remaining: 'จำนวนคงเหลือ',
  is_safety_stock: 'เป็น Safety stock',
  pr_no: 'เลข PR',
  po_no: 'เลข PO',
  gr_no: 'เลข GR',
  requested_at: 'วันที่ขอ',
  ordered_at: 'วันที่สั่งซื้อ',
  received_at: 'วันที่รับ',
  approved_at: 'วันที่อนุมัติ',
  file_name: 'ชื่อไฟล์',
  uploaded_at: 'วันที่อัปโหลด',
  row_index: 'แถวในไฟล์',
  sku_ref: 'SKU',
  line_total: 'ยอดบรรทัด',
  commission: 'ค่าคอมมิชชั่น',
  transaction_fee: 'ค่าธรรมเนียม',
  username: 'ชื่อผู้ใช้',
  role: 'Role',
  email: 'อีเมล',
  is_active: 'เปิดใช้งาน',
}

const TABLE_PRIMARY_COLUMNS: Record<string, string[]> = {
  or_orders: ['bill_no', 'channel_code', 'status', 'customer_name', 'total_amount', 'payment_date', 'shipped_time', 'tracking_number'],
  or_order_items: ['product_name', 'quantity', 'unit_price', 'ink_color', 'cartoon_pattern', 'line_1', 'notes'],
  inv_stock_movements: ['created_at', 'product_id', 'movement_type', 'qty', 'unit_cost', 'total_cost', 'ref_type', 'note'],
  inv_stock_lots: ['created_at', 'product_id', 'qty_initial', 'qty_remaining', 'unit_cost', 'is_safety_stock', 'ref_type'],
  inv_stock_balances: ['product_id', 'on_hand', 'reserved', 'safety_stock', 'updated_at'],
  inv_pr: ['pr_no', 'status', 'requested_at', 'approved_at', 'note'],
  inv_po: ['po_no', 'status', 'ordered_at', 'note'],
  inv_gr: ['gr_no', 'status', 'received_at', 'note'],
  ac_ecommerce_sale_lines: ['payment_at', 'order_no', 'sku_ref', 'qty', 'line_total', 'commission', 'transaction_fee'],
  pr_products: ['product_code', 'product_name', 'product_category', 'product_type', 'is_active', 'landed_cost'],
  us_users: ['username', 'email', 'role', 'created_at'],
  hr_employees: ['employee_code', 'first_name', 'last_name', 'department_id', 'position_id', 'status'],
}

const TECHNICAL_COLUMNS = new Set([
  'id',
  'order_id',
  'product_id',
  'created_by',
  'updated_by',
  'approved_by',
  'requested_by',
  'uploaded_by',
  'assigned_to',
  'ref_id',
  'batch_id',
  'work_order_id',
])

function hasBlockingWork(blockers: Record<string, number | string> | undefined) {
  if (!blockers) return false
  return Object.entries(blockers).some(([, value]) => typeof value === 'number' && value > 0)
}

function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  return value.toLocaleString()
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '-'
  return new Date(value).toLocaleString('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatCellValue(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'ใช่' : 'ไม่ใช่'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatFriendlyCellValue(column: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'ใช่' : 'ไม่ใช่'

  if (typeof value === 'string') {
    if (column.endsWith('_at') || column.includes('date') || column.includes('time')) {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return formatDateTime(value)
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return value.slice(0, 8) + '...'
    }
  }

  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function getTableLabel(tableName: string) {
  return TABLE_LABELS[tableName] || tableName
}

function getColumnLabel(column: string) {
  return COLUMN_LABELS[column] || column
}

function isTechnicalColumn(column: string) {
  return TECHNICAL_COLUMNS.has(column) || column.endsWith('_id') || column.includes('_meta') || column === 'raw_snapshot'
}

function getTableGroup(tableName: string): BackupTableGroup {
  const match = TABLE_GROUP_OPTIONS.find((group) => {
    if (group.key === 'all') return false
    if (group.tables?.includes(tableName)) return true
    return group.prefixes?.some((prefix) => tableName.startsWith(prefix))
  })
  return match?.key ?? 'settings'
}

function buildDisplayColumns(tableName: string, columns: string[], showTechnical: boolean) {
  const allowed = showTechnical ? columns : columns.filter((column) => !isTechnicalColumn(column))
  const primary = TABLE_PRIMARY_COLUMNS[tableName] ?? []
  const ordered = [
    ...primary.filter((column) => allowed.includes(column)),
    ...allowed.filter((column) => !primary.includes(column)),
  ]
  return ordered.slice(0, showTechnical ? 20 : 12)
}

function operationLabel(type: OperationType) {
  if (type === 'annual_close') return 'ปิดงวดรายปี'
  if (type === 'reset_only') return 'ล้างข้อมูลอย่างเดียว'
  return 'สำรองข้อมูลอย่างเดียว'
}

export default function DataBackupClearPanel() {
  const [activePanelTab, setActivePanelTab] = useState<PanelTab>('actions')
  const [targetYear, setTargetYear] = useState(currentYear)
  const [stockStrategy, setStockStrategy] = useState<StockStrategy>('opening')
  const [runningMode, setRunningMode] = useState<OperationType | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [result, setResult] = useState<OperationResult | null>(null)

  const [backups, setBackups] = useState<BackupListItem[]>([])
  const [backupLoading, setBackupLoading] = useState(false)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [selectedBackup, setSelectedBackup] = useState<BackupListItem | null>(null)
  const [manifest, setManifest] = useState<BackupManifest | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [selectedTableName, setSelectedTableName] = useState('')
  const [tablePageIndex, setTablePageIndex] = useState(0)
  const [tablePage, setTablePage] = useState<TablePageResult | null>(null)
  const [tablePageLoading, setTablePageLoading] = useState(false)
  const [viewerError, setViewerError] = useState<string | null>(null)
  const [tableGroup, setTableGroup] = useState<BackupTableGroup>('all')
  const [tableSearch, setTableSearch] = useState('')
  const [showTechnicalColumns, setShowTechnicalColumns] = useState(false)
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null)

  const topTableCounts = useMemo(() => {
    return [...(preview?.table_counts ?? [])]
      .filter((row) => (row.row_count ?? 0) > 0)
      .sort((a, b) => (b.row_count ?? 0) - (a.row_count ?? 0))
      .slice(0, 12)
  }, [preview])

  const exportedTables = useMemo(() => {
    return [...(manifest?.exported_tables ?? [])].sort((a, b) => {
      const aRows = a.total_rows ?? 0
      const bRows = b.total_rows ?? 0
      if (bRows !== aRows) return bRows - aRows
      return a.table_name.localeCompare(b.table_name)
    })
  }, [manifest])

  const selectedTable = useMemo(() => {
    return exportedTables.find((table) => table.table_name === selectedTableName) ?? null
  }, [exportedTables, selectedTableName])

  const tableColumns = useMemo(() => {
    const rows = tablePage?.rows ?? []
    const keys = new Set<string>()
    rows.slice(0, 50).forEach((row) => {
      Object.keys(row).forEach((key) => keys.add(key))
    })
    return Array.from(keys)
  }, [tablePage])

  const displayColumns = useMemo(() => {
    return buildDisplayColumns(selectedTableName, tableColumns, showTechnicalColumns)
  }, [selectedTableName, showTechnicalColumns, tableColumns])

  const filteredRows = useMemo(() => {
    const rows = tablePage?.rows ?? []
    const keyword = tableSearch.trim().toLowerCase()
    if (!keyword) return rows
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(keyword))
  }, [tablePage, tableSearch])

  useEffect(() => {
    if (activePanelTab === 'backups' && backups.length === 0 && !backupLoading) {
      loadBackups()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelTab])

  async function invokeDataBackup<T>(body: Record<string, unknown>) {
    const { data, error } = await supabase.functions.invoke('data-backup', { body })
    if (error) throw error
    if (!(data as { success?: boolean })?.success) {
      throw new Error((data as { error?: string })?.error || 'เรียกใช้งาน data-backup ไม่สำเร็จ')
    }
    return data as T
  }

  async function createOperation(operationType: OperationType) {
    const { data, error } = await supabase.rpc('rpc_data_operation_create', {
      p_operation_type: operationType,
      p_target_year: operationType === 'annual_close' ? targetYear : null,
      p_stock_strategy: operationType === 'backup_only' ? 'opening' : stockStrategy,
    })
    if (error) throw error
    const operationId = (data as { operation_id?: string })?.operation_id
    if (!operationId) throw new Error('ไม่พบ operation_id จากระบบ')
    return operationId
  }

  async function previewOperation(operationId: string) {
    const { data, error } = await supabase.rpc('rpc_data_operation_preview', {
      p_operation_id: operationId,
    })
    if (error) throw error
    setPreview(data as PreviewResult)
    return data as PreviewResult
  }

  async function runBackup(operationId: string) {
    return invokeDataBackup<{ success: boolean; operation_id: string; manifest_path: string }>({
      action: 'create_backup',
      operation_id: operationId,
    })
  }

  async function runReset(operationId: string, operationType: OperationType) {
    const expectedText = operationType === 'annual_close' ? `CLOSE YEAR ${targetYear}` : 'RESET DATA'
    const message =
      operationType === 'annual_close'
        ? `ยืนยันปิดงวดปี ${targetYear} และล้างข้อมูลธุรกรรมทั้งหมด โดยไม่ลบข้อมูล HR\n\nกรุณาพิมพ์: ${expectedText}`
        : `ยืนยันล้างข้อมูลธุรกรรมทั้งหมด โดยไม่ลบข้อมูล HR และไม่สำรองข้อมูล\n\nกรุณาพิมพ์: ${expectedText}`
    const confirmText = window.prompt(message)
    if (confirmText !== expectedText) {
      throw new Error(`ยกเลิก: ข้อความยืนยันไม่ตรงกับ "${expectedText}"`)
    }

    const { data, error } = await supabase.rpc('rpc_data_reset_execute', {
      p_operation_id: operationId,
      p_confirm_text: confirmText,
    })
    if (error) throw error
    return data
  }

  async function loadBackups() {
    setBackupLoading(true)
    setBackupError(null)
    try {
      const data = await invokeDataBackup<{ success: boolean; backups: BackupListItem[] }>({
        action: 'list_backups',
      })
      setBackups(data.backups ?? [])
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : String(error))
    } finally {
      setBackupLoading(false)
    }
  }

  async function loadManifest(backup: BackupListItem) {
    setSelectedBackup(backup)
    setManifest(null)
    setSelectedTableName('')
    setTablePage(null)
    setTableSearch('')
    setSelectedRow(null)
    setViewerError(null)
    setManifestLoading(true)
    try {
      const data = await invokeDataBackup<{ success: boolean; manifest: BackupManifest }>({
        action: 'get_manifest',
        operation_id: backup.id,
      })
      setManifest(data.manifest)
      const firstTable = data.manifest.exported_tables?.find((table) => table.success && (table.files?.length ?? 0) > 0)
      if (firstTable) {
        setSelectedTableName(firstTable.table_name)
        setTablePageIndex(0)
        await loadTablePage(backup.id, firstTable.table_name, 0)
      }
    } catch (error) {
      setViewerError(error instanceof Error ? error.message : String(error))
    } finally {
      setManifestLoading(false)
    }
  }

  async function loadTablePage(operationId: string, tableName: string, pageIndex: number) {
    setTablePageLoading(true)
    setViewerError(null)
    setSelectedRow(null)
    try {
      const data = await invokeDataBackup<TablePageResult>({
        action: 'get_table_page',
        operation_id: operationId,
        table_name: tableName,
        page_index: pageIndex,
      })
      setTablePage(data)
      setTablePageIndex(pageIndex)
    } catch (error) {
      setTablePage(null)
      setViewerError(error instanceof Error ? error.message : String(error))
    } finally {
      setTablePageLoading(false)
    }
  }

  async function handleTableChange(tableName: string) {
    setSelectedTableName(tableName)
    setTablePageIndex(0)
    setTableSearch('')
    setSelectedRow(null)
    if (selectedBackup && tableName) {
      await loadTablePage(selectedBackup.id, tableName, 0)
    }
  }

  async function runBackupOnly() {
    setRunningMode('backup_only')
    setResult(null)
    try {
      const operationId = await createOperation('backup_only')
      const backupResult = await runBackup(operationId)
      setResult({
        mode: 'backup_only',
        operationId,
        status: 'success',
        message: 'สำรองข้อมูล/manifest สำเร็จ โดยไม่มีการล้างข้อมูล',
        details: backupResult,
      })
      await loadBackups()
      setActivePanelTab('backups')
    } catch (error) {
      setResult({
        mode: 'backup_only',
        operationId: '-',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRunningMode(null)
    }
  }

  async function runResetOnly() {
    setRunningMode('reset_only')
    setResult(null)
    try {
      const operationId = await createOperation('reset_only')
      const previewResult = await previewOperation(operationId)
      if (hasBlockingWork(previewResult.blockers)) {
        throw new Error('พบงานค้างในระบบ กรุณาตรวจสอบรายการ Preflight ก่อนล้างข้อมูล')
      }
      const resetResult = await runReset(operationId, 'reset_only')
      setResult({
        mode: 'reset_only',
        operationId,
        status: 'success',
        message: 'ล้างข้อมูลธุรกรรมสำเร็จ โดยไม่ลบข้อมูล HR',
        details: resetResult,
      })
    } catch (error) {
      setResult({
        mode: 'reset_only',
        operationId: '-',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRunningMode(null)
    }
  }

  async function runAnnualClose() {
    setRunningMode('annual_close')
    setResult(null)
    try {
      const operationId = await createOperation('annual_close')
      const previewResult = await previewOperation(operationId)
      if (hasBlockingWork(previewResult.blockers)) {
        throw new Error('พบงานค้างในระบบ กรุณาตรวจสอบรายการ Preflight ก่อนปิดงวด')
      }
      await runBackup(operationId)
      const resetResult = await runReset(operationId, 'annual_close')
      setResult({
        mode: 'annual_close',
        operationId,
        status: 'success',
        message: `ปิดงวดปี ${targetYear} สำเร็จ พร้อมสำรองข้อมูลและสร้างยอดยกมา`,
        details: resetResult,
      })
      await loadBackups()
    } catch (error) {
      setResult({
        mode: 'annual_close',
        operationId: '-',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRunningMode(null)
    }
  }

  const isRunning = runningMode !== null

  return (
    <div className="space-y-6">
      <div className="bg-red-50 border border-red-200 rounded-xl p-4">
        <h2 className="text-xl font-bold text-red-800">สำลองข้อมูล/ล้างข้อมูล</h2>
        <p className="text-sm text-red-700 mt-1">
          เมนูนี้เป็นงานเสี่ยงสูง ใช้ได้เฉพาะ superadmin และฟีเจอร์ล้างข้อมูลจะไม่ลบข้อมูล HR เป็นค่าเริ่มต้น
        </p>
      </div>

      <div className="bg-white rounded-xl shadow p-2 flex flex-wrap gap-2">
        <TabButton active={activePanelTab === 'actions'} onClick={() => setActivePanelTab('actions')}>
          ดำเนินการ
        </TabButton>
        <TabButton active={activePanelTab === 'backups'} onClick={() => setActivePanelTab('backups')}>
          ประวัติข้อมูลสำรอง
        </TabButton>
      </div>

      {activePanelTab === 'actions' ? (
        <ActionsView
          targetYear={targetYear}
          setTargetYear={setTargetYear}
          stockStrategy={stockStrategy}
          setStockStrategy={setStockStrategy}
          runningMode={runningMode}
          isRunning={isRunning}
          preview={preview}
          result={result}
          topTableCounts={topTableCounts}
          runAnnualClose={runAnnualClose}
          runResetOnly={runResetOnly}
          runBackupOnly={runBackupOnly}
        />
      ) : (
        <BackupHistoryView
          backups={backups}
          backupLoading={backupLoading}
          backupError={backupError}
          selectedBackup={selectedBackup}
          manifest={manifest}
          manifestLoading={manifestLoading}
          exportedTables={exportedTables}
          selectedTableName={selectedTableName}
          selectedTable={selectedTable}
          tablePage={tablePage}
          displayColumns={displayColumns}
          filteredRows={filteredRows}
          tablePageIndex={tablePageIndex}
          tablePageLoading={tablePageLoading}
          viewerError={viewerError}
          tableGroup={tableGroup}
          tableSearch={tableSearch}
          showTechnicalColumns={showTechnicalColumns}
          selectedRow={selectedRow}
          setTableGroup={setTableGroup}
          setTableSearch={setTableSearch}
          setShowTechnicalColumns={setShowTechnicalColumns}
          setSelectedRow={setSelectedRow}
          loadBackups={loadBackups}
          loadManifest={loadManifest}
          handleTableChange={handleTableChange}
          loadTablePage={loadTablePage}
        />
      )}
    </div>
  )
}

function ActionsView({
  targetYear,
  setTargetYear,
  stockStrategy,
  setStockStrategy,
  runningMode,
  isRunning,
  preview,
  result,
  topTableCounts,
  runAnnualClose,
  runResetOnly,
  runBackupOnly,
}: {
  targetYear: number
  setTargetYear: (value: number) => void
  stockStrategy: StockStrategy
  setStockStrategy: (value: StockStrategy) => void
  runningMode: OperationType | null
  isRunning: boolean
  preview: PreviewResult | null
  result: OperationResult | null
  topTableCounts: TableCount[]
  runAnnualClose: () => void
  runResetOnly: () => void
  runBackupOnly: () => void
}) {
  return (
    <>
      <div className="bg-white rounded-xl shadow p-5 space-y-4">
        <h3 className="font-semibold text-gray-900">ค่าก่อนดำเนินการ</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">ปีงวดสำหรับปิดงวดรายปี</span>
            <input
              type="number"
              value={targetYear}
              onChange={(event) => setTargetYear(Number(event.target.value) || currentYear)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
              min={2000}
              max={2100}
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">นโยบายสต๊อกหลังล้างข้อมูล</span>
            <select
              value={stockStrategy}
              onChange={(event) => setStockStrategy(event.target.value as StockStrategy)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            >
              <option value="opening">สร้างยอดยกมาต้นระบบใหม่ (แนะนำ)</option>
              <option value="zero">ล้างสต๊อกเป็นศูนย์</option>
            </select>
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ActionCard
          title="ปิดงวดรายปี"
          tone="blue"
          description="สำรองข้อมูล, verify manifest, สร้างยอดยกมา แล้วล้างข้อมูลธุรกรรม"
          disabled={isRunning}
          loading={runningMode === 'annual_close'}
          buttonLabel="เริ่มปิดงวดรายปี"
          onClick={runAnnualClose}
        />
        <ActionCard
          title="ล้างข้อมูลอย่างเดียว"
          tone="red"
          description="ล้างเฉพาะ transactional data ไม่สำรอง ไม่ปิดงวด และไม่ลบข้อมูล HR"
          disabled={isRunning}
          loading={runningMode === 'reset_only'}
          buttonLabel="ล้างข้อมูลอย่างเดียว"
          onClick={runResetOnly}
        />
        <ActionCard
          title="สำรองข้อมูลอย่างเดียว"
          tone="green"
          description="สร้าง backup manifest และ table counts เท่านั้น ไม่มีการล้างข้อมูล"
          disabled={isRunning}
          loading={runningMode === 'backup_only'}
          buttonLabel="สำรองข้อมูลอย่างเดียว"
          onClick={runBackupOnly}
        />
      </div>

      {preview && (
        <div className="bg-white rounded-xl shadow p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">Preflight ล่าสุด</h3>
              <p className="text-sm text-gray-600">
                Operation: <span className="font-mono">{preview.operation_id}</span> · รวมข้อมูลที่จะล้าง{' '}
                {formatCount(preview.total_rows)} แถว
              </p>
            </div>
            <span className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-sm font-semibold">
              HR: Preserve
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border rounded-lg p-4">
              <h4 className="font-semibold mb-2">งานค้างที่ต้องตรวจ</h4>
              <div className="space-y-1 text-sm">
                {Object.entries(preview.blockers).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-3">
                    <span className="text-gray-600">{key}</span>
                    <span className={typeof value === 'number' && value > 0 ? 'font-bold text-red-600' : 'font-medium'}>
                      {String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border rounded-lg p-4">
              <h4 className="font-semibold mb-2">ตารางที่จะถูกล้างมากที่สุด</h4>
              <div className="space-y-1 text-sm max-h-64 overflow-auto">
                {topTableCounts.length === 0 ? (
                  <p className="text-gray-500">ไม่พบข้อมูลธุรกรรม</p>
                ) : (
                  topTableCounts.map((row) => (
                    <div key={row.table_name} className="flex justify-between gap-3">
                      <span className="font-mono text-gray-700">{row.table_name}</span>
                      <span>{formatCount(row.row_count)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`rounded-xl border p-4 ${
            result.status === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <h3 className="font-semibold">{result.status === 'success' ? 'สำเร็จ' : 'ไม่สำเร็จ'}</h3>
          <p className="text-sm mt-1">{result.message}</p>
          {result.operationId !== '-' && (
            <p className="text-xs mt-2 font-mono">operation_id: {result.operationId}</p>
          )}
        </div>
      )}
    </>
  )
}

function BackupHistoryView({
  backups,
  backupLoading,
  backupError,
  selectedBackup,
  manifest,
  manifestLoading,
  exportedTables,
  selectedTableName,
  selectedTable,
  tablePage,
  displayColumns,
  filteredRows,
  tablePageIndex,
  tablePageLoading,
  viewerError,
  tableGroup,
  tableSearch,
  showTechnicalColumns,
  selectedRow,
  setTableGroup,
  setTableSearch,
  setShowTechnicalColumns,
  setSelectedRow,
  loadBackups,
  loadManifest,
  handleTableChange,
  loadTablePage,
}: {
  backups: BackupListItem[]
  backupLoading: boolean
  backupError: string | null
  selectedBackup: BackupListItem | null
  manifest: BackupManifest | null
  manifestLoading: boolean
  exportedTables: BackupTableExport[]
  selectedTableName: string
  selectedTable: BackupTableExport | null
  tablePage: TablePageResult | null
  displayColumns: string[]
  filteredRows: Record<string, unknown>[]
  tablePageIndex: number
  tablePageLoading: boolean
  viewerError: string | null
  tableGroup: BackupTableGroup
  tableSearch: string
  showTechnicalColumns: boolean
  selectedRow: Record<string, unknown> | null
  setTableGroup: (value: BackupTableGroup) => void
  setTableSearch: (value: string) => void
  setShowTechnicalColumns: (value: boolean) => void
  setSelectedRow: (row: Record<string, unknown> | null) => void
  loadBackups: () => void
  loadManifest: (backup: BackupListItem) => void
  handleTableChange: (tableName: string) => void
  loadTablePage: (operationId: string, tableName: string, pageIndex: number) => void
}) {
  const filteredTables = useMemo(() => {
    return exportedTables.filter((table) => {
      if (tableGroup === 'all') return true
      return getTableGroup(table.table_name) === tableGroup
    })
  }, [exportedTables, tableGroup])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
      <div className="bg-white rounded-xl shadow p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-900">ประวัติข้อมูลสำรอง</h3>
            <p className="text-sm text-gray-500">แสดง backup ที่สร้างสำเร็จจาก bucket private</p>
          </div>
          <button
            type="button"
            onClick={loadBackups}
            disabled={backupLoading}
            className="px-3 py-2 rounded-lg bg-gray-900 text-white text-sm font-semibold disabled:bg-gray-400"
          >
            {backupLoading ? 'กำลังโหลด...' : 'รีเฟรช'}
          </button>
        </div>

        {backupError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {backupError}
          </div>
        )}

        <div className="space-y-3 max-h-[720px] overflow-auto pr-1">
          {backups.length === 0 && !backupLoading ? (
            <p className="text-sm text-gray-500">ยังไม่พบ backup ที่สำเร็จ</p>
          ) : (
            backups.map((backup) => (
              <button
                key={backup.id}
                type="button"
                onClick={() => loadManifest(backup)}
                className={`w-full text-left rounded-xl border p-4 transition-colors ${
                  selectedBackup?.id === backup.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-blue-300'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-gray-900">{operationLabel(backup.operation_type)}</p>
                    <p className="text-xs text-gray-500">{formatDateTime(backup.backup_verified_at)}</p>
                  </div>
                  <span className="rounded-full bg-green-50 px-2 py-1 text-xs font-semibold text-green-700">
                    {backup.status}
                  </span>
                </div>
                <p className="mt-2 text-xs font-mono text-gray-500 break-all">{backup.id}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-600">
                  <span>ปี: {backup.target_year ?? '-'}</span>
                  <span>ตาราง: {backup.exported_table_count}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="space-y-6">
        {!selectedBackup ? (
          <div className="bg-white rounded-xl shadow p-8 text-center text-gray-500">
            เลือก backup จากรายการด้านซ้ายเพื่อดูรายละเอียด
          </div>
        ) : (
          <>
            <div className="bg-white rounded-xl shadow p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-900">รายละเอียด Backup</h3>
                  <p className="text-sm text-gray-500 font-mono break-all">{selectedBackup.id}</p>
                </div>
                <span className="rounded-full bg-green-50 px-3 py-1 text-sm font-semibold text-green-700">
                  HR: Preserve
                </span>
              </div>

              {manifestLoading ? (
                <p className="text-sm text-gray-500">กำลังโหลด manifest...</p>
              ) : manifest ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <InfoRow label="ประเภท" value={operationLabel(manifest.operation_type)} />
                  <InfoRow label="สร้างเมื่อ" value={formatDateTime(manifest.created_at)} />
                  <InfoRow label="Bucket" value={manifest.storage?.bucket || '-'} />
                  <InfoRow label="Manifest" value={manifest.storage?.manifest_path || selectedBackup.manifest_path || '-'} mono />
                  <InfoRow label="Object Prefix" value={manifest.storage?.object_prefix || '-'} mono />
                  <InfoRow label="จำนวนตาราง" value={String(exportedTables.length)} />
                </div>
              ) : null}
            </div>

            {viewerError && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700">
                {viewerError}
              </div>
            )}

            {manifest && (
              <div className="bg-white rounded-xl shadow p-5 space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
                  <div className="space-y-3">
                    <div>
                      <h4 className="font-semibold text-gray-900">มุมมองข้อมูลย้อนหลัง</h4>
                      <p className="text-sm text-gray-500">เลือกหมวดและตาราง ระบบจะแสดงชื่อที่อ่านง่ายให้ก่อน</p>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-xs font-semibold text-gray-600">หมวดข้อมูล</span>
                      <select
                        value={tableGroup}
                        onChange={(event) => setTableGroup(event.target.value as BackupTableGroup)}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2"
                      >
                        {TABLE_GROUP_OPTIONS.map((group) => (
                          <option key={group.key} value={group.key}>
                            {group.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <select
                      value={selectedTableName}
                      onChange={(event) => handleTableChange(event.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    >
                      <option value="">เลือกตาราง</option>
                      {filteredTables.map((table) => (
                        <option key={table.table_name} value={table.table_name}>
                          {getTableLabel(table.table_name)} ({formatCount(table.total_rows ?? 0)})
                        </option>
                      ))}
                    </select>

                    {selectedTable && (
                      <div className="rounded-lg border p-3 text-sm space-y-1">
                        <div className="flex justify-between">
                          <span className="text-gray-500">จำนวนแถว</span>
                          <span>{formatCount(selectedTable.total_rows ?? 0)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-500">จำนวนไฟล์</span>
                          <span>{formatCount(selectedTable.files?.length ?? 0)}</span>
                        </div>
                        {selectedTable.error && (
                          <p className="text-red-600 text-xs pt-2">{selectedTable.error}</p>
                        )}
                      </div>
                    )}
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="checkbox"
                        checked={showTechnicalColumns}
                        onChange={(event) => setShowTechnicalColumns(event.target.checked)}
                      />
                      แสดงคอลัมน์เทคนิค เช่น id/ref_id
                    </label>
                  </div>

                  <div className="space-y-3 min-w-0">
                    <TablePageToolbar
                      selectedBackup={selectedBackup}
                      selectedTableName={selectedTableName}
                      tablePageIndex={tablePageIndex}
                      tablePage={tablePage}
                      tablePageLoading={tablePageLoading}
                      loadTablePage={loadTablePage}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <input
                        type="search"
                        value={tableSearch}
                        onChange={(event) => setTableSearch(event.target.value)}
                        placeholder="ค้นหาในหน้าปัจจุบัน..."
                        className="min-w-[260px] flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <p className="text-xs text-gray-500">
                        แสดง {formatCount(filteredRows.length)} / {formatCount(tablePage?.rows.length ?? 0)} แถว
                      </p>
                    </div>
                    <JsonTable
                      rows={filteredRows}
                      columns={displayColumns}
                      tableName={selectedTableName}
                      loading={tablePageLoading}
                      onRowSelect={setSelectedRow}
                    />
                    <RowDetailPanel row={selectedRow} tableName={selectedTableName} onClose={() => setSelectedRow(null)} />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function TablePageToolbar({
  selectedBackup,
  selectedTableName,
  tablePageIndex,
  tablePage,
  tablePageLoading,
  loadTablePage,
}: {
  selectedBackup: BackupListItem
  selectedTableName: string
  tablePageIndex: number
  tablePage: TablePageResult | null
  tablePageLoading: boolean
  loadTablePage: (operationId: string, tableName: string, pageIndex: number) => void
}) {
  const pageCount = tablePage?.page_count ?? 0
  const canPrev = selectedTableName && tablePageIndex > 0 && !tablePageLoading
  const canNext = selectedTableName && pageCount > 0 && tablePageIndex + 1 < pageCount && !tablePageLoading

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h4 className="font-semibold text-gray-900">ดูข้อมูล: {selectedTableName ? getTableLabel(selectedTableName) : '-'}</h4>
        <p className="text-xs text-gray-500">
          {selectedTableName || 'ยังไม่ได้เลือกตาราง'} · หน้า {pageCount ? tablePageIndex + 1 : '-'} / {pageCount || '-'}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => loadTablePage(selectedBackup.id, selectedTableName, tablePageIndex - 1)}
          className="px-3 py-2 rounded-lg border text-sm font-semibold disabled:opacity-50"
        >
          ก่อนหน้า
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => loadTablePage(selectedBackup.id, selectedTableName, tablePageIndex + 1)}
          className="px-3 py-2 rounded-lg border text-sm font-semibold disabled:opacity-50"
        >
          ถัดไป
        </button>
      </div>
    </div>
  )
}

function JsonTable({
  rows,
  columns,
  tableName,
  loading,
  onRowSelect,
}: {
  rows: Record<string, unknown>[]
  columns: string[]
  tableName: string
  loading: boolean
  onRowSelect: (row: Record<string, unknown>) => void
}) {
  if (loading) {
    return <div className="rounded-lg border p-8 text-center text-gray-500">กำลังโหลดข้อมูล...</div>
  }

  if (rows.length === 0) {
    return <div className="rounded-lg border p-8 text-center text-gray-500">ไม่พบข้อมูลใน {tableName ? getTableLabel(tableName) : 'หน้านี้'}</div>
  }

  return (
    <div className="border rounded-lg overflow-auto max-h-[620px]">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 text-left font-semibold text-gray-700 border-b whitespace-nowrap">
                {getColumnLabel(column)}
              </th>
            ))}
            <th className="px-3 py-2 text-left font-semibold text-gray-700 border-b whitespace-nowrap">รายละเอียด</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="odd:bg-white even:bg-gray-50 hover:bg-blue-50">
              {columns.map((column) => (
                <td key={column} className="px-3 py-2 border-b max-w-[280px] truncate" title={formatCellValue(row[column])}>
                  {formatFriendlyCellValue(column, row[column])}
                </td>
              ))}
              <td className="px-3 py-2 border-b whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onRowSelect(row)}
                  className="rounded-lg border px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                >
                  ดูรายละเอียด
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowDetailPanel({
  row,
  tableName,
  onClose,
}: {
  row: Record<string, unknown> | null
  tableName: string
  onClose: () => void
}) {
  if (!row) return null

  const entries = Object.entries(row)
  const mainEntries = entries.filter(([key]) => !isTechnicalColumn(key))
  const technicalEntries = entries.filter(([key]) => isTechnicalColumn(key))

  return (
    <div className="rounded-xl border bg-gray-50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-gray-900">รายละเอียด: {getTableLabel(tableName)}</h4>
          <p className="text-xs text-gray-500">แสดงทุก field ของแถวที่เลือก โดยแยกข้อมูลหลักออกจากข้อมูลเทคนิค</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1 text-sm font-semibold">
          ปิด
        </button>
      </div>

      <DetailGrid title="ข้อมูลหลัก" entries={mainEntries} />
      {technicalEntries.length > 0 && <DetailGrid title="ข้อมูลเทคนิค" entries={technicalEntries} compact />}
    </div>
  )
}

function DetailGrid({
  title,
  entries,
  compact = false,
}: {
  title: string
  entries: Array<[string, unknown]>
  compact?: boolean
}) {
  return (
    <div>
      <h5 className="mb-2 text-sm font-semibold text-gray-800">{title}</h5>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {entries.map(([key, value]) => (
          <div key={key} className={`rounded-lg bg-white border p-3 ${compact ? 'opacity-80' : ''}`}>
            <p className="text-xs text-gray-500">{getColumnLabel(key)}</p>
            <p className="mt-1 break-words text-sm text-gray-900">{formatFriendlyCellValue(key, value)}</p>
            <p className="mt-1 font-mono text-[10px] text-gray-400">{key}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 break-all ${mono ? 'font-mono text-xs' : 'font-medium text-gray-900'}`}>{value}</p>
    </div>
  )
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-lg font-semibold text-sm ${
        active ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

function ActionCard({
  title,
  description,
  buttonLabel,
  tone,
  disabled,
  loading,
  onClick,
}: {
  title: string
  description: string
  buttonLabel: string
  tone: 'blue' | 'green' | 'red'
  disabled: boolean
  loading: boolean
  onClick: () => void
}) {
  const colorClass = {
    blue: 'bg-blue-600 hover:bg-blue-700',
    green: 'bg-green-600 hover:bg-green-700',
    red: 'bg-red-600 hover:bg-red-700',
  }[tone]

  return (
    <div className="bg-white rounded-xl shadow p-5 flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-bold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-600 mt-1">{description}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`mt-auto rounded-lg px-4 py-2 font-semibold text-white transition-colors ${
          disabled ? 'bg-gray-400 cursor-not-allowed' : colorClass
        }`}
      >
        {loading ? 'กำลังดำเนินการ...' : buttonLabel}
      </button>
    </div>
  )
}
