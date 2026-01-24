<<<<<<< HEAD
import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderItem, Product, CartoonPattern } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'

// Component for uploading slips without immediate verification
function SlipUploadSimple({
  billNo,
  onSlipsUploaded,
  existingSlips = [],
  readOnly = false,
}: {
  billNo?: string | null
  onSlipsUploaded?: (slipUrls: string[]) => void
  existingSlips?: string[]
  readOnly?: boolean
}) {
  const { user } = useAuthContext()
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadedSlips, setUploadedSlips] = useState<string[]>(existingSlips)
  const [previewUrls, setPreviewUrls] = useState<string[]>([])

  // Sync existingSlips when it changes
  useEffect(() => {
    setUploadedSlips(existingSlips)
  }, [existingSlips])

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
      alert('กรุณาบันทึกออเดอร์เพื่อสร้างเลขบิลก่อนอัพโหลดสลิป')
      return
    }

    setUploading(true)
    try {
      // ตั้งชื่อโฟลเดอร์: slip{billNo}
      const folderName = `slip${billNo}`
      
      // ตรวจสอบไฟล์ที่มีอยู่ในโฟลเดอร์เพื่อหาลำดับถัดไป
      const { data: existingFiles, error: listError } = await supabase.storage
        .from('slip-images')
        .list(folderName)
      
      if (listError && listError.message !== 'The resource was not found') {
        console.error('Error listing files:', listError)
      }

      // หาลำดับถัดไป
      let nextNumber = 1
      if (existingFiles && existingFiles.length > 0) {
        // หาเลขลำดับสูงสุด
        const numbers = existingFiles
          .map(file => {
            const match = file.name.match(/slip.*-(\d+)\./i)
            return match ? parseInt(match[1]) : 0
          })
          .filter(num => num > 0)
        
        if (numbers.length > 0) {
          nextNumber = Math.max(...numbers) + 1
        }
      }

      const slipUrls: string[] = []
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const fileExt = file.name.split('.').pop() || 'jpg'
        
        // ตั้งชื่อไฟล์: slip{billNo}-{ลำดับ}.{ext}
        const fileNumber = String(nextNumber + i).padStart(2, '0')
        const fileName = `${folderName}/slip${billNo}-${fileNumber}.${fileExt}`
        
        console.log('Uploading file:', fileName)
        console.log('Folder:', folderName)
        console.log('Bill No:', billNo)
        console.log('File size:', file.size, 'bytes')
        console.log('File type:', file.type)
        
        // ใช้ authenticated client
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('slip-images')
          .upload(fileName, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || `image/${fileExt}`
          })
        
        if (uploadError) {
          console.error('Upload error:', uploadError)
          console.error('Error details:', {
            message: uploadError.message,
          })
          
          // ถ้าเป็น RLS error ให้แสดงคำแนะนำ
          if (uploadError.message.includes('row-level security') || uploadError.message.includes('RLS')) {
            throw new Error('ไม่มีสิทธิ์ในการอัพโหลดไฟล์ กรุณาตรวจสอบการตั้งค่า Storage Policy ใน Supabase')
          }
          
          // ถ้าไฟล์ซ้ำ ให้ลองใช้ชื่อใหม่
          if (uploadError.message.includes('already exists')) {
            const newFileNumber = String(nextNumber + i + 100).padStart(2, '0')
            const newFileName = `${folderName}/slip${billNo}-${newFileNumber}.${fileExt}`
            console.log('File exists, trying new name:', newFileName)
            
            const { data: retryUploadData, error: retryError } = await supabase.storage
              .from('slip-images')
              .upload(newFileName, file, {
                cacheControl: '3600',
                upsert: false,
                contentType: file.type || `image/${fileExt}`
              })
            
            if (retryError) {
              throw retryError
            }
            
            const { data: urlData } = supabase.storage
              .from('slip-images')
              .getPublicUrl(retryUploadData.path)
            
            slipUrls.push(urlData.publicUrl)
            continue
          }
          
          throw uploadError
        }

        console.log('Upload success:', uploadData)

        const { data: urlData } = supabase.storage
          .from('slip-images')
          .getPublicUrl(uploadData.path)

        console.log('Public URL:', urlData.publicUrl)
        slipUrls.push(urlData.publicUrl)
      }

      // อัพเดตรายการสลิปที่อัพโหลดแล้ว (รวมกับรายการเดิม)
      const updatedSlips = [...uploadedSlips, ...slipUrls]
      setUploadedSlips(updatedSlips)
      
      // Cleanup preview URLs
      previewUrls.forEach(url => URL.revokeObjectURL(url))
      setPreviewUrls([])
      setFiles([])
      
      if (onSlipsUploaded) {
        onSlipsUploaded(updatedSlips)
      }
      
      alert(`อัพโหลดสลิปสำเร็จ ${slipUrls.length} ไฟล์`)
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
            disabled={uploading}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? 'กำลังอัพโหลด...' : `อัพโหลดสลิป ${files.length} ไฟล์`}
          </button>
        </div>
      )}

      {uploadedSlips.length > 0 && (
        <div className="space-y-3">
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-green-800 text-sm font-medium">
              อัพโหลดแล้ว {uploadedSlips.length} ไฟล์
            </p>
            <p className="text-green-700 text-xs mt-1">
              สลิปจะถูกตรวจสอบเมื่อกดปุ่ม "บันทึก (ข้อมูลครบ)"
            </p>
          </div>
          
          {/* แสดงรูปภาพที่อัพโหลดแล้ว */}
          <div>
            <p className="text-sm font-medium mb-2 text-gray-700">รูปภาพสลิปที่อัพโหลดแล้ว:</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {uploadedSlips.map((url, index) => (
                <div key={index} className="relative group">
                  <img
                    src={url}
                    alt={`สลิป ${index + 1}`}
                    className="w-full aspect-square object-contain rounded-lg border-2 border-gray-200 hover:border-blue-400 transition-colors cursor-pointer bg-gray-50"
                    onClick={() => window.open(url, '_blank')}
                    onError={(e) => {
                      console.error('Error loading image:', url)
                      e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23ddd" width="200" height="200"/%3E%3Ctext fill="%23999" font-family="sans-serif" font-size="14" x="50%25" y="50%25" text-anchor="middle" dy=".3em"%3Eไม่สามารถโหลดรูปภาพ%3C/text%3E%3C/svg%3E'
                    }}
                  />
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        const newSlips = uploadedSlips.filter((_, i) => i !== index)
                        setUploadedSlips(newSlips)
                        if (onSlipsUploaded) {
                          onSlipsUploaded(newSlips)
                        }
                      }}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="ลบรูปภาพ"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
=======
import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderItem, Product, CartoonPattern } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import SlipUpload from './SlipUpload'
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208

interface OrderFormProps {
  order?: Order | null
  onSave: () => void
  onCancel: () => void
}

export default function OrderForm({ order, onSave, onCancel }: OrderFormProps) {
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
<<<<<<< HEAD
  const [showProductDropdown, setShowProductDropdown] = useState<{ [key: number]: boolean }>({})
  const [uploadedSlipUrls, setUploadedSlipUrls] = useState<string[]>([])
  const dropdownRefs = React.useRef<{ [key: number]: HTMLDivElement | null }>({})
  const selectRefs = React.useRef<{ [key: number]: HTMLSelectElement | null }>({})
=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
  
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

<<<<<<< HEAD
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
        setUploadedSlipUrls([])
        return
      }

      const urls = files
        .filter(file => file.name && !file.name.endsWith('/'))
        .map(file => {
          const { data: urlData } = supabase.storage
            .from('slip-images')
            .getPublicUrl(`${folderName}/${file.name}`)
          return { name: file.name, url: urlData.publicUrl }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(item => item.url)

      setUploadedSlipUrls(urls)
    } catch (error) {
      console.error('Error loading slip images:', error)
    }
  }

  useEffect(() => {
    loadInitialData()
    async function loadOrderData() {
      if (order) {
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
        
        // โหลด order_items จากฐานข้อมูลถ้ายังไม่มีใน order object
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
          // ตั้งค่า productSearchTerm สำหรับแต่ละรายการ
          const searchTerms: { [key: number]: string } = {}
          loadedItems.forEach((item, idx) => {
            if (item.product_name) {
              searchTerms[idx] = item.product_name
            }
          })
          setProductSearchTerm(searchTerms)
        } else {
          // เพิ่มรายการแรกอัตโนมัติ
          setItems([{ product_type: 'ชั้น1' }])
        }
        
        // โหลดข้อมูล billing_details
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
          setUploadedSlipUrls([])
        }
      } else {
        // เพิ่มรายการแรกอัตโนมัติสำหรับออเดอร์ใหม่
        setItems([{ product_type: 'ชั้น1' }])
        setUploadedSlipUrls([])
      }
    }
    loadOrderData()
=======
  useEffect(() => {
    loadInitialData()
    if (order) {
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
      if (order.order_items && order.order_items.length > 0) {
        const loadedItems = order.order_items.map(item => ({ ...item }))
        setItems(loadedItems)
        // ตั้งค่า productSearchTerm สำหรับแต่ละรายการ
        const searchTerms: { [key: number]: string } = {}
        loadedItems.forEach((item, idx) => {
          if (item.product_name) {
            searchTerms[idx] = item.product_name
          }
        })
        setProductSearchTerm(searchTerms)
      } else {
        // เพิ่มรายการแรกอัตโนมัติ
        setItems([{ product_type: 'ชั้น1' }])
      }
    } else {
      // เพิ่มรายการแรกอัตโนมัติสำหรับออเดอร์ใหม่
      setItems([{ product_type: 'ชั้น1' }])
    }
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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

<<<<<<< HEAD
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
        await handleSubmitInternal(updatedItems)
      }, 100)
      return
    }
    
    // ตรวจสอบว่ามีรายการสินค้าที่มี product_id หรือไม่
    const itemsWithProduct = items.filter(item => item.product_id)
    if (itemsWithProduct.length === 0) {
      alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
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
      
=======
    setLoading(true)
    try {
      // คำนวณราคารวมจากรายการสินค้า
      const calculatedPrice = calculateItemsTotal()
      const calculatedTotal = calculatedPrice + formData.shipping_cost - formData.discount
      
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
      const orderData = {
        ...formData,
        price: calculatedPrice,
        total_amount: calculatedTotal,
<<<<<<< HEAD
        payment_date: paymentDate,
        payment_time: paymentTime,
        status: targetStatus,
        admin_user: user.username || user.email,
        entry_date: new Date().toISOString().slice(0, 10),
        billing_details: (showTaxInvoice || showCashBill) ? billingDetails : null,
=======
        status: 'รอลงข้อมูล' as const,
        admin_user: user.username || user.email,
        entry_date: new Date().toISOString().slice(0, 10),
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
      }

      let orderId: string
      if (order) {
        const { error } = await supabase
          .from('or_orders')
          .update(orderData)
          .eq('id', order.id)
        if (error) throw error
        orderId = order.id
      } else {
        // Generate bill number
        const billNo = await generateBillNo(formData.channel_code)
        const { data, error } = await supabase
          .from('or_orders')
          .insert({ ...orderData, bill_no: billNo })
          .select()
          .single()
        if (error) throw error
        orderId = data.id
      }

      // Save order items
<<<<<<< HEAD
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
      if (targetStatus === 'ลงข้อมูลเสร็จสิ้น' && uploadedSlipUrls.length > 0) {
        try {
          await verifyUploadedSlips(orderId, uploadedSlipUrls, calculatedTotal)
        } catch (error: any) {
          console.error('Error verifying slips:', error)
          alert('บันทึกออเดอร์สำเร็จ แต่เกิดข้อผิดพลาดในการตรวจสอบสลิป: ' + error.message)
        }
      }

      const statusText = targetStatus === 'ลงข้อมูลเสร็จสิ้น' ? 'บันทึกข้อมูลครบ' : 'บันทึก (รอลงข้อมูล)'
      alert(order ? `อัปเดตข้อมูลสำเร็จ (${statusText})` : `บันทึกสำเร็จ! (${statusText})`)
      if (uploadedSlipUrls.length > 0) {
        setUploadedSlipUrls([]) // ล้างสลิปที่อัพโหลดไว้
      }
=======
      if (items.length > 0) {
        await supabase.from('or_order_items').delete().eq('order_id', orderId)
        const itemsToInsert = items
          .filter(item => item.product_id)
          .map(item => ({
            order_id: orderId,
            item_uid: `${formData.channel_code}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
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
          }))
        
        if (itemsToInsert.length > 0) {
          const { error: itemsError } = await supabase
            .from('or_order_items')
            .insert(itemsToInsert)
          if (itemsError) throw itemsError
        }
      }

      alert(order ? 'อัปเดตข้อมูลสำเร็จ' : 'บันทึกสำเร็จ!')
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
      onSave()
    } catch (error: any) {
      console.error('Error saving order:', error)
      alert('เกิดข้อผิดพลาด: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

<<<<<<< HEAD
  // ฟังก์ชันตรวจสอบสลิปที่อัพโหลดไว้
  async function verifyUploadedSlips(orderId: string, slipUrls: string[], orderAmount: number) {
    try {
      // Check for duplicates
      const { data: existingSlips, error: duplicateCheckError } = await supabase
        .from('ac_verified_slips')
        .select('slip_image_url')
        .in('slip_image_url', slipUrls)

      if (duplicateCheckError) {
        console.error('Error checking duplicate slips:', duplicateCheckError)
        throw new Error('เกิดข้อผิดพลาดในการตรวจสอบสลิปซ้ำ: ' + duplicateCheckError.message)
      }

      if (existingSlips && existingSlips.length > 0) {
        const duplicateUrls = existingSlips.map(s => s.slip_image_url).join(', ')
        throw new Error(`พบสลิปที่เคยใช้แล้ว กรุณาใช้สลิปใหม่\n\nสลิปที่ซ้ำ: ${duplicateUrls}`)
      }

      // Verify slips using Easyslip
      const results: any[] = []
      let totalAmount = 0
      const errors: string[] = []
      const successfulVerifications: number[] = []

      console.log(`[Verify Slips] Starting verification for ${slipUrls.length} slip(s)`)

      for (let i = 0; i < slipUrls.length; i++) {
        const url = slipUrls[i]
        console.log(`[Verify Slips] Verifying slip ${i + 1}/${slipUrls.length}`)

        try {
          const { data, error: verifyError } = await supabase.functions.invoke('verify-slip', {
            body: { imageUrl: url }
          })

          if (verifyError) {
            const errorMsg = verifyError.message || 'Unknown error'
            console.error(`[Verify Slips] Slip ${i + 1} verification failed:`, errorMsg)
            
            // Check if it's a configuration error
            if (errorMsg.includes('not configured') || errorMsg.includes('EASYSLIP_API_KEY')) {
              throw new Error('Easyslip API Key ยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบเพื่อตั้งค่า EASYSLIP_API_KEY ใน Supabase Secrets')
            }
            
            errors.push(`สลิป ${i + 1}: ${errorMsg}`)
            results.push({
              success: false,
              error: errorMsg
            })
          } else if (!data) {
            const errorMsg = 'ไม่ได้รับข้อมูลจาก Edge Function'
            console.error(`[Verify Slips] Slip ${i + 1} - No data received`)
            errors.push(`สลิป ${i + 1}: ${errorMsg}`)
            results.push({
              success: false,
              error: errorMsg
            })
          } else if (!data.success) {
            const errorMsg = data.error || 'การตรวจสอบสลิปล้มเหลว'
            console.error(`[Verify Slips] Slip ${i + 1} verification failed:`, errorMsg)
            errors.push(`สลิป ${i + 1}: ${errorMsg}`)
            results.push({
              success: false,
              error: errorMsg
            })
          } else {
            const amount = data.amount || 0
            totalAmount += amount
            successfulVerifications.push(i + 1)
            console.log(`[Verify Slips] Slip ${i + 1} verified successfully - Amount: ${amount}`)
            results.push({
              success: true,
              amount,
              message: data.message || 'ตรวจสอบสำเร็จ'
            })
          }
        } catch (error: any) {
          // Re-throw configuration errors immediately
          if (error.message?.includes('EASYSLIP_API_KEY') || error.message?.includes('not configured')) {
            throw error
          }
          
          const errorMsg = error.message || 'เกิดข้อผิดพลาดในการตรวจสอบสลิป'
          console.error(`[Verify Slips] Slip ${i + 1} error:`, errorMsg)
          errors.push(`สลิป ${i + 1}: ${errorMsg}`)
          results.push({
            success: false,
            error: errorMsg
          })
        }
      }

      // If all slips failed, throw error
      if (successfulVerifications.length === 0) {
        throw new Error(`ตรวจสอบสลิปไม่สำเร็จทั้งหมด:\n${errors.join('\n')}`)
      }

      // If some slips failed, show warning but continue
      if (errors.length > 0) {
        console.warn(`[Verify Slips] ${errors.length} slip(s) failed, ${successfulVerifications.length} succeeded`)
      }

      // Save verified slips (only successful ones)
      const slipsToInsert = results
        .map((r, idx) => ({
          order_id: orderId,
          slip_image_url: slipUrls[idx],
          verified_amount: r.amount || 0,
        }))
        .filter((s, idx) => results[idx].success && s.verified_amount > 0)

      if (slipsToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from('ac_verified_slips')
          .insert(slipsToInsert)

        if (insertError) {
          console.error('Error inserting verified slips:', insertError)
          throw new Error('เกิดข้อผิดพลาดในการบันทึกสลิปที่ตรวจสอบแล้ว: ' + insertError.message)
        }
      }

      // Check if amount matches or exceeds
      if (totalAmount >= orderAmount) {
        // Update order status to "รอตรวจคำสั่งซื้อ"
        const { error: updateError } = await supabase
          .from('or_orders')
          .update({ status: 'รอตรวจคำสั่งซื้อ' })
          .eq('id', orderId)

        if (updateError) {
          console.error('Error updating order status:', updateError)
          throw new Error('เกิดข้อผิดพลาดในการอัพเดตสถานะออเดอร์: ' + updateError.message)
        }

        const successMsg = errors.length > 0
          ? `ตรวจสอบสลิปสำเร็จบางส่วน!\n\nยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})\n\nสลิปที่สำเร็จ: ${successfulVerifications.join(', ')}\nสลิปที่ล้มเหลว: ${errors.length} ใบ`
          : `ตรวจสอบสลิปสำเร็จ! ยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        
        alert(successMsg)
      } else {
        // Amount is less than order amount - create refund record
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

        const refundMsg = errors.length > 0
          ? `ยอดสลิปไม่พอ! ยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})\n\nสลิปที่สำเร็จ: ${successfulVerifications.join(', ')}\nสลิปที่ล้มเหลว: ${errors.length} ใบ\n\nสร้างรายการโอนคืนแล้ว`
          : `ยอดสลิปไม่พอ! ยอดรวม: ฿${totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()}) - สร้างรายการโอนคืนแล้ว`
        
        alert(refundMsg)
      }
    } catch (error: any) {
      console.error('[Verify Slips] Error:', error)
      throw error
    }
  }

=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
    // คัดลอกข้อมูลจากรายการสุดท้าย (ถ้ามี)
    const lastItem = items.length > 0 ? items[items.length - 1] : null
    const newItem = lastItem 
      ? { ...lastItem } // คัดลอกข้อมูลทั้งหมดรวมถึง product_id และ product_name
      : { product_type: 'ชั้น1' }
    setItems([...items, newItem])
    
    // ตั้งค่า search term สำหรับรายการใหม่จากชื่อสินค้าที่คัดลอกมา
    if (items.length > 0 && lastItem?.product_name) {
      setProductSearchTerm({ ...productSearchTerm, [items.length]: lastItem.product_name })
    } else {
      setProductSearchTerm({ ...productSearchTerm, [items.length]: '' })
    }
=======
    setItems([...items, { product_type: 'ชั้น1' }])
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold">ข้อมูลหลัก</h3>
          {order?.bill_no && (
            <div className="text-right">
              <span className="text-sm text-gray-500">เลขบิล:</span>
              <span className="ml-2 text-lg font-bold text-blue-600">{order.bill_no}</span>
            </div>
          )}
        </div>
=======
        <h3 className="text-xl font-bold mb-4">ข้อมูลหลัก</h3>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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

<<<<<<< HEAD
      <div className="bg-white p-6 rounded-lg shadow" style={{ position: 'relative', overflow: 'visible' }}>
        <h3 className="text-xl font-bold mb-4">รายการสินค้า</h3>
        <div className="overflow-x-auto" style={{ overflowY: 'visible' }}>
          <table className="w-full border-collapse text-sm" style={{ position: 'relative' }}>
=======
      <div className="bg-white p-6 rounded-lg shadow">
        <h3 className="text-xl font-bold mb-4">รายการสินค้า</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2">ชื่อสินค้า</th>
                <th className="border p-2">สีหมึก</th>
<<<<<<< HEAD
                <th className="border p-2">ชั้น</th>
=======
                <th className="border p-2">ชั้นที่</th>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
                          
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
=======
                        }}
                        onInput={(e) => {
                          const input = e.target as HTMLInputElement
                          const selectedOption = document.querySelector(
                            `#product-list-${index} option[value="${input.value}"]`
                          ) as HTMLOptionElement
                          if (selectedOption) {
                            const productId = selectedOption.getAttribute('data-id')
                            if (productId) {
                              const product = products.find(p => p.id === productId)
                              if (product) {
                                updateItem(index, 'product_id', product.id)
                                updateItem(index, 'product_name', product.product_name)
                                setProductSearchTerm({ ...productSearchTerm, [index]: product.product_name })
                              }
                            }
                          }
                        }}
                        onBlur={(e) => {
                          // ถ้าไม่ตรงกับสินค้าใดๆ ให้ใช้ชื่อสินค้าที่เลือกไว้
                          const matchedProduct = products.find(
                            p => p.product_name.toLowerCase() === e.target.value.toLowerCase()
                          )
                          if (!matchedProduct) {
                            setProductSearchTerm({ ...productSearchTerm, [index]: item.product_name || '' })
                          } else {
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                            // อัพเดตให้ตรงกับสินค้าที่เลือก
                            updateItem(index, 'product_id', matchedProduct.id)
                            updateItem(index, 'product_name', matchedProduct.product_name)
                            setProductSearchTerm({ ...productSearchTerm, [index]: matchedProduct.product_name })
<<<<<<< HEAD
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
=======
                          }
                        }}
                        placeholder="พิมพ์ค้นหาหรือเลือกสินค้า"
                        className="w-full px-2 py-1 border rounded min-w-[120px]"
                      />
                      <datalist id={`product-list-${index}`}>
                        {products
                          .filter(p => 
                            !productSearchTerm[index] || 
                            p.product_name.toLowerCase().includes(productSearchTerm[index].toLowerCase())
                          )
                          .map((p) => (
                            <option key={p.id} value={p.product_name} data-id={p.id} />
                          ))}
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                      </datalist>
                    </div>
                  </td>
                  <td className="border p-2">
                    <select
                      value={item.ink_color || ''}
                      onChange={(e) => updateItem(index, 'ink_color', e.target.value)}
<<<<<<< HEAD
                      className="w-full px-2 py-1 border rounded min-w-[150px]"
=======
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
                      className="w-full px-2 py-1 border rounded min-w-[60px]"
=======
                      className="w-full px-2 py-1 border rounded min-w-[80px]"
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
                      className="w-full px-2 py-1 border rounded min-w-[70px]"
=======
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                      placeholder="ลายการ์ตูน"
                    />
                  </td>
                  <td className="border p-2">
                    <input
                      type="text"
                      value={item.line_pattern || ''}
                      onChange={(e) => updateItem(index, 'line_pattern', e.target.value)}
<<<<<<< HEAD
                      className="w-full px-2 py-1 border rounded min-w-[70px]"
=======
                      className="w-full px-2 py-1 border rounded min-w-[100px]"
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
                      className="w-full px-2 py-1 border rounded min-w-[50px]"
=======
                      className="w-full px-2 py-1 border rounded min-w-[60px]"
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ฝั่งซ้าย: อัพโหลดสลิปโอนเงิน */}
          <div>
            {formData.payment_method === 'โอน' || uploadedSlipUrls.length > 0 ? (
              <>
                <h4 className="font-semibold mb-3 text-lg">อัพโหลดสลิปโอนเงิน</h4>
                <SlipUploadSimple
                  billNo={order?.bill_no || null}
                  existingSlips={uploadedSlipUrls}
                  readOnly={formData.payment_method !== 'โอน'}
                  onSlipsUploaded={(slipUrls) => {
                    setUploadedSlipUrls(slipUrls)
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
=======
        <h3 className="text-xl font-bold mb-4">ข้อมูลการชำระเงิน</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
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
              value={formData.shipping_cost}
              onChange={(e) => setFormData({ ...formData, shipping_cost: parseFloat(e.target.value) || 0 })}
              step="0.01"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ส่วนลด</label>
            <input
              type="number"
              value={formData.discount}
              onChange={(e) => setFormData({ ...formData, discount: parseFloat(e.target.value) || 0 })}
              step="0.01"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">ยอดสุทธิ</label>
            <input
              type="number"
              value={formData.total_amount}
              readOnly
              className="w-full px-3 py-2 border rounded-lg bg-gray-100 font-bold"
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

        {formData.payment_method === 'โอน' && (
          <>
            <div className="border-t pt-4">
              <h4 className="font-semibold mb-3">อัพโหลดสลิปโอนเงิน</h4>
              {order && order.id ? (
                <SlipUpload
                  orderId={order.id}
                  orderAmount={formData.total_amount}
                  onVerificationComplete={(success, totalAmount) => {
                    if (success) {
                      alert('ตรวจสอบสลิปสำเร็จ! ออเดอร์จะถูกส่งไปให้ Admin QC ตรวจสอบ')
                    }
                  }}
                />
              ) : (
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                  <p className="text-yellow-800 text-sm mb-2">กรุณาบันทึกออเดอร์ก่อนเพื่ออัพโหลดสลิป</p>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                  >
                    บันทึกออเดอร์เพื่ออัพโหลดสลิป
                  </button>
                </div>
              )}
            </div>
          </>
        )}
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
            <h4 className="font-semibold text-blue-800 mb-3">ข้อมูลสำหรับใบกำกับภาษี</h4>
=======
            <h4 className="font-semibold text-blue-800 mb-3">ข้อมูลสำหรับใบกำกับภาษี / บิลเงินสด</h4>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
<<<<<<< HEAD
                <div className="border rounded-lg p-3 bg-gray-50">
=======
                <div className="border rounded-lg p-3 bg-gray-50 max-h-48 overflow-y-auto">
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                  {items.filter(item => item.product_id).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
<<<<<<< HEAD
                          <th className="text-center p-2" style={{ width: '8%' }}>ลำดับ</th>
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '15%' }}>จำนวน</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>ราคา/หน่วย</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>รวม</th>
=======
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-left p-2">จำนวน</th>
                          <th className="text-right p-2">ราคา/หน่วย</th>
                          <th className="text-right p-2">รวม</th>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
<<<<<<< HEAD
                                <td className="p-2 text-center">{idx + 1}</td>
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{quantity}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 pl-2 pr-4 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
=======
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2">{quantity}</td>
                                <td className="p-2 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
<<<<<<< HEAD
                        {(() => {
                          const totalAmount = items
                            .filter(item => item.product_id)
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
=======
                        <tr className="border-t font-bold">
                          <td colSpan={3} className="p-2 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 text-right">
                            {items
                              .filter(item => item.product_id)
                              .reduce((sum, item) => {
                                const quantity = item.quantity || 1
                                const unitPrice = item.unit_price || 0
                                return sum + (quantity * unitPrice)
                              }, 0)
                              .toLocaleString('th-TH', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
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
                  {items.filter(item => item.product_id).length > 0 ? (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
<<<<<<< HEAD
                          <th className="text-center p-2" style={{ width: '8%' }}>ลำดับ</th>
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '15%' }}>จำนวน</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>ราคา/หน่วย</th>
                          <th className="text-right p-2 pl-2 pr-4" style={{ width: '20%' }}>รวม</th>
=======
                          <th className="text-left p-2">ชื่อสินค้า</th>
                          <th className="text-left p-2">จำนวน</th>
                          <th className="text-right p-2">ราคา/หน่วย</th>
                          <th className="text-right p-2">รวม</th>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                        </tr>
                      </thead>
                      <tbody>
                        {items
                          .filter(item => item.product_id)
                          .map((item, idx) => {
                            const quantity = item.quantity || 1
                            const unitPrice = item.unit_price || 0
                            const total = quantity * unitPrice
                            return (
                              <tr key={idx} className="border-b">
<<<<<<< HEAD
                                <td className="p-2 text-center">{idx + 1}</td>
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{quantity}</td>
                                <td className="p-2 pl-2 pr-4 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 pl-2 pr-4 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
=======
                                <td className="p-2">{item.product_name || '-'}</td>
                                <td className="p-2">{quantity}</td>
                                <td className="p-2 text-right">{unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td className="p-2 text-right font-semibold">{total.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                              </tr>
                            )
                          })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t font-bold">
<<<<<<< HEAD
                          <td colSpan={4} className="p-2 pl-2 pr-4 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 pl-2 pr-4 text-right">
=======
                          <td colSpan={3} className="p-2 text-right">รวมทั้งสิ้น:</td>
                          <td className="p-2 text-right">
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
                            {items
                              .filter(item => item.product_id)
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
<<<<<<< HEAD
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

            // ตรวจสอบรายการสินค้า
            const itemsWithProduct = items.filter(item => item.product_id)
            if (itemsWithProduct.length === 0) {
              alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
              return
            }

            // ตรวจสอบว่ารายการสินค้าทุกรายการมีราคา/หน่วยหรือไม่
            const itemsWithoutPrice = itemsWithProduct.filter(item => !item.unit_price || item.unit_price <= 0)
            if (itemsWithoutPrice.length > 0) {
              const itemNames = itemsWithoutPrice.map(item => item.product_name || 'สินค้า').join(', ')
              alert(`กรุณากรอกราคา/หน่วยสำหรับรายการสินค้าทั้งหมด\n\nรายการที่ยังไม่มีราคา:\n${itemNames}`)
              return
            }

            // ตรวจสอบสลิปโอน
            if (uploadedSlipUrls.length === 0) {
              alert('กรุณาอัพโหลดสลิปโอนเงิน')
              return
            }

            // พยายาม match สินค้าก่อน
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
            if (hasUpdates) {
              setItems(updatedItems)
              setTimeout(async () => {
                await handleSubmitInternal(updatedItems, 'ลงข้อมูลเสร็จสิ้น')
              }, 100)
            } else {
              await handleSubmitInternal(items, 'ลงข้อมูลเสร็จสิ้น')
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
=======
          type="submit"
          disabled={loading}
          className="px-6 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {loading ? 'กำลังบันทึก...' : order ? 'อัปเดต' : 'บันทึก'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-6 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          ยกเลิก
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
        </button>
      </div>
    </form>
  )
}
