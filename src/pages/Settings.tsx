import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { User, BankSetting, OrderChatLog, IssueType } from '../types'
import { formatDateTime } from '../lib/utils'
import { BANK_CODES } from '../types'
import { testEasySlipConnection, testEasySlipWithImage } from '../lib/slipVerification'
import Modal from '../components/ui/Modal'
import { useWmsModal } from '../components/wms/useWmsModal'
import { useMenuAccess } from '../contexts/MenuAccessContext'

const SETTINGS_TABS = [
  { key: 'users', label: 'จัดการสิทธิ์ผู้ใช้' },
  { key: 'role-settings', label: 'ตั้งค่า Role' },
  { key: 'banks', label: 'ตั้งค่าข้อมูลธนาคาร' },
  { key: 'product-settings', label: 'ตั้งค่าสินค้า' },
  { key: 'sellers', label: 'ผู้ขาย' },
  { key: 'issue-types', label: 'ประเภท Issue' },
  { key: 'chat-history', label: 'ประวัติแชท' },
  { key: 'easyslip', label: 'API EasySlip' },
] as const

type SettingsTabKey = (typeof SETTINGS_TABS)[number]['key']

export default function Settings() {
  const { hasAccess, refreshMenuAccess } = useMenuAccess()
  const [users, setUsers] = useState<User[]>([])
  const [bankSettings, setBankSettings] = useState<BankSetting[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('users')

  // ตั้งค่า activeTab ให้เป็นแท็บแรกที่ user มีสิทธิ์เข้าถึง
  useEffect(() => {
    const firstAccessible = SETTINGS_TABS.find(t => hasAccess(`settings-${t.key}`))
    if (firstAccessible && !hasAccess(`settings-${activeTab}`)) {
      setActiveTab(firstAccessible.key)
    }
  }, [hasAccess]) // eslint-disable-line react-hooks/exhaustive-deps
  const [, setFixingStatus] = useState(false)
  const [, setStatusFixResult] = useState<{
    success: boolean
    message: string
    details?: any
  } | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean
    message: string
    details?: any
  } | null>(null)
  const [testingWithImage, setTestingWithImage] = useState(false)
  const [testImageResult, setTestImageResult] = useState<{
    success: boolean
    message: string
    amount?: number
    transRef?: string
    date?: string
    receiverBank?: any
    receiverAccount?: any
    data?: any
    error?: string
  } | null>(null)
  const [selectedImage, setSelectedImage] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  
  // Bank settings form state
  const [showBankForm, setShowBankForm] = useState(false)
  const [editingBank, setEditingBank] = useState<BankSetting | null>(null)
  const [bankFormData, setBankFormData] = useState({
    account_number: '',
    bank_code: '',
    bank_name: '',
    account_name: '',
    is_active: true,
    selectedChannels: [] as string[],
  })

  // ตั้งค่าสินค้า: หมวดหมู่ + ฟิลด์ที่อนุญาตให้กรอก
  const PRODUCT_FIELD_KEYS = [
    { key: 'product_name', label: 'ชื่อสินค้า' },
    { key: 'ink_color', label: 'สีหมึก' },
    { key: 'layer', label: 'ชั้น' },
    { key: 'cartoon_pattern', label: 'ลายการ์ตูน' },
    { key: 'line_pattern', label: 'ลายเส้น' },
    { key: 'font', label: 'ฟอนต์' },
    { key: 'line_1', label: 'บรรทัด 1' },
    { key: 'line_2', label: 'บรรทัด 2' },
    { key: 'line_3', label: 'บรรทัด 3' },
    { key: 'quantity', label: 'จำนวน' },
    { key: 'unit_price', label: 'ราคา/หน่วย' },
    { key: 'notes', label: 'หมายเหตุ' },
    { key: 'attachment', label: 'ไฟล์แนบ' },
  ] as const
  type ProductFieldKey = (typeof PRODUCT_FIELD_KEYS)[number]['key']
  const defaultCategoryFields: Record<ProductFieldKey, boolean> = {
    product_name: true,
    ink_color: true,
    layer: true,
    cartoon_pattern: true,
    line_pattern: true,
    font: true,
    line_1: true,
    line_2: true,
    line_3: true,
    quantity: true,
    unit_price: true,
    notes: true,
    attachment: true,
  }
  const [productCategories, setProductCategories] = useState<string[]>([])
  const [categoryFieldSettings, setCategoryFieldSettings] = useState<Record<string, Record<ProductFieldKey, boolean>>>({})
  const [savingProductSettings, setSavingProductSettings] = useState(false)
  // Product-level field overrides (null = ใช้ค่าจากหมวดหมู่)
  const [allProducts, setAllProducts] = useState<{ id: string; product_name: string; product_code: string; product_category: string | null }[]>([])
  const [productOverrides, setProductOverrides] = useState<Record<string, Record<ProductFieldKey, boolean | null>>>({})
  const [savingProductOverrides, setSavingProductOverrides] = useState(false)
  const [overrideSearchInput, setOverrideSearchInput] = useState('')
  const [overrideSearchTerm, setOverrideSearchTerm] = useState('')
  const [overrideCategoryFilter, setOverrideCategoryFilter] = useState<string>('')
  const [overridePage, setOverridePage] = useState(1)
  const overrideDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [roleMenus, setRoleMenus] = useState<Record<string, Record<string, boolean>>>({})
  const [savingRoleMenus, setSavingRoleMenus] = useState(false)
  const [chatLogs, setChatLogs] = useState<OrderChatLog[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatFromDate, setChatFromDate] = useState(() => new Date().toISOString().split('T')[0])
  const [chatToDate, setChatToDate] = useState(() => new Date().toISOString().split('T')[0])
  const [chatSource, setChatSource] = useState<'all' | 'confirm' | 'issue'>('all')
  // Issue messages merged into a unified format
  const [issueChatLogs, setIssueChatLogs] = useState<(OrderChatLog & { _source: 'issue'; _issueTitle?: string })[]>([])
  // Bill-level grouping
  const [selectedChatBill, setSelectedChatBill] = useState<string | null>(null)
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([])
  const [issueTypeName, setIssueTypeName] = useState('')
  const [issueTypeColor, setIssueTypeColor] = useState('#3B82F6')
  const [issueTypeSaving, setIssueTypeSaving] = useState(false)
  const [issueTypeEditingId, setIssueTypeEditingId] = useState<string | null>(null)
  const [userRoleFilter, setUserRoleFilter] = useState<string>('all')

  // ผู้ขาย (Sellers)
  const [sellers, setSellers] = useState<{ id: string; name: string; name_cn: string; purchase_channel: string; is_active: boolean }[]>([])
  const [sellerName, setSellerName] = useState('')
  const [sellerNameCn, setSellerNameCn] = useState('')
  const [sellerPurchaseChannel, setSellerPurchaseChannel] = useState('')
  const [sellerSaving, setSellerSaving] = useState(false)
  const [sellerEditingId, setSellerEditingId] = useState<string | null>(null)

  const { showMessage, showConfirm, MessageModal, ConfirmModal } = useWmsModal()

  useEffect(() => {
    loadUsers()
    loadBankSettings()
    loadChannels()
  }, [])

  useEffect(() => {
    if (activeTab === 'product-settings') {
      loadProductCategories()
      loadCategoryFieldSettings()
      loadAllProducts()
      loadProductOverrides()
    }
    if (activeTab === 'role-settings') {
      loadRoleMenus()
    }
    if (activeTab === 'chat-history') {
      loadChatLogs()
    }
    if (activeTab === 'issue-types') {
      loadIssueTypes()
    }
    if (activeTab === 'sellers') {
      loadSellers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  useEffect(() => {
    overrideDebounceRef.current = setTimeout(() => {
      setOverrideSearchTerm(overrideSearchInput.trim())
      setOverridePage(1)
    }, 400)
    return () => {
      if (overrideDebounceRef.current) clearTimeout(overrideDebounceRef.current)
    }
  }, [overrideSearchInput])

  async function testConnection() {
    setTestingConnection(true)
    setConnectionTestResult(null)
    try {
      const result = await testEasySlipConnection()
      setConnectionTestResult(result)
    } catch (error: any) {
      setConnectionTestResult({
        success: false,
        message: `เกิดข้อผิดพลาด: ${error.message}`,
      })
    } finally {
      setTestingConnection(false)
    }
  }

  function handleImageSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) {
      setSelectedImage(file)
      // Create preview
      const reader = new FileReader()
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  async function testWithImage() {
    if (!selectedImage) {
      showMessage({ message: 'กรุณาเลือกไฟล์รูปสลิปก่อน' })
      return
    }

    setTestingWithImage(true)
    setTestImageResult(null)
    try {
      const result = await testEasySlipWithImage(selectedImage)
      setTestImageResult(result)
    } catch (error: any) {
      setTestImageResult({
        success: false,
        message: `เกิดข้อผิดพลาด: ${error.message}`,
        error: error.message,
      })
    } finally {
      setTestingWithImage(false)
    }
  }

  async function loadChannels() {
    try {
      const { data, error } = await supabase
        .from('channels')
        .select('channel_code, channel_name')
        .order('channel_code', { ascending: true })

      if (error) throw error
      setChannels(data || [])
    } catch (error: any) {
      console.error('Error loading channels:', error)
    }
  }

  async function loadUsers() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('us_users')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      setUsers(data || [])
    } catch (error: any) {
      console.error('Error loading users:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message })
    } finally {
      setLoading(false)
    }
  }

  async function updateUsername(userId: string, newUsername: string) {
    try {
      const { error } = await supabase
        .from('us_users')
        .update({ username: newUsername.trim() })
        .eq('id', userId)

      if (error) throw error
      showMessage({ title: 'สำเร็จ', message: 'อัปเดต Username สำเร็จ' })
      loadUsers()
    } catch (error: any) {
      console.error('Error updating username:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  async function updateUserRole(userId: string, newRole: string) {
    try {
      const { error } = await supabase
        .from('us_users')
        .update({ role: newRole })
        .eq('id', userId)

      if (error) throw error
      showMessage({ title: 'สำเร็จ', message: 'อัปเดตสิทธิ์สำเร็จ' })
      loadUsers()
    } catch (error: any) {
      console.error('Error updating user role:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  const MENU_ROLE_OPTIONS = [
    // ── Dashboard ──
    { key: 'dashboard', label: 'Dashboard', group: '' },
    // ── ออเดอร์ ──
    { key: 'orders', label: 'ออเดอร์', group: '' },
    { key: 'orders-create', label: 'สร้าง/แก้ไข', group: 'orders' },
    { key: 'orders-waiting', label: 'รอลงข้อมูล', group: 'orders' },
    { key: 'orders-data-error', label: 'ลงข้อมูลผิด', group: 'orders' },
    { key: 'orders-complete', label: 'ตรวจสอบไม่ผ่าน', group: 'orders' },
    { key: 'orders-verified', label: 'ตรวจสอบแล้ว', group: 'orders' },
    { key: 'orders-confirm', label: 'Confirm', group: 'orders' },
    { key: 'orders-work-orders', label: 'ใบสั่งงาน', group: 'orders' },
    { key: 'orders-work-orders-manage', label: 'จัดการใบงาน', group: 'orders' },
    { key: 'orders-shipped', label: 'จัดส่งแล้ว', group: 'orders' },
    { key: 'orders-cancelled', label: 'ยกเลิก', group: 'orders' },
    { key: 'orders-issue', label: 'Issue', group: 'orders' },
    // ── รอตรวจคำสั่งซื้อ ──
    { key: 'admin-qc', label: 'รอตรวจคำสั่งซื้อ', group: '' },
    // ── Plan ──
    { key: 'plan', label: 'Plan', group: '' },
    { key: 'plan-dash', label: 'Dashboard (Master Plan)', group: 'plan' },
    { key: 'plan-dept', label: 'หน้าแผนก (คิวงาน)', group: 'plan' },
    { key: 'plan-jobs', label: 'ใบงานทั้งหมด', group: 'plan' },
    { key: 'plan-form', label: 'สร้าง/แก้ไขใบงาน', group: 'plan' },
    { key: 'plan-set', label: 'ตั้งค่า', group: 'plan' },
    { key: 'plan-issue', label: 'Issue', group: 'plan' },
    // ── จัดสินค้า (WMS) ──
    { key: 'wms', label: 'จัดสินค้า', group: '' },
    { key: 'wms-new-orders', label: 'ใบงานใหม่', group: 'wms' },
    { key: 'wms-upload', label: 'รายการใบงาน', group: 'wms' },
    { key: 'wms-review', label: 'ตรวจสินค้า', group: 'wms' },
    { key: 'wms-kpi', label: 'KPI', group: 'wms' },
    { key: 'wms-requisition', label: 'รายการเบิก', group: 'wms' },
    { key: 'wms-notif', label: 'แจ้งเตือน', group: 'wms' },
    { key: 'wms-settings', label: 'ตั้งค่า', group: 'wms' },
    // ── QC ──
    { key: 'qc', label: 'QC', group: '' },
    { key: 'qc-operation', label: 'QC Operation', group: 'qc' },
    { key: 'qc-reject', label: 'Reject', group: 'qc' },
    { key: 'qc-report', label: 'Reports & KPI', group: 'qc' },
    { key: 'qc-history', label: 'History Check', group: 'qc' },
    { key: 'qc-settings', label: 'Settings', group: 'qc' },
    // ── จัดของ ──
    { key: 'packing', label: 'จัดของ', group: '' },
    { key: 'packing-new', label: 'ใบงานใหม่', group: 'packing' },
    { key: 'packing-shipped', label: 'จัดส่งแล้ว', group: 'packing' },
    { key: 'packing-queue', label: 'คิวอัปโหลด', group: 'packing' },
    // ── ทวนสอบขนส่ง ──
    { key: 'transport', label: 'ทวนสอบขนส่ง', group: '' },
    // ── บัญชี ──
    { key: 'account', label: 'บัญชี', group: '' },
    { key: 'account-dashboard', label: 'Dashboard', group: 'account' },
    { key: 'account-slip-verification', label: 'รายการการตรวจสลิป', group: 'account' },
    { key: 'account-manual-slip-check', label: 'ตรวจสลิปมือ', group: 'account' },
    { key: 'account-bill-edit', label: 'แก้ไขบิล', group: 'account' },
    { key: 'account-slip-age', label: 'อายุสลิป', group: 'account' },
    { key: 'account-refunds', label: 'รายการโอนคืน', group: 'account' },
    { key: 'account-tax-invoice', label: 'ขอใบกำกับภาษี', group: 'account' },
    { key: 'account-cash-bill', label: 'ขอบิลเงินสด', group: 'account' },
    { key: 'account-approvals', label: 'รายการอนุมัติ', group: 'account' },
    // ── สินค้า ──
    { key: 'products', label: 'สินค้า', group: '' },
    // ── ลายการ์ตูน ──
    { key: 'cartoon-patterns', label: 'ลายการ์ตูน', group: '' },
    // ── คลัง ──
    { key: 'warehouse', label: 'คลัง', group: '' },
    { key: 'warehouse-stock', label: 'คลังสินค้า', group: 'warehouse' },
    { key: 'warehouse-audit', label: 'Audit', group: 'warehouse' },
    { key: 'warehouse-adjust', label: 'ปรับสต๊อค', group: 'warehouse' },
    { key: 'warehouse-returns', label: 'รับสินค้าตีกลับ', group: 'warehouse' },
    // ── สั่งซื้อ ──
    { key: 'purchase', label: 'สั่งซื้อ', group: '' },
    { key: 'purchase-pr', label: 'PR (ใบขอซื้อ)', group: 'purchase' },
    { key: 'purchase-po', label: 'PO (ใบสั่งซื้อ)', group: 'purchase' },
    { key: 'purchase-gr', label: 'GR (ใบรับสินค้า)', group: 'purchase' },
    { key: 'purchase-sample', label: 'สินค้าตัวอย่าง', group: 'purchase' },
    // ── รายงานยอดขาย ──
    { key: 'sales-reports', label: 'รายงานยอดขาย', group: '' },
    // ── KPI ──
    { key: 'kpi', label: 'KPI', group: '' },
    // ── ตั้งค่า ──
    { key: 'settings', label: 'ตั้งค่า', group: '' },
    { key: 'settings-users', label: 'จัดการสิทธิ์ผู้ใช้', group: 'settings' },
    { key: 'settings-role-settings', label: 'ตั้งค่า Role', group: 'settings' },
    { key: 'settings-banks', label: 'ตั้งค่าข้อมูลธนาคาร', group: 'settings' },
    { key: 'settings-product-settings', label: 'ตั้งค่าสินค้า', group: 'settings' },
    { key: 'settings-sellers', label: 'ผู้ขาย', group: 'settings' },
    { key: 'settings-issue-types', label: 'ประเภท Issue', group: 'settings' },
    { key: 'settings-chat-history', label: 'ประวัติแชท', group: 'settings' },
    { key: 'settings-easyslip', label: 'API EasySlip', group: 'settings' },
  ] as const

  async function loadRoleMenus() {
    try {
      const { data, error } = await supabase
        .from('st_user_menus')
        .select('role, menu_key, has_access')
      if (error) throw error
      const map: Record<string, Record<string, boolean>> = {}
      settingsRoles.forEach((role) => {
        map[role] = {}
        MENU_ROLE_OPTIONS.forEach((menu) => {
          map[role][menu.key] = true
        })
      })
      ;(data || []).forEach((row: any) => {
        if (!map[row.role]) map[row.role] = {}
        map[row.role][row.menu_key] = row.has_access !== false
      })
      setRoleMenus(map)
    } catch (error: any) {
      console.error('Error loading role menus:', error)
    }
  }

  async function loadChatLogs() {
    setChatLoading(true)
    setSelectedChatBill(null)
    try {
      // Load Confirm Chat
      let confirmQuery = supabase
        .from('or_order_chat_logs')
        .select('*')
        .order('created_at', { ascending: false })
      if (chatFromDate) confirmQuery = confirmQuery.gte('created_at', `${chatFromDate}T00:00:00.000Z`)
      if (chatToDate) confirmQuery = confirmQuery.lte('created_at', `${chatToDate}T23:59:59.999Z`)
      const { data: confirmData, error: confirmError } = await confirmQuery.limit(500)
      if (confirmError) throw confirmError
      setChatLogs((confirmData || []) as OrderChatLog[])

      // Load Issue Chat (messages + issue info)
      let issueQuery = supabase
        .from('or_issue_messages')
        .select('*, or_issues!inner(id, title, order_id)')
        .order('created_at', { ascending: false })
      if (chatFromDate) issueQuery = issueQuery.gte('created_at', `${chatFromDate}T00:00:00.000Z`)
      if (chatToDate) issueQuery = issueQuery.lte('created_at', `${chatToDate}T23:59:59.999Z`)
      const { data: issueData, error: issueError } = await issueQuery.limit(500)
      if (issueError) throw issueError

      // ดึง order_id → bill_no mapping
      const orderIds = [...new Set((issueData || []).map((m: any) => m.or_issues?.order_id).filter(Boolean))]
      let billMap: Record<string, string> = {}
      if (orderIds.length > 0) {
        const { data: orders } = await supabase
          .from('or_orders')
          .select('id, bill_no')
          .in('id', orderIds)
        ;(orders || []).forEach((o: any) => { billMap[o.id] = o.bill_no })
      }

      const mapped = (issueData || []).map((m: any) => ({
        id: m.id,
        order_id: m.or_issues?.order_id || '',
        bill_no: billMap[m.or_issues?.order_id] || m.or_issues?.title || 'N/A',
        sender_id: m.sender_id,
        sender_name: m.sender_name,
        message: m.message,
        created_at: m.created_at,
        _source: 'issue' as const,
        _issueTitle: m.or_issues?.title,
      }))
      setIssueChatLogs(mapped)
    } catch (error: any) {
      console.error('Error loading chat logs:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการโหลดประวัติแชท: ' + error.message })
    } finally {
      setChatLoading(false)
    }
  }

  async function deleteChatLog(id: string) {
    const ok = await showConfirm({ title: 'ลบข้อความ', message: 'ต้องการลบข้อความนี้หรือไม่?' })
    if (!ok) return
    try {
      const { error } = await supabase
        .from('or_order_chat_logs')
        .delete()
        .eq('id', id)
      if (error) throw error
      setChatLogs((prev) => prev.filter((log) => log.id !== id))
    } catch (error: any) {
      console.error('Error deleting chat log:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการลบ: ' + error.message })
    }
  }

  async function deleteChatLogsByBill(billNo: string) {
    const ok = await showConfirm({ title: 'ลบแชททั้งบิล', message: `ต้องการลบข้อความทั้งหมดของบิล ${billNo} หรือไม่?\n(เฉพาะ Confirm Chat เท่านั้น)` })
    if (!ok) return
    try {
      const { error } = await supabase
        .from('or_order_chat_logs')
        .delete()
        .eq('bill_no', billNo)
      if (error) throw error
      setChatLogs((prev) => prev.filter((log) => log.bill_no !== billNo))
      setSelectedChatBill(null)
    } catch (error: any) {
      console.error('Error deleting chat logs by bill:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการลบ: ' + error.message })
    }
  }

  async function loadIssueTypes() {
    try {
      const { data, error } = await supabase
        .from('or_issue_types')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      setIssueTypes((data || []) as IssueType[])
    } catch (error: any) {
      console.error('Error loading issue types:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการโหลดประเภท Issue: ' + error.message })
    }
  }

  async function saveIssueType() {
    if (!issueTypeName.trim()) {
      showMessage({ message: 'กรุณากรอกชื่อประเภท' })
      return
    }
    setIssueTypeSaving(true)
    try {
      const payload = {
        name: issueTypeName.trim(),
        color: issueTypeColor || '#3B82F6',
        is_active: true,
      }
      if (issueTypeEditingId) {
        const { error } = await supabase
          .from('or_issue_types')
          .update(payload)
          .eq('id', issueTypeEditingId)
        if (error) throw error
      } else {
        const { error } = await supabase.from('or_issue_types').insert(payload)
        if (error) throw error
      }
      setIssueTypeName('')
      setIssueTypeColor('#3B82F6')
      setIssueTypeEditingId(null)
      loadIssueTypes()
    } catch (error: any) {
      console.error('Error saving issue type:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setIssueTypeSaving(false)
    }
  }

  async function deleteIssueType(id: string) {
    const ok = await showConfirm({ title: 'ลบประเภท Issue', message: 'ต้องการลบประเภท Issue นี้หรือไม่?' })
    if (!ok) return
    try {
      const { error } = await supabase
        .from('or_issue_types')
        .delete()
        .eq('id', id)
      if (error) throw error
      setIssueTypes((prev) => prev.filter((t) => t.id !== id))
    } catch (error: any) {
      console.error('Error deleting issue type:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  // ===== Sellers CRUD =====
  async function loadSellers() {
    try {
      const { data, error } = await supabase
        .from('pr_sellers')
        .select('*')
        .eq('is_active', true)
        .order('name')
      if (error) throw error
      setSellers(data || [])
    } catch (error: any) {
      console.error('Error loading sellers:', error)
    }
  }

  async function saveSeller() {
    if (!sellerName.trim()) {
      showMessage({ message: 'กรุณากรอกชื่อผู้ขาย' })
      return
    }
    setSellerSaving(true)
    try {
      const payload = {
        name: sellerName.trim(),
        name_cn: sellerNameCn.trim(),
        purchase_channel: sellerPurchaseChannel.trim(),
      }
      if (sellerEditingId) {
        const { error } = await supabase
          .from('pr_sellers')
          .update(payload)
          .eq('id', sellerEditingId)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('pr_sellers')
          .insert(payload)
        if (error) throw error
      }
      setSellerName('')
      setSellerNameCn('')
      setSellerPurchaseChannel('')
      setSellerEditingId(null)
      loadSellers()
    } catch (error: any) {
      console.error('Error saving seller:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setSellerSaving(false)
    }
  }

  async function deleteSeller(id: string) {
    const ok = await showConfirm({ title: 'ลบผู้ขาย', message: 'ต้องการลบผู้ขายนี้หรือไม่?' })
    if (!ok) return
    try {
      const { error } = await supabase
        .from('pr_sellers')
        .update({ is_active: false })
        .eq('id', id)
      if (error) throw error
      setSellers((prev) => prev.filter((s) => s.id !== id))
    } catch (error: any) {
      console.error('Error deleting seller:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  async function toggleRoleMenu(role: string, menuKey: string, checked: boolean) {
    setRoleMenus((prev) => {
      const updated = {
        ...prev,
        [role]: {
          ...(prev[role] || {}),
          [menuKey]: checked,
        },
      }
      // ถ้าปิดเมนูหลัก → ปิดเมนูย่อยด้วย
      if (!checked) {
        MENU_ROLE_OPTIONS.forEach((m) => {
          if (m.group === menuKey) {
            updated[role][m.key] = false
          }
        })
      }
      // ถ้าเปิดเมนูย่อย → เปิดเมนูหลักด้วย
      const menu = MENU_ROLE_OPTIONS.find((m) => m.key === menuKey)
      if (checked && menu && menu.group) {
        updated[role][menu.group] = true
      }
      return updated
    })
  }

  async function saveRoleMenus() {
    setSavingRoleMenus(true)
    try {
      const payload: Array<{ role: string; menu_key: string; menu_name: string; has_access: boolean }> = []
      Object.entries(roleMenus).forEach(([role, menus]) => {
        MENU_ROLE_OPTIONS.forEach((menu) => {
          payload.push({
            role,
            menu_key: menu.key,
            menu_name: menu.label,
            has_access: menus?.[menu.key] ?? false,
          })
        })
      })
      const { error } = await supabase.from('st_user_menus').upsert(payload, { onConflict: 'role,menu_key' })
      if (error) throw error
      refreshMenuAccess()
      showMessage({ title: 'สำเร็จ', message: 'บันทึกการตั้งค่า Role สำเร็จ' })
    } catch (error: any) {
      console.error('Error saving role menus:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    } finally {
      setSavingRoleMenus(false)
    }
  }

  async function loadBankSettings() {
    try {
      // Load bank settings
      const { data: bankData, error: bankError } = await supabase
        .from('bank_settings')
        .select('*')
        .order('created_at', { ascending: false })

      if (bankError) throw bankError

      if (!bankData || bankData.length === 0) {
        setBankSettings([])
        return
      }

      // Load all bank_settings_channels
      const { data: channelsData, error: channelsError } = await supabase
        .from('bank_settings_channels')
        .select('bank_setting_id, channel_code')

      if (channelsError) {
        console.error('Error loading bank settings channels:', channelsError)
        // Continue without channels if error
      }

      // Load all channels for mapping
      const { data: allChannels, error: allChannelsError } = await supabase
        .from('channels')
        .select('channel_code, channel_name')

      if (allChannelsError) {
        console.error('Error loading channels:', allChannelsError)
      }

      // Create channel map
      const channelMap = new Map(
        (allChannels || []).map((ch: any) => [ch.channel_code, ch.channel_name])
      )

      // Transform data to include channels array
      const transformedData = bankData.map((bank: any) => {
        // Find channels for this bank
        const bankChannels = (channelsData || [])
          .filter((bsc: any) => bsc.bank_setting_id === bank.id)
          .map((bsc: any) => ({
            channel_code: bsc.channel_code,
            channel_name: channelMap.get(bsc.channel_code) || bsc.channel_code,
          }))

        return {
          ...bank,
          channels: bankChannels,
        }
      })

      setBankSettings(transformedData)
    } catch (error: any) {
      console.error('Error loading bank settings:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message })
    }
  }

  async function loadProductCategories() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('product_category')
        .eq('is_active', true)
        .not('product_category', 'is', null)

      if (error) throw error
      const categories = Array.from(
        new Set(
          (data || [])
            .map((r: { product_category: string | null }) => r.product_category)
            .filter((c): c is string => !!c && String(c).trim() !== '')
        )
      ).sort((a, b) => a.localeCompare(b))
      setProductCategories(categories)
    } catch (error: any) {
      console.error('Error loading product categories:', error)
      setProductCategories([])
    }
  }

  async function loadCategoryFieldSettings() {
    try {
      const { data, error } = await supabase
        .from('pr_category_field_settings')
        .select('*')

      if (error) throw error
      const map: Record<string, Record<ProductFieldKey, boolean>> = {}
      ;(data || []).forEach((row: any) => {
        map[row.category] = {
          product_name: row.product_name ?? true,
          ink_color: row.ink_color ?? true,
          layer: row.layer ?? true,
          cartoon_pattern: row.cartoon_pattern ?? true,
          line_pattern: row.line_pattern ?? true,
          font: row.font ?? true,
          line_1: row.line_1 ?? true,
          line_2: row.line_2 ?? true,
          line_3: row.line_3 ?? true,
          quantity: row.quantity ?? true,
          unit_price: row.unit_price ?? true,
          notes: row.notes ?? true,
          attachment: row.attachment ?? true,
        }
      })
      setCategoryFieldSettings(map)
    } catch (error: any) {
      console.error('Error loading category field settings:', error)
      setCategoryFieldSettings({})
    }
  }

  function getCategoryFields(category: string): Record<ProductFieldKey, boolean> {
    return categoryFieldSettings[category]
      ? { ...categoryFieldSettings[category] }
      : { ...defaultCategoryFields }
  }

  function setCategoryField(category: string, field: ProductFieldKey, value: boolean) {
    setCategoryFieldSettings((prev) => ({
      ...prev,
      [category]: { ...getCategoryFields(category), [field]: value },
    }))
  }

  async function saveCategoryFieldSettings() {
    setSavingProductSettings(true)
    try {
      for (const category of productCategories) {
        const fields = getCategoryFields(category)
        await supabase.from('pr_category_field_settings').upsert(
          {
            category,
            product_name: fields.product_name,
            ink_color: fields.ink_color,
            layer: fields.layer,
            cartoon_pattern: fields.cartoon_pattern,
            line_pattern: fields.line_pattern,
            font: fields.font,
            line_1: fields.line_1,
            line_2: fields.line_2,
            line_3: fields.line_3,
            quantity: fields.quantity,
            unit_price: fields.unit_price,
            notes: fields.notes,
            attachment: fields.attachment,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'category' }
        )
      }
      showMessage({ title: 'สำเร็จ', message: 'บันทึกตั้งค่าสินค้าสำเร็จ' })
    } catch (error: any) {
      console.error('Error saving category field settings:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการบันทึก: ' + error.message })
    } finally {
      setSavingProductSettings(false)
    }
  }

  // --- Product-level field overrides ---
  async function loadAllProducts() {
    try {
      const { data, error } = await supabase
        .from('pr_products')
        .select('id, product_name, product_code, product_category')
        .eq('is_active', true)
        .eq('product_type', 'FG')
        .order('product_name')
      if (error) throw error
      setAllProducts(data || [])
    } catch (error: any) {
      console.error('Error loading products for overrides:', error)
      setAllProducts([])
    }
  }

  async function loadProductOverrides() {
    try {
      const { data, error } = await supabase.from('pr_product_field_overrides').select('*')
      if (error) throw error
      const map: Record<string, Record<ProductFieldKey, boolean | null>> = {}
      ;(data || []).forEach((row: any) => {
        const pid = row.product_id
        if (!pid) return
        const entry: Record<string, boolean | null> = {}
        for (const { key } of PRODUCT_FIELD_KEYS) {
          entry[key] = row[key] ?? null
        }
        map[pid] = entry as Record<ProductFieldKey, boolean | null>
      })
      setProductOverrides(map)
    } catch (error: any) {
      console.error('Error loading product overrides:', error)
      setProductOverrides({})
    }
  }

  function getProductOverrideFields(productId: string): Record<ProductFieldKey, boolean | null> {
    if (productOverrides[productId]) return { ...productOverrides[productId] }
    const empty: Record<string, boolean | null> = {}
    for (const { key } of PRODUCT_FIELD_KEYS) empty[key] = null
    return empty as Record<ProductFieldKey, boolean | null>
  }

  function setProductOverrideField(productId: string, field: ProductFieldKey, value: boolean | null) {
    setProductOverrides((prev) => ({
      ...prev,
      [productId]: { ...getProductOverrideFields(productId), [field]: value },
    }))
  }

  /** ตรวจว่าสินค้านี้มี override ที่แตกต่างจาก null (ต้องบันทึก) */
  function productHasOverrides(productId: string): boolean {
    const fields = productOverrides[productId]
    if (!fields) return false
    return Object.values(fields).some((v) => v !== null)
  }

  const OVERRIDE_PAGE_SIZE = 50

  /** สินค้าที่กรองตามการค้นหาและหมวดหมู่ (memoized) */
  const filteredOverrideProducts = useMemo(() => {
    let list = allProducts
    if (overrideCategoryFilter) {
      list = list.filter((p) => (p.product_category || '') === overrideCategoryFilter)
    }
    if (overrideSearchTerm) {
      const term = overrideSearchTerm.toLowerCase()
      list = list.filter(
        (p) =>
          (p.product_name || '').toLowerCase().includes(term) ||
          (p.product_code || '').toLowerCase().includes(term)
      )
    }
    return list
  }, [allProducts, overrideCategoryFilter, overrideSearchTerm])

  const overrideTotalPages = Math.ceil(filteredOverrideProducts.length / OVERRIDE_PAGE_SIZE)
  const paginatedOverrideProducts = useMemo(() => {
    const start = (overridePage - 1) * OVERRIDE_PAGE_SIZE
    return filteredOverrideProducts.slice(start, start + OVERRIDE_PAGE_SIZE)
  }, [filteredOverrideProducts, overridePage])

  async function saveProductOverrides() {
    setSavingProductOverrides(true)
    try {
      const productsWithOverrides = allProducts.filter((p) => productHasOverrides(p.id))
      const productsWithoutOverrides = allProducts.filter((p) => !productHasOverrides(p.id))

      for (const product of productsWithOverrides) {
        const fields = getProductOverrideFields(product.id)
        await supabase.from('pr_product_field_overrides').upsert(
          {
            product_id: product.id,
            ink_color: fields.ink_color,
            layer: fields.layer,
            cartoon_pattern: fields.cartoon_pattern,
            line_pattern: fields.line_pattern,
            font: fields.font,
            line_1: fields.line_1,
            line_2: fields.line_2,
            line_3: fields.line_3,
            quantity: fields.quantity,
            unit_price: fields.unit_price,
            notes: fields.notes,
            attachment: fields.attachment,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'product_id' }
        )
      }

      if (productsWithoutOverrides.length > 0) {
        const idsToDelete = productsWithoutOverrides
          .filter((p) => p.id in productOverrides)
          .map((p) => p.id)
        if (idsToDelete.length > 0) {
          await supabase.from('pr_product_field_overrides').delete().in('product_id', idsToDelete)
        }
      }

      showMessage({ title: 'สำเร็จ', message: 'บันทึกตั้งค่า override ระดับสินค้าสำเร็จ' })
    } catch (error: any) {
      console.error('Error saving product overrides:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาดในการบันทึก: ' + error.message })
    } finally {
      setSavingProductOverrides(false)
    }
  }

  async function openBankForm(bank?: BankSetting) {
    if (bank) {
      setEditingBank(bank)
      
      // Load channels for this bank
      const { data: channelsData, error } = await supabase
        .from('bank_settings_channels')
        .select('channel_code')
        .eq('bank_setting_id', bank.id)
      
      const selectedChannels = error ? [] : (channelsData || []).map(c => c.channel_code)
      
      setBankFormData({
        account_number: bank.account_number,
        bank_code: bank.bank_code,
        bank_name: bank.bank_name || '',
        account_name: bank.account_name || '',
        is_active: bank.is_active,
        selectedChannels,
      })
    } else {
      setEditingBank(null)
      setBankFormData({
        account_number: '',
        bank_code: '',
        bank_name: '',
        account_name: '',
        is_active: true,
        selectedChannels: [],
      })
    }
    setShowBankForm(true)
  }

  function closeBankForm() {
    setShowBankForm(false)
    setEditingBank(null)
    setBankFormData({
      account_number: '',
      bank_code: '',
      bank_name: '',
      account_name: '',
      is_active: true,
      selectedChannels: [],
    })
  }

  async function saveBankSetting() {
    try {
      if (!bankFormData.account_number || !bankFormData.bank_code) {
        showMessage({ message: 'กรุณากรอกเลขบัญชีและรหัสธนาคาร' })
        return
      }

      if (bankFormData.selectedChannels.length === 0) {
        showMessage({ message: 'กรุณาเลือกช่องทางการขายอย่างน้อย 1 ช่องทาง' })
        return
      }

      // Find bank name from BANK_CODES
      const bankInfo = BANK_CODES.find(b => b.code === bankFormData.bank_code)
      const bankName = bankInfo?.name || bankFormData.bank_name

      let bankSettingId: string

      // Prepare update/insert data
      const bankData: any = {
        account_number: bankFormData.account_number,
        bank_code: bankFormData.bank_code,
        bank_name: bankName,
        is_active: bankFormData.is_active,
      }

      // Only include account_name if migration has been run
      // Try to include it, but if column doesn't exist, it will be ignored
      if (bankFormData.account_name) {
        bankData.account_name = bankFormData.account_name
      }

      if (editingBank) {
        // Update existing
        bankData.updated_at = new Date().toISOString()
        const { error } = await supabase
          .from('bank_settings')
          .update(bankData)
          .eq('id', editingBank.id)

        if (error) {
          // If error is about account_name column, try without it
          if (error.message.includes('account_name')) {
            delete bankData.account_name
            const { error: retryError } = await supabase
              .from('bank_settings')
              .update(bankData)
              .eq('id', editingBank.id)
            if (retryError) throw retryError
          } else {
            throw error
          }
        }
        bankSettingId = editingBank.id
        
        // Delete old channels
        const { error: deleteError } = await supabase
          .from('bank_settings_channels')
          .delete()
          .eq('bank_setting_id', bankSettingId)

        if (deleteError) {
          // If table doesn't exist yet, that's okay
          if (!deleteError.message.includes('does not exist')) {
            throw deleteError
          }
        }
        showMessage({ title: 'สำเร็จ', message: 'อัปเดตข้อมูลธนาคารสำเร็จ' })
      } else {
        // Insert new
        const { data, error } = await supabase
          .from('bank_settings')
          .insert(bankData)
          .select()
          .single()

        if (error) {
          // If error is about account_name column, try without it
          if (error.message.includes('account_name')) {
            delete bankData.account_name
            const { data: retryData, error: retryError } = await supabase
              .from('bank_settings')
              .insert(bankData)
              .select()
              .single()
            if (retryError) throw retryError
            bankSettingId = retryData.id
          } else {
            throw error
          }
        } else {
          bankSettingId = data.id
        }
        showMessage({ title: 'สำเร็จ', message: 'เพิ่มข้อมูลธนาคารสำเร็จ' })
      }

      // Insert channels
      if (bankFormData.selectedChannels.length > 0) {
        const channelsToInsert = bankFormData.selectedChannels.map(channelCode => ({
          bank_setting_id: bankSettingId,
          channel_code: channelCode,
        }))

        const { error: channelsError } = await supabase
          .from('bank_settings_channels')
          .insert(channelsToInsert)

        if (channelsError) {
          // If table doesn't exist yet, show warning but don't fail
          if (channelsError.message.includes('does not exist')) {
            showMessage({ title: 'คำเตือน', message: 'เพิ่มข้อมูลธนาคารสำเร็จ แต่ไม่สามารถบันทึกช่องทางการขายได้ กรุณารัน migration 008_update_bank_settings.sql' })
          } else {
            throw channelsError
          }
        }
      }

      closeBankForm()
      loadBankSettings()
    } catch (error: any) {
      console.error('Error saving bank setting:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  async function deleteBankSetting(id: string) {
    const ok = await showConfirm({ title: 'ลบข้อมูลธนาคาร', message: 'ต้องการลบข้อมูลธนาคารนี้หรือไม่?' })
    if (!ok) return

    try {
      const { error } = await supabase
        .from('bank_settings')
        .delete()
        .eq('id', id)

      if (error) throw error
      showMessage({ title: 'สำเร็จ', message: 'ลบข้อมูลธนาคารสำเร็จ' })
      loadBankSettings()
    } catch (error: any) {
      console.error('Error deleting bank setting:', error)
      showMessage({ title: 'ผิดพลาด', message: 'เกิดข้อผิดพลาด: ' + error.message })
    }
  }

  // @ts-ignore TS6133 - kept for future use
  async function fixOrderStatuses() {
    const ok = await showConfirm({ title: 'แก้ไขสถานะบิล', message: 'ต้องการตรวจสอบและแก้ไขสถานะบิลทั้งหมดให้ถูกต้องตามข้อมูลในตารางหรือไม่?\n\nการดำเนินการนี้อาจใช้เวลาสักครู่' })
    if (!ok) return

    setFixingStatus(true)
    setStatusFixResult(null)

    try {
      // 1. โหลดบิลทั้งหมดที่มี slip verification records
      const { data: verifiedSlips, error: slipsError } = await supabase
        .from('ac_verified_slips')
        .select('order_id, validation_status, validation_errors, account_name_match, bank_code_match, amount_match')
        .not('validation_status', 'is', null)

      if (slipsError) throw slipsError

      // 2. จัดกลุ่มตาม order_id
      const orderVerificationMap = new Map<string, {
        hasPassed: boolean
        hasFailed: boolean
        hasErrors: boolean
        errors: string[]
      }>()

      verifiedSlips?.forEach((slip: any) => {
        if (!orderVerificationMap.has(slip.order_id)) {
          orderVerificationMap.set(slip.order_id, {
            hasPassed: false,
            hasFailed: false,
            hasErrors: false,
            errors: [],
          })
        }

        const status = orderVerificationMap.get(slip.order_id)!
        if (slip.validation_status === 'passed') {
          status.hasPassed = true
        } else if (slip.validation_status === 'failed') {
          status.hasFailed = true
        }

        if (slip.validation_errors && Array.isArray(slip.validation_errors) && slip.validation_errors.length > 0) {
          status.hasErrors = true
          status.errors.push(...slip.validation_errors)
        }
      })

      // 3. โหลดบิลทั้งหมด
      const { data: allOrders, error: ordersError } = await supabase
        .from('or_orders')
        .select('id, bill_no, status, total_amount')

      if (ordersError) throw ordersError

      // 4. ตรวจสอบและแก้ไขสถานะ
      const updates: Array<{ id: string; bill_no: string; currentStatus: string; newStatus: string; reason: string }> = []
      const errors: string[] = []

      for (const order of allOrders || []) {
        const verification = orderVerificationMap.get(order.id)
        
        // ถ้ามี slip verification records
        if (verification) {
          let expectedStatus: string | null = null
          let reason = ''

          // ตรวจสอบสถานะที่ควรเป็น
          if (verification.hasPassed && !verification.hasErrors && !verification.hasFailed) {
            // ทุก slip ผ่าน validation → ควรเป็น "ตรวจสอบแล้ว"
            expectedStatus = 'ตรวจสอบแล้ว'
            reason = 'ทุกสลิปผ่านการตรวจสอบ'
          } else if (verification.hasFailed || verification.hasErrors) {
            // มี slip ที่ไม่ผ่าน → ควรเป็น "ตรวจสอบไม่ผ่าน"
            expectedStatus = 'ตรวจสอบไม่ผ่าน'
            reason = `พบข้อผิดพลาด: ${verification.errors.slice(0, 3).join(', ')}${verification.errors.length > 3 ? '...' : ''}`
          }

          // ถ้าสถานะไม่ตรงกับที่ควรเป็น
          if (expectedStatus && order.status !== expectedStatus) {
            // ตรวจสอบว่าบิลอยู่ในสถานะที่เกี่ยวข้องหรือไม่ (ไม่ใช่สถานะอื่นๆ เช่น "ยกเลิก", "จัดส่งแล้ว")
            const irrelevantStatuses = ['ยกเลิก', 'จัดส่งแล้ว', 'ใบงานกำลังผลิต']
            if (!irrelevantStatuses.includes(order.status)) {
              updates.push({
                id: order.id,
                bill_no: order.bill_no,
                currentStatus: order.status,
                newStatus: expectedStatus,
                reason,
              })
            }
          }
        } else {
          // ถ้าไม่มี slip verification records แต่สถานะเป็น "ตรวจสอบแล้ว" หรือ "ตรวจสอบไม่ผ่าน"
          // อาจเป็นบิลที่ถูกย้ายไปแล้วแต่ยังไม่มี slip records
          // ไม่ต้องแก้ไขในกรณีนี้ เพราะอาจเป็นบิลที่ยังไม่ได้ตรวจสอบสลิป
        }
      }

      // 5. อัพเดตสถานะ
      let successCount = 0
      let errorCount = 0

      for (const update of updates) {
        try {
          const { error: updateError } = await supabase
            .from('or_orders')
            .update({ status: update.newStatus })
            .eq('id', update.id)

          if (updateError) {
            errors.push(`บิล ${update.bill_no}: ${updateError.message}`)
            errorCount++
          } else {
            successCount++
          }
        } catch (error: any) {
          errors.push(`บิล ${update.bill_no}: ${error.message}`)
          errorCount++
        }
      }

      setStatusFixResult({
        success: errorCount === 0,
        message: `แก้ไขสถานะสำเร็จ ${successCount} รายการ${errorCount > 0 ? `, เกิดข้อผิดพลาด ${errorCount} รายการ` : ''}`,
        details: {
          totalChecked: allOrders?.length || 0,
          needsUpdate: updates.length,
          successCount,
          errorCount,
          updates: updates.slice(0, 20), // แสดง 20 รายการแรก
          errors: errors.slice(0, 10), // แสดง 10 errors แรก
        },
      })
    } catch (error: any) {
      console.error('Error fixing order statuses:', error)
      setStatusFixResult({
        success: false,
        message: `เกิดข้อผิดพลาด: ${error.message}`,
        details: { error: error.message },
      })
    } finally {
      setFixingStatus(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  // Role ทั้งหมด — ใช้ใน dropdown จัดการสิทธิ์ผู้ใช้
  const allRoles = [
    'superadmin',
    'admin',
    'admin-tr',
    'admin_qc',
    'admin-pump',
    'qc_staff',
    'packing_staff',
    'account',
    'store',
    'production',
    'production_mb',
    'manager',
    'picker',
    'auditor',
  ]
  const settingsRoles = [
    'superadmin',
    'admin',
    'admin-tr',
    'admin_qc',
    'admin-pump',
    'qc_staff',
    'packing_staff',
    'account',
    'store',
    'production',
  ]

  return (
    <div className="space-y-6">
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {SETTINGS_TABS.filter((tab) => hasAccess(`settings-${tab.key}`)).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`py-3 px-3 sm:px-4 rounded-t-xl border-b-2 font-semibold text-base whitespace-nowrap flex-shrink-0 transition-colors ${
                  activeTab === tab.key
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-blue-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* API EasySlip Tab */}
      {activeTab === 'easyslip' && hasAccess('settings-easyslip') && (
        <div className="space-y-6">
          {/* Test EasySlip Connection Section */}
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold mb-1">ทดสอบการเชื่อมต่อ EasySlip API</h2>
                <p className="text-sm text-gray-600">ตรวจสอบว่า Edge Function และ EasySlip API ทำงานได้ปกติ</p>
              </div>
              <button
                onClick={testConnection}
                disabled={testingConnection}
                className={`px-4 py-2 rounded-xl font-semibold ${
                  testingConnection
                    ? 'bg-gray-400 text-white cursor-not-allowed'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                {testingConnection ? 'กำลังทดสอบ...' : 'ทดสอบการเชื่อมต่อ'}
              </button>
            </div>
            
            {connectionTestResult && (
              <div className={`mt-4 p-4 rounded-lg ${
                connectionTestResult.success
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
              }`}>
                <div className={`font-semibold mb-2 ${
                  connectionTestResult.success ? 'text-green-800' : 'text-red-800'
                }`}>
                  {connectionTestResult.success ? '✅' : '❌'} {connectionTestResult.message}
                </div>
                {connectionTestResult.details && (
                  <div className="mt-2 text-sm text-gray-700 space-y-1">
                    <div>Edge Function: {connectionTestResult.details.edgeFunctionReachable ? '✅ เข้าถึงได้' : '❌ ไม่สามารถเข้าถึงได้'}</div>
                    <div>Secrets ตั้งค่าแล้ว: {connectionTestResult.details.secretsConfigured ? '✅ ตั้งค่าแล้ว' : '❌ ยังไม่ได้ตั้งค่า'}</div>
                    <div>EasySlip API: {connectionTestResult.details.easyslipApiReachable ? '✅ เชื่อมต่อได้' : '❌ ไม่สามารถเชื่อมต่อได้'}</div>
                    {connectionTestResult.details.error && (
                      <div className="mt-2 p-3 bg-red-100 rounded border border-red-300">
                        <div className="text-red-800 font-semibold mb-1">Error Details:</div>
                        <div className="text-red-700 text-sm whitespace-pre-line">{connectionTestResult.details.error}</div>
                        {connectionTestResult.details.error.includes('404') && (
                          <div className="mt-2 text-xs text-red-600">
                            <strong>หมายเหตุ:</strong> Error 404 จาก EasySlip API อาจเกิดจาก:
                            <ul className="list-disc list-inside mt-1">
                              <li>API endpoint ไม่ถูกต้อง</li>
                              <li>Test payload ไม่ถูกต้อง (ใช้ 'test' แทน base64 image จริง)</li>
                              <li>EasySlip service ยังไม่ได้เปิดใช้งาน</li>
                            </ul>
                            <div className="mt-2">
                              <strong>แนะนำ:</strong> ลองทดสอบด้วยรูปภาพจริงในส่วน "ทดสอบการตรวจสอบสลิปด้วยรูปภาพจริง" ด้านล่าง
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {!connectionTestResult.success && connectionTestResult.details.easyslipApiReachable === false && (
                      <div className="mt-3 p-3 bg-yellow-50 rounded border border-yellow-200">
                        <div className="text-yellow-800 font-semibold mb-2">วิธีแก้ไข:</div>
                        <ul className="text-yellow-700 text-sm space-y-1 list-disc list-inside">
                          <li>ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว (ไปที่ https://developer.easyslip.com)</li>
                          <li>ตรวจสอบว่า EASYSLIP_API_KEY ถูกต้อง (ใน Supabase Dashboard → Settings → Edge Functions → Secrets)</li>
                          <li>ตรวจสอบ Logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs</li>
                          <li>ตรวจสอบว่า Package/Plan ยังใช้งานได้</li>
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Test with Image Section */}
          <div className="bg-white p-4 rounded-lg shadow">
            <div>
              <h2 className="text-lg font-semibold mb-1">ทดสอบการตรวจสอบสลิปด้วยรูปภาพจริง</h2>
              <p className="text-sm text-gray-600 mb-4">อัปโหลดรูปสลิปเพื่อทดสอบการตรวจสอบจริง</p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  เลือกรูปสลิป
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
                {imagePreview && (
                  <div className="mt-4">
                    <p className="text-sm text-gray-600 mb-2">ตัวอย่างรูป:</p>
                    <img
                      src={imagePreview}
                      alt="Preview"
                      className="max-w-xs border border-gray-300 rounded-lg"
                    />
                  </div>
                )}
              </div>

              <button
                onClick={testWithImage}
                disabled={testingWithImage || !selectedImage}
                className={`px-4 py-2 rounded-xl font-semibold ${
                  testingWithImage || !selectedImage
                    ? 'bg-gray-400 text-white cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                {testingWithImage ? 'กำลังทดสอบ...' : 'ทดสอบการตรวจสอบสลิป'}
              </button>

              {testImageResult && (
                <div className={`mt-4 p-4 rounded-lg ${
                  testImageResult.success
                    ? 'bg-green-50 border border-green-200'
                    : 'bg-red-50 border border-red-200'
                }`}>
                  <div className={`font-semibold mb-2 ${
                    testImageResult.success ? 'text-green-800' : 'text-red-800'
                  }`}>
                    {testImageResult.success ? '✅' : '❌'} {testImageResult.message}
                  </div>
                  
                  {testImageResult.success && testImageResult.data && (
                    <div className="mt-3 text-sm text-gray-700 space-y-2">
                      {testImageResult.amount !== undefined && (
                        <div className="font-semibold text-lg text-green-700">
                          ยอดเงิน: {testImageResult.amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท
                        </div>
                      )}
                      {testImageResult.transRef && (
                        <div>เลขที่อ้างอิง: {testImageResult.transRef}</div>
                      )}
                      {testImageResult.date && (
                        <div>วันที่: {new Date(testImageResult.date).toLocaleString('th-TH')}</div>
                      )}
                      {testImageResult.receiverBank && (
                        <div>
                          ธนาคารผู้รับ: {testImageResult.receiverBank.name || testImageResult.receiverBank.short} 
                          {testImageResult.receiverBank.id && ` (${testImageResult.receiverBank.id})`}
                        </div>
                      )}
                      {testImageResult.receiverAccount?.bank?.account && (
                        <div>เลขบัญชีผู้รับ: {testImageResult.receiverAccount.bank.account}</div>
                      )}
                      {testImageResult.receiverAccount?.name?.th && (
                        <div>ชื่อผู้รับ: {testImageResult.receiverAccount.name.th}</div>
                      )}
                    </div>
                  )}

                  {testImageResult.error && (
                    <div className="mt-2 p-3 bg-red-100 rounded border border-red-300">
                      <div className="text-red-800 font-semibold mb-1">Error Details:</div>
                      <div className="text-red-700 text-sm whitespace-pre-line">{testImageResult.error}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Users Tab */}
      {activeTab === 'users' && hasAccess('settings-users') && (() => {
        const filteredUsers = userRoleFilter === 'all'
          ? users
          : users.filter((u) => u.role === userRoleFilter)
        return (
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">ผู้ใช้ทั้งหมด</h2>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-600">กรอง Role:</label>
              <select
                value={userRoleFilter}
                onChange={(e) => setUserRoleFilter(e.target.value)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">ทั้งหมด ({users.length})</option>
                {allRoles.map((role) => {
                  const count = users.filter((u) => u.role === role).length
                  return (
                    <option key={role} value={role}>
                      {role} ({count})
                    </option>
                  )
                })}
              </select>
              {userRoleFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setUserRoleFilter('all')}
                  className="text-xs text-gray-500 hover:text-red-500 px-2 py-1 rounded hover:bg-gray-100"
                  title="ล้างตัวกรอง"
                >
                  ✕
                </button>
              )}
              <span className="text-sm text-gray-400 ml-1">
                {filteredUsers.length} รายการ
              </span>
            </div>
          </div>
        {filteredUsers.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลผู้ใช้
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">อีเมล</th>
                  <th className="p-3 text-left font-semibold">Username</th>
                  <th className="p-3 text-left font-semibold">Role</th>
                  <th className="p-3 text-left font-semibold rounded-tr-xl"></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user, idx) => (
                  <tr key={user.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3">{user.email || '-'}</td>
                    <td className="p-3">
                      <input
                        type="text"
                        defaultValue={user.username || ''}
                        placeholder="-"
                        onBlur={(e) => {
                          const newVal = e.target.value.trim()
                          if (newVal !== (user.username || '')) {
                            updateUsername(user.id, newVal)
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                        className="px-3 py-1 border border-gray-300 rounded w-full max-w-[200px] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                      />
                    </td>
                    <td className="p-3">
                      <select
                        value={user.role}
                        onChange={(e) => updateUserRole(user.id, e.target.value)}
                        className="px-3 py-1 border rounded"
                      >
                        {allRoles.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3"></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
        )
      })()}

      {activeTab === 'role-settings' && hasAccess('settings-role-settings') && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">ตั้งค่า Role</h2>
            <button
              onClick={saveRoleMenus}
              disabled={savingRoleMenus}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            >
              {savingRoleMenus ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          <div className="overflow-x-auto" style={{ maxHeight: '75vh' }}>
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10">
                <tr className="bg-blue-600 text-white">
                  <th className="p-2 text-left font-semibold rounded-tl-xl sticky left-0 z-20 bg-blue-600 min-w-[180px]">เมนู</th>
                  {settingsRoles.map((role, i) => (
                    <th key={role} className={`p-2 text-center text-xs font-semibold whitespace-nowrap ${i === settingsRoles.length - 1 ? 'rounded-tr-xl' : ''}`}>{role}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MENU_ROLE_OPTIONS.map((menu) => {
                  const isSub = !!menu.group
                  return (
                    <tr
                      key={menu.key}
                      className={`transition-colors hover:bg-blue-50 ${
                        isSub
                          ? 'bg-gray-50/70'
                          : 'bg-white border-t-2 border-gray-300'
                      }`}
                    >
                      <td
                        className={`p-2 whitespace-nowrap sticky left-0 z-[5] ${
                          isSub
                            ? 'pl-8 text-gray-500 text-xs bg-gray-50/70 border-l-2 border-blue-200'
                            : 'font-bold text-gray-800 bg-white'
                        }`}
                      >
                        {isSub && <span className="text-blue-300 mr-1">└</span>}
                        {menu.label}
                      </td>
                      {settingsRoles.map((role) => (
                        <td key={role} className={`p-2 text-center ${isSub ? 'bg-gray-50/70' : 'bg-white'}`}>
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 w-4 h-4 text-blue-600 focus:ring-blue-500"
                            checked={roleMenus?.[role]?.[menu.key] ?? false}
                            onChange={(e) => toggleRoleMenu(role, menu.key, e.target.checked)}
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bank Settings Tab */}
      {activeTab === 'banks' && hasAccess('settings-banks') && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">ข้อมูลธนาคารสำหรับตรวจสลิป</h2>
              <button
                onClick={() => openBankForm()}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                + เพิ่มข้อมูลธนาคาร
              </button>
            </div>

            {bankSettings.length === 0 ? (
              <div className="text-center py-12 text-gray-500">
                ไม่พบข้อมูลธนาคาร
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-blue-600 text-white">
                      <th className="p-3 text-left font-semibold rounded-tl-xl">ชื่อบัญชี</th>
                      <th className="p-3 text-left font-semibold">เลขบัญชี</th>
                      <th className="p-3 text-left font-semibold">รหัสธนาคาร</th>
                      <th className="p-3 text-left font-semibold">ชื่อธนาคาร</th>
                      <th className="p-3 text-left font-semibold">ช่องทางการขาย</th>
                      <th className="p-3 text-left font-semibold">สถานะ</th>
                      <th className="p-3 text-left font-semibold rounded-tr-xl">การจัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankSettings.map((bank, idx) => (
                      <tr key={bank.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                        <td className="p-3">{bank.account_name || '-'}</td>
                        <td className="p-3">{bank.account_number}</td>
                        <td className="p-3">{bank.bank_code}</td>
                        <td className="p-3">{bank.bank_name || '-'}</td>
                        <td className="p-3">
                          {bank.channels && bank.channels.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {bank.channels.map((ch, idx) => (
                                <span
                                  key={idx}
                                  className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs"
                                >
                                  {ch.channel_name || ch.channel_code}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-400 text-sm">-</span>
                          )}
                        </td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-1 rounded text-sm ${
                              bank.is_active
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-800'
                            }`}
                          >
                            {bank.is_active ? 'ใช้งาน' : 'ไม่ใช้งาน'}
                          </span>
                        </td>
                        <td className="p-3">
                          <button
                            onClick={() => openBankForm(bank)}
                            className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm mr-2"
                          >
                            แก้ไข
                          </button>
                          <button
                            onClick={() => deleteBankSetting(bank.id)}
                            className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                          >
                            ลบ
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Bank Form Modal */}
          {showBankForm && (
            <Modal
              open
              onClose={closeBankForm}
              contentClassName="max-w-2xl w-full mx-4 my-8 overflow-y-auto"
            >
              <div className="p-6">
                <h3 className="text-xl font-bold mb-4">
                  {editingBank ? 'แก้ไขข้อมูลธนาคาร' : 'เพิ่มข้อมูลธนาคาร'}
                </h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      ชื่อบัญชี
                    </label>
                    <input
                      type="text"
                      value={bankFormData.account_name}
                      onChange={(e) =>
                        setBankFormData({ ...bankFormData, account_name: e.target.value })
                      }
                      className="w-full px-3 py-2 border rounded-lg"
                      placeholder="เช่น บัญชีหลัก, บัญชีสำรอง"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">
                      เลขบัญชี <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={bankFormData.account_number}
                      onChange={(e) =>
                        setBankFormData({ ...bankFormData, account_number: e.target.value })
                      }
                      className="w-full px-3 py-2 border rounded-lg"
                      placeholder="เช่น 123-456-7890"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">
                      รหัสธนาคาร <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={bankFormData.bank_code}
                      onChange={(e) => {
                        const selectedBank = BANK_CODES.find(b => b.code === e.target.value)
                        setBankFormData({
                          ...bankFormData,
                          bank_code: e.target.value,
                          bank_name: selectedBank?.name || '',
                        })
                      }}
                      className="w-full px-3 py-2 border rounded-lg"
                    >
                      <option value="">-- เลือกรหัสธนาคาร --</option>
                      {BANK_CODES.map((bank) => (
                        <option key={bank.code} value={bank.code}>
                          {bank.code} - {bank.name} ({bank.abbreviation})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">ชื่อธนาคาร</label>
                    <input
                      type="text"
                      value={bankFormData.bank_name}
                      onChange={(e) =>
                        setBankFormData({ ...bankFormData, bank_name: e.target.value })
                      }
                      className="w-full px-3 py-2 border rounded-lg"
                      placeholder="ชื่อธนาคาร (จะถูกเติมอัตโนมัติเมื่อเลือกรหัสธนาคาร)"
                      readOnly
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">
                      ช่องทางการขาย <span className="text-red-500">*</span>
                    </label>
                    <div className="border rounded-lg p-3 max-h-48 overflow-y-auto">
                      {channels.map((channel) => (
                        <label key={channel.channel_code} className="flex items-center mb-2">
                          <input
                            type="checkbox"
                            checked={bankFormData.selectedChannels.includes(channel.channel_code)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setBankFormData({
                                  ...bankFormData,
                                  selectedChannels: [...bankFormData.selectedChannels, channel.channel_code],
                                })
                              } else {
                                setBankFormData({
                                  ...bankFormData,
                                  selectedChannels: bankFormData.selectedChannels.filter(
                                    (c) => c !== channel.channel_code
                                  ),
                                })
                              }
                            }}
                            className="mr-2"
                          />
                          <span className="text-sm">
                            {channel.channel_name || channel.channel_code}
                          </span>
                        </label>
                      ))}
                      {channels.length === 0 && (
                        <p className="text-gray-500 text-sm">ไม่มีช่องทางการขาย</p>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      เลือกได้หลายช่องทาง (ต้องเลือกอย่างน้อย 1 ช่องทาง)
                    </p>
                  </div>

                  <div>
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={bankFormData.is_active}
                        onChange={(e) =>
                          setBankFormData({ ...bankFormData, is_active: e.target.checked })
                        }
                        className="mr-2"
                      />
                      <span className="text-sm">ใช้งาน</span>
                    </label>
                  </div>
                </div>

                <div className="flex gap-4 mt-6">
                  <button
                    onClick={saveBankSetting}
                    className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                  >
                    บันทึก
                  </button>
                  <button
                    onClick={closeBankForm}
                    className="flex-1 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
                  >
                    ยกเลิก
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </div>
      )}

      {/* ตั้งค่าสินค้า Tab */}
      {activeTab === 'product-settings' && hasAccess('settings-product-settings') && (
        <>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold">ตั้งค่าสินค้า — ข้อมูลที่อนุญาตให้กรอกต่อหมวดหมู่</h2>
            <button
              onClick={saveCategoryFieldSettings}
              disabled={savingProductSettings || productCategories.length === 0}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingProductSettings ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          {productCategories.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              ไม่พบหมวดหมู่สินค้า (ตรวจสอบว่ามีสินค้าใน pr_products และมี product_category)
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-blue-600 text-white">
                    <th className="p-3 text-left font-semibold whitespace-nowrap rounded-tl-xl">ชื่อหมวดหมู่สินค้า</th>
                    {PRODUCT_FIELD_KEYS.map(({ key, label }, i) => (
                      <th key={key} className={`p-2 text-center font-semibold text-sm whitespace-nowrap ${i === PRODUCT_FIELD_KEYS.length - 1 ? 'rounded-tr-xl' : ''}`}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productCategories.map((category, idx) => (
                    <tr key={category} className={`border-b border-gray-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3 border-r border-gray-200 font-semibold whitespace-nowrap">{category}</td>
                      {PRODUCT_FIELD_KEYS.map(({ key }) => (
                        <td key={key} className="p-2 text-center border-r border-gray-200">
                          <input
                            type="checkbox"
                            checked={getCategoryFields(category)[key]}
                            onChange={(e) => setCategoryField(category, key, e.target.checked)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Override ระดับสินค้า */}
        <div className="bg-white p-6 rounded-lg shadow mt-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="text-xl font-bold">ตั้งค่าฟิลด์ระดับสินค้า (Override)</h2>
              <p className="text-sm text-gray-500 mt-1">ตั้งค่าเฉพาะสินค้าที่ต้องการแตกต่างจากหมวดหมู่ — คลิกเพื่อสลับ 3 สถานะ</p>
            </div>
            <button
              onClick={saveProductOverrides}
              disabled={savingProductOverrides || allProducts.length === 0}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingProductOverrides ? 'กำลังบันทึก...' : 'บันทึก Override'}
            </button>
          </div>
          <div className="flex items-center gap-6 mb-3 text-xs text-gray-600">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-4 rounded border-2 border-gray-300 bg-gray-100 relative">
                <span className="absolute inset-0 flex items-center justify-center text-gray-400 font-bold text-[10px]">—</span>
              </span>
              ตามหมวดหมู่ (ค่าเริ่มต้น)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-4 rounded border-2 border-amber-500 bg-amber-500 relative">
                <svg className="w-3 h-3 text-white absolute inset-0 m-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              </span>
              Override เปิด
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-4 rounded border-2 border-red-400 bg-red-50 relative">
                <svg className="w-3 h-3 text-red-500 absolute inset-0 m-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </span>
              Override ปิด
            </span>
          </div>
          <div className="flex gap-3 mb-4 flex-wrap">
            <input
              type="text"
              placeholder="ค้นหาชื่อหรือรหัสสินค้า..."
              value={overrideSearchInput}
              onChange={(e) => setOverrideSearchInput(e.target.value)}
              className="flex-1 min-w-[200px] px-3 py-2 border rounded-lg text-sm"
            />
            <select
              value={overrideCategoryFilter}
              onChange={(e) => { setOverrideCategoryFilter(e.target.value); setOverridePage(1) }}
              className="px-3 py-2 border rounded-lg text-sm"
            >
              <option value="">ทุกหมวดหมู่</option>
              {productCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>
          {allProducts.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              ไม่พบสินค้า
            </div>
          ) : filteredOverrideProducts.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              ไม่พบสินค้าที่ตรงกับการค้นหา
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-amber-600 text-white">
                      <th className="p-2 text-left font-semibold whitespace-nowrap rounded-tl-xl">สินค้า</th>
                      <th className="p-2 text-left font-semibold whitespace-nowrap text-xs">หมวดหมู่</th>
                      {PRODUCT_FIELD_KEYS.map(({ key, label }, i) => (
                        <th key={key} className={`p-1.5 text-center font-semibold text-xs whitespace-nowrap ${i === PRODUCT_FIELD_KEYS.length - 1 ? 'rounded-tr-xl' : ''}`}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedOverrideProducts.map((product, idx) => {
                      const catKey = (product.product_category || '').trim()
                      const catSettings = catKey ? getCategoryFields(catKey) : defaultCategoryFields
                      const overrideFields = getProductOverrideFields(product.id)
                      const hasAny = productHasOverrides(product.id)
                      return (
                        <tr
                          key={product.id}
                          className={`border-b border-gray-200 hover:bg-amber-50 transition-colors ${hasAny ? 'bg-amber-50/50' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}
                        >
                          <td className="p-2 border-r border-gray-200 font-medium whitespace-nowrap max-w-[200px] truncate" title={`${product.product_code} — ${product.product_name}`}>
                            <span className="text-gray-500 text-xs mr-1">{product.product_code}</span>
                            {product.product_name}
                          </td>
                          <td className="p-2 border-r border-gray-200 text-xs text-gray-500 whitespace-nowrap">{catKey || '—'}</td>
                          {PRODUCT_FIELD_KEYS.map(({ key }) => {
                            const overrideVal = overrideFields[key]
                            const categoryVal = catSettings[key]
                            return (
                              <td key={key} className="p-1 text-center border-r border-gray-200">
                                <TriStateOverrideCheckbox
                                  value={overrideVal}
                                  categoryValue={categoryVal}
                                  onChange={(v) => setProductOverrideField(product.id, key, v)}
                                />
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between mt-3 text-sm text-gray-600">
                <span>
                  แสดง {Math.min((overridePage - 1) * OVERRIDE_PAGE_SIZE + 1, filteredOverrideProducts.length)}–{Math.min(overridePage * OVERRIDE_PAGE_SIZE, filteredOverrideProducts.length)} จาก {filteredOverrideProducts.length} รายการ
                  {filteredOverrideProducts.length < allProducts.length && ` (ทั้งหมด ${allProducts.length})`}
                </span>
                {overrideTotalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOverridePage(1)}
                      disabled={overridePage <= 1}
                      className="px-2 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                    >
                      «
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverridePage((p) => Math.max(1, p - 1))}
                      disabled={overridePage <= 1}
                      className="px-2 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                    >
                      ‹ ก่อนหน้า
                    </button>
                    <span className="px-2 py-1 font-medium text-xs">
                      หน้า {overridePage} / {overrideTotalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOverridePage((p) => Math.min(overrideTotalPages, p + 1))}
                      disabled={overridePage >= overrideTotalPages}
                      className="px-2 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                    >
                      ถัดไป ›
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverridePage(overrideTotalPages)}
                      disabled={overridePage >= overrideTotalPages}
                      className="px-2 py-1 border rounded-lg hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                    >
                      »
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        </>
      )}

      {/* ผู้ขาย Tab */}
      {activeTab === 'sellers' && hasAccess('settings-sellers') && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">จัดการผู้ขาย</h2>
          </div>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-sm font-semibold text-gray-700 mb-1">ชื่อผู้ขาย</label>
              <input
                type="text"
                value={sellerName}
                onChange={(e) => setSellerName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveSeller() }}
                placeholder="กรอกชื่อผู้ขาย"
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-base"
              />
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-sm font-semibold text-gray-700 mb-1">ชื่อผู้ขายภาษาจีน</label>
              <input
                type="text"
                value={sellerNameCn}
                onChange={(e) => setSellerNameCn(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveSeller() }}
                placeholder="กรอกชื่อภาษาจีน"
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-base"
              />
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="block text-sm font-semibold text-gray-700 mb-1">ช่องทางซื้อ</label>
              <input
                type="text"
                value={sellerPurchaseChannel}
                onChange={(e) => setSellerPurchaseChannel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveSeller() }}
                placeholder="เช่น Taobao, 1688, Alibaba"
                className="w-full px-3 py-2 border border-gray-300 rounded-xl text-base"
              />
            </div>
            <button
              onClick={saveSeller}
              disabled={sellerSaving}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold disabled:opacity-50"
            >
              {sellerSaving ? 'กำลังบันทึก...' : sellerEditingId ? 'อัปเดต' : 'เพิ่ม'}
            </button>
            {sellerEditingId && (
              <button
                onClick={() => { setSellerEditingId(null); setSellerName(''); setSellerNameCn(''); setSellerPurchaseChannel('') }}
                className="px-4 py-2 border border-gray-300 rounded-xl hover:bg-gray-100"
              >
                ยกเลิก
              </button>
            )}
          </div>
          {sellers.length === 0 ? (
            <p className="text-gray-400 italic text-center py-8">ยังไม่มีข้อมูลผู้ขาย</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="px-4 py-2.5 text-left font-semibold rounded-tl-xl w-12">#</th>
                  <th className="px-4 py-2.5 text-left font-semibold">ชื่อผู้ขาย</th>
                  <th className="px-4 py-2.5 text-left font-semibold">ชื่อภาษาจีน</th>
                  <th className="px-4 py-2.5 text-left font-semibold">ช่องทางซื้อ</th>
                  <th className="px-4 py-2.5 text-right font-semibold rounded-tr-xl w-40">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((s, idx) => (
                  <tr key={s.id} className={`border-t hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="px-4 py-2.5 text-gray-400">{idx + 1}</td>
                    <td className="px-4 py-2.5 font-semibold">{s.name}</td>
                    <td className="px-4 py-2.5 text-gray-700">{s.name_cn || '-'}</td>
                    <td className="px-4 py-2.5 text-gray-700">{s.purchase_channel || '-'}</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => { setSellerEditingId(s.id); setSellerName(s.name); setSellerNameCn(s.name_cn || ''); setSellerPurchaseChannel(s.purchase_channel || '') }}
                          className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-xs font-semibold"
                        >
                          แก้ไข
                        </button>
                        <button
                          onClick={() => deleteSeller(s.id)}
                          className="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 text-xs font-semibold"
                        >
                          ลบ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'issue-types' && hasAccess('settings-issue-types') && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold">ประเภท Issue</h2>
            <button
              onClick={saveIssueType}
              disabled={issueTypeSaving}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
            >
              {issueTypeSaving ? 'กำลังบันทึก...' : issueTypeEditingId ? 'บันทึกการแก้ไข' : 'เพิ่มประเภท'}
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ชื่อประเภท</label>
              <input
                value={issueTypeName}
                onChange={(e) => setIssueTypeName(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="เช่น ด่วน, ด่วนมาก"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">สี</label>
              <input
                type="color"
                value={issueTypeColor}
                onChange={(e) => setIssueTypeColor(e.target.value)}
                className="h-10 w-20 border rounded-lg p-1 bg-white"
              />
            </div>
            <div className="flex items-end">
              {issueTypeEditingId && (
                <button
                  type="button"
                  onClick={() => {
                    setIssueTypeEditingId(null)
                    setIssueTypeName('')
                    setIssueTypeColor('#3B82F6')
                  }}
                  className="px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  ยกเลิกการแก้ไข
                </button>
              )}
            </div>
          </div>

          {issueTypes.length === 0 ? (
            <div className="text-center py-8 text-gray-500">ยังไม่มีประเภท Issue</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-blue-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl">ชื่อประเภท</th>
                    <th className="p-3 text-left font-semibold">สี</th>
                    <th className="p-3 text-left font-semibold">สถานะ</th>
                    <th className="p-3 text-left font-semibold rounded-tr-xl">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {issueTypes.map((t, idx) => (
                    <tr key={t.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3 font-medium">{t.name}</td>
                      <td className="p-3">
                        <span
                          className="inline-flex items-center gap-2 px-2 py-1 rounded border"
                          style={{ borderColor: t.color, color: t.color }}
                        >
                          <span className="inline-block w-3 h-3 rounded-full" style={{ background: t.color }} />
                          {t.color}
                        </span>
                      </td>
                      <td className="p-3">{t.is_active ? 'ใช้งาน' : 'ปิดใช้งาน'}</td>
                      <td className="p-3 space-x-2">
                        <button
                          onClick={() => {
                            setIssueTypeEditingId(t.id)
                            setIssueTypeName(t.name)
                            setIssueTypeColor(t.color || '#3B82F6')
                          }}
                          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-xs"
                        >
                          แก้ไข
                        </button>
                        <button
                          onClick={() => deleteIssueType(t.id)}
                          className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-xs"
                        >
                          ลบ
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'chat-history' && hasAccess('settings-chat-history') && (() => {
        // รวม chat จาก 2 แหล่ง + กรองตาม source
        type UnifiedChat = OrderChatLog & { _source: 'confirm' | 'issue'; _issueTitle?: string }
        const confirmMapped: UnifiedChat[] = chatLogs.map((l) => ({ ...l, _source: 'confirm' }))
        const allChats: UnifiedChat[] =
          chatSource === 'confirm' ? confirmMapped
          : chatSource === 'issue' ? issueChatLogs
          : [...confirmMapped, ...issueChatLogs]

        // จัดกลุ่มตาม bill_no
        const billGroups: Record<string, { bill_no: string; sources: Set<string>; lastDate: string; count: number; issueTitle?: string }> = {}
        allChats.forEach((c) => {
          const key = c.bill_no
          if (!billGroups[key]) {
            billGroups[key] = { bill_no: c.bill_no, sources: new Set(), lastDate: c.created_at, count: 0, issueTitle: c._issueTitle }
          }
          billGroups[key].sources.add(c._source)
          billGroups[key].count++
          if (c.created_at > billGroups[key].lastDate) billGroups[key].lastDate = c.created_at
        })
        const billList = Object.values(billGroups).sort((a, b) => b.lastDate.localeCompare(a.lastDate))

        // ข้อความของบิลที่เลือก เรียงตาม created_at ascending (เก่าสุดก่อน)
        const selectedMessages = selectedChatBill
          ? allChats.filter((c) => c.bill_no === selectedChatBill).sort((a, b) => a.created_at.localeCompare(b.created_at))
          : []

        return (
        <div className="bg-white rounded-xl shadow space-y-0 overflow-hidden">
          {/* ── Filter Bar ── */}
          <div className="p-4 border-b border-gray-200 bg-gray-50">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">จากวันที่</label>
                <input type="date" value={chatFromDate} onChange={(e) => setChatFromDate(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ถึงวันที่</label>
                <input type="date" value={chatToDate} onChange={(e) => setChatToDate(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">ประเภทแชท</label>
                <select value={chatSource} onChange={(e) => setChatSource(e.target.value as any)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                  <option value="all">ทั้งหมด</option>
                  <option value="confirm">Confirm Chat</option>
                  <option value="issue">Issue Chat</option>
                </select>
              </div>
              <button onClick={loadChatLogs} disabled={chatLoading} className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 text-sm font-medium transition-colors">
                {chatLoading ? 'กำลังโหลด...' : 'กรองข้อมูล'}
              </button>
            </div>
          </div>

          {chatLoading ? (
            <div className="flex justify-center items-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-200 border-t-blue-500" />
            </div>
          ) : billList.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-gray-400">
              <svg className="w-12 h-12 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
              <p className="text-sm">ไม่พบประวัติแชท</p>
            </div>
          ) : (
            <div className="flex" style={{ minHeight: '480px' }}>
              {/* ── Bill List (Left Panel) ── */}
              <div className="w-80 shrink-0 border-r border-gray-200 overflow-y-auto bg-white" style={{ maxHeight: '65vh' }}>
                {billList.map((bill) => (
                  <button
                    key={bill.bill_no}
                    type="button"
                    onClick={() => setSelectedChatBill(bill.bill_no)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-blue-50 transition-colors ${selectedChatBill === bill.bill_no ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-gray-900 truncate">{bill.bill_no}</span>
                      <span className="text-xs text-gray-400 shrink-0">{bill.count} ข้อความ</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {bill.sources.has('confirm') && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 font-medium">Confirm</span>
                      )}
                      {bill.sources.has('issue') && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Issue</span>
                      )}
                      <span className="text-[11px] text-gray-400 ml-auto">{formatDateTime(bill.lastDate)}</span>
                    </div>
                    {bill.issueTitle && bill.sources.has('issue') && (
                      <div className="text-[11px] text-gray-500 mt-0.5 truncate">Ticket: {bill.issueTitle}</div>
                    )}
                  </button>
                ))}
              </div>

              {/* ── Chat Messages (Right Panel) ── */}
              <div className="flex-1 flex flex-col bg-gray-50">
                {!selectedChatBill ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                    <svg className="w-16 h-16 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    <p className="text-sm">เลือกบิลเพื่อดูประวัติแชท</p>
                  </div>
                ) : (
                  <>
                    {/* Chat Header */}
                    <div className="px-5 py-3 bg-white border-b border-gray-200 flex items-center justify-between shrink-0">
                      <div>
                        <h4 className="font-bold text-gray-900 text-sm">{selectedChatBill}</h4>
                        <p className="text-xs text-gray-500">{selectedMessages.length} ข้อความ</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => deleteChatLogsByBill(selectedChatBill!)}
                          className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          ลบทั้งบิล
                        </button>
                        <button type="button" onClick={() => setSelectedChatBill(null)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors">
                          ปิด
                        </button>
                      </div>
                    </div>

                    {/* Chat Messages */}
                    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3" style={{ maxHeight: '55vh' }}>
                      {selectedMessages.map((msg) => (
                        <div key={msg.id} className="group">
                          <div className="bg-white rounded-xl px-4 py-3 shadow-sm border border-gray-100 max-w-xl">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-sm font-semibold text-gray-900">{msg.sender_name}</span>
                              {msg._source === 'issue' ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Issue</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-600 font-medium">Confirm</span>
                              )}
                              <span className="text-[11px] text-gray-400 ml-auto">{formatDateTime(msg.created_at)}</span>
                            </div>
                            <p className="text-sm text-gray-700 whitespace-pre-wrap select-text">{msg.message}</p>
                          </div>
                          {/* Delete button (confirm chat only) */}
                          {msg._source === 'confirm' && (
                            <div className="mt-1 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={() => deleteChatLog(msg.id)}
                                className="text-[11px] text-red-400 hover:text-red-600 transition-colors"
                              >
                                ลบข้อความ
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        )
      })()}
      {MessageModal}
      {ConfirmModal}
    </div>
  )
}

/** Tri-state checkbox สำหรับ override ระดับสินค้า: null (ตามหมวดหมู่) → true (เปิด) → false (ปิด) → null */
function TriStateOverrideCheckbox({
  value,
  categoryValue,
  onChange,
}: {
  value: boolean | null
  categoryValue: boolean
  onChange: (v: boolean | null) => void
}) {
  function handleClick() {
    if (value === null) onChange(true)
    else if (value === true) onChange(false)
    else onChange(null)
  }

  const title =
    value === null
      ? `ตามหมวดหมู่ (${categoryValue ? 'เปิด' : 'ปิด'}) — คลิกเพื่อ override เปิด`
      : value
        ? 'Override: เปิด — คลิกเพื่อ override ปิด'
        : 'Override: ปิด — คลิกเพื่อกลับตามหมวดหมู่'

  if (value === null) {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={title}
        className="w-5 h-5 rounded border-2 border-gray-300 bg-gray-100 flex items-center justify-center cursor-pointer hover:border-gray-400 transition-colors mx-auto"
      >
        <span className="text-gray-400 font-bold text-[11px] leading-none">—</span>
      </button>
    )
  }

  if (value === true) {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={title}
        className="w-5 h-5 rounded border-2 border-amber-500 bg-amber-500 flex items-center justify-center cursor-pointer hover:bg-amber-600 hover:border-amber-600 transition-colors mx-auto"
      >
        <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      className="w-5 h-5 rounded border-2 border-red-400 bg-red-50 flex items-center justify-center cursor-pointer hover:bg-red-100 hover:border-red-500 transition-colors mx-auto"
    >
      <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )
}
