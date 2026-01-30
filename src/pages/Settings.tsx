import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import type { User, BankSetting } from '../types'
import { BANK_CODES } from '../types'
import { testEasySlipConnection, testEasySlipWithImage } from '../lib/slipVerification'
import Modal from '../components/ui/Modal'

export default function Settings() {
  const [users, setUsers] = useState<User[]>([])
  const [bankSettings, setBankSettings] = useState<BankSetting[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'users' | 'banks' | 'product-settings' | 'order-status'>('users')
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
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">ตั้งค่า</h1>

      {/* Test EasySlip Connection Section */}
      <div className="bg-white p-4 rounded-lg shadow mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold mb-1">ทดสอบการเชื่อมต่อ EasySlip API</h2>
            <p className="text-sm text-gray-600">ตรวจสอบว่า Edge Function และ EasySlip API ทำงานได้ปกติ</p>
          </div>
          <button
            onClick={testConnection}
            disabled={testingConnection}
            className={`px-4 py-2 rounded-lg font-medium ${
              testingConnection
                ? 'bg-gray-400 text-white cursor-not-allowed'
                : 'bg-green-500 text-white hover:bg-green-600'
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
      <div className="bg-white p-4 rounded-lg shadow mb-4">
        <div>
          <h2 className="text-lg font-semibold mb-1">ทดสอบการตรวจสอบสลิปด้วยรูปภาพจริง</h2>
          <p className="text-sm text-gray-600 mb-4">อัปโหลดรูปสลิปเพื่อทดสอบการตรวจสอบจริง</p>
        </div>

        <div className="space-y-4">
          {/* Image Upload */}
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

          {/* Test Button */}
          <button
            onClick={testWithImage}
            disabled={testingWithImage || !selectedImage}
            className={`px-4 py-2 rounded-lg font-medium ${
              testingWithImage || !selectedImage
                ? 'bg-gray-400 text-white cursor-not-allowed'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            {testingWithImage ? 'กำลังทดสอบ...' : 'ทดสอบการตรวจสอบสลิป'}
          </button>

          {/* Test Result */}
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

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <nav className="flex space-x-8">
          <button
            onClick={() => setActiveTab('users')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'users'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            จัดการสิทธิ์ผู้ใช้
          </button>
          <button
            onClick={() => setActiveTab('banks')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'banks'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            ตั้งค่าข้อมูลธนาคาร
          </button>
          <button
            onClick={() => setActiveTab('product-settings')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'product-settings'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            ตั้งค่าสินค้า
          </button>
          <button
            onClick={() => setActiveTab('order-status')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'order-status'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            แก้ไขสถานะบิล
          </button>
        </nav>
      </div>

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
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">อีเมล</th>
                  <th className="p-3 text-left">Username</th>
                  <th className="p-3 text-left">Role</th>
                  <th className="p-3 text-left">การจัดการ</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t">
                    <td className="p-3">{user.email}</td>
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
                    <td className="p-3">
                      <button className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm">
                        แก้ไข
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
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-3 text-left">ชื่อบัญชี</th>
                      <th className="p-3 text-left">เลขบัญชี</th>
                      <th className="p-3 text-left">รหัสธนาคาร</th>
                      <th className="p-3 text-left">ชื่อธนาคาร</th>
                      <th className="p-3 text-left">ช่องทางการขาย</th>
                      <th className="p-3 text-left">สถานะ</th>
                      <th className="p-3 text-left">การจัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankSettings.map((bank) => (
                      <tr key={bank.id} className="border-t">
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
          <p className="text-gray-600 text-sm mb-4">
            ติ๊กรายการที่อนุญาตให้กรอกได้สำหรับแต่ละหมวดหมู่ หากไม่ได้ติ๊ก ฟิลด์นั้นจะกรอกไม่ได้ในฟอร์มสร้าง/แก้ไขออเดอร์
          </p>
          {productCategories.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              ไม่พบหมวดหมู่สินค้า (ตรวจสอบว่ามีสินค้าใน pr_products และมี product_category)
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-gray-100 border-b">
                    <th className="p-3 text-left border font-medium whitespace-nowrap">ชื่อหมวดหมู่สินค้า</th>
                    {PRODUCT_FIELD_KEYS.map(({ key, label }) => (
                      <th key={key} className="p-2 text-center border font-medium text-sm whitespace-nowrap">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {productCategories.map((category) => (
                    <tr key={category} className="border-b hover:bg-gray-50">
                      <td className="p-3 border font-medium whitespace-nowrap">{category}</td>
                      {PRODUCT_FIELD_KEYS.map(({ key }) => (
                        <td key={key} className="p-2 text-center border">
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

      {/* Order Status Fix Tab */}
      {activeTab === 'order-status' && (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-bold mb-4">แก้ไขสถานะบิลให้ถูกต้อง</h2>
          <p className="text-gray-600 mb-4">
            ฟังก์ชันนี้จะตรวจสอบสถานะของบิลทั้งหมดและแก้ไขให้ถูกต้องตามข้อมูลในตาราง ac_verified_slips
          </p>
          <p className="text-sm text-gray-500 mb-6">
            <strong>วิธีการทำงาน:</strong>
            <br />
            • ตรวจสอบบิลที่มี slip verification records
            <br />
            • เปรียบเทียบสถานะปัจจุบันกับสถานะที่ควรเป็น
            <br />
            • แก้ไขสถานะให้ถูกต้อง (ตรวจสอบแล้ว / ตรวจสอบไม่ผ่าน)
          </p>

          <button
            onClick={fixOrderStatuses}
            disabled={fixingStatus}
            className={`px-6 py-3 rounded-lg font-medium ${
              fixingStatus
                ? 'bg-gray-400 text-white cursor-not-allowed'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            {fixingStatus ? 'กำลังตรวจสอบและแก้ไข...' : 'เริ่มตรวจสอบและแก้ไขสถานะบิล'}
          </button>

          {statusFixResult && (
            <div className={`mt-6 p-4 rounded-lg ${
              statusFixResult.success
                ? 'bg-green-50 border border-green-200'
                : 'bg-red-50 border border-red-200'
            }`}>
              <div className={`font-semibold mb-2 ${
                statusFixResult.success ? 'text-green-800' : 'text-red-800'
              }`}>
                {statusFixResult.success ? '✅' : '❌'} {statusFixResult.message}
              </div>
              
              {statusFixResult.details && (
                <div className="mt-4 text-sm text-gray-700 space-y-2">
                  <div>ตรวจสอบบิลทั้งหมด: {statusFixResult.details.totalChecked} รายการ</div>
                  <div>บิลที่ต้องแก้ไข: {statusFixResult.details.needsUpdate} รายการ</div>
                  <div>แก้ไขสำเร็จ: {statusFixResult.details.successCount} รายการ</div>
                  {statusFixResult.details.errorCount > 0 && (
                    <div className="text-red-600">เกิดข้อผิดพลาด: {statusFixResult.details.errorCount} รายการ</div>
                  )}

                  {statusFixResult.details.updates && statusFixResult.details.updates.length > 0 && (
                    <div className="mt-4">
                      <div className="font-semibold mb-2">รายการที่แก้ไข:</div>
                      <div className="max-h-60 overflow-y-auto border rounded p-3 bg-gray-50">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left p-2">เลขบิล</th>
                              <th className="text-left p-2">สถานะเดิม</th>
                              <th className="text-left p-2">สถานะใหม่</th>
                              <th className="text-left p-2">เหตุผล</th>
                            </tr>
                          </thead>
                          <tbody>
                            {statusFixResult.details.updates.map((update: any, idx: number) => (
                              <tr key={idx} className="border-b">
                                <td className="p-2 font-medium">{update.bill_no}</td>
                                <td className="p-2">
                                  <span className="px-2 py-1 bg-gray-200 rounded text-xs">
                                    {update.currentStatus}
                                  </span>
                                </td>
                                <td className="p-2">
                                  <span className={`px-2 py-1 rounded text-xs ${
                                    update.newStatus === 'ตรวจสอบแล้ว'
                                      ? 'bg-green-200 text-green-800'
                                      : 'bg-red-200 text-red-800'
                                  }`}>
                                    {update.newStatus}
                                  </span>
                                </td>
                                <td className="p-2 text-xs">{update.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {statusFixResult.details.updates.length >= 20 && (
                          <p className="text-xs text-gray-500 mt-2">
                            แสดง 20 รายการแรก (มีทั้งหมด {statusFixResult.details.needsUpdate} รายการ)
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {statusFixResult.details.errors && statusFixResult.details.errors.length > 0 && (
                    <div className="mt-4">
                      <div className="font-semibold mb-2 text-red-800">ข้อผิดพลาด:</div>
                      <div className="max-h-40 overflow-y-auto border border-red-300 rounded p-3 bg-red-50">
                        <ul className="list-disc list-inside space-y-1 text-xs text-red-700">
                          {statusFixResult.details.errors.map((error: string, idx: number) => (
                            <li key={idx}>{error}</li>
                          ))}
                        </ul>
                        {statusFixResult.details.errors.length >= 10 && (
                          <p className="text-xs text-red-600 mt-2">
                            แสดง 10 errors แรก
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
