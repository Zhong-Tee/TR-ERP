import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderItem, Product, CartoonPattern, BankSetting } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import { uploadMultipleToStorage, verifyMultipleSlipsFromStorage } from '../../lib/slipVerification'

// Component for uploading slips without immediate verification
function SlipUploadSimple({
  billNo,
  onSlipsUploaded,
  existingSlips = [],
  readOnly = false,
}: {
  billNo?: string | null
  onSlipsUploaded?: (slipStoragePaths: string[]) => void
  existingSlips?: string[]
  readOnly?: boolean
}) {
  const { user } = useAuthContext()
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadedSlipPaths, setUploadedSlipPaths] = useState<string[]>(existingSlips)
  const [previewUrls, setPreviewUrls] = useState<string[]>([])
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [uploadedSlipUrls, setUploadedSlipUrls] = useState<string[]>([])

  // Sync existingSlips when it changes
  useEffect(() => {
    setUploadedSlipPaths(existingSlips)
  }, [existingSlips])

  // Resolve uploaded slip URLs (use signed URLs for private buckets)
  useEffect(() => {
    let isMounted = true
    async function loadUploadedUrls() {
      if (uploadedSlipPaths.length === 0) {
        if (isMounted) setUploadedSlipUrls([])
        return
      }

      const urls = await Promise.all(
        uploadedSlipPaths.map(async (storagePath) => {
          const [bucket, ...pathParts] = storagePath.split('/')
          const filePath = pathParts.join('/')
          const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(filePath, 3600)

          if (error || !data?.signedUrl) {
            return ''
          }

          return data.signedUrl
        })
      )

      if (isMounted) {
        setUploadedSlipUrls(urls)
      }
    }

    loadUploadedUrls()

    return () => {
      isMounted = false
    }
  }, [uploadedSlipPaths])

  // Cleanup preview URLs when component unmounts or files change
  useEffect(() => {
    return () => {
      previewUrls.forEach(url => URL.revokeObjectURL(url))
    }
  }, [previewUrls])

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files)
      setFiles(prev => [...prev, ...selectedFiles])
      
      // สร้าง preview URLs
      const newPreviewUrls = selectedFiles.map(file => URL.createObjectURL(file))
      setPreviewUrls(prev => [...prev, ...newPreviewUrls])
    }
    
    // Reset input เพื่อให้สามารถเลือกไฟล์เดิมได้อีกครั้ง
    if (e.target) {
      e.target.value = ''
    }
  }

  async function handleUpload() {
    if (files.length === 0) {
      alert('กรุณาเลือกไฟล์สลิป')
      return
    }

    // ตรวจสอบว่า user authenticated หรือไม่
    if (!user) {
      alert('กรุณาเข้าสู่ระบบก่อนอัพโหลดสลิป')
      return
    }

    // ตรวจสอบ session
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      alert('กรุณาเข้าสู่ระบบก่อนอัพโหลดสลิป')
      return
    }

    // ตรวจสอบว่ามี bill_no หรือไม่
    if (!billNo) {
      setUploadNotice('กรุณาบันทึกออเดอร์เพื่อสร้างเลขบิลก่อนอัพโหลดสลิป')
      return
    }

    setUploadNotice(null)
    setUploading(true)
    try {
      // ตั้งชื่อโฟลเดอร์: slip{billNo}
      const folderName = `slip${billNo}`
      
      // อัปโหลดไฟล์ไปยัง Storage โดยใช้ API function ใหม่
      const storagePaths = await uploadMultipleToStorage(files, 'slip-images', folderName)
      
      console.log('Uploaded storage paths:', storagePaths)

      // อัพเดตรายการสลิปที่อัพโหลดแล้ว (รวมกับรายการเดิม)
      const updatedSlipPaths = [...uploadedSlipPaths, ...storagePaths]
      setUploadedSlipPaths(updatedSlipPaths)
      
      // Cleanup preview URLs
      previewUrls.forEach(url => URL.revokeObjectURL(url))
      setPreviewUrls([])
      setFiles([])
      
      if (onSlipsUploaded) {
        onSlipsUploaded(updatedSlipPaths)
      }
      
      alert(`อัพโหลดสลิปสำเร็จ ${storagePaths.length} ไฟล์`)
    } catch (error: any) {
      console.error('Error uploading slips:', error)
      alert('เกิดข้อผิดพลาดในการอัพโหลดสลิป: ' + error.message)
    } finally {
      setUploading(false)
    }
  }

  function handleRemoveFile(index: number) {
    // Cleanup preview URL
    if (previewUrls[index]) {
      URL.revokeObjectURL(previewUrls[index])
    }
    
    setFiles(files.filter((_, i) => i !== index))
    setPreviewUrls(previewUrls.filter((_, i) => i !== index))
  }

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-4">
      {!readOnly && (
        <div>
          <label className="block text-sm font-medium mb-2">
            อัปโหลดสลิปโอน (สามารถเลือกหลายไฟล์)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-4 py-3 border-2 border-dashed border-blue-300 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 font-medium transition-colors"
          >
            📎 คลิกเพื่อเพิ่มไฟล์สลิป
          </button>
          {files.length > 0 && (
            <p className="text-sm text-gray-600 mt-2">เลือกแล้ว {files.length} ไฟล์</p>
          )}
        </div>
      )}

      {!readOnly && files.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600 font-medium">ไฟล์ที่เลือก ({files.length} ไฟล์):</p>
          
          {/* แสดง preview รูปภาพ */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {files.map((file, index) => {
              const previewUrl = previewUrls[index]
              return (
                <div key={index} className="relative group">
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt={file.name}
                      className="w-full aspect-square object-contain rounded-lg border-2 border-gray-200 bg-gray-50"
                      onError={(e) => {
                        console.error('Error loading preview:', file.name)
                        e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23ddd" width="200" height="200"/%3E%3Ctext fill="%23999" font-family="sans-serif" font-size="14" x="50%25" y="50%25" text-anchor="middle" dy=".3em"%3Eไม่สามารถโหลดรูปภาพ%3C/text%3E%3C/svg%3E'
                      }}
                    />
                  ) : (
                    <div className="w-full h-32 bg-gray-100 rounded-lg border-2 border-gray-200 flex items-center justify-center">
                      <span className="text-gray-400 text-xs">กำลังโหลด...</span>
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs p-1 rounded-b-lg truncate">
                    {file.name}
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(index)}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="ลบ"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          
          <button
            type="button"
            onClick={handleUpload}
            disabled={uploading || !billNo}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? 'กำลังอัพโหลด...' : `อัพโหลดสลิป ${files.length} ไฟล์`}
          </button>
          {uploadNotice && (
            <p className="text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-lg p-2">
              {uploadNotice}
            </p>
          )}
        </div>
      )}

      {uploadedSlipPaths.length > 0 && (
        <div className="space-y-3">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-green-800 text-sm font-medium">
              อัพโหลดแล้ว {uploadedSlipPaths.length} ไฟล์
            </p>
            <p className="text-green-700 text-xs mt-1">
              สลิปจะถูกตรวจสอบเมื่อกดปุ่ม "บันทึก (ข้อมูลครบ)"
            </p>
          </div>
          
          {/* แสดงรูปภาพที่อัพโหลดแล้ว */}
          <div>
            <p className="text-sm font-medium mb-2 text-gray-700">รูปภาพสลิปที่อัพโหลดแล้ว:</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {uploadedSlipPaths.map((storagePath, index) => {
                const imageUrl = uploadedSlipUrls[index]
                return (
                  <div key={index} className="relative group">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={`สลิป ${index + 1}`}
                        className="w-full aspect-square object-contain rounded-lg border-2 border-gray-200 hover:border-blue-400 transition-colors cursor-pointer bg-gray-50"
                        onClick={() => window.open(imageUrl, '_blank')}
                        onError={(e) => {
                          e.currentTarget.src =
                            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23ddd" width="200" height="200"/%3E%3Ctext fill="%23999" font-family="sans-serif" font-size="14" x="50%25" y="50%25" text-anchor="middle" dy=".3em"%3Eไม่สามารถโหลดรูปภาพ%3C/text%3E%3C/svg%3E'
                        }}
                      />
                    ) : (
                      <div className="w-full aspect-square bg-gray-100 rounded-lg border-2 border-gray-200 flex items-center justify-center text-xs text-gray-500">
                        กำลังโหลดรูป...
                      </div>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={async () => {
                          const storagePath = uploadedSlipPaths[index]
                          
                          if (!storagePath) {
                            console.warn('No storage path to delete')
                            return
                          }

                          // Parse storage path: format is "bucket/path/to/file"
                          const pathParts = storagePath.split('/')
                          if (pathParts.length < 2) {
                            console.error('Invalid storage path format:', storagePath)
                            alert('รูปแบบ path ไม่ถูกต้อง: ' + storagePath)
                            return
                          }

                          const bucket = pathParts[0]
                          const filePath = pathParts.slice(1).join('/')
                          
                          console.log('Deleting file from bucket:', bucket, 'path:', filePath)
                          
                          try {
                            // ตรวจสอบ session ก่อนลบ
                            const { data: { session } } = await supabase.auth.getSession()
                            if (!session) {
                              alert('กรุณาเข้าสู่ระบบก่อนลบไฟล์')
                              return
                            }

                            console.log('Attempting to delete:', { bucket, filePath, storagePath })
                            
                            // ลบรูปจาก bucket
                            const { data, error: deleteError } = await supabase.storage
                              .from(bucket)
                              .remove([filePath])
                            
                            if (deleteError) {
                              console.error('Error deleting file from bucket:', {
                                error: deleteError,
                                message: deleteError.message,
                                statusCode: deleteError.statusCode,
                                errorCode: deleteError.error,
                                bucket,
                                filePath,
                                storagePath
                              })
                              
                              // แสดง error message ที่ชัดเจนขึ้น
                              let errorMessage = 'เกิดข้อผิดพลาดในการลบไฟล์'
                              if (deleteError.message) {
                                errorMessage += ': ' + deleteError.message
                              }
                              if (deleteError.statusCode === 403 || deleteError.error === 'permission_denied') {
                                errorMessage += '\n\nสาเหตุ: ไม่มีสิทธิ์ลบไฟล์\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า Storage policies ถูกตั้งค่าแล้ว (รัน migration 012_setup_slip_images_storage_policies.sql)\n2. ตรวจสอบว่า bucket "slip-images" มีการเปิดใช้งาน RLS\n3. ตรวจสอบว่า user มีสิทธิ์ authenticated'
                              } else if (deleteError.statusCode === 404) {
                                errorMessage += '\n\nสาเหตุ: ไม่พบไฟล์ที่ต้องการลบ (อาจถูกลบไปแล้ว)'
                              }
                              
                              alert(errorMessage)
                              return // Don't remove from UI if deletion failed
                            }

                            console.log('File deleted successfully:', { filePath, data })
                            
                            // Update UI only after successful deletion
                            const newSlips = uploadedSlipPaths.filter((_, i) => i !== index)
                            setUploadedSlipPaths(newSlips)
                            
                            if (onSlipsUploaded) {
                              onSlipsUploaded(newSlips)
                            }
                            
                            // แสดงข้อความสำเร็จ
                            console.log('File removed from UI successfully')
                          } catch (error: any) {
                            console.error('Exception deleting file:', {
                              error,
                              message: error?.message,
                              stack: error?.stack,
                              bucket,
                              filePath,
                              storagePath
                            })
                            alert('เกิดข้อผิดพลาดในการลบไฟล์: ' + (error?.message || String(error)))
                          }
                        }}
                        className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="ลบรูปภาพ"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface OrderFormProps {
  order?: Order | null
  onSave: () => void
  onCancel: () => void
  readOnly?: boolean
}

export default function OrderForm({ order, onSave, onCancel, readOnly = false }: OrderFormProps) {
  const { user } = useAuthContext()
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [cartoonPatterns, setCartoonPatterns] = useState<CartoonPattern[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [inkTypes, setInkTypes] = useState<{ id: number; ink_name: string }[]>([])
  const [fonts, setFonts] = useState<{ font_code: string; font_name: string }[]>([])
  const [items, setItems] = useState<Partial<OrderItem>[]>([])
  const [showTaxInvoice, setShowTaxInvoice] = useState(false)
  const [showCashBill, setShowCashBill] = useState(false)
  const [productSearchTerm, setProductSearchTerm] = useState<{ [key: number]: string }>({})
  const [showProductDropdown, setShowProductDropdown] = useState<{ [key: number]: boolean }>({})
  const [uploadedSlipPaths, setUploadedSlipPaths] = useState<string[]>([])
  const [bankSettings, setBankSettings] = useState<BankSetting[]>([])
  const [preBillNo, setPreBillNo] = useState<string | null>(null)
  const dropdownRefs = React.useRef<{ [key: number]: HTMLDivElement | null }>({})
  const selectRefs = React.useRef<{ [key: number]: HTMLSelectElement | null }>({})

  const [formData, setFormData] = useState({
    channel_code: '',
    customer_name: '',
    customer_address: '',
    price: 0,
    shipping_cost: 0,
    discount: 0,
    total_amount: 0,
    payment_method: 'โอน',
    promotion: '',
    payment_date: '',
    payment_time: '',
  })
  const [taxInvoiceData, setTaxInvoiceData] = useState({
    company_name: '',
    address: '',
    tax_id: '',
    items_note: '',
  })
  const [cashBillData, setCashBillData] = useState({
    company_name: '',
    address: '',
    items_note: '',
  })

  async function loadSlipImages(billNo: string) {
    try {
      const folderName = `slip${billNo}`
      const { data: files, error } = await supabase.storage
        .from('slip-images')
        .list(folderName, { limit: 100 })

      if (error) {
        console.error('Error loading slip images:', error)
        return
      }

      if (!files || files.length === 0) {
        setUploadedSlipPaths([])
        return
      }

      // Convert to storage paths (bucket/path/to/file)
      const storagePaths = files
        .filter(file => file.name && !file.name.endsWith('/'))
        .map(file => `slip-images/${folderName}/${file.name}`)
        .sort()

      setUploadedSlipPaths(storagePaths)
    } catch (error) {
      console.error('Error loading slip images:', error)
    }
  }

  async function loadBankSettings() {
    try {
      const { data, error } = await supabase
        .from('bank_settings')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })

      if (error) throw error
      setBankSettings(data || [])
    } catch (error) {
      console.error('Error loading bank settings:', error)
    }
  }

  useEffect(() => {
    loadInitialData()
    loadBankSettings()
    async function loadOrderData() {
      if (order) {
        setPreBillNo(order.bill_no || null)
        setFormData({
          channel_code: order.channel_code,
          customer_name: order.customer_name,
          customer_address: order.customer_address,
          price: order.price,
          shipping_cost: order.shipping_cost,
          discount: order.discount,
          total_amount: order.total_amount,
          payment_method: order.payment_method || 'โอน',
          promotion: order.promotion || '',
          payment_date: order.payment_date || '',
          payment_time: order.payment_time || '',
        })

        let orderItems = order.order_items || []
        if (orderItems.length === 0 && order.id) {
          const { data: itemsData, error } = await supabase
            .from('or_order_items')
            .select('*')
            .eq('order_id', order.id)
            .order('created_at', { ascending: true })

          if (error) {
            console.error('Error loading order items:', error)
          } else if (itemsData) {
            orderItems = itemsData
          }
        }

        if (orderItems && orderItems.length > 0) {
          const loadedItems = orderItems.map(item => ({ ...item }))
          setItems(loadedItems)
          const searchTerms: { [key: number]: string } = {}
          loadedItems.forEach((item, idx) => {
            if (item.product_name) {
              searchTerms[idx] = item.product_name
            }
          })
          setProductSearchTerm(searchTerms)
        } else {
          setItems([{ product_type: 'ชั้น1' }])
        }

        if (order.billing_details) {
          const bd = order.billing_details
          setShowTaxInvoice(bd.request_tax_invoice || false)
          setShowCashBill(bd.request_cash_bill || false)
          if (bd.request_tax_invoice) {
            setTaxInvoiceData({
              company_name: bd.tax_customer_name || '',
              address: bd.tax_customer_address || '',
              tax_id: bd.tax_id || '',
              items_note: '',
            })
          }
          if (bd.request_cash_bill) {
            setCashBillData({
              company_name: bd.tax_customer_name || '',
              address: bd.tax_customer_address || '',
              items_note: '',
            })
          }
        }

        if (order.bill_no) {
          await loadSlipImages(order.bill_no)
        } else {
          setUploadedSlipPaths([])
        }
      } else {
        setItems([{ product_type: 'ชั้น1' }])
        setUploadedSlipUrls([])
        setPreBillNo(null)
      }
    }
    loadOrderData()
  }, [order])

  async function loadInitialData() {
    try {
      const [productsRes, patternsRes, channelsRes, inkTypesRes, fontsRes] = await Promise.all([
        supabase.from('pr_products').select('*').eq('is_active', true),
        supabase.from('cp_cartoon_patterns').select('*').eq('is_active', true),
        supabase.from('channels').select('channel_code, channel_name'),
        supabase.from('ink_types').select('id, ink_name').order('ink_name'),
        supabase.from('fonts').select('font_code, font_name').eq('is_active', true),
      ])

      if (productsRes.data) setProducts(productsRes.data)
      if (patternsRes.data) setCartoonPatterns(patternsRes.data)
      if (channelsRes.data) setChannels(channelsRes.data)
      if (inkTypesRes.data) setInkTypes(inkTypesRes.data)
      if (fontsRes.data) setFonts(fontsRes.data)
    } catch (error) {
      console.error('Error loading data:', error)
    }
  }

  // คำนวณราคารวมจากรายการสินค้า
  function calculateItemsTotal() {
    const total = items.reduce((sum, item) => {
      const quantity = item.quantity || 1
      const unitPrice = item.unit_price || 0
      return sum + (quantity * unitPrice)
    }, 0)
    return total
  }

  // คำนวณยอดสุทธิ
  function calculateTotal() {
    const itemsTotal = calculateItemsTotal()
    const subtotal = itemsTotal + formData.shipping_cost - formData.discount
    setFormData(prev => ({ ...prev, price: itemsTotal, total_amount: subtotal }))
  }

  useEffect(() => {
    calculateTotal()
  }, [items, formData.shipping_cost, formData.discount])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return

    // Validation สำหรับบันทึก "รอลงข้อมูล"
    if (!formData.channel_code || formData.channel_code.trim() === '') {
      alert('กรุณาเลือกช่องทาง')
      return
    }

    if (!formData.customer_name || formData.customer_name.trim() === '') {
      alert('กรุณากรอกชื่อลูกค้า')
      return
    }

    if (!formData.customer_address || formData.customer_address.trim() === '') {
      alert('กรุณากรอกที่อยู่ลูกค้า')
      return
    }

    // พยายาม match สินค้าที่ไม่มี product_id แต่มี product_name
    let hasUpdates = false
    const updatedItems = items.map((item, index) => {
      if (!item.product_id && item.product_name?.trim()) {
        const searchName = item.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
        
        // พยายาม match สินค้าจากชื่อ (case-insensitive, normalize spaces)
        let matchedProduct = products.find(
          p => p.product_name.toLowerCase().trim().replace(/\s+/g, ' ') === searchName
        )
        
        // ถ้ายังไม่ match ลอง match แบบ partial (ถ้าชื่อสินค้าที่พิมพ์เป็นส่วนหนึ่งของชื่อสินค้าในฐานข้อมูล)
        if (!matchedProduct) {
          matchedProduct = products.find(
            p => {
              const dbName = p.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
              return dbName.includes(searchName) || searchName.includes(dbName)
            }
          )
        }
        
        if (matchedProduct) {
          console.log(`Auto-matched product for item ${index}:`, {
            searched: item.product_name,
            found: matchedProduct.product_name
          })
          hasUpdates = true
          return { ...item, product_id: matchedProduct.id, product_name: matchedProduct.product_name }
        } else {
          console.warn(`Could not match product for item ${index}:`, {
            searched: item.product_name,
            available_products: products.map(p => p.product_name).slice(0, 10)
          })
        }
      }
      return item
    })
    
    // อัพเดต items ถ้ามีการ match
    if (hasUpdates) {
      setItems(updatedItems)
      // รอ state อัพเดตแล้วค่อยบันทึก
      setTimeout(async () => {
        await handleSubmitInternal(updatedItems, 'รอลงข้อมูล')
      }, 100)
      return
    }
    
    // ตรวจสอบว่ามีรายการสินค้าที่มี product_id หรือไม่
    const itemsWithProduct = items.filter(item => item.product_id)
    if (itemsWithProduct.length === 0) {
      // ตรวจสอบว่ามีรายการที่สร้างไว้แล้วหรือไม่
      const hasItems = items.length > 0
      if (hasItems) {
        alert('กรุณาเลือกสินค้าจากรายการที่สร้างไว้ (กรุณาเลือกสินค้าจาก dropdown)')
      } else {
        alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      }
      return
    }

    // ตรวจสอบว่ารายการสินค้าทุกรายการมีราคา/หน่วยหรือไม่
    const itemsWithoutPrice = itemsWithProduct.filter(item => !item.unit_price || item.unit_price <= 0)
    if (itemsWithoutPrice.length > 0) {
      const itemNames = itemsWithoutPrice.map(item => item.product_name || 'สินค้า').join(', ')
      alert(`กรุณากรอกราคา/หน่วยสำหรับรายการสินค้าทั้งหมด\n\nรายการที่ยังไม่มีราคา:\n${itemNames}`)
      return
    }

      await handleSubmitInternal(items, 'รอลงข้อมูล')
  }

  async function handleSubmitInternal(itemsToSave: typeof items, targetStatus: 'รอลงข้อมูล' | 'ลงข้อมูลเสร็จสิ้น' = 'รอลงข้อมูล') {
    if (!user) {
      console.error('User not found')
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      // คำนวณราคารวมจากรายการสินค้า
      const calculatedPrice = itemsToSave
        .filter(item => item.product_id)
        .reduce((sum, item) => {
          const quantity = item.quantity || 1
          const unitPrice = item.unit_price || 0
          return sum + (quantity * unitPrice)
        }, 0)
      const calculatedTotal = calculatedPrice + formData.shipping_cost - formData.discount
      
      // แก้ไขปัญหา date field - ถ้าเป็น empty string ให้เป็น null
      const paymentDate = formData.payment_date && formData.payment_date.trim() !== '' 
        ? formData.payment_date 
        : null
      const paymentTime = formData.payment_time && formData.payment_time.trim() !== '' 
        ? formData.payment_time 
        : null
      
      // เตรียมข้อมูล billing_details
      const billingDetails = {
        request_tax_invoice: showTaxInvoice,
        request_cash_bill: showCashBill,
        tax_customer_name: showTaxInvoice ? taxInvoiceData.company_name : (showCashBill ? cashBillData.company_name : null),
        tax_customer_address: showTaxInvoice ? taxInvoiceData.address : (showCashBill ? cashBillData.address : null),
        tax_id: showTaxInvoice ? taxInvoiceData.tax_id : null,
        tax_items: (showTaxInvoice || showCashBill) ? itemsToSave
          .filter(item => item.product_id)
          .map(item => ({
            product_name: item.product_name || '',
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
          })) : []
      }
      
      const orderData = {
        ...formData,
        price: calculatedPrice,
        total_amount: calculatedTotal,
        payment_date: paymentDate,
        payment_time: paymentTime,
        status: targetStatus,
        admin_user: user.username || user.email,
        entry_date: new Date().toISOString().slice(0, 10),
        billing_details: (showTaxInvoice || showCashBill) ? billingDetails : null,
      }

      let orderId: string
      let currentBillNo: string | null = null
      if (order) {
        const { error } = await supabase
          .from('or_orders')
          .update(orderData)
          .eq('id', order.id)
        if (error) throw error
        orderId = order.id
        currentBillNo = order.bill_no || null
      } else {
        // Use pre-generated bill number if available
        const billNo = preBillNo || await generateBillNo(formData.channel_code)
        const { data, error } = await supabase
          .from('or_orders')
          .insert({ ...orderData, bill_no: billNo })
          .select()
          .single()
        if (error) throw error
        orderId = data.id
        currentBillNo = data.bill_no || billNo
      }

      // Save order items
      console.log('All items before filtering:', itemsToSave)
      console.log('Items with product_id:', itemsToSave.filter(item => item.product_id))
      
      if (itemsToSave.length > 0) {
        // ลบรายการเก่าก่อน (ถ้ามี)
        const { error: deleteError } = await supabase
          .from('or_order_items')
          .delete()
          .eq('order_id', orderId)
        
        if (deleteError) {
          console.error('Error deleting old order items:', deleteError)
          // ไม่ throw error เพราะอาจจะไม่มีรายการเก่า
        }
        
        // กรองเฉพาะรายการที่มี product_id และเตรียมข้อมูล
        const itemsToInsert = itemsToSave
          .filter((item, idx) => {
            if (!item.product_id) {
              console.warn(`Item at index ${idx} missing product_id:`, {
                product_name: item.product_name,
                product_id: item.product_id,
                full_item: item
              })
              return false
            }
            return true
          })
          .map((item, index) => {
            // สร้าง item_uid ที่ไม่ซ้ำกัน โดยใช้ timestamp + index + random
            const timestamp = Date.now()
            const randomStr = Math.random().toString(36).substring(2, 9)
            const itemUid = `${formData.channel_code}-${timestamp}-${index}-${randomStr}`
            
            return {
              order_id: orderId,
              item_uid: itemUid,
              product_id: item.product_id!,
              product_name: item.product_name || '',
              quantity: item.quantity || 1,
              unit_price: item.unit_price || 0,
              ink_color: item.ink_color || null,
              product_type: item.product_type || 'ชั้น1',
              cartoon_pattern: item.cartoon_pattern || null,
              line_pattern: item.line_pattern || null,
              font: item.font || null,
              line_1: item.line_1 || null,
              line_2: item.line_2 || null,
              line_3: item.line_3 || null,
              notes: item.notes || null,
              file_attachment: item.file_attachment || null,
            }
          })
        
        console.log('Items to insert:', itemsToInsert.length, itemsToInsert)
        console.log('Total items:', items.length)
        console.log('Items with product_id:', items.filter(item => item.product_id).length)
        
        // บันทึกรายการสินค้า
        if (itemsToInsert.length > 0) {
          const { data: insertedData, error: itemsError } = await supabase
            .from('or_order_items')
            .insert(itemsToInsert)
            .select()
          
          if (itemsError) {
            console.error('Error inserting order items:', itemsError)
            console.error('Items that failed to insert:', itemsToInsert)
            throw new Error(`ไม่สามารถบันทึกรายการสินค้าได้: ${itemsError.message}`)
          }
          
          console.log('Successfully inserted order items:', insertedData)
        } else {
          console.warn('No items to insert - all items are missing product_id')
          console.warn('All items:', items)
          const itemsWithoutProductId = items.map((item, idx) => ({
            index: idx,
            product_name: item.product_name,
            product_id: item.product_id,
            has_product_name: !!item.product_name,
            has_product_id: !!item.product_id
          }))
          console.warn('Items without product_id:', itemsWithoutProductId)
          alert('คำเตือน: ไม่มีรายการสินค้าที่จะบันทึก กรุณาเลือกสินค้าจาก dropdown ก่อนบันทึก\n\nตรวจสอบ Console (F12) เพื่อดูรายละเอียด')
        }
      } else {
        console.warn('No items in the form')
        alert('กรุณาเพิ่มรายการสินค้าก่อนบันทึก')
      }

      // ถ้าเป็น "ลงข้อมูลเสร็จสิ้น" และมีสลิปที่อัพโหลดไว้ ให้ตรวจสอบสลิป
      if (targetStatus === 'ลงข้อมูลเสร็จสิ้น' && uploadedSlipPaths.length > 0) {
        try {
          await verifyUploadedSlips(orderId, uploadedSlipPaths, calculatedTotal)
        } catch (error: any) {
          console.error('Error verifying slips:', error)
          // Error handling is done inside verifyUploadedSlips
          // If status was updated to "ตรวจสอบไม่ผ่าน", verifyUploadedSlips will return (not throw)
          // If there's a real error, show alert and refresh UI anyway
          alert('เกิดข้อผิดพลาดในการตรวจสอบสลิป: ' + error.message)
          // Refresh UI even if there's an error (status might have been updated)
          onSave()
          return // Don't continue with normal success flow
        }
      }

      const statusText = targetStatus === 'ลงข้อมูลเสร็จสิ้น' ? 'บันทึกข้อมูลครบ' : 'บันทึก (รอลงข้อมูล)'
      alert(order ? `อัปเดตข้อมูลสำเร็จ (${statusText})` : `บันทึกสำเร็จ! (${statusText})`)
      
      // โหลดรูปสลิปกลับมา (ถ้ามี bill_no)
      // ไม่ล้าง uploadedSlipPaths เพราะรูปสลิปถูกอัพโหลดไปแล้วใน storage
      if (currentBillNo) {
        console.log('[บันทึกออเดอร์] โหลดรูปสลิปกลับมาสำหรับ bill_no:', currentBillNo)
        await loadSlipImages(currentBillNo)
      } else {
        // ถ้าไม่มี bill_no ให้ล้าง uploadedSlipPaths (ไม่น่าจะเกิดขึ้น)
        console.warn('[บันทึกออเดอร์] ไม่มี bill_no ไม่สามารถโหลดรูปสลิปได้')
        if (uploadedSlipPaths.length > 0) {
          setUploadedSlipPaths([])
        }
      }
      
      onSave()
    } catch (error: any) {
      console.error('Error saving order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  // ฟังก์ชันตรวจสอบสลิปที่อัพโหลดไว้ (ใช้ระบบใหม่)
  async function verifyUploadedSlips(orderId: string, slipStoragePaths: string[], orderAmount: number) {
    try {
      // Get order data including status
      const { data: orderData, error: orderError } = await supabase
        .from('or_orders')
        .select('channel_code, status, total_amount')
        .eq('id', orderId)
        .single()

      if (orderError || !orderData) {
        throw new Error('ไม่พบข้อมูลออเดอร์: ' + (orderError?.message || 'Unknown error'))
      }

      // ถ้ารายการอยู่ที่ "ตรวจสอบแล้ว" และยอดเงินเท่าเดิม ไม่ต้องตรวจสอบซ้ำ
      if (orderData.status === 'ตรวจสอบแล้ว' && 
          orderData.total_amount && 
          Math.abs(orderData.total_amount - orderAmount) < 0.01) {
        console.log('[Verify Slips] Order already verified with same amount, skipping verification')
        return
      }

      const channelCode = orderData.channel_code

      // Get bank settings for this channel
      // First, get bank_setting_ids for this channel
      const { data: bankChannelsData, error: bankChannelsError } = await supabase
        .from('bank_settings_channels')
        .select('bank_setting_id')
        .eq('channel_code', channelCode)

      if (bankChannelsError) {
        console.error('[Verify Slips] Error loading bank settings channels:', bankChannelsError)
      }

      // Find active bank setting for this channel
      let bankAccount: string | undefined
      let bankCode: string | undefined

      if (bankChannelsData && bankChannelsData.length > 0) {
        // Get bank_setting_ids
        const bankSettingIds = bankChannelsData.map((bsc: any) => bsc.bank_setting_id)

        // Load bank settings
        const { data: bankSettingsData, error: bankError } = await supabase
          .from('bank_settings')
          .select('account_number, bank_code, account_name, is_active')
          .in('id', bankSettingIds)
          .eq('is_active', true)
          .limit(1)

        if (bankError) {
          console.error('[Verify Slips] Error loading bank settings:', bankError)
        } else if (bankSettingsData && bankSettingsData.length > 0) {
          bankAccount = bankSettingsData[0].account_number
          bankCode = bankSettingsData[0].bank_code
        }
      }

      // Fallback: if no channel-specific bank setting, use any active bank setting
      if (!bankAccount && bankSettings.length > 0) {
        const activeBankSettings = bankSettings.filter(b => b.is_active)
        if (activeBankSettings.length > 0) {
          bankAccount = activeBankSettings[0].account_number
          bankCode = activeBankSettings[0].bank_code
        }
      }

      if (!bankAccount) {
        console.warn('[Verify Slips] No active bank settings found for channel:', channelCode)
      }

      console.log(`[Verify Slips] Starting verification for ${slipStoragePaths.length} slip(s)`)
      console.log(`[Verify Slips] Channel: ${channelCode}`)
      console.log(`[Verify Slips] Expected amount: ${orderAmount}`)
      console.log(`[Verify Slips] Bank account: ${bankAccount}, Bank code: ${bankCode}`)

      // Verify slips using new API
      const results = await verifyMultipleSlipsFromStorage(
        slipStoragePaths,
        orderAmount,
        bankAccount,
        bankCode
      )

      // Log all results for debugging
      console.log('[Verify Slips] All verification results:', results)
      results.forEach((result, index) => {
        console.log(`[Verify Slips] Result ${index + 1}:`, {
          success: result.success,
          amount: result.amount,
          error: result.error,
          hasEasyslipResponse: !!result.easyslipResponse,
          easyslipResponseKeys: result.easyslipResponse ? Object.keys(result.easyslipResponse) : [],
        })
      })

      // Convert storage paths to URLs for saving (needed for logs)
      const slipUrls = slipStoragePaths.map(storagePath => {
        const [bucket, ...pathParts] = storagePath.split('/')
        const filePath = pathParts.join('/')
        const { data: urlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(filePath)
        return urlData.publicUrl
      })

      const verifiedBy = user?.id || null

      // Check for duplicate slips BEFORE saving
      // Check by transRef or amount + date combination
      const duplicateCheckPromises = results.map(async (r: any) => {
        if (!r.easyslipResponse || r.amount === undefined) {
          return { isDuplicate: false, duplicateOrderId: null }
        }
        
        const transRef = r.easyslipResponse?.data?.transRef
        const amount = r.amount
        const date = r.easyslipResponse?.data?.date
        
        // Check by transRef first (most reliable)
        if (transRef) {
          const { data: duplicateByRef } = await supabase
            .from('ac_verified_slips')
            .select('order_id')
            .eq('easyslip_trans_ref', transRef)
            .neq('order_id', orderId)
            .limit(1)
          
          if (duplicateByRef && duplicateByRef.length > 0) {
            return { isDuplicate: true, duplicateOrderId: duplicateByRef[0].order_id }
          }
        }
        
        // Check by amount + date combination (fallback)
        if (amount && date) {
          const { data: duplicateByAmountDate } = await supabase
            .from('ac_verified_slips')
            .select('order_id')
            .eq('verified_amount', amount)
            .eq('easyslip_date', date)
            .neq('order_id', orderId)
            .limit(1)
          
          if (duplicateByAmountDate && duplicateByAmountDate.length > 0) {
            return { isDuplicate: true, duplicateOrderId: duplicateByAmountDate[0].order_id }
          }
        }
        
        return { isDuplicate: false, duplicateOrderId: null }
      })
      
      const duplicateChecks = await Promise.all(duplicateCheckPromises)

      // Save verification logs FIRST (for all attempts, success & failure)
      // This must be done before throwing errors, so we don't lose the data
      const logsToInsert = results.map((r: any, idx) => {
        const duplicateCheck = duplicateChecks[idx]
        const isDuplicate = duplicateCheck.isDuplicate
        
        // Combine error, message, and validationErrors for better logging
        let errorMessage = r.error || null
        if (isDuplicate) {
          errorMessage = 'สลิปซ้ำ (พบในออเดอร์อื่น)'
        } else if (!errorMessage && r.validationErrors && r.validationErrors.length > 0) {
          // If validation errors exist, use them
          errorMessage = r.validationErrors.join(', ')
        } else if (!errorMessage && r.message && !r.success) {
          // If no error but has message and failed, use message
          errorMessage = r.message
        }
        
        return {
          order_id: orderId,
          slip_image_url: slipUrls[idx],
          slip_storage_path: slipStoragePaths[idx],
          verified_by: verifiedBy,
          status: (r.success && !isDuplicate) ? 'passed' : 'failed',
          verified_amount: r.amount || 0,
          error: errorMessage,
          easyslip_response: r.easyslipResponse || null,
        }
      })

      // Log what we're about to insert
      console.log('[Verify Slips] Logs to insert:', logsToInsert.map((log, idx) => ({
        index: idx + 1,
        status: log.status,
        hasEasyslipResponse: !!log.easyslip_response,
        easyslipResponseType: log.easyslip_response ? typeof log.easyslip_response : 'null',
        easyslipResponseKeys: log.easyslip_response && typeof log.easyslip_response === 'object' 
          ? Object.keys(log.easyslip_response) 
          : [],
        error: log.error,
      })))

      if (logsToInsert.length > 0) {
        const { data: insertedLogs, error: logError } = await supabase
          .from('ac_slip_verification_logs')
          .insert(logsToInsert)
          .select()

        if (logError) {
          console.error('[Verify Slips] Error inserting verification logs:', logError)
        } else {
          console.log('[Verify Slips] Successfully inserted logs:', insertedLogs?.length || 0, 'records')
        }
      }

      // Process results
      let totalAmount = 0
      const errors: string[] = []
      const successfulVerifications: number[] = []
      const validationErrors: string[] = []

      results.forEach((result, index) => {
        const duplicateCheck = duplicateChecks[index]
        const isDuplicate = duplicateCheck.isDuplicate
        
        // If duplicate, treat as failed
        if (isDuplicate) {
          errors.push(`สลิป ${index + 1}: สลิปซ้ำ (พบในออเดอร์อื่น)`)
        } else if (result.success) {
          totalAmount += result.amount || 0
          successfulVerifications.push(index + 1)
          
          // Check for validation errors from result.validationErrors array or result.error
          if (result.validationErrors && Array.isArray(result.validationErrors) && result.validationErrors.length > 0) {
            validationErrors.push(...result.validationErrors.map((err: string) => `สลิป ${index + 1}: ${err}`))
          } else if (result.error && result.error.includes('ไม่ตรง')) {
            validationErrors.push(`สลิป ${index + 1}: ${result.error}`)
          }
        } else {
          errors.push(`สลิป ${index + 1}: ${result.error || result.message || 'การตรวจสอบล้มเหลว'}`)
        }
      })

      // Save ALL EasySlip responses to ac_verified_slips FIRST (before validation)
      // This stores the raw response data, then we'll update validation status
      const slipsToInsert = results
        .map((r: any, idx) => {
          // Skip if no EasySlip response received
          if (!r.easyslipResponse || r.amount === undefined) {
            return null
          }
          
          const duplicateCheck = duplicateChecks[idx]
          const isDuplicate = duplicateCheck.isDuplicate
          
          // Determine validation status
          let validationStatus: 'pending' | 'passed' | 'failed' = 'pending'
          const validationErrors: string[] = []
          
          // Add duplicate error if found
          if (isDuplicate) {
            validationErrors.push(`สลิปซ้ำ (พบในออเดอร์อื่น)`)
            validationStatus = 'failed'
          } else if (r.success === true) {
            validationStatus = 'passed'
          } else if (r.success === false) {
            validationStatus = 'failed'
            // Collect validation errors
            if (r.validationErrors && Array.isArray(r.validationErrors)) {
              validationErrors.push(...r.validationErrors)
            } else if (r.error) {
              validationErrors.push(r.error)
            } else if (r.message && !r.success) {
              validationErrors.push(r.message)
            }
          }
          
          return {
            order_id: orderId,
            slip_image_url: slipUrls[idx],
            verified_amount: r.amount || 0,
            verified_by: verifiedBy,
            easyslip_response: r.easyslipResponse || null,
            easyslip_trans_ref: r.easyslipResponse?.data?.transRef || null,
            easyslip_date: r.easyslipResponse?.data?.date || null,
            easyslip_receiver_bank_id: r.easyslipResponse?.data?.receiver?.bank?.id || null,
            easyslip_receiver_account: r.easyslipResponse?.data?.receiver?.account?.bank?.account || null,
            // Validation status fields
            is_validated: r.success !== undefined || isDuplicate, // true if we got a validation result
            validation_status: validationStatus,
            validation_errors: validationErrors.length > 0 ? validationErrors : null,
            expected_amount: orderAmount || null,
            expected_bank_account: bankAccount || null,
            expected_bank_code: bankCode || null,
            // Individual validation statuses
            account_name_match: r.accountNameMatch !== undefined ? r.accountNameMatch : null,
            bank_code_match: r.bankCodeMatch !== undefined ? r.bankCodeMatch : null,
            amount_match: r.amountMatch !== undefined ? r.amountMatch : null,
          }
        })
        .filter((s: any) => s !== null) // Remove null entries

      // Log what we're about to insert into ac_verified_slips
      console.log('[Verify Slips] All slips to insert (before validation):', slipsToInsert.map((slip, idx) => ({
        index: idx + 1,
        verified_amount: slip.verified_amount,
        hasEasyslipResponse: !!slip.easyslip_response,
        validation_status: slip.validation_status,
        validation_errors: slip.validation_errors,
        is_validated: slip.is_validated,
      })))

      // Insert or Update ALL slips (regardless of validation result)
      // Handle duplicate slip_image_url (unique constraint) by checking and updating existing records
      if (slipsToInsert.length > 0) {
        const slipUrls = slipsToInsert.map((s: any) => s.slip_image_url).filter(Boolean)
        
        if (slipUrls.length > 0) {
          // Check existing records for this order
          const { data: existingSlips, error: checkError } = await supabase
            .from('ac_verified_slips')
            .select('id, slip_image_url, order_id')
            .in('slip_image_url', slipUrls)
            .eq('order_id', orderId)

          if (checkError) {
            console.error('[Verify Slips] Error checking existing slips:', checkError)
          }

          // Separate into inserts and updates based on existing records for THIS order
          const existingUrlsForThisOrder = new Set(existingSlips?.map((s: any) => s.slip_image_url) || [])
          const toInsert = slipsToInsert.filter((s: any) => !existingUrlsForThisOrder.has(s.slip_image_url))
          const toUpdate = slipsToInsert.filter((s: any) => existingUrlsForThisOrder.has(s.slip_image_url))

          // Insert new records (handle duplicate key errors gracefully)
          if (toInsert.length > 0) {
            try {
              const { data: insertedData, error: insertError } = await supabase
                .from('ac_verified_slips')
                .insert(toInsert)
                .select()

              if (insertError) {
                console.error('[Verify Slips] Error inserting verified slips:', insertError)
                
                // If it's a duplicate key error (slip_image_url exists in another order),
                // update the existing record to point to this order instead
                if (insertError.message.includes('duplicate key') || insertError.code === '23505' || insertError.message.includes('ac_verified_slips_slip_image_url_key')) {
                  console.log('[Verify Slips] Duplicate key detected for slip_image_url, updating existing records instead')
                  
                  // Update existing records by slip_image_url (regardless of order_id)
                  for (const slip of toInsert) {
                    const { error: updateError } = await supabase
                      .from('ac_verified_slips')
                      .update({
                        order_id: slip.order_id,
                        verified_amount: slip.verified_amount,
                        verified_by: slip.verified_by,
                        easyslip_response: slip.easyslip_response,
                        easyslip_trans_ref: slip.easyslip_trans_ref,
                        easyslip_date: slip.easyslip_date,
                        easyslip_receiver_bank_id: slip.easyslip_receiver_bank_id,
                        easyslip_receiver_account: slip.easyslip_receiver_account,
                        is_validated: slip.is_validated,
                        validation_status: slip.validation_status,
                        validation_errors: slip.validation_errors,
                        expected_amount: slip.expected_amount,
                        expected_bank_account: slip.expected_bank_account,
                        expected_bank_code: slip.expected_bank_code,
                        account_name_match: slip.account_name_match,
                        bank_code_match: slip.bank_code_match,
                        amount_match: slip.amount_match,
                      })
                      .eq('slip_image_url', slip.slip_image_url)

                    if (updateError) {
                      console.error('[Verify Slips] Error updating verified slip:', updateError, 'for slip:', slip.slip_image_url)
                      // Continue with other slips even if one fails
                    } else {
                      console.log('[Verify Slips] Successfully updated existing verified slip:', slip.slip_image_url)
                    }
                  }
                } else {
                  throw new Error('เกิดข้อผิดพลาดในการบันทึกสลิปที่ตรวจสอบแล้ว: ' + insertError.message)
                }
              } else {
                console.log('[Verify Slips] Successfully inserted verified slips:', insertedData?.length || 0, 'records')
              }
            } catch (error: any) {
              // If insert fails with duplicate key, try to update instead
              if (error.message && (error.message.includes('duplicate key') || error.message.includes('ac_verified_slips_slip_image_url_key'))) {
                console.log('[Verify Slips] Catch: Duplicate key detected, updating existing records')
                for (const slip of toInsert) {
                  const { error: updateError } = await supabase
                    .from('ac_verified_slips')
                    .update({
                      order_id: slip.order_id,
                      verified_amount: slip.verified_amount,
                      verified_by: slip.verified_by,
                      easyslip_response: slip.easyslip_response,
                      easyslip_trans_ref: slip.easyslip_trans_ref,
                      easyslip_date: slip.easyslip_date,
                      easyslip_receiver_bank_id: slip.easyslip_receiver_bank_id,
                      easyslip_receiver_account: slip.easyslip_receiver_account,
                      is_validated: slip.is_validated,
                      validation_status: slip.validation_status,
                      validation_errors: slip.validation_errors,
                      expected_amount: slip.expected_amount,
                      expected_bank_account: slip.expected_bank_account,
                      expected_bank_code: slip.expected_bank_code,
                      account_name_match: slip.account_name_match,
                      bank_code_match: slip.bank_code_match,
                      amount_match: slip.amount_match,
                    })
                    .eq('slip_image_url', slip.slip_image_url)

                  if (updateError) {
                    console.error('[Verify Slips] Error updating verified slip in catch:', updateError)
                  }
                }
              } else {
                throw error
              }
            }
          }

          // Update existing records for this order
          if (toUpdate.length > 0) {
            console.log('[Verify Slips] Updating', toUpdate.length, 'existing verified slips for this order')
            
            for (const slip of toUpdate) {
              const { error: updateError } = await supabase
                .from('ac_verified_slips')
                .update({
                  verified_amount: slip.verified_amount,
                  verified_by: slip.verified_by,
                  easyslip_response: slip.easyslip_response,
                  easyslip_trans_ref: slip.easyslip_trans_ref,
                  easyslip_date: slip.easyslip_date,
                  easyslip_receiver_bank_id: slip.easyslip_receiver_bank_id,
                  easyslip_receiver_account: slip.easyslip_receiver_account,
                  is_validated: slip.is_validated,
                  validation_status: slip.validation_status,
                  validation_errors: slip.validation_errors,
                  expected_amount: slip.expected_amount,
                  expected_bank_account: slip.expected_bank_account,
                  expected_bank_code: slip.expected_bank_code,
                  account_name_match: slip.account_name_match,
                  bank_code_match: slip.bank_code_match,
                  amount_match: slip.amount_match,
                })
                .eq('slip_image_url', slip.slip_image_url)
                .eq('order_id', orderId)

              if (updateError) {
                console.error('[Verify Slips] Error updating verified slip:', updateError, 'for slip:', slip.slip_image_url)
              }
            }
            
            console.log('[Verify Slips] Successfully updated verified slips:', toUpdate.length, 'records')
          }
        }
      } else {
        console.log('[Verify Slips] No slips to insert (no EasySlip response received)')
      }

      // Now process validation results to determine order status
      // If all slips failed validation, mark as "ตรวจสอบไม่ผ่าน"
      if (successfulVerifications.length === 0) {
        const { error: updateError } = await supabase
          .from('or_orders')
          .update({ status: 'ตรวจสอบไม่ผ่าน' })
          .eq('id', orderId)

        if (updateError) {
          console.error('Error updating order status:', updateError)
          throw new Error('เกิดข้อผิดพลาดในการอัพเดตสถานะออเดอร์: ' + updateError.message)
        }

        // Status updated successfully - show alert and return (don't throw error)
        // This allows the UI to refresh and show the order in "ตรวจสอบไม่ผ่าน" menu
        const errorMessage = `ตรวจสอบสลิปไม่สำเร็จทั้งหมด:\n${errors.join('\n')}\n\nบิลถูกย้ายไปเมนู "ตรวจสอบไม่ผ่าน"\n\nคำแนะนำ:\n- ตรวจสอบว่า Edge Function ตั้งค่า Secrets ถูกต้องแล้ว\n- ตรวจสอบว่า EasySlip API เปิดใช้งานแล้ว\n- ดู Logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs`
        alert(errorMessage)
        return // Return instead of throwing error so UI can refresh
      }

      // Determine status based on verification results
      let newStatus: string = 'ตรวจสอบไม่ผ่าน'
      let statusMessage = ''

      // Check if amount matches or exceeds
      if (totalAmount >= orderAmount) {
        if (validationErrors.length === 0 && errors.length === 0) {
          // All validations passed - move to "ตรวจสอบแล้ว"
          newStatus = 'ตรวจสอบแล้ว'
          statusMessage = `ตรวจสอบสลิปสำเร็จ! ยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        } else {
          // Amount matches but has validation errors - move to "ตรวจสอบไม่ผ่าน"
          newStatus = 'ตรวจสอบไม่ผ่าน'
          statusMessage = `ยอดเงินถูกต้อง แต่พบข้อผิดพลาดในการตรวจสอบ:\n${validationErrors.join('\n')}\n\nยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        }
      } else {
        // Amount is less than order amount - move to "ตรวจสอบไม่ผ่าน"
        const excessAmount = orderAmount - totalAmount
        const { error: refundError } = await supabase
          .from('ac_refunds')
          .insert({
            order_id: orderId,
            amount: excessAmount,
            reason: `ยอดสลิปไม่พอ (ยอดออเดอร์: ฿${orderAmount.toLocaleString()}, ยอดสลิป: ฿${totalAmount.toLocaleString()})`,
            status: 'pending',
          })

        if (refundError) {
          console.error('Error creating refund record:', refundError)
          throw new Error('เกิดข้อผิดพลาดในการสร้างรายการโอนคืน: ' + refundError.message)
        }

        newStatus = 'ตรวจสอบไม่ผ่าน'
        statusMessage = `ยอดสลิปไม่พอ! ยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()}) - สร้างรายการโอนคืนแล้ว`
      }
      
      // Any verification errors keep as "ตรวจสอบไม่ผ่าน"
      if (errors.length > 0 && successfulVerifications.length < slipStoragePaths.length) {
        newStatus = 'ตรวจสอบไม่ผ่าน'
      }

      // Add error details if any
      if (errors.length > 0) {
        statusMessage += `\n\nสลิปที่สำเร็จ: ${successfulVerifications.join(', ')}\nสลิปที่ล้มเหลว: ${errors.length} ใบ`
      }

      // Update order status
      const { error: updateError } = await supabase
        .from('or_orders')
        .update({ status: newStatus })
        .eq('id', orderId)

      if (updateError) {
        console.error('Error updating order status:', updateError)
        throw new Error('เกิดข้อผิดพลาดในการอัพเดตสถานะออเดอร์: ' + updateError.message)
      }

      alert(statusMessage)
    } catch (error: any) {
      console.error('[Verify Slips] Error:', error)
      throw error
    }
  }

  async function generateBillNo(channelCode: string): Promise<string> {
    const today = new Date()
    const year = today.getFullYear().toString().slice(-2)
    const month = (today.getMonth() + 1).toString().padStart(2, '0')

    const { data } = await supabase
      .from('or_orders')
      .select('bill_no')
      .like('bill_no', `${channelCode}${year}${month}%`)
      .order('bill_no', { ascending: false })
      .limit(1)

    let sequence = 1
    if (data && data.length > 0) {
      const lastBillNo = data[0].bill_no
      const lastSeq = parseInt(lastBillNo.slice(-4)) || 0
      sequence = lastSeq + 1
    }

    return `${channelCode}${year}${month}${sequence.toString().padStart(4, '0')}`
  }

  function addItem() {
    const lastItem = items.length > 0 ? items[items.length - 1] : null
    const newItem = lastItem
      ? { ...lastItem }
      : { product_type: 'ชั้น1' }
    setItems([...items, newItem])

    if (items.length > 0 && lastItem?.product_name) {
      setProductSearchTerm({ ...productSearchTerm, [items.length]: lastItem.product_name })
    } else {
      setProductSearchTerm({ ...productSearchTerm, [items.length]: '' })
    }
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index))
  }

  function updateItem(index: number, field: keyof OrderItem, value: any) {
    const newItems = [...items]
    newItems[index] = { ...newItems[index], [field]: value }
    setItems(newItems)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">ข้อมูลลูกค้า</h3>
          <div className="flex items-center gap-3">
            {(order?.bill_no || preBillNo) && (
              <div className="text-right">
                <span className="text-sm text-gray-500">เลขบิล:</span>
                <span className="ml-2 text-lg font-bold text-blue-600">
                  {order?.bill_no || preBillNo}
                </span>
              </div>
            )}
            {!order?.bill_no && !preBillNo && (
              <button
                type="button"
                onClick={async () => {
                  if (!formData.channel_code || formData.channel_code.trim() === '') {
                    alert('กรุณาเลือกช่องทางก่อนสร้างเลขบิล')
                    return
                  }
                  const billNo = await generateBillNo(formData.channel_code)
                  setPreBillNo(billNo)
                }}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                สร้างบิล
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">ช่องทาง</label>
            <select
              value={formData.channel_code}
              onChange={(e) => setFormData({ ...formData, channel_code: e.target.value })}
              required
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">-- เลือกช่องทาง --</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ชื่อลูกค้า</label>
            <input
              type="text"
              value={formData.customer_name}
              onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
              required
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium mb-1">ที่อยู่ลูกค้า</label>
          <textarea
            value={formData.customer_address}
            onChange={(e) => setFormData({ ...formData, customer_address: e.target.value })}
            required
            rows={4}
            className="w-full px-3 py-2 border rounded-lg"
          />
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow" style={{ position: 'relative', overflow: 'visible' }}>
        <h3 className="text-xl font-bold mb-4">รายการสินค้า</h3>
        <div className="overflow-x-auto" style={{ overflowY: 'visible' }}>
          <table className="w-full border-collapse text-sm" style={{ position: 'relative' }}>
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2">ชื่อสินค้า</th>
                <th className="border p-2">สีหมึก</th>
                <th className="border p-2">ชั้น</th>
                <th className="border p-2">ลายการ์ตูน</th>
                <th className="border p-2">ลายเส้น</th>
                <th className="border p-2">ฟอนต์</th>
                <th className="border p-2">บรรทัด 1</th>
                <th className="border p-2">บรรทัด 2</th>
                <th className="border p-2">บรรทัด 3</th>
                <th className="border p-2">จำนวน</th>
                <th className="border p-2">ราคา/หน่วย</th>
                <th className="border p-2">หมายเหตุ</th>
                <th className="border p-2">ไฟล์แนบ</th>
                <th className="border p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td className="border p-2">
                    <div className="relative">
                      <input
                        type="text"
                        list={`product-list-${index}`}
                        value={productSearchTerm[index] !== undefined ? productSearchTerm[index] : (item.product_name || '')}
                        onChange={(e) => {
                          const searchTerm = e.target.value
                          setProductSearchTerm({ ...productSearchTerm, [index]: searchTerm })
                          
                          // ค้นหาสินค้าที่ตรงกับค่าที่พิมพ์ทันที
                          const matchedProduct = products.find(
                            p => p.product_name.toLowerCase().trim() === searchTerm.toLowerCase().trim()
                          )
                          
                          if (matchedProduct) {
                            updateItem(index, 'product_id', matchedProduct.id)
                            updateItem(index, 'product_name', matchedProduct.product_name)
                          } else if (searchTerm === '') {
                            // ถ้าล้างค่า ให้ล้าง product_id ด้วย
                            updateItem(index, 'product_id', undefined)
                            updateItem(index, 'product_name', undefined)
                          }
                        }}
                        onBlur={(e) => {
                          const inputValue = e.target.value.trim()
                          
                          if (!inputValue) {
                            // ถ้าไม่มีค่าและไม่มี product_id ให้ล้าง
                            if (!item.product_id) {
                              setProductSearchTerm({ ...productSearchTerm, [index]: '' })
                            }
                            return
                          }
                          
                          // ค้นหาสินค้าที่ตรงกับค่าที่พิมพ์
                          const matchedProduct = products.find(
                            p => p.product_name.toLowerCase().trim() === inputValue.toLowerCase().trim()
                          )
                          
                          if (matchedProduct) {
                            // อัพเดตให้ตรงกับสินค้าที่เลือก
                            updateItem(index, 'product_id', matchedProduct.id)
                            updateItem(index, 'product_name', matchedProduct.product_name)
                            setProductSearchTerm({ ...productSearchTerm, [index]: matchedProduct.product_name })
                          } else if (item.product_id) {
                            // ถ้าไม่ตรงกับสินค้าใดๆ แต่มี product_id อยู่แล้ว ให้ใช้ชื่อสินค้าที่เลือกไว้
                            setProductSearchTerm({ ...productSearchTerm, [index]: item.product_name || '' })
                          } else {
                            // ถ้าไม่ตรงและไม่มี product_id ให้ล้าง
                            setProductSearchTerm({ ...productSearchTerm, [index]: '' })
                          }
                        }}
                        placeholder="ค้นหาหรือเลือกสินค้า..."
                        className="w-full px-2 py-1 border rounded min-w-[220px]"
                        autoComplete="off"
                      />
                      <datalist id={`product-list-${index}`}>
                        {(() => {
                          const searchTerm = productSearchTerm[index] || ''
                          const searchLower = searchTerm.toLowerCase().trim()
                          
                          // ตรวจสอบว่าคำค้นหาตรงกับสีหมึกหรือไม่
                          const matchedInk = inkTypes.find(ink => 
                            ink.ink_name.toLowerCase().includes(searchLower)
                          )
                          
                          // ตรวจสอบว่าคำค้นหาตรงกับฟอนต์หรือไม่
                          const matchedFont = fonts.find(font => 
                            font.font_name.toLowerCase().includes(searchLower)
                          )
                          
                          // กรองสินค้าตามเงื่อนไข
                          const filteredProducts = products.filter(p => {
                            // ถ้าไม่มีคำค้นหา ให้แสดงสินค้าทั้งหมด
                            if (!searchLower) return true
                            // ค้นหาในชื่อสินค้า
                            if (p.product_name.toLowerCase().includes(searchLower)) return true
                            // ถ้าคำค้นหาตรงกับสีหมึก ให้แสดงสินค้าทั้งหมด
                            if (matchedInk) return true
                            // ถ้าคำค้นหาตรงกับฟอนต์ ให้แสดงสินค้าทั้งหมด
                            if (matchedFont) return true
                            return false
                          })
                          
                          return filteredProducts.map((p) => (
                            <option key={p.id} value={p.product_name} data-id={p.id} />
                          ))
                        })()}
                      </datalist>
                    </div>
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.ink_color || ''}
                      onChange={(e) => updateItem(index, 'ink_color', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[150px]"
                    >
                      <option value="">-- เลือกสี --</option>
                      {inkTypes.map((ink) => (
                        <option key={ink.id} value={ink.ink_name}>
                          {ink.ink_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.product_type || 'ชั้น1'}
                      onChange={(e) => updateItem(index, 'product_type', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[60px]"
                    >
                      <option value="ชั้น1">ชั้น1</option>
                      <option value="ชั้น2">ชั้น2</option>
                      <option value="ชั้น3">ชั้น3</option>
                      <option value="ชั้น4">ชั้น4</option>
                      <option value="ชั้น5">ชั้น5</option>
                    </select>
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.cartoon_pattern || ''}
                      onChange={(e) => updateItem(index, 'cartoon_pattern', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[70px]"
                      placeholder="ลายการ์ตูน"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_pattern || ''}
                      onChange={(e) => updateItem(index, 'line_pattern', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[70px]"
                      placeholder="ลายเส้น"
                    />
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.font || ''}
                      onChange={(e) => updateItem(index, 'font', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    >
                      <option value="">-- เลือกฟอนต์ --</option>
                      {fonts.map((font) => (
                        <option key={font.font_code} value={font.font_name}>
                          {font.font_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_1 || ''}
                      onChange={(e) => updateItem(index, 'line_1', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_2 || ''}
                      onChange={(e) => updateItem(index, 'line_2', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_3 || ''}
                      onChange={(e) => updateItem(index, 'line_3', e.target.value)}
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="number"
                      value={item.quantity || 1}
                      onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value) || 1)}
                      min="1"
                      className="w-full px-2 py-1 border rounded min-w-[50px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="number"
                      value={item.unit_price || ''}
                      onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                      onFocus={(e) => {
                        if (e.target.value === '0') {
                          e.target.value = ''
                        }
                      }}
                      onBlur={(e) => {
                        if (e.target.value === '') {
                          updateItem(index, 'unit_price', 0)
                        }
                      }}
                      step="0.01"
                      placeholder="0.00"
                      className="w-full px-2 py-1 border rounded min-w-[80px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.notes || ''}
                      onChange={(e) => updateItem(index, 'notes', e.target.value)}
                      placeholder="หมายเหตุเพิ่มเติม"
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.file_attachment || ''}
                      onChange={(e) => updateItem(index, 'file_attachment', e.target.value)}
                      placeholder="URL ไฟล์แนบ"
                      className="w-full px-2 py-1 border rounded min-w-[120px]"
                    />
                  </td>
                  <td className="border p-2">
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-xl"
                      title="ลบ"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={addItem}
          className="mt-4 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          + เพิ่มแถว
        </button>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ฝั่งซ้าย: อัพโหลดสลิปโอนเงิน */}
          <div>
            {formData.payment_method === 'โอน' || uploadedSlipPaths.length > 0 ? (
              <>
                <h4 className="font-semibold mb-3 text-lg">อัพโหลดสลิปโอนเงิน</h4>
                <SlipUploadSimple
                  billNo={order?.bill_no || preBillNo || null}
                  existingSlips={uploadedSlipPaths}
                  readOnly={formData.payment_method !== 'โอน'}
                  onSlipsUploaded={(slipStoragePaths) => {
                    setUploadedSlipPaths(slipStoragePaths)
                  }}
                />
              </>
            ) : (
              <div className="text-gray-400 text-sm italic">
                เลือกวิธีการชำระ "โอน" เพื่ออัพโหลดสลิป
              </div>
            )}
          </div>

          {/* ฝั่งขวา: ข้อมูลการชำระเงิน */}
          <div className="space-y-4">
            <h3 className="text-xl font-bold mb-2">ข้อมูลการชำระเงิน</h3>
            <div>
              <label className="block text-sm font-medium mb-1">ราคา</label>
              <input
                type="number"
                value={calculateItemsTotal()}
                readOnly
                step="0.01"
                className="w-full px-3 py-2 border rounded-lg bg-gray-100 font-semibold"
              />
              <p className="text-xs text-gray-500 mt-1">คำนวณจากรายการสินค้า</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">ค่าส่ง</label>
              <input
                type="number"
                value={formData.shipping_cost || ''}
                onChange={(e) => setFormData({ ...formData, shipping_cost: parseFloat(e.target.value) || 0 })}
                onFocus={(e) => {
                  if (e.target.value === '0') {
                    e.target.value = ''
                  }
                }}
                onBlur={(e) => {
                  if (e.target.value === '') {
                    setFormData({ ...formData, shipping_cost: 0 })
                  }
                }}
                step="0.01"
                placeholder="0"
                className={`w-full px-3 py-2 border rounded-lg ${
                  formData.shipping_cost === 0 ? 'text-gray-400' : ''
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">ส่วนลด</label>
              <input
                type="number"
                value={formData.discount || ''}
                onChange={(e) => setFormData({ ...formData, discount: parseFloat(e.target.value) || 0 })}
                onFocus={(e) => {
                  if (e.target.value === '0') {
                    e.target.value = ''
                  }
                }}
                onBlur={(e) => {
                  if (e.target.value === '') {
                    setFormData({ ...formData, discount: 0 })
                  }
                }}
                step="0.01"
                placeholder="0"
                className={`w-full px-3 py-2 border rounded-lg ${
                  formData.discount === 0 ? 'text-gray-400' : ''
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">ยอดสุทธิ</label>
              <input
                type="number"
                value={formData.total_amount}
                readOnly
                className="w-full px-3 py-2 border-2 border-blue-300 rounded-lg bg-blue-50 font-bold text-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">วิธีการชำระ</label>
              <select
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="โอน">โอน</option>
                <option value="COD">COD</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">ขอเอกสาร</h3>
        <div className="flex gap-4 mb-4">
          <button
            type="button"
            onClick={() => {
              setShowTaxInvoice(!showTaxInvoice)
              setShowCashBill(false)
            }}
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              showTaxInvoice
                ? 'bg-blue-600 text-white'
                : 'bg-blue-100 text-blue-600 hover:bg-blue-200'
            }`}
          >
            ขอใบกำกับภาษี
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCashBill(!showCashBill)
              setShowTaxInvoice(false)
            }}
            className={`px-6 py-2 rounded-lg font-medium transition-colors ${
              showCashBill
                ? 'bg-green-600 text-white'
                : 'bg-green-100 text-green-600 hover:bg-green-200'
            }`}
          >
            ขอบิลเงินสด
          </button>
        </div>

        {showTaxInvoice && (
          <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50">
            <h4 className="font-semibold text-blue-800 mb-3">ข้อมูลสำหรับใบกำกับภาษี</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อลูกค้า/บริษัท</label>
                <input
                  type="text"
                  value={taxInvoiceData.company_name}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ที่อยู่</label>
                <textarea
                  value={taxInvoiceData.address}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, address: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">เลขประจำตัวผู้เสียภาษี (TAX ID)</label>
                <input
                  type="text"
                  value={taxInvoiceData.tax_id}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, tax_id: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="เช่น 0-0000-00000-00-0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">รายการสินค้าในใบกำกับ</label>
                <div className="border rounded-lg p-3 bg-gray-50">
                  {items.filter(item => item.product_id || item.product_name).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-center p-2" style={{ width: '8%' }}>ลำดับ</th>
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '15%' }}>จำนวน</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>ราคา/หน่วย</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>รวม</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id || item.product_name)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
                                <td className="p-2 text-center">{idx + 1}</td>
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{quantity}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 pl-2 pr-4 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
                        {(() => {
                          const totalAmount = items
                            .filter(item => item.product_id || item.product_name)
                            .reduce((sum, item) => {
                              const quantity = item.quantity || 1
                              const unitPrice = item.unit_price || 0
                              return sum + (quantity * unitPrice)
                            }, 0)
                          const vatAmount = totalAmount * 0.07
                          const grandTotal = totalAmount + vatAmount
                          
                          return (
                            <>
                              <tr className="border-t font-bold">
                                <td colSpan={4} className="p-2 pl-2 pr-4 text-right">รวมทั้งสิ้น:</td>
                                <td className="p-2 pl-2 pr-4 text-right">
                                  {totalAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                                </td>
                              </tr>
                              <tr className="border-t">
                                <td colSpan={4} className="p-2 pl-2 pr-4 text-right">ภาษีมูลค่าเพิ่ม 7%:</td>
                                <td className="p-2 pl-2 pr-4 text-right">
                                  {vatAmount.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                                </td>
                              </tr>
                              <tr className="border-t font-bold text-lg">
                                <td colSpan={4} className="p-2 pl-2 pr-4 text-right">ยอดเงินที่ต้องชำระ:</td>
                                <td className="p-2 pl-2 pr-4 text-right">
                                  {grandTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                                </td>
                              </tr>
                            </>
                          )
                        })()}
                      </tfoot>
                    </table>
                  ) : (
                    <p className="text-gray-500 text-sm">ยังไม่มีรายการสินค้า กรุณาเพิ่มรายการสินค้าก่อน</p>
                  )}
                </div>
                <textarea
                  value={taxInvoiceData.items_note}
                  onChange={(e) => setTaxInvoiceData({ ...taxInvoiceData, items_note: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg mt-2"
                  placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                />
              </div>
            </div>
          </div>
        )}

        {showCashBill && (
          <div className="border-2 border-green-200 rounded-lg p-4 bg-green-50">
            <h4 className="font-semibold text-green-800 mb-3">ข้อมูลสำหรับบิลเงินสด</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อลูกค้า/บริษัท</label>
                <input
                  type="text"
                  value={cashBillData.company_name}
                  onChange={(e) => setCashBillData({ ...cashBillData, company_name: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">ที่อยู่</label>
                <textarea
                  value={cashBillData.address}
                  onChange={(e) => setCashBillData({ ...cashBillData, address: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">รายการสินค้าในบิล</label>
                <div className="border rounded-lg p-3 bg-gray-50 max-h-48 overflow-y-auto">
                  {items.filter(item => item.product_id || item.product_name).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-center p-2" style={{ width: '8%' }}>ลำดับ</th>
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '15%' }}>จำนวน</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>ราคา/หน่วย</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>รวม</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id || item.product_name)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
                                <td className="p-2 text-center">{idx + 1}</td>
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{quantity}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 pl-2 pr-4 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-bold">
                          <td colSpan={4} className="p-2 pl-2 pr-4 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 pl-2 pr-4 text-right">
                            {items
                              .filter(item => item.product_id || item.product_name)
                              .reduce((sum, item) => {
                                const quantity = item.quantity || 1
                                const unitPrice = item.unit_price || 0
                                return sum + (quantity * unitPrice)
                              }, 0)
                              .toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  ) : (
                    <p className="text-gray-500 text-sm">ยังไม่มีรายการสินค้า กรุณาเพิ่มรายการสินค้าก่อน</p>
                  )}
                </div>
                <textarea
                  value={cashBillData.items_note}
                  onChange={(e) => setCashBillData({ ...cashBillData, items_note: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg mt-2"
                  placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault()
            await handleSubmit(e as any)
          }}
          disabled={loading}
          className="px-6 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50"
        >
          {loading ? 'กำลังบันทึก...' : 'บันทึก (รอลงข้อมูล)'}
        </button>
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault()
            
            try {
              console.log('[บันทึกข้อมูลครบ] เริ่มต้นการบันทึก...')
              console.log('[บันทึกข้อมูลครบ] formData:', formData)
              console.log('[บันทึกข้อมูลครบ] items:', items)
              console.log('[บันทึกข้อมูลครบ] uploadedSlipPaths:', uploadedSlipPaths)
              
              // Validation สำหรับบันทึก "ข้อมูลครบ"
              if (!formData.channel_code || formData.channel_code.trim() === '') {
                alert('กรุณาเลือกช่องทาง')
                return
              }

              if (!formData.customer_name || formData.customer_name.trim() === '') {
                alert('กรุณากรอกชื่อลูกค้า')
                return
              }

              if (!formData.customer_address || formData.customer_address.trim() === '') {
                alert('กรุณากรอกที่อยู่ลูกค้า')
                return
              }

              console.log('[บันทึกข้อมูลครบ] เริ่ม match สินค้า...')

              // พยายาม match สินค้าก่อน (รองรับกรณีเลือกจาก dropdown แต่ product_id ยังไม่ถูก set)
              let hasUpdates = false
              const updatedItems = items.map((item, index) => {
                if (!item.product_id && item.product_name?.trim()) {
                  const searchName = item.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
                  let matchedProduct = products.find(
                    p => p.product_name.toLowerCase().trim().replace(/\s+/g, ' ') === searchName
                  )
                  if (!matchedProduct) {
                    matchedProduct = products.find(
                      p => {
                        const dbName = p.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
                        return dbName.includes(searchName) || searchName.includes(dbName)
                      }
                    )
                  }
                  if (matchedProduct) {
                    hasUpdates = true
                    return { ...item, product_id: matchedProduct.id, product_name: matchedProduct.product_name }
                  }
                }
                return item
              })
              
              console.log('[บันทึกข้อมูลครบ] hasUpdates:', hasUpdates)

              const itemsToValidate = hasUpdates ? updatedItems : items

              // ตรวจสอบรายการสินค้า
              const itemsWithProduct = itemsToValidate.filter(item => item.product_id)
              console.log('[บันทึกข้อมูลครบ] itemsWithProduct:', itemsWithProduct.length)
              if (itemsWithProduct.length === 0) {
                const hasItems = itemsToValidate.length > 0
                if (hasItems) {
                  alert('กรุณาเลือกสินค้าจากรายการที่สร้างไว้ (กรุณาเลือกสินค้าจาก dropdown)')
                } else {
                  alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
                }
                return
              }

              // ตรวจสอบว่ารายการสินค้ามีราคา/หน่วยหรือไม่
              const itemsWithoutPrice = itemsWithProduct.filter(item => !item.unit_price || item.unit_price <= 0)
              if (itemsWithoutPrice.length > 0) {
                const itemNames = itemsWithoutPrice.map(item => item.product_name || 'สินค้า').join(', ')
                alert(`กรุณากรอกราคา/หน่วยสำหรับรายการสินค้าทั้งหมด\n\nรายการที่ยังไม่มีราคา:\n${itemNames}`)
                return
              }

              // ตรวจสอบสลิปโอน
              if (uploadedSlipPaths.length === 0) {
                alert('กรุณาอัพโหลดสลิปโอนเงิน')
                return
              }
              
              // Show verification popup if there are slips to verify
              let verificationPopup: HTMLElement | null = null
              if (uploadedSlipPaths.length > 0) {
                verificationPopup = document.createElement('div')
                verificationPopup.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
                verificationPopup.innerHTML = `
                  <div class="bg-white p-6 rounded-lg shadow-lg max-w-md">
                    <div class="flex items-center space-x-4">
                      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                      <div>
                        <h3 class="text-lg font-semibold">กำลังตรวจสอบสลิป...</h3>
                        <p class="text-sm text-gray-600">กรุณารอสักครู่ กำลังตรวจสอบสลิป ${uploadedSlipPaths.length} ใบ</p>
                      </div>
                    </div>
                  </div>
                `
                document.body.appendChild(verificationPopup)
              }
              
              try {
                if (hasUpdates) {
                  console.log('[บันทึกข้อมูลครบ] มีการอัพเดต items กำลัง setItems...')
                  setItems(updatedItems)
                  setTimeout(async () => {
                    console.log('[บันทึกข้อมูลครบ] เรียก handleSubmitInternal หลังจาก setItems...')
                    await handleSubmitInternal(updatedItems, 'ลงข้อมูลเสร็จสิ้น')
                    if (verificationPopup) {
                      document.body.removeChild(verificationPopup)
                    }
                  }, 100)
                } else {
                  console.log('[บันทึกข้อมูลครบ] ไม่มีการอัพเดต items เรียก handleSubmitInternal ทันที...')
                  await handleSubmitInternal(items, 'ลงข้อมูลเสร็จสิ้น')
                  if (verificationPopup) {
                    document.body.removeChild(verificationPopup)
                  }
                }
              } catch (error: any) {
                if (verificationPopup) {
                  document.body.removeChild(verificationPopup)
                }
                throw error
              }
            } catch (error: any) {
              console.error('[บันทึกข้อมูลครบ] Error:', error)
              alert('เกิดข้อผิดพลาดในการบันทึก: ' + (error.message || error))
            }
          }}
          disabled={loading}
          className="px-6 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
        >
          {loading ? 'กำลังบันทึก...' : 'บันทึก (ข้อมูลครบ)'}
        </button>
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault()
            if (!order) {
              onCancel()
              return
            }
            
            const confirmMessage = `ต้องการยกเลิกออเดอร์ ${order.bill_no} หรือไม่?`
            if (!confirm(confirmMessage)) {
              return
            }

            try {
              setLoading(true)
              const { error } = await supabase
                .from('or_orders')
                .update({ status: 'ยกเลิก' })
                .eq('id', order.id)

              if (error) throw error

              alert('ยกเลิกออเดอร์สำเร็จ')
              onSave()
            } catch (error: any) {
              console.error('Error cancelling order:', error)
              alert('เกิดข้อผิดพลาดในการยกเลิกออเดอร์: ' + error.message)
            } finally {
              setLoading(false)
            }
          }}
          disabled={loading}
          className="px-6 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
        >
          {loading ? 'กำลังยกเลิก...' : 'ยกเลิก'}
        </button>
      </div>
    </form>
  )
}
