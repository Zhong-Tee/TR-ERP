import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { User, BankSetting, OrderChatLog, IssueType } from '../types'
import { BANK_CODES } from '../types'
import { testEasySlipConnection, testEasySlipWithImage } from '../lib/slipVerification'
import Modal from '../components/ui/Modal'

export default function Settings() {
  const [users, setUsers] = useState<User[]>([])
  const [bankSettings, setBankSettings] = useState<BankSetting[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<
    'users' | 'role-settings' | 'banks' | 'product-settings' | 'chat-history' | 'issue-types' | 'easyslip'
  >('users')
  const [fixingStatus, setFixingStatus] = useState(false)
  const [statusFixResult, setStatusFixResult] = useState<{
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
  const [roleMenus, setRoleMenus] = useState<Record<string, Record<string, boolean>>>({})
  const [savingRoleMenus, setSavingRoleMenus] = useState(false)
  const [chatLogs, setChatLogs] = useState<OrderChatLog[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatFromDate, setChatFromDate] = useState('')
  const [chatToDate, setChatToDate] = useState('')
  const [issueTypes, setIssueTypes] = useState<IssueType[]>([])
  const [issueTypeName, setIssueTypeName] = useState('')
  const [issueTypeColor, setIssueTypeColor] = useState('#3B82F6')
  const [issueTypeSaving, setIssueTypeSaving] = useState(false)
  const [issueTypeEditingId, setIssueTypeEditingId] = useState<string | null>(null)

  useEffect(() => {
    loadUsers()
    loadBankSettings()
    loadChannels()
  }, [])

  useEffect(() => {
    if (activeTab === 'product-settings') {
      loadProductCategories()
      loadCategoryFieldSettings()
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
  }, [activeTab])

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
      alert('กรุณาเลือกไฟล์รูปสลิปก่อน')
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
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  async function updateUserRole(userId: string, newRole: string) {
    try {
      const { error } = await supabase
        .from('us_users')
        .update({ role: newRole })
        .eq('id', userId)

      if (error) throw error
      alert('อัปเดตสิทธิ์สำเร็จ')
      loadUsers()
    } catch (error: any) {
      console.error('Error updating user role:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  const MENU_ROLE_OPTIONS = [
    { key: 'orders', label: 'ออเดอร์' },
    { key: 'admin-qc', label: 'รอตรวจคำสั่งซื้อ' },
    { key: 'account', label: 'บัญชี' },
    { key: 'export', label: 'ใบงาน' },
    { key: 'plan', label: 'Plan' },
    { key: 'wms', label: 'จัดสินค้า' },
    { key: 'qc', label: 'QC' },
    { key: 'packing', label: 'จัดของ' },
    { key: 'transport', label: 'ทวนสอบขนส่ง' },
    { key: 'products', label: 'สินค้า' },
    { key: 'cartoon-patterns', label: 'ลายการ์ตูน' },
    { key: 'sales-reports', label: 'รายงานยอดขาย' },
    { key: 'settings', label: 'ตั้งค่า' },
  ] as const

  async function loadRoleMenus() {
    try {
      const { data, error } = await supabase
        .from('st_user_menus')
        .select('role, menu_key, has_access')
      if (error) throw error
      const map: Record<string, Record<string, boolean>> = {}
      roles.forEach((role) => {
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
    try {
      let query = supabase
        .from('or_order_chat_logs')
        .select('*')
        .order('created_at', { ascending: false })

      if (chatFromDate) {
        query = query.gte('created_at', `${chatFromDate}T00:00:00.000Z`)
      }
      if (chatToDate) {
        query = query.lte('created_at', `${chatToDate}T23:59:59.999Z`)
      }

      const { data, error } = await query.limit(500)
      if (error) throw error
      setChatLogs((data || []) as OrderChatLog[])
    } catch (error: any) {
      console.error('Error loading chat logs:', error)
      alert('เกิดข้อผิดพลาดในการโหลดประวัติแชท: ' + error.message)
    } finally {
      setChatLoading(false)
    }
  }

  async function deleteChatLog(id: string) {
    if (!confirm('ต้องการลบข้อความนี้หรือไม่?')) return
    try {
      const { error } = await supabase
        .from('or_order_chat_logs')
        .delete()
        .eq('id', id)
      if (error) throw error
      setChatLogs((prev) => prev.filter((log) => log.id !== id))
    } catch (error: any) {
      console.error('Error deleting chat log:', error)
      alert('เกิดข้อผิดพลาดในการลบ: ' + error.message)
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
      alert('เกิดข้อผิดพลาดในการโหลดประเภท Issue: ' + error.message)
    }
  }

  async function saveIssueType() {
    if (!issueTypeName.trim()) {
      alert('กรุณากรอกชื่อประเภท')
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
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setIssueTypeSaving(false)
    }
  }

  async function deleteIssueType(id: string) {
    if (!confirm('ต้องการลบประเภท Issue นี้หรือไม่?')) return
    try {
      const { error } = await supabase
        .from('or_issue_types')
        .delete()
        .eq('id', id)
      if (error) throw error
      setIssueTypes((prev) => prev.filter((t) => t.id !== id))
    } catch (error: any) {
      console.error('Error deleting issue type:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function toggleRoleMenu(role: string, menuKey: string, checked: boolean) {
    setRoleMenus((prev) => ({
      ...prev,
      [role]: {
        ...(prev[role] || {}),
        [menuKey]: checked,
      },
    }))
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
      alert('บันทึกการตั้งค่า Role สำเร็จ')
    } catch (error: any) {
      console.error('Error saving role menus:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
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
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
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
      alert('บันทึกตั้งค่าสินค้าสำเร็จ')
    } catch (error: any) {
      console.error('Error saving category field settings:', error)
      alert('เกิดข้อผิดพลาดในการบันทึก: ' + error.message)
    } finally {
      setSavingProductSettings(false)
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
        alert('กรุณากรอกเลขบัญชีและรหัสธนาคาร')
        return
      }

      if (bankFormData.selectedChannels.length === 0) {
        alert('กรุณาเลือกช่องทางการขายอย่างน้อย 1 ช่องทาง')
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
        alert('อัปเดตข้อมูลธนาคารสำเร็จ')
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
        alert('เพิ่มข้อมูลธนาคารสำเร็จ')
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
            alert('เพิ่มข้อมูลธนาคารสำเร็จ แต่ไม่สามารถบันทึกช่องทางการขายได้ กรุณารัน migration 008_update_bank_settings.sql')
          } else {
            throw channelsError
          }
        }
      }

      closeBankForm()
      loadBankSettings()
    } catch (error: any) {
      console.error('Error saving bank setting:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function deleteBankSetting(id: string) {
    if (!confirm('ต้องการลบข้อมูลธนาคารนี้หรือไม่?')) {
      return
    }

    try {
      const { error } = await supabase
        .from('bank_settings')
        .delete()
        .eq('id', id)

      if (error) throw error
      alert('ลบข้อมูลธนาคารสำเร็จ')
      loadBankSettings()
    } catch (error: any) {
      console.error('Error deleting bank setting:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    }
  }

  async function fixOrderStatuses() {
    if (!confirm('ต้องการตรวจสอบและแก้ไขสถานะบิลทั้งหมดให้ถูกต้องตามข้อมูลในตารางหรือไม่?\n\nการดำเนินการนี้อาจใช้เวลาสักครู่')) {
      return
    }

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

  const roles = [
    'superadmin',
    'admin',
    'admin_qc',
    'order_staff',
    'qc_staff',
    'packing_staff',
    'account_staff',
    'viewer',
    'store',
    'production',
    'manager',
    'picker',
  ]

  return (
    <div className="space-y-6">
      {/* เมนูย่อย — สไตล์เดียวกับเมนูออเดอร์ */}
      <div className="sticky top-0 z-10 bg-white border-b border-surface-200 shadow-soft -mx-6 px-6">
        <div className="w-full px-4 sm:px-6 lg:px-8 overflow-x-auto scrollbar-thin">
          <nav className="flex gap-1 sm:gap-3 flex-nowrap min-w-max py-3" aria-label="Tabs">
            {([
              { key: 'users', label: 'จัดการสิทธิ์ผู้ใช้' },
              { key: 'role-settings', label: 'ตั้งค่า Role' },
              { key: 'banks', label: 'ตั้งค่าข้อมูลธนาคาร' },
              { key: 'product-settings', label: 'ตั้งค่าสินค้า' },
              { key: 'issue-types', label: 'ประเภท Issue' },
              { key: 'chat-history', label: 'ประวัติแชท' },
              { key: 'easyslip', label: 'API EasySlip' },
            ] as { key: typeof activeTab; label: string }[]).map((tab) => (
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
      {activeTab === 'easyslip' && (
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
      {activeTab === 'users' && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">ผู้ใช้ทั้งหมด</h2>
        {users.length === 0 ? (
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
                {users.map((user, idx) => (
                  <tr key={user.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3">{user.email || '-'}</td>
                    <td className="p-3">{user.username || '-'}</td>
                    <td className="p-3">
                      <select
                        value={user.role}
                        onChange={(e) => updateUserRole(user.id, e.target.value)}
                        className="px-3 py-1 border rounded"
                      >
                        {roles.map((role) => (
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
      )}

      {activeTab === 'role-settings' && (
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
          <div className="overflow-x-auto">
            <table className="w-full border">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">Role</th>
                  {MENU_ROLE_OPTIONS.map((menu, i) => (
                    <th key={menu.key} className={`p-3 text-center text-sm font-semibold ${i === MENU_ROLE_OPTIONS.length - 1 ? 'rounded-tr-xl' : ''}`}>{menu.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roles.map((role, idx) => (
                  <tr key={role} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="p-3 font-medium">{role}</td>
                    {MENU_ROLE_OPTIONS.map((menu) => (
                      <td key={menu.key} className="p-3 text-center">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300"
                          checked={roleMenus?.[role]?.[menu.key] ?? false}
                          onChange={(e) => toggleRoleMenu(role, menu.key, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Bank Settings Tab */}
      {activeTab === 'banks' && (
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
      {activeTab === 'product-settings' && (
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
      )}

      {activeTab === 'issue-types' && (
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

      {activeTab === 'chat-history' && (
        <div className="bg-white p-6 rounded-lg shadow space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">จากวันที่</label>
              <input
                type="date"
                value={chatFromDate}
                onChange={(e) => setChatFromDate(e.target.value)}
                className="px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ถึงวันที่</label>
              <input
                type="date"
                value={chatToDate}
                onChange={(e) => setChatToDate(e.target.value)}
                className="px-3 py-2 border rounded-lg"
              />
            </div>
            <button
              onClick={loadChatLogs}
              disabled={chatLoading}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {chatLoading ? 'กำลังโหลด...' : 'กรองข้อมูล'}
            </button>
          </div>

          {chatLoading ? (
            <div className="flex justify-center items-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
            </div>
          ) : chatLogs.length === 0 ? (
            <div className="text-center py-12 text-gray-500">ไม่พบประวัติแชท</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-blue-600 text-white">
                    <th className="p-3 text-left font-semibold rounded-tl-xl">วันที่เวลา</th>
                    <th className="p-3 text-left font-semibold">เลขบิล</th>
                    <th className="p-3 text-left font-semibold">ผู้ส่ง</th>
                    <th className="p-3 text-left font-semibold">ข้อความ</th>
                    <th className="p-3 text-left font-semibold rounded-tr-xl">การจัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {chatLogs.map((log, idx) => (
                    <tr key={log.id} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3 whitespace-nowrap">{new Date(log.created_at).toLocaleString('th-TH')}</td>
                      <td className="p-3 font-medium">{log.bill_no}</td>
                      <td className="p-3">{log.sender_name}</td>
                      <td className="p-3 max-w-[420px]">
                        <div className="truncate" title={log.message}>
                          {log.message}
                        </div>
                      </td>
                      <td className="p-3">
                        <button
                          onClick={() => deleteChatLog(log.id)}
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
    </div>
  )
}
