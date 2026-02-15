import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { Order, OrderItem, Product, CartoonPattern, BankSetting } from '../../types'
import { useAuthContext } from '../../contexts/AuthContext'
import { uploadMultipleToStorage, verifyMultipleSlipsFromStorage } from '../../lib/slipVerification'
import { parseAddressText, type SubDistrictOption } from '../../lib/thaiAddress'
import VerificationResultModal, { type AmountStatus, type VerificationResultType } from './VerificationResultModal'
import Modal from '../ui/Modal'
import * as XLSX from 'xlsx'
import * as Papa from 'papaparse'

// Component for uploading slips without immediate verification
function SlipUploadSimple({
  billNo,
  orderId,
  onSlipsUploaded,
  onBindSlipPaths,
  existingSlips = [],
  readOnly = false,
}: {
  billNo?: string | null
  orderId?: string | null
  onSlipsUploaded?: (slipStoragePaths: string[]) => void
  /** หลังอัปโหลดสำเร็จ: ผูก path กับ order ใน DB (ac_verified_slips) เพื่อให้เปิดบิลกลับมาเห็นรูป */
  onBindSlipPaths?: (orderId: string, paths: string[]) => void
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
  /** Modal กรอกเหตุผลลบสลิป (แทน prompt) */
  const [deleteSlipModal, setDeleteSlipModal] = useState<{ open: boolean; index: number | null; storagePath: string | null }>({ open: false, index: null, storagePath: null })
  const [deleteSlipReason, setDeleteSlipReason] = useState('')
  const [deleteSlipSubmitting, setDeleteSlipSubmitting] = useState(false)
  /** Modal แจ้งอัพโหลดสลิปสำเร็จ (แทน alert) */
  const [uploadSuccessModal, setUploadSuccessModal] = useState<{ open: boolean; count: number }>({ open: false, count: 0 })

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
      
      // ผูก path กับ order ใน DB เพื่อเปิดบิลกลับมาเห็นรูป
      if (orderId && onBindSlipPaths && storagePaths.length > 0) {
        onBindSlipPaths(orderId, storagePaths)
      }
      
      // Cleanup preview URLs
      previewUrls.forEach(url => URL.revokeObjectURL(url))
      setPreviewUrls([])
      setFiles([])
      
      if (onSlipsUploaded) {
        onSlipsUploaded(updatedSlipPaths)
      }
      
      setUploadSuccessModal({ open: true, count: storagePaths.length })
    } catch (error: any) {
      console.error('Error uploading slips:', error)
      const msg = error?.message || ''
      const isHtmlInsteadOfJson =
        /Unexpected token\s*'<'|is not valid JSON/i.test(msg)
      const displayMessage = isHtmlInsteadOfJson
        ? 'เซิร์ฟเวอร์ตอบกลับเป็น HTML แทน JSON — กรุณาตรวจสอบ Supabase Dashboard (Storage bucket slip-images, RLS) และตัวแปร VITE_SUPABASE_URL'
        : msg
      alert('เกิดข้อผิดพลาดในการอัพโหลดสลิป: ' + displayMessage)
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

  async function performDeleteSlip(index: number, storagePath: string, deletionReason: string) {
    const pathParts = storagePath.split('/')
    if (pathParts.length < 2) {
      alert('รูปแบบ path ไม่ถูกต้อง: ' + storagePath)
      return
    }
    const bucket = pathParts[0]
    const filePath = pathParts.slice(1).join('/')
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      alert('กรุณาเข้าสู่ระบบก่อนลบไฟล์')
      return
    }
    try {
      const { error: deleteError } = await supabase.storage.from(bucket).remove([filePath])
      if (deleteError) {
        const err = deleteError as { message?: string; statusCode?: number; error?: string }
        let errorMessage = 'เกิดข้อผิดพลาดในการลบไฟล์' + (err.message ? ': ' + err.message : '')
        if (err.statusCode === 403 || err.error === 'permission_denied') {
          errorMessage += '\n\nสาเหตุ: ไม่มีสิทธิ์ลบไฟล์'
        } else if (err.statusCode === 404) {
          // ไปทำ soft delete ต่อ
        } else {
          alert(errorMessage)
          return
        }
      }
      const { error: softDeleteError } = await supabase
        .from('ac_verified_slips')
        .update({
          is_deleted: true,
          deleted_at: new Date().toISOString(),
          deleted_by: session.user.id,
          deletion_reason: deletionReason,
        })
        .eq('slip_storage_path', storagePath)
      if (softDeleteError) {
        alert('ลบไฟล์สำเร็จ แต่บันทึก Soft Delete ไม่สำเร็จ: ' + softDeleteError.message)
      }
      const newSlips = uploadedSlipPaths.filter((_, i) => i !== index)
      setUploadedSlipPaths(newSlips)
      if (onSlipsUploaded) onSlipsUploaded(newSlips)
      setDeleteSlipModal({ open: false, index: null, storagePath: null })
      setDeleteSlipReason('')
    } catch (error: any) {
      alert('เกิดข้อผิดพลาดในการลบไฟล์: ' + (error?.message || String(error)))
    } finally {
      setDeleteSlipSubmitting(false)
    }
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
              {uploadedSlipPaths.map((_, index) => {
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
                        onClick={() => {
                          const storagePath = uploadedSlipPaths[index]
                          if (!storagePath) return
                          setDeleteSlipReason('')
                          setDeleteSlipModal({ open: true, index, storagePath })
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

      {/* Modal กรอกเหตุผลลบสลิป (แทน prompt) */}
      {deleteSlipModal.open && deleteSlipModal.index !== null && deleteSlipModal.storagePath !== null && (
        <Modal
          open
          onClose={() => {
            if (!deleteSlipSubmitting) {
              setDeleteSlipModal({ open: false, index: null, storagePath: null })
              setDeleteSlipReason('')
            }
          }}
          contentClassName="max-w-md w-full"
        >
          <div className="p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">เหตุผลในการลบสลิป (บังคับ)</h3>
            <p className="text-sm text-gray-600 mb-3">เช่น: สลิปซ้ำ / สลิปไม่ถูกต้อง / อื่นๆ</p>
            <input
              type="text"
              value={deleteSlipReason}
              onChange={(e) => setDeleteSlipReason(e.target.value)}
              placeholder="กรอกเหตุผล..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 placeholder-gray-500"
              disabled={deleteSlipSubmitting}
            />
            <div className="flex gap-3 justify-end mt-4">
              <button
                type="button"
                onClick={() => {
                  if (!deleteSlipSubmitting) {
                    setDeleteSlipModal({ open: false, index: null, storagePath: null })
                    setDeleteSlipReason('')
                  }
                }}
                disabled={deleteSlipSubmitting}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={async () => {
                  const reason = deleteSlipReason.trim()
                  if (!reason) {
                    alert('กรุณากรอกเหตุผลในการลบสลิป ไม่สามารถลบได้หากไม่ระบุเหตุผล')
                    return
                  }
                  setDeleteSlipSubmitting(true)
                  await performDeleteSlip(deleteSlipModal.index!, deleteSlipModal.storagePath!, reason)
                }}
                disabled={deleteSlipSubmitting}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
              >
                {deleteSlipSubmitting ? (
                  <>
                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    กำลังลบ...
                  </>
                ) : (
                  'ยืนยันลบ'
                )}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal แจ้งอัพโหลดสลิปสำเร็จ */}
      <Modal
        open={uploadSuccessModal.open}
        onClose={() => setUploadSuccessModal({ open: false, count: 0 })}
        contentClassName="max-w-md"
        closeOnBackdropClick
      >
        <div className="p-5">
          <p className="text-gray-800">
            อัพโหลดสลิปสำเร็จ {uploadSuccessModal.count} ไฟล์
          </p>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setUploadSuccessModal({ open: false, count: 0 })}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              ตกลง
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

interface OrderFormProps {
  order?: Order | null
  /** options.switchToTab: 'complete' = หลัง save ให้สลับไปแท็บ "ตรวจสอบไม่ผ่าน" (ใช้เมื่อปฏิเสธโอนเกิน) */
  onSave: (options?: { switchToTab?: 'complete' }) => void
  onCancel: () => void
  /** เปิดบิลที่สร้างจากปุ่มเคลม (สร้างบิลเคลมแล้วให้ parent เปิดออเดอร์นั้น) */
  onOpenOrder?: (order: Order) => void
  readOnly?: boolean
  /** โหมดดูอย่างเดียว (จาก ตรวจสอบแล้ว/ยกเลิก): ซ่อนขอเอกสารและปุ่มบันทึก/ยกเลิก แสดงเฉพาะปุ่มกลับ */
  viewOnly?: boolean
}

type ImportedOrderItem = {
  product_id: string | null
  product_name: string
  quantity: number
  unit_price?: number
  ink_color?: string
  product_type?: string
  cartoon_pattern?: string
  line_pattern?: string
  font?: string
  line_1?: string
  line_2?: string
  line_3?: string
  notes?: string
  file_attachment?: string
}

type ImportedOrder = {
  bill_no?: string
  channel_code: string
  channel_order_no?: string | null
  customer_name: string
  customer_address: string
  price: number
  shipping_cost: number
  discount: number
  total_amount: number
  payment_method: string | null
  promotion?: string | null
  payment_date?: string | null
  payment_time?: string | null
  items: ImportedOrderItem[]
}

/** ช่องทางที่บล็อกที่อยู่ลูกค้า (SHOP PICKUP=SHOPP บล็อกที่อยู่ ปิดเลขพัสดุ; SHOP SHIPPING=SHOP แสดงที่อยู่+ชื่อช่องทาง ปิดเลขพัสดุ) */
const CHANNELS_BLOCK_ADDRESS = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'SHOPP']
/** ช่องทางที่แสดงฟิลด์ "ชื่อช่องทาง" (SHOP + SHOPP) */
const CHANNELS_SHOW_CHANNEL_NAME = ['FBTR', 'PUMP', 'OATR', 'SHOP', 'SHOPP', 'INFU', 'PN']
/** ช่องทางที่เปิดให้กรอกเลขพัสดุ (SHOP PICKUP ปิด) */
const CHANNELS_ENABLE_TRACKING = ['SPTR', 'FSPTR', 'TTTR', 'LZTR']
/** ช่องทางที่ให้กรอกราคาเอง (ล็อคราคา/หน่วย ใช้ราคาที่ข้อมูลชำระเงินแทน) */
const CHANNELS_MANUAL_PRICE = ['SPTR', 'FSPTR', 'TTTR', 'LZTR']
/** ช่องทางที่แสดงฟิลด์ "เลขคำสั่งซื้อ" */
const CHANNELS_SHOW_ORDER_NO = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'PGTR', 'WY']
/** ช่องทางที่เมื่อบันทึก "ข้อมูลครบ" ให้เคลื่อนสถานะไปที่ "ตรวจสอบแล้ว" โดยตรง (ไม่ต้องรอตรวจสลิป) */
const CHANNELS_COMPLETE_TO_VERIFIED = ['SPTR', 'FSPTR', 'TTTR', 'LZTR', 'SHOPP']
/** ช่องทางที่เปิดปุ่มอัพโหลดสลิป (นอกจากช่องทางที่อยู่ใน bank_settings_channels) */
const CHANNELS_SHOW_SLIP_UPLOAD = ['SHOPP', 'SHOP']

/** แมปสีหมึกพลาสติก → รหัสสินค้าหมึกแฟลชพลาสติกที่แถม */
const PLASTIC_INK_BONUS_MAP: Record<string, { product_code: string; product_name: string }> = {
  'พลาสติกดำ': { product_code: '110000321', product_name: 'หมึกแฟลชพลาสติก 5 ml. (ดำ)' },
  'พลาสติกเขียว': { product_code: '110000320', product_name: 'หมึกแฟลชพลาสติก 5 ml. (เขียว)' },
  'พลาสติกแดง': { product_code: '110000322', product_name: 'หมึกแฟลชพลาสติก 5 ml. (แดง)' },
  'พลาสติกน้ำเงิน': { product_code: '110000323', product_name: 'หมึกแฟลชพลาสติก 5 ml. (น้ำเงิน)' },
}

export default function OrderForm({ order, onSave, onCancel, onOpenOrder, readOnly = false, viewOnly = false }: OrderFormProps) {
  const { user } = useAuthContext()
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [cartoonPatterns, setCartoonPatterns] = useState<CartoonPattern[]>([])
  const [channels, setChannels] = useState<{ channel_code: string; channel_name: string }[]>([])
  const [promotions, setPromotions] = useState<{ id: string; name: string }[]>([])
  const [inkTypes, setInkTypes] = useState<{ id: number; ink_name: string }[]>([])
  const [fonts, setFonts] = useState<{ font_code: string; font_name: string }[]>([])
  const [items, setItems] = useState<Partial<OrderItem>[]>([])
  const [showTaxInvoice, setShowTaxInvoice] = useState(false)
  const [showCashBill, setShowCashBill] = useState(false)
  const [productSearchTerm, setProductSearchTerm] = useState<{ [key: number]: string }>({})
  const [patternSearchTerm, setPatternSearchTerm] = useState<{ [key: number]: string }>({})
  const [fontSearchTerm, setFontSearchTerm] = useState<{ [key: number]: string }>({})
  const [discountType, setDiscountType] = useState<'baht' | 'percent'>('baht')
  const [uploadedSlipPaths, setUploadedSlipPaths] = useState<string[]>([])
  const [bankSettings, setBankSettings] = useState<BankSetting[]>([])
  /** ช่องทางที่อยู่ใน bank_settings_channels (ต้องอัพโหลดสลิปเมื่อชำระโอน) */
  const [channelCodesWithSlipVerification, setChannelCodesWithSlipVerification] = useState<Set<string>>(new Set())
  const [creatingBill, setCreatingBill] = useState(false)
  const [verificationModal, setVerificationModal] = useState<{
    type: VerificationResultType
    accountMatch: boolean | null
    bankCodeMatch: boolean | null
    amountStatus: AmountStatus
    orderAmount: number
    totalAmount: number
    overpayAmount?: number
    errors: string[]
    validationErrors: string[]
    statusMessage: string
    orderId?: string
  } | null>(null)
  const [confirmingOverpay, setConfirmingOverpay] = useState(false)
  /** Popup ยกเลิกออเดอร์ (ถามยืนยัน → แสดงผลสำเร็จ/ผิดพลาด ใน popup เดียว) */
  const [cancelOrderModal, setCancelOrderModal] = useState<{
    open: boolean
    success?: boolean
    error?: string
    submitting?: boolean
  }>({ open: false })
  /** Modal แจ้งเตือนทั่วไป (แทน alert เช่น กรุณาอัพโหลดสลิปโอนเงิน) */
  const [messageModal, setMessageModal] = useState<{ open: boolean; title: string; message: string }>({
    open: false,
    title: '',
    message: '',
  })
  const [importModalOpen, setImportModalOpen] = useState(false)
  const [importTab, setImportTab] = useState<'smart' | 'wy'>('smart')
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [wyFile, setWyFile] = useState<File | null>(null)
  const [wyStatus, setWyStatus] = useState('')
  /** Modal เคลม: step 1 เลือกบิลอ้างอิง, step 2 เลือกหัวข้อเคลม + ยืนยัน */
  const [claimModalOpen, setClaimModalOpen] = useState(false)
  const [claimStep, setClaimStep] = useState<1 | 2>(1)
  const [claimOrders, setClaimOrders] = useState<Order[]>([])
  const [claimOrdersLoading, setClaimOrdersLoading] = useState(false)
  const [claimFilterSearch, setClaimFilterSearch] = useState('')
  const undoStackRef = useRef<Array<{ formData: typeof formData; items: Partial<OrderItem>[] }>>([])
  const undoingRef = useRef(false)
  const [claimFilterChannel, setClaimFilterChannel] = useState('')
  const [selectedClaimRefOrder, setSelectedClaimRefOrder] = useState<Order | null>(null)
  const [claimTypes, setClaimTypes] = useState<{ code: string; name: string }[]>([])
  const [selectedClaimType, setSelectedClaimType] = useState('')
  const [claimConfirmSubmitting, setClaimConfirmSubmitting] = useState(false)
  /** เมื่อออเดอร์สถานะ "ลงข้อมูลผิด": ฟิลด์ระดับบิลที่ติ๊กผิดจาก review (แสดงกรอบแดง) */
  const [reviewErrorFields, setReviewErrorFields] = useState<Record<string, boolean> | null>(null)
  /** ฟิลด์ระดับรายการที่ผิดต่อ index (error_fields.items) — ถ้ามีใช้แยกรายการ ไม่ใช่ทั้งบิล */
  const [reviewErrorFieldsByItem, setReviewErrorFieldsByItem] = useState<Record<number, Record<string, boolean>> | null>(null)
  /** หมายเหตุจาก review (ลงข้อมูลผิด) */
  const [reviewRemarks, setReviewRemarks] = useState<string | null>(null)
  /** ตั้งค่าฟิลด์ที่อนุญาตให้กรอกต่อหมวดหมู่สินค้า */
  const [categoryFieldSettings, setCategoryFieldSettings] = useState<Record<string, Record<string, boolean>>>({})
  /** index ของแถวที่ช่องหมายเหตุกำลังโฟกัส (แสดงกล่องใหญ่); null = ปกติ */
  const [notesFocusedIndex, setNotesFocusedIndex] = useState<number | null>(null)
  /** index ของแถวที่ช่องไฟล์แนบกำลังโฟกัส (แสดงกล่องใหญ่); null = ปกติ */
  const [fileAttachmentFocusedIndex, setFileAttachmentFocusedIndex] = useState<number | null>(null)
  /** ref ช่องวันที่ เวลา นัดรับ (SHOP PICKUP) — คลิกที่ไหนของช่องก็เปิด picker ได้ */
  const scheduledPickupInputRef = useRef<HTMLInputElement>(null)

  const [formData, setFormData] = useState({
    channel_code: '',
    customer_name: '',
    customer_address: '',
    channel_order_no: '',
    recipient_name: '',
    scheduled_pickup_at: '',
    address_line: '',
    sub_district: '',
    district: '',
    province: '',
    postal_code: '',
    mobile_phone: '',
    tracking_number: '',
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
    mobile_phone: '',
    items_note: '',
  })
  const [autoFillAddressLoading, setAutoFillAddressLoading] = useState(false)
  /** เบอร์โทรที่ parse ได้หลายเบอร์ (จาก Auto fill) — แสดง dropdown ให้เลือก */
  const [mobilePhoneCandidates, setMobilePhoneCandidates] = useState<string[]>([])
  /** รายการแขวง/ตำบล + เขต (จาก Auto fill) — แสดง dropdown แขวง/เขต */
  const [subDistrictOptions, setSubDistrictOptions] = useState<SubDistrictOption[]>([])
  /** แสดง Modal แทน alert เมื่อยังไม่ได้เลือกสินค้าจาก dropdown */
  const [productSelectAlertOpen, setProductSelectAlertOpen] = useState(false)

  async function handleAutoFillAddress() {
    setAutoFillAddressLoading(true)
    try {
      const parsed = await parseAddressText(formData.customer_address || '', supabase)
      setMobilePhoneCandidates(parsed.mobilePhoneCandidates ?? [])
      setSubDistrictOptions(parsed.subDistrictOptions ?? [])
      const channelCode = formData.channel_code
      const updates: Partial<typeof formData> = {
        address_line: parsed.addressLine,
        sub_district: parsed.subDistrict,
        district: parsed.district,
        province: parsed.province,
        postal_code: parsed.postalCode,
        mobile_phone: parsed.mobilePhone,
      }
      if (parsed.recipientName?.trim()) {
        if (CHANNELS_SHOW_CHANNEL_NAME.includes(channelCode)) {
          updates.recipient_name = parsed.recipientName.trim()
        } else if (CHANNELS_SHOW_ORDER_NO.includes(channelCode)) {
          updates.customer_name = parsed.recipientName.trim()
        }
      }
      setFormData(prev => ({ ...prev, ...updates }))
    } finally {
      setAutoFillAddressLoading(false)
    }
  }

  /** โหลด path สลิป: ถ้ามี orderId โหลดจาก ac_verified_slips (ผูกกับออเดอร์) ก่อน; ไม่มีหรือว่างจึง list โฟลเดอร์ */
  async function loadSlipImages(billNo: string, orderId?: string): Promise<string[]> {
    try {
      if (orderId) {
        const { data: rows, error: dbError } = await supabase
          .from('ac_verified_slips')
          .select('slip_storage_path')
          .eq('order_id', orderId)
          .eq('is_deleted', false)
          .order('created_at', { ascending: true })
        if (!dbError && rows && rows.length > 0) {
          const paths = (rows as { slip_storage_path?: string | null }[])
            .map(r => r.slip_storage_path)
            .filter((p): p is string => Boolean(p))
          setUploadedSlipPaths(paths)
          return paths
        }
      }

      const folderName = `slip${billNo}`
      const { data: files, error } = await supabase.storage
        .from('slip-images')
        .list(folderName, { limit: 100 })

      if (error) {
        console.error('Error loading slip images:', error)
        setUploadedSlipPaths([])
        return []
      }

      if (!files || files.length === 0) {
        setUploadedSlipPaths([])
        return []
      }

      let storagePaths = files
        .filter(file => file.name && !file.name.endsWith('/'))
        .map(file => `slip-images/${folderName}/${file.name}`)
        .sort()

      if (orderId) {
        const { data: deletedRows } = await supabase
          .from('ac_verified_slips')
          .select('slip_storage_path')
          .eq('order_id', orderId)
          .eq('is_deleted', true)
        const deletedPaths = new Set(
          (deletedRows || []).map((r: { slip_storage_path?: string | null }) => r.slip_storage_path).filter(Boolean) as string[]
        )
        storagePaths = storagePaths.filter(p => !deletedPaths.has(p))
      }

      setUploadedSlipPaths(storagePaths)
      return storagePaths
    } catch (error) {
      console.error('Error loading slip images:', error)
      setUploadedSlipPaths([])
      return []
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
      const banks = data || []
      setBankSettings(banks)

      if (banks.length === 0) {
        setChannelCodesWithSlipVerification(new Set())
        return
      }
      const bankIds = banks.map((b: { id: string }) => b.id)
      const { data: bscData, error: bscError } = await supabase
        .from('bank_settings_channels')
        .select('channel_code')
        .in('bank_setting_id', bankIds)
      if (bscError) {
        setChannelCodesWithSlipVerification(new Set())
        return
      }
      const codes = new Set((bscData || []).map((r: { channel_code: string }) => r.channel_code).filter(Boolean))
      setChannelCodesWithSlipVerification(codes)
    } catch (error) {
      console.error('Error loading bank settings:', error)
    }
  }

  useEffect(() => {
    loadInitialData()
    loadBankSettings()
    async function loadOrderData() {
      if (order) {
        const bd = order.billing_details as { address_line?: string; sub_district?: string; district?: string; province?: string; postal_code?: string; mobile_phone?: string } | undefined
        const hasAddressParts = bd?.address_line != null || bd?.sub_district != null || bd?.province != null || bd?.postal_code != null
        const customerAddress = hasAddressParts
          ? [bd?.address_line, bd?.sub_district, bd?.district, bd?.province, bd?.postal_code].filter(Boolean).join(' ')
          : order.customer_address
        const orderAny = order as { channel_order_no?: string | null; recipient_name?: string | null; scheduled_pickup_at?: string | null }
        const sp = orderAny.scheduled_pickup_at
        const scheduledPickupLocal = sp ? (() => {
          const d = new Date(sp)
          if (isNaN(d.getTime())) return ''
          const y = d.getFullYear()
          const m = String(d.getMonth() + 1).padStart(2, '0')
          const day = String(d.getDate()).padStart(2, '0')
          const h = String(d.getHours()).padStart(2, '0')
          const min = String(d.getMinutes()).padStart(2, '0')
          return `${y}-${m}-${day}T${h}:${min}`
        })() : ''
        setFormData({
          channel_code: order.channel_code,
          customer_name: order.customer_name,
          customer_address: customerAddress,
          channel_order_no: orderAny.channel_order_no ?? '',
          recipient_name: orderAny.recipient_name ?? '',
          scheduled_pickup_at: scheduledPickupLocal,
          address_line: bd?.address_line ?? '',
          sub_district: bd?.sub_district ?? '',
          district: bd?.district ?? '',
          province: bd?.province ?? '',
          postal_code: bd?.postal_code ?? '',
          mobile_phone: bd?.mobile_phone ?? '',
          tracking_number: (order as { tracking_number?: string }).tracking_number || '',
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
          setItems([{ product_type: 'ชั้น1', quantity: 1 }])
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
            const bdTyped = bd as { tax_customer_phone?: string | null }
            setCashBillData({
              company_name: bd.tax_customer_name || '',
              address: bd.tax_customer_address || '',
              mobile_phone: bdTyped.tax_customer_phone ?? bd.mobile_phone ?? '',
              items_note: '',
            })
          }
        }

        if (order.bill_no) {
          await loadSlipImages(order.bill_no, order.id)
        } else {
          setUploadedSlipPaths([])
        }
      } else {
        setItems([{ product_type: 'ชั้น1', quantity: 1 }])
        setUploadedSlipPaths([])
      }
    }
    loadOrderData()
  }, [order])

  // โหลด review (error_fields + rejection_reason) เมื่อออเดอร์สถานะ "ลงข้อมูลผิด"
  useEffect(() => {
    if (!order?.id || order?.status !== 'ลงข้อมูลผิด') {
      setReviewErrorFields(null)
      setReviewErrorFieldsByItem(null)
      setReviewRemarks(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('or_order_reviews')
        .select('error_fields, rejection_reason')
        .eq('order_id', order.id)
        .eq('status', 'rejected')
        .order('reviewed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      if (error) {
        console.error('Error loading order review:', error)
        setReviewErrorFields(null)
        setReviewErrorFieldsByItem(null)
        setReviewRemarks(null)
        return
      }
      const raw = data?.error_fields as Record<string, unknown> | null
      setReviewRemarks(data?.rejection_reason ?? null)
      if (!raw || typeof raw !== 'object') {
        setReviewErrorFields(null)
        setReviewErrorFieldsByItem(null)
        return
      }
      const itemsArr = raw.items
      if (Array.isArray(itemsArr)) {
        const orderLevel: Record<string, boolean> = {}
        const orderKeys = ['channel_name', 'customer_name', 'address', 'channel_order_no', 'tracking_number', 'unit_price']
        orderKeys.forEach((k) => {
          if (raw[k] === true) orderLevel[k] = true
        })
        setReviewErrorFields(Object.keys(orderLevel).length > 0 ? orderLevel : null)
        const byItem: Record<number, Record<string, boolean>> = {}
        itemsArr.forEach((entry, i) => {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const obj = entry as Record<string, boolean>
            const filtered: Record<string, boolean> = {}
            Object.keys(obj).forEach((k) => { if (obj[k] === true) filtered[k] = true })
            if (Object.keys(filtered).length > 0) byItem[i] = filtered
          }
        })
        setReviewErrorFieldsByItem(Object.keys(byItem).length > 0 ? byItem : null)
      } else {
        setReviewErrorFields(raw as Record<string, boolean>)
        setReviewErrorFieldsByItem(null)
      }
    })()
    return () => { cancelled = true }
  }, [order?.id, order?.status])

  /** แปลงค่าเป็น boolean จริง (รองรับทั้ง boolean และ string จาก API); undefined/null = false (ซ่อนฟิลด์) ยกเว้นระบุ defaultVal */
  function toBool(v: unknown, defaultVal = false): boolean {
    if (v === undefined || v === null) return defaultVal
    return v === true || v === 'true'
  }

  /** โหลดการตั้งค่าฟิลด์ต่อหมวดหมู่แยก (ไม่พึ่ง loadInitialData) เพื่อให้ได้ข้อมูลแม้ request อื่นล้มเหลว */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await supabase.from('pr_category_field_settings').select('*')
        if (cancelled) return
        if (error) {
          console.error('Error loading category field settings:', error)
          return
        }
        const settingsMap: Record<string, Record<string, boolean>> = {}
        if (data && Array.isArray(data)) {
          data.forEach((row: any) => {
            const cat = row.category
            if (cat != null && String(cat).trim() !== '') {
              const key = String(cat).trim()
              settingsMap[key] = {
                product_name: toBool(row.product_name, true),
                ink_color: toBool(row.ink_color),
                layer: toBool(row.layer),
                cartoon_pattern: toBool(row.cartoon_pattern),
                line_pattern: toBool(row.line_pattern),
                font: toBool(row.font),
                line_1: toBool(row.line_1),
                line_2: toBool(row.line_2),
                line_3: toBool(row.line_3),
                quantity: toBool(row.quantity, true),
                unit_price: toBool(row.unit_price, true),
                notes: toBool(row.notes),
                attachment: toBool(row.attachment),
              }
            }
          })
        }
        setCategoryFieldSettings(settingsMap)
      } catch (e) {
        if (!cancelled) console.error('Error loading category field settings:', e)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /** เมื่อเปิด Modal เคลม: โหลดรายการบิลและ claim_type */
  useEffect(() => {
    if (!claimModalOpen) return
    setClaimStep(1)
    setSelectedClaimRefOrder(null)
    setSelectedClaimType('')
    setClaimFilterSearch('')
    setClaimFilterChannel('')
    setClaimOrdersLoading(true)
    ;(async () => {
      try {
        const [ordersRes, typesRes] = await Promise.all([
          supabase.from('or_orders').select('*').not('bill_no', 'is', null).eq('status', 'จัดส่งแล้ว').order('created_at', { ascending: false }).limit(500),
          supabase.from('claim_type').select('code, name').order('sort_order', { ascending: true }),
        ])
        if (ordersRes.data) setClaimOrders(ordersRes.data as Order[])
        if (typesRes.data) setClaimTypes(typesRes.data as { code: string; name: string }[])
      } catch (e) {
        console.error('Error loading claim data:', e)
      } finally {
        setClaimOrdersLoading(false)
      }
    })()
  }, [claimModalOpen])

  async function loadInitialData() {
    try {
      const [productsRes, patternsRes, channelsRes, inkTypesRes, fontsRes, categorySettingsRes, promotionsRes] = await Promise.all([
        supabase.from('pr_products').select('*').eq('is_active', true),
        supabase.from('cp_cartoon_patterns').select('*').eq('is_active', true),
        supabase.from('channels').select('channel_code, channel_name'),
        supabase.from('ink_types').select('id, ink_name').order('ink_name'),
        supabase.from('fonts').select('font_code, font_name').eq('is_active', true),
        supabase.from('pr_category_field_settings').select('*'),
        supabase.from('promotion').select('id, name').eq('is_active', true).order('name'),
      ])

      if (productsRes.data) setProducts(productsRes.data)
      if (patternsRes.data) setCartoonPatterns(patternsRes.data)
      if (channelsRes.data) setChannels(channelsRes.data)
      if (promotionsRes.data) setPromotions(promotionsRes.data)
      if (inkTypesRes.data) setInkTypes(inkTypesRes.data)
      if (fontsRes.data) setFonts(fontsRes.data)
      
      // โหลดการตั้งค่าฟิลด์ต่อหมวดหมู่ (แปลงเป็น boolean จริง เพื่อกันค่า string "false" ที่เป็น truthy)
      const settingsMap: Record<string, Record<string, boolean>> = {}
      if (categorySettingsRes.data && Array.isArray(categorySettingsRes.data)) {
        categorySettingsRes.data.forEach((row: any) => {
          const cat = row.category
          if (cat != null && String(cat).trim() !== '') {
            const key = String(cat).trim()
            settingsMap[key] = {
              product_name: toBool(row.product_name, true),
              ink_color: toBool(row.ink_color),
              layer: toBool(row.layer),
              cartoon_pattern: toBool(row.cartoon_pattern),
              line_pattern: toBool(row.line_pattern),
              font: toBool(row.font),
              line_1: toBool(row.line_1),
              line_2: toBool(row.line_2),
              line_3: toBool(row.line_3),
              quantity: toBool(row.quantity, true),
              unit_price: toBool(row.unit_price, true),
              notes: toBool(row.notes),
              attachment: toBool(row.attachment),
            }
          }
        })
      }
      setCategoryFieldSettings(settingsMap)
    } catch (error) {
      console.error('Error loading data:', error)
    }
  }

  /** เช็คว่าฟิลด์นี้ควรแสดงหรือไม่ สำหรับ item ที่ index นี้ */
  function isFieldEnabled(itemIndex: number, fieldKey: string): boolean {
    const item = items[itemIndex]
    if (!item?.product_id) return true // ถ้ายังไม่เลือกสินค้า แสดงทุกฟิลด์
    
    // หา product จาก id ก่อน; ถ้าไม่เจอลองจาก product_name (เผื่อ type ไม่ตรง)
    let product = products.find(p => String(p.id) === String(item.product_id))
    if (!product && item.product_name) {
      product = products.find(
        p => p.product_name && String(p.product_name).trim().toLowerCase() === String(item.product_name).trim().toLowerCase()
      )
    }
    if (!product) return true

    const catRaw = (product as { product_category?: string | null }).product_category
    if (catRaw === undefined || catRaw === null || String(catRaw).trim() === '') return true

    const catKey = String(catRaw).trim()
    const categorySettings = categoryFieldSettings[catKey]
    if (!categorySettings) return true // ถ้าไม่มี setting สำหรับหมวดหมู่นี้ แสดงทุกฟิลด์ (default = true)

    // คืนค่า boolean จริง (ถ้าค่าเป็น string "false" จะได้ false; ไม่มี key = แสดงฟิลด์)
    const v = categorySettings[fieldKey] as boolean | string | undefined
    if (v === undefined || v === null) return true
    return v === true || v === 'true'
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

  const isManualPriceChannel = CHANNELS_MANUAL_PRICE.includes(formData.channel_code || '')

  // คำนวณส่วนลดเป็นบาท (รองรับทั้งบาทและ %)
  function getDiscountInBaht(basePrice: number, discountValue: number, type: 'baht' | 'percent'): number {
    if (type === 'percent') {
      return Math.round(basePrice * (discountValue / 100) * 100) / 100
    }
    return discountValue
  }

  // คำนวณยอดสุทธิ
  function calculateTotal() {
    const itemsTotal = calculateItemsTotal()
    
    setFormData(prev => {
      // ใช้ prev.channel_code แทน closure เพื่อป้องกัน stale value
      const isManual = CHANNELS_MANUAL_PRICE.includes(prev.channel_code || '')
      const basePrice = isManual ? (prev.price || 0) : itemsTotal
      let subtotal: number
      
      // หากมีการกดปุ่มขอใบกำกับภาษี ยอดสุทธิจะใช้ยอดเงินที่ต้องชำระ (รวมภาษีแล้ว)
      if (showTaxInvoice) {
        // คำนวณยอดรวมภาษี 7% (ยอดเงินที่ต้องชำระ)
        subtotal = basePrice * 1.07
      } else {
        // คำนวณยอดปกติ (รวมค่าขนส่ง ลบส่วนลด)
        const discountBaht = getDiscountInBaht(basePrice, prev.discount || 0, discountType)
        subtotal = basePrice + (prev.shipping_cost || 0) - discountBaht
      }
      
      // ปัดเศษให้เป็น 2 ทศนิยมเพื่อหลีกเลี่ยง floating point error
      subtotal = Math.round(subtotal * 100) / 100
      
      return {
        ...prev,
        price: isManual ? (prev.price || 0) : itemsTotal,
        total_amount: subtotal
      }
    })
  }

  useEffect(() => {
    calculateTotal()
  }, [items, formData.shipping_cost, formData.discount, discountType, showTaxInvoice, formData.price, formData.channel_code])

  useEffect(() => {
    if (undoingRef.current) return
    const snapshot = {
      formData: { ...formData },
      items: items.map((item) => ({ ...item })),
    }
    undoStackRef.current.push(snapshot)
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift()
    }
  }, [formData, items])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      const prev = undoStackRef.current.pop()
      if (!prev) return
      event.preventDefault()
      undoingRef.current = true
      setFormData(prev.formData)
      setItems(prev.items)
      window.setTimeout(() => {
        undoingRef.current = false
      }, 0)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return

    // Validation สำหรับบันทึก "รอลงข้อมูล"
    if (!formData.channel_code || formData.channel_code.trim() === '') {
      setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกช่องทาง' })
      return
    }

    if (CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code)) {
      if (!formData.customer_name || formData.customer_name.trim() === '') {
        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกชื่อช่องทาง' })
        return
      }
    }
    if (CHANNELS_SHOW_ORDER_NO.includes(formData.channel_code)) {
      if (!formData.channel_order_no || formData.channel_order_no.trim() === '') {
        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกเลขคำสั่งซื้อ' })
        return
      }
      // ช่องทางใน CHANNELS_COMPLETE_TO_VERIFIED ไม่บังคับกรอกชื่อลูกค้าเมื่อบันทึก
      if (!CHANNELS_COMPLETE_TO_VERIFIED.includes(formData.channel_code) && (!formData.customer_name || formData.customer_name.trim() === '')) {
        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกชื่อลูกค้า' })
        return
      }
    }

    if (formData.channel_code === 'SHOPP') {
      if (!formData.scheduled_pickup_at || !formData.scheduled_pickup_at.trim()) {
        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกวันที่ เวลา นัดรับ' })
        return
      }
    }

    if (formData.tracking_number && formData.tracking_number.trim()) {
      const { data: dup, error } = await supabase
        .from('or_orders')
        .select('id')
        .eq('tracking_number', formData.tracking_number.trim())
        .neq('id', order?.id || '00000000-0000-0000-0000-000000000000')
        .limit(1)
      if (error) {
        setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: error.message })
        return
      }
      if (dup && dup.length > 0) {
        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'เลขพัสดุซ้ำกับรายการในระบบ' })
        return
      }
    }

    const isAddressBlocked = CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code)
    const composedAddress = [formData.address_line, formData.sub_district, formData.district, formData.province, formData.postal_code].filter(Boolean).join(' ').trim()
    const hasAddress = (formData.customer_address?.trim() || composedAddress) !== ''
    if (!isAddressBlocked && !hasAddress) {
      setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกที่อยู่ลูกค้า หรือวางที่อยู่แล้วกด Auto fill' })
      return
    }

    // พยายาม match สินค้าที่ไม่มี product_id แต่มี product_name หรือรหัสสินค้า
    let hasUpdates = false
    const updatedItems = items.map((item, index) => {
      if (!item.product_id && item.product_name?.trim()) {
        const searchName = item.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
        
        // พยายาม match จากรหัสสินค้า (ตรงทุกตัว)
        let matchedProduct = products.find(
          p => p.product_code && p.product_code.toLowerCase().trim() === searchName
        )
        // หรือ match จากชื่อสินค้า (case-insensitive, normalize spaces)
        if (!matchedProduct) {
          matchedProduct = products.find(
            p => p.product_name.toLowerCase().trim().replace(/\s+/g, ' ') === searchName
          )
        }
        // ถ้ายังไม่ match ลอง match แบบ partial (ชื่อสินค้า)
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
        setProductSelectAlertOpen(true)
      } else {
        alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
      }
      return
    }

    // ตรวจสอบว่ารายการสินค้าที่เลือกแล้ว กรอกข้อมูลครบทุกฟิลด์ที่เปิดใช้งาน (ยกเว้น บรรทัด1-3, หมายเหตุ, ไฟล์แนบ, สินค้าฟรี)
    const missingFieldItems: { index: number; productName: string; missingFields: string[] }[] = []
    itemsWithProduct.forEach((item, _) => {
      if ((item as { is_free?: boolean }).is_free) return // ข้ามสินค้าของแถม — ตรวจสอบเฉพาะปุ่ม "บันทึก (ข้อมูลครบ)"
      const itemIndex = items.indexOf(item)
      const missing: string[] = []
      // สีหมึก
      if (isFieldEnabled(itemIndex, 'ink_color') && !item.ink_color?.trim()) {
        missing.push('สีหมึก')
      }
      // ลาย (cartoon_pattern) — อนุญาตให้กรอก "0" ได้
      if (isFieldEnabled(itemIndex, 'cartoon_pattern') && !item.cartoon_pattern?.trim()) {
        missing.push('ลาย (หากไม่ต้องการเลือกลาย กรุณาใส่เลข 0)')
      }
      // ฟอนต์ — อนุญาตให้กรอก "0" ได้
      if (isFieldEnabled(itemIndex, 'font') && !item.font?.trim()) {
        missing.push('ฟอนต์ (หากไม่ต้องการเลือกฟอนต์ กรุณาใส่เลข 0)')
      }
      // จำนวน
      if (isFieldEnabled(itemIndex, 'quantity') && (!item.quantity || item.quantity <= 0)) {
        missing.push('จำนวน')
      }
      if (missing.length > 0) {
        missingFieldItems.push({
          index: itemIndex + 1,
          productName: item.product_name || 'สินค้า',
          missingFields: missing,
        })
      }
    })
    if (missingFieldItems.length > 0) {
      const details = missingFieldItems
        .map(m => `รายการที่ ${m.index} (${m.productName}): ${m.missingFields.join(', ')}`)
        .join('\n')
      setMessageModal({
        open: true,
        title: 'แจ้งเตือน',
        message: `กรุณากรอกข้อมูลให้ครบทุกช่อง\n\n${details}`,
      })
      return
    }

    // ตรวจสอบว่ารายการสินค้าทุกรายการมีราคา/หน่วยหรือไม่
    if (isManualPriceChannel) {
      if (!formData.price || formData.price <= 0) {
        setMessageModal({
          open: true,
          title: 'แจ้งเตือน',
          message: 'กรุณากรอกราคาที่ข้อมูลการชำระเงิน',
        })
        return
      }
    } else {
      const itemsWithoutPrice = itemsWithProduct.filter(item => (!item.unit_price || item.unit_price <= 0) && !isCondoSubRow(item) && !(item as { is_free?: boolean }).is_free)
      if (itemsWithoutPrice.length > 0) {
        const itemNames = itemsWithoutPrice.map(item => item.product_name || 'สินค้า').join(', ')
        setMessageModal({
          open: true,
          title: 'แจ้งเตือน',
          message: `กรุณากรอกราคา/หน่วยสำหรับรายการสินค้าทั้งหมด\n\nรายการที่ยังไม่มีราคา:\n${itemNames}`,
        })
        return
      }
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
      // คำนวณราคารวมจากรายการสินค้า หรือใช้ราคาที่กรอกเอง
      const calculatedPrice = isManualPriceChannel
        ? (formData.price || 0)
        : itemsToSave
            .filter(item => item.product_id)
            .reduce((sum, item) => {
              const quantity = item.quantity || 1
              const unitPrice = item.unit_price || 0
              return sum + (quantity * unitPrice)
            }, 0)
      
      // คำนวณยอดสุทธิ (เหมือนกับ calculateTotal)
      const discountBahtForSave = getDiscountInBaht(calculatedPrice, formData.discount, discountType)
      let calculatedTotal: number
      if (showTaxInvoice) {
        // คำนวณยอดรวมภาษี 7% (ยอดเงินที่ต้องชำระ)
        calculatedTotal = calculatedPrice * 1.07
      } else {
        // คำนวณยอดปกติ (รวมค่าขนส่ง ลบส่วนลด)
        calculatedTotal = calculatedPrice + formData.shipping_cost - discountBahtForSave
      }
      
      // ปัดเศษให้เป็น 2 ทศนิยมเพื่อหลีกเลี่ยง floating point error
      calculatedTotal = Math.round(calculatedTotal * 100) / 100
      
      // แก้ไขปัญหา date field - ถ้าเป็น empty string ให้เป็น null
      const paymentDate = formData.payment_date && formData.payment_date.trim() !== '' 
        ? formData.payment_date 
        : null
      const paymentTime = formData.payment_time && formData.payment_time.trim() !== '' 
        ? formData.payment_time 
        : null
      
      // เตรียมข้อมูล billing_details (รวม address parts สำหรับที่อยู่ลูกค้า)
      const hasAddressParts = !!(formData.address_line?.trim() || formData.sub_district?.trim() || formData.district?.trim() || formData.province?.trim() || formData.postal_code?.trim() || formData.mobile_phone?.trim())
      const customerAddressToSave = hasAddressParts
        ? [formData.address_line, formData.sub_district, formData.district, formData.province, formData.postal_code].filter(Boolean).join(' ')
        : (formData.customer_address || '')
      const billingDetails = {
        ...(order?.billing_details && typeof order.billing_details === 'object' ? order.billing_details : {}),
        request_tax_invoice: showTaxInvoice,
        request_cash_bill: showCashBill,
        tax_customer_name: showTaxInvoice ? taxInvoiceData.company_name : (showCashBill ? cashBillData.company_name : null),
        tax_customer_address: showTaxInvoice ? taxInvoiceData.address : (showCashBill ? cashBillData.address : null),
        tax_customer_phone: showCashBill ? (cashBillData.mobile_phone?.trim() || null) : (order?.billing_details && typeof order.billing_details === 'object' ? (order.billing_details as { tax_customer_phone?: string | null }).tax_customer_phone ?? null : null),
        tax_id: showTaxInvoice ? taxInvoiceData.tax_id : null,
        tax_items: (showTaxInvoice || showCashBill) ? itemsToSave
          .filter(item => item.product_id && !(item as { is_free?: boolean }).is_free)
          .map(item => ({
            product_name: item.product_name || '',
            quantity: item.quantity || 1,
            unit_price: item.unit_price || 0,
          })) : [],
        address_line: formData.address_line?.trim() || null,
        sub_district: formData.sub_district?.trim() || null,
        district: formData.district?.trim() || null,
        province: formData.province?.trim() || null,
        postal_code: formData.postal_code?.trim() || null,
        mobile_phone: formData.mobile_phone?.trim() || null,
      }

      // บิลที่บันทึก "ข้อมูลครบ": ช่องทางใน CHANNELS_COMPLETE_TO_VERIFIED → สถานะ "ตรวจสอบแล้ว" โดยตรง; ช่องทางอื่นที่ไม่มี slip verification → บันทึกเป็น "ตรวจสอบแล้ว"
      let statusToSave: 'รอลงข้อมูล' | 'ลงข้อมูลเสร็จสิ้น' | 'ตรวจสอบแล้ว' = targetStatus
      if (targetStatus === 'ลงข้อมูลเสร็จสิ้น') {
        const channelCode = formData.channel_code?.trim() || ''
        if (CHANNELS_COMPLETE_TO_VERIFIED.includes(channelCode)) {
          statusToSave = 'ตรวจสอบแล้ว'
        } else {
          let channelHasSlipVerification = false
          if (formData.payment_method === 'โอน') {
            const { data: bscData, error: bscError } = await supabase
              .from('bank_settings_channels')
              .select('bank_setting_id')
              .eq('channel_code', channelCode)
            if (bscError) {
              channelHasSlipVerification = true
            } else if (bscData && bscData.length > 0) {
              const ids = bscData.map((r: { bank_setting_id: string }) => r.bank_setting_id)
              const { data: activeBank } = await supabase
                .from('bank_settings')
                .select('id')
                .in('id', ids)
                .eq('is_active', true)
                .limit(1)
              channelHasSlipVerification = !!(activeBank && activeBank.length > 0)
            }
          }
          if (!channelHasSlipVerification) {
            statusToSave = 'ตรวจสอบแล้ว'
          }
        }
      }

      const { address_line: _al, sub_district: _sd, district: _d, province: _p, postal_code: _pc, mobile_phone: _mp, scheduled_pickup_at: _spForm, ...formDataForDb } = formData
      const orderData = {
        ...formDataForDb,
        customer_address: customerAddressToSave,
        price: calculatedPrice,
        discount: discountBahtForSave,
        total_amount: calculatedTotal,
        payment_date: paymentDate,
        payment_time: paymentTime,
        status: statusToSave,
        admin_user: user.username || user.email,
        entry_date: new Date().toISOString().slice(0, 10),
        billing_details: (showTaxInvoice || showCashBill || hasAddressParts) ? billingDetails : (order?.billing_details ?? null),
        scheduled_pickup_at: formData.scheduled_pickup_at?.trim() ? new Date(formData.scheduled_pickup_at.trim()).toISOString() : null,
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
        // New order (no Create Bill yet): generate bill_no and insert
        const billNo = await generateBillNo(formData.channel_code)
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
            // ตั้งชื่อ item_uid เป็น bill_no-1, bill_no-2, ... ตามลำดับรายการ
            const itemUid = currentBillNo ? `${currentBillNo}-${index + 1}` : `${formData.channel_code}-${Date.now()}-${index}-${Math.random().toString(36).substring(2, 9)}`
            
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
              no_name_line: !!(item as { no_name_line?: boolean }).no_name_line,
              is_free: !!(item as { is_free?: boolean }).is_free,
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

      // ถ้าเป็น "ลงข้อมูลเสร็จสิ้น" ให้ตรวจสอบสลิป (เฉพาะเมื่อช่องทางมีในข้อมูลธนาคารสำหรับตรวจสลิป)
      // ช่องทางใน CHANNELS_COMPLETE_TO_VERIFIED บันทึกเป็น "ตรวจสอบแล้ว" แล้ว — ไม่ต้องรันตรวจสลิป
      if (targetStatus === 'ลงข้อมูลเสร็จสิ้น') {
        const channelCodeForVerify = formData.channel_code?.trim() || ''
        if (CHANNELS_COMPLETE_TO_VERIFIED.includes(channelCodeForVerify)) {
          // ข้ามการตรวจสลิป — สถานะถูกบันทึกเป็น "ตรวจสอบแล้ว" แล้วใน handleSubmitInternal
        } else {
        const originalStatus = order?.status
        let channelHasSlipVerification = false
        if (formData.payment_method === 'โอน') {
          const channelCode = channelCodeForVerify
          const { data: bscData, error: bscError } = await supabase
            .from('bank_settings_channels')
            .select('bank_setting_id')
            .eq('channel_code', channelCode)
          if (bscError) {
            channelHasSlipVerification = true // fail secure
          } else if (bscData && bscData.length > 0) {
            const ids = bscData.map((r: { bank_setting_id: string }) => r.bank_setting_id)
            const { data: activeBank } = await supabase
              .from('bank_settings')
              .select('id')
              .in('id', ids)
              .eq('is_active', true)
              .limit(1)
            channelHasSlipVerification = !!(activeBank && activeBank.length > 0)
          }
        }

        if (channelHasSlipVerification) {
          const shouldVerifySlips =
            uploadedSlipPaths.length > 0 ||
            originalStatus === 'ลงข้อมูลผิด' ||
            originalStatus === 'ตรวจสอบไม่ผ่าน'

          if (shouldVerifySlips) {
            // ใช้เฉพาะ uploadedSlipPaths (การอัพปัจจุบัน) — ไม่ fallback โหลดจาก storage เพื่อไม่ให้ไปดึงสลิปเก่า
            const slipsToVerify = uploadedSlipPaths

            if (slipsToVerify.length > 0) {
              try {
                await verifyUploadedSlips(orderId, slipsToVerify, calculatedTotal)
                // หลังแสดงผลตรวจสลิป โหลด path กลับมา (ตัด path ที่ถูกลบแล้วถ้ามี orderId)
                if (currentBillNo) await loadSlipImages(currentBillNo, orderId)
                return
              } catch (error: any) {
                console.error('Error verifying slips:', error)
                alert('เกิดข้อผิดพลาดในการตรวจสอบสลิป: ' + error.message)
                onSave()
                return
              }
            } else {
              // ถ้าไม่มีสลิปเลย แต่บิลอยู่ในสถานะ "ลงข้อมูลผิด" หรือ "ตรวจสอบไม่ผ่าน"
              // ให้แจ้งเตือนและย้ายไปสถานะ "ตรวจสอบไม่ผ่าน"
              if (originalStatus === 'ลงข้อมูลผิด' || originalStatus === 'ตรวจสอบไม่ผ่าน') {
                const { error: updateError } = await supabase
                  .from('or_orders')
                  .update({ status: 'ตรวจสอบไม่ผ่าน' })
                  .eq('id', orderId)

                if (updateError) {
                  console.error('Error updating order status:', updateError)
                  setMessageModal({
                    open: true,
                    title: 'เกิดข้อผิดพลาด',
                    message: 'เกิดข้อผิดพลาดในการอัพเดตสถานะออเดอร์: ' + updateError.message,
                  })
                } else {
                  setMessageModal({
                    open: true,
                    title: 'แจ้งเตือน',
                    message: 'ไม่พบสลิปโอนเงิน บิลถูกย้ายไปเมนู "ตรวจสอบไม่ผ่าน" กรุณาอัพโหลดสลิปโอนเงิน',
                  })
                  onSave()
                  return
                }
              }
            }
          }
        }
        }
      }

      const statusText = targetStatus === 'ลงข้อมูลเสร็จสิ้น' ? 'บันทึกข้อมูลครบ' : 'บันทึก (รอลงข้อมูล)'
      const successMessage = order ? `อัปเดตข้อมูลสำเร็จ (${statusText})` : `บันทึกสำเร็จ! (${statusText})`

      // โหลดรูปสลิปกลับมา (ถ้ามี bill_no) — ส่ง orderId เพื่อตัด path ที่ถูกลบแล้ว
      if (currentBillNo) {
        console.log('[บันทึกออเดอร์] โหลดรูปสลิปกลับมาสำหรับ bill_no:', currentBillNo)
        await loadSlipImages(currentBillNo, orderId)
      } else {
        if (uploadedSlipPaths.length > 0) {
          setUploadedSlipPaths([])
        }
      }

      // แสดงผลด้วย VerificationResultModal แทน alert (localhost)
      setVerificationModal({
        type: 'save_success',
        accountMatch: null,
        bankCodeMatch: null,
        amountStatus: 'match',
        orderAmount: 0,
        totalAmount: 0,
        errors: [],
        validationErrors: [],
        statusMessage: successMessage,
      })
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

      // ระบบป้องกันสลิปซ้ำ: สลิปถือว่าซ้ำเมื่อพบในออเดอร์อื่นที่สถานะ "ไม่ใช่" ต่อไปนี้ (สถานะที่ไม่นับว่าซ้ำ: รอลงข้อมูล, ลงข้อมูลผิด, ตรวจสอบไม่ผ่าน)
      const SLIP_NOT_USED_STATUSES = ['รอลงข้อมูล', 'ลงข้อมูลผิด', 'ตรวจสอบไม่ผ่าน'] as const
      const isSlipUsedByOrder = (status: string | null | undefined) =>
        status != null && !SLIP_NOT_USED_STATUSES.includes(status as any)

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
            .select('order_id, or_orders(status)')
            .eq('easyslip_trans_ref', transRef)
            .eq('is_deleted', false)
            .neq('order_id', orderId)
          
          const verifiedDuplicate = (duplicateByRef || []).find(
            (row: any) => isSlipUsedByOrder(row.or_orders?.status)
          )
          if (verifiedDuplicate) {
            return { isDuplicate: true, duplicateOrderId: verifiedDuplicate.order_id }
          }
        }
        
        // Check by amount + date combination (fallback)
        if (amount && date) {
          const { data: duplicateByAmountDate } = await supabase
            .from('ac_verified_slips')
            .select('order_id, or_orders(status)')
            .eq('verified_amount', amount)
            .eq('easyslip_date', date)
            .eq('is_deleted', false)
            .neq('order_id', orderId)
          
          const verifiedDuplicate = (duplicateByAmountDate || []).find(
            (row: any) => isSlipUsedByOrder(row.or_orders?.status)
          )
          if (verifiedDuplicate) {
            return { isDuplicate: true, duplicateOrderId: verifiedDuplicate.order_id }
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

      // ดึงยอดจากผลตรวจ — รองรับ amount เป็น string จาก API และ fallback จาก easyslipResponse
      const getSlipAmount = (r: any): number => {
        const raw = r?.amount ?? r?.easyslipResponse?.data?.amount?.amount ?? r?.data?.amount?.amount
        if (raw == null || raw === '') return 0
        const n = Number(raw)
        return Number.isFinite(n) ? n : 0
      }

      // ยอดรวมจากผลตรวจรอบนี้ (ใช้ชั่วคราวสำหรับ build slipsToInsert; หลัง insert จะ query จาก ac_verified_slips)
      let totalFromSlips = results.reduce((sum, r) => sum + getSlipAmount(r), 0)
      const isMultiSlip = slipStoragePaths.length > 1
      const totalAmountMatchesOrder = Math.abs(totalFromSlips - orderAmount) <= 0.01

      if (isMultiSlip) {
        console.log('[Verify Slips] Multi-slip total:', {
          perSlipAmounts: results.map((r, i) => ({ slip: i + 1, amount: getSlipAmount(r), raw: (r as any).amount })),
          totalFromSlips,
          orderAmount,
          match: totalAmountMatchesOrder,
        })
      }

      let totalAmount = 0
      const errors: string[] = []
      const successfulVerifications: number[] = []
      const validationErrors: string[] = []
      let allAccountNameMatch = true
      let allBankCodeMatch = true

      results.forEach((result, index) => {
        const duplicateCheck = duplicateChecks[index]
        const isDuplicate = duplicateCheck.isDuplicate
        
        // If duplicate, treat as failed แต่ยังใช้ผลตรวจเลขบัญชี/สาขา/ยอดจาก API ได้ (สลิปซ้ำไม่ได้แปลว่าไม่ตรง)
        if (isDuplicate) {
          errors.push(`สลิป ${index + 1}: สลิปซ้ำ (พบในออเดอร์อื่น)`)
          if (result.accountNameMatch === false) allAccountNameMatch = false
          if (result.bankCodeMatch === false) allBankCodeMatch = false
        } else if (result.success) {
          totalAmount += getSlipAmount(result)
          successfulVerifications.push(index + 1)
          
          // Track account name and bank code matches
          if (result.accountNameMatch === false) {
            allAccountNameMatch = false
          }
          if (result.bankCodeMatch === false) {
            allBankCodeMatch = false
          }
          
          // กรณีหลายสลิป: ไม่เอา "ยอดเงินไม่ตรง" ต่อใบมาเป็น validation error — ใช้ผลรวมเทียบทีเดียว
          if (result.validationErrors && Array.isArray(result.validationErrors) && result.validationErrors.length > 0) {
            const errs = isMultiSlip
              ? result.validationErrors.filter((err: string) => !/ยอดเงิน|amount/i.test(err))
              : result.validationErrors
            if (errs.length > 0) {
              validationErrors.push(...errs.map((err: string) => `สลิป ${index + 1}: ${err}`))
            }
          } else if (result.error && result.error.includes('ไม่ตรง') && !isMultiSlip) {
            validationErrors.push(`สลิป ${index + 1}: ${result.error}`)
          }
        } else {
          const rawError = result.error || result.message || 'การตรวจสอบล้มเหลว'
          let friendlyError: string
          if (/application_expired/i.test(rawError)) {
            friendlyError = 'แพคเกจหมดอายุ หรือ โคต้าหมด'
          } else if (/slip_not_found|not_found|อ่านข้อมูลไม่ได้/i.test(rawError)) {
            friendlyError = 'ระบบอ่านข้อมูลสลิปจากรูปนี้ไม่ได้\n(รูปอาจไม่ชัด ไม่ใช่สลิปที่รองรับ หรือไฟล์เสีย)\nกรุณาตรวจสอบรูปหรืออัพโหลดใหม่'
          } else {
            friendlyError = rawError
          }
          errors.push(`สลิป ${index + 1}: ${friendlyError}`)
          // ใช้ค่าจริงจาก EasySlip — ไม่บังคับให้เลขบัญชี/สาขาเป็นไม่ตรงเมื่อสลิป fail (เช่น แค่ยอดเกิน)
          if (result.accountNameMatch === false) allAccountNameMatch = false
          if (result.bankCodeMatch === false) allBankCodeMatch = false
        }
      })

      // กรณีหลายสลิปและผลรวมไม่ตรงยอดออเดอร์: เพิ่มข้อความสำหรับ modal
      if (isMultiSlip && !totalAmountMatchesOrder && totalFromSlips > 0) {
        validationErrors.push(
          totalFromSlips < orderAmount
            ? `ยอดรวมสลิป (฿${totalFromSlips.toLocaleString()}) ไม่พอ ยอดออเดอร์ (฿${orderAmount.toLocaleString()})`
            : `ยอดรวมสลิป (฿${totalFromSlips.toLocaleString()}) เกิน ยอดออเดอร์ (฿${orderAmount.toLocaleString()})`
        )
      }

      // Save ALL EasySlip responses to ac_verified_slips FIRST (before validation)
      // กรณีหลายสลิป: ยอดเงินใช้ผลรวมเทียบกับยอดออเดอร์ — เลขบัญชี/สาขาต้องตรงทุกใบ
      const slipsToInsert = results
        .map((r: any, idx) => {
          // Skip if no EasySlip response (ไม่มีข้อมูลจาก API) หรือดึงยอดไม่ได้
          const slipAmount = getSlipAmount(r)
          if (!r.easyslipResponse && slipAmount === 0) {
            return null
          }
          
          const duplicateCheck = duplicateChecks[idx]
          const isDuplicate = duplicateCheck.isDuplicate
          
          // Determine validation status
          let validationStatus: 'pending' | 'passed' | 'failed' = 'pending'
          const slipValidationErrors: string[] = []
          
          // Add duplicate error if found
          if (isDuplicate) {
            slipValidationErrors.push(`สลิปซ้ำ (พบในออเดอร์อื่น)`)
            validationStatus = 'failed'
          } else if (r.success === true) {
            // กรณีหลายสลิป: ผ่านต่อใบเมื่อไม่มี error อื่น (ยอดใช้ผลรวมเช็คแยก)
            if (isMultiSlip) {
              const nonAmountErrors = (r.validationErrors && Array.isArray(r.validationErrors))
                ? r.validationErrors.filter((err: string) => !/ยอดเงิน|amount/i.test(err))
                : []
              if (nonAmountErrors.length > 0) {
                slipValidationErrors.push(...nonAmountErrors)
                validationStatus = 'failed'
              } else {
                validationStatus = totalAmountMatchesOrder ? 'passed' : 'failed'
              }
            } else {
              validationStatus = 'passed'
            }
          } else if (r.success === false) {
            validationStatus = 'failed'
            // กรณีหลายสลิป: ไม่เก็บ error เรื่องยอดเงินต่อใบ
            if (r.validationErrors && Array.isArray(r.validationErrors)) {
              const errs = isMultiSlip
                ? r.validationErrors.filter((err: string) => !/ยอดเงิน|amount/i.test(err))
                : r.validationErrors
              slipValidationErrors.push(...errs)
            }
            if (slipValidationErrors.length === 0 && r.error && !/ยอดเงิน|amount/i.test(r.error)) {
              slipValidationErrors.push(r.error)
            } else if (slipValidationErrors.length === 0 && r.message && !r.success && !/ยอดเงิน|amount/i.test(r.message)) {
              slipValidationErrors.push(r.message)
            }
          }
          
          // กรณีหลายสลิป: amount_match = ผลรวมตรงกับยอดออเดอร์หรือไม่ (ทุกใบใช้ค่าเดียวกัน)
          const amountMatchValue = isMultiSlip ? totalAmountMatchesOrder : (r.amountMatch !== undefined ? r.amountMatch : null)
          
          return {
            order_id: orderId,
            slip_image_url: slipUrls[idx],
            slip_storage_path: slipStoragePaths[idx] || null,
            verified_amount: slipAmount,
            verified_by: verifiedBy,
            easyslip_response: r.easyslipResponse || null,
            easyslip_trans_ref: r.easyslipResponse?.data?.transRef || null,
            easyslip_date: r.easyslipResponse?.data?.date || null,
            easyslip_receiver_bank_id: r.easyslipResponse?.data?.receiver?.bank?.id || null,
            easyslip_receiver_account: r.easyslipResponse?.data?.receiver?.account?.bank?.account || null,
            // Validation status fields
            is_validated: r.success !== undefined || isDuplicate,
            validation_status: validationStatus,
            validation_errors: slipValidationErrors.length > 0 ? slipValidationErrors : null,
            expected_amount: orderAmount || null,
            expected_bank_account: bankAccount || null,
            expected_bank_code: bankCode || null,
            // Individual validation statuses — เลขบัญชี/สาขาต้องตรงทุกใบ; ยอดใช้ผลรวมเมื่อหลายสลิป
            account_name_match: r.accountNameMatch !== undefined ? r.accountNameMatch : null,
            bank_code_match: r.bankCodeMatch !== undefined ? r.bankCodeMatch : null,
            amount_match: amountMatchValue !== null ? amountMatchValue : (r.amountMatch !== undefined ? r.amountMatch : null),
          }
        })
        .filter((s: any) => s !== null) // Remove null entries

      // Log what we're about to insert into ac_verified_slips
      console.log('[Verify Slips] All slips to insert (before validation):', slipsToInsert.map((s, idx) => s ? {
        index: idx + 1,
        verified_amount: s.verified_amount,
        hasEasyslipResponse: !!s.easyslip_response,
        validation_status: s.validation_status,
        validation_errors: s.validation_errors,
        is_validated: s.is_validated,
      } : null))

      // Insert or Update ALL slips (regardless of validation result)
      // Match existing by slip_storage_path (so "upload only" rows get updated with verification result)
      if (slipsToInsert.length > 0) {
        const storagePaths = slipsToInsert.map((s: any) => s.slip_storage_path).filter(Boolean)
        const existingByPath: Record<string, { id: string; slip_image_url: string }> = {}
        if (storagePaths.length > 0) {
          const { data: existingByStorage, error: checkErr } = await supabase
            .from('ac_verified_slips')
            .select('id, slip_image_url, slip_storage_path')
            .eq('order_id', orderId)
            .in('slip_storage_path', storagePaths)
          if (!checkErr && existingByStorage) {
            existingByStorage.forEach((r: any) => {
              if (r.slip_storage_path) existingByPath[r.slip_storage_path] = { id: r.id, slip_image_url: r.slip_image_url }
            })
          }
        }
        const toInsert = slipsToInsert.filter((s: any) => !s.slip_storage_path || !existingByPath[s.slip_storage_path])
        const toUpdate = slipsToInsert.filter((s: any) => s.slip_storage_path && existingByPath[s.slip_storage_path])

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
                    if (!slip) continue
                    const { error: updateError } = await supabase
                      .from('ac_verified_slips')
                      .update({
                        order_id: slip.order_id,
                        slip_storage_path: slip.slip_storage_path ?? null,
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
                  if (!slip) continue
                  const { error: updateError } = await supabase
                    .from('ac_verified_slips')
                    .update({
                      order_id: slip.order_id,
                      slip_storage_path: slip.slip_storage_path ?? null,
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

          // Update existing records (e.g. "upload only" rows matched by slip_storage_path)
          if (toUpdate.length > 0) {
            console.log('[Verify Slips] Updating', toUpdate.length, 'existing verified slips for this order')
            const updatePayload = (slip: any) => ({
              slip_image_url: slip.slip_image_url,
              slip_storage_path: slip.slip_storage_path ?? null,
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
            for (const slip of toUpdate) {
              if (!slip?.slip_storage_path) continue
              const existing = existingByPath[slip.slip_storage_path]
              if (!existing) continue
              const { error: updateError } = await supabase
                .from('ac_verified_slips')
                .update(updatePayload(slip))
                .eq('id', existing.id)

              if (updateError) {
                console.error('[Verify Slips] Error updating verified slip:', updateError, 'for path:', slip.slip_storage_path)
              }
            }
            console.log('[Verify Slips] Successfully updated verified slips:', toUpdate.length, 'records')
          }
      } else {
        console.log('[Verify Slips] No slips to insert (no EasySlip response received)')
      }

      // แหล่งความจริงของยอดรวมสลิป: sum จาก ac_verified_slips (ไม่รวมสลิปที่ลบแล้ว)
      const { data: verifiedSlipsForOrder } = await supabase
        .from('ac_verified_slips')
        .select('verified_amount')
        .eq('order_id', orderId)
        .eq('is_deleted', false)
      const sumFromVerifiedSlips = (verifiedSlipsForOrder || []).reduce(
        (sum, r) => sum + (Number((r as any).verified_amount) || 0),
        0
      )
      totalFromSlips = sumFromVerifiedSlips

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

        // ยอดจากสลิป (รวมทุกใบ ไม่รวมที่ลบ) — มาจาก ac_verified_slips (totalFromSlips ที่ query แล้ว)
        const displayTotal = totalFromSlips > 0 ? totalFromSlips : totalAmount
        let failedAmountStatus: AmountStatus = 'mismatch'
        if (displayTotal === orderAmount) failedAmountStatus = 'match'
        else if (displayTotal > orderAmount) failedAmountStatus = 'over'
        else if (displayTotal < orderAmount && displayTotal > 0) failedAmountStatus = 'under'

        // เลขบัญชีตรง สาขาตรง แต่ยอดเกิน และไม่มีสลิปซ้ำ → แสดงปุ่ม "ยืนยัน โอนเงินเกิน" แทน modal ไม่สำเร็จ
        if (displayTotal > orderAmount && allAccountNameMatch && allBankCodeMatch && !duplicateChecks.some((d) => d.isDuplicate)) {
          const overpay = displayTotal - orderAmount
          const msg = errors.length === 0 && validationErrors.length === 0
            ? `เลขบัญชีและสาขาตรงกัน แต่ยอดสลิปเกิน\n\nยืนยันว่าลูกค้าโอนเกินและต้องมีการโอนคืนหรือไม่?`
            : `เลขบัญชีและสาขาตรงกัน แต่ยอดเกิน\n\n${validationErrors.length > 0 ? validationErrors.join('\n') + '\n\n' : ''}ยืนยันว่าลูกค้าโอนเกินและต้องมีการโอนคืนหรือไม่?`
          setVerificationModal({
            type: 'over_transfer',
            accountMatch: true,
            bankCodeMatch: true,
            amountStatus: 'over',
            orderAmount,
            totalAmount: displayTotal,
            overpayAmount: overpay,
            errors,
            validationErrors,
            statusMessage: msg,
            orderId,
          })
          return
        }

        const errorMessage = `ตรวจสอบสลิปไม่สำเร็จทั้งหมด\n\nบิลถูกย้ายไปเมนู "ตรวจสอบไม่ผ่าน"`
        setVerificationModal({
          type: 'failed',
          accountMatch: allAccountNameMatch,
          bankCodeMatch: allBankCodeMatch,
          amountStatus: failedAmountStatus,
          orderAmount,
          totalAmount: displayTotal,
          errors,
          validationErrors: [],
          statusMessage: errorMessage,
        })
        return
      }

      // กรณีหลายสลิป: ใช้ผลรวมจากทุกใบ (totalFromSlips) สำหรับเช็คยอด
      const amountForCheck = isMultiSlip ? totalFromSlips : totalAmount
      let newStatus: string = 'ตรวจสอบไม่ผ่าน'
      let statusMessage = ''
      let amountStatus: AmountStatus = 'mismatch'
      const overpayAmount = amountForCheck > orderAmount ? amountForCheck - orderAmount : 0

      if (Math.abs(amountForCheck - orderAmount) <= 0.01) {
        amountStatus = 'match'
        if (validationErrors.length === 0 && errors.length === 0) {
          newStatus = 'ตรวจสอบแล้ว'
          statusMessage = `ตรวจสอบสลิปสำเร็จ! ยอดรวม: ฿${amountForCheck.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        } else {
          newStatus = 'ตรวจสอบไม่ผ่าน'
          statusMessage = `ยอดเงินถูกต้อง แต่พบข้อผิดพลาดในการตรวจสอบ\n\nยอดรวม: ฿${amountForCheck.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        }
      } else if (amountForCheck > orderAmount) {
        amountStatus = 'over'
        if (allAccountNameMatch && allBankCodeMatch && !duplicateChecks.some((d) => d.isDuplicate)) {
          // เลขบัญชีและสาขาตรง แต่ยอดเกิน และไม่มีสลิปซ้ำ → แสดง popup ยืนยันโอนเงินเกิน (ยังไม่อัปเดต DB)
          const msg = errors.length === 0 && validationErrors.length === 0
            ? `เลขบัญชีและสาขาตรงกัน\n\nยืนยันว่าลูกค้าโอนเกินและต้องมีการโอนคืนหรือไม่?`
            : `เลขบัญชีและสาขาตรงกัน แต่ยอดเกิน\n\n${validationErrors.length > 0 ? validationErrors.join('\n') + '\n\n' : ''}ยืนยันว่าลูกค้าโอนเกินและต้องมีการโอนคืนหรือไม่?`
          setVerificationModal({
            type: 'over_transfer',
            accountMatch: true,
            bankCodeMatch: true,
            amountStatus: 'over',
            orderAmount,
            totalAmount: amountForCheck,
            overpayAmount,
            errors,
            validationErrors,
            statusMessage: msg,
            orderId,
          })
          return
        } else {
          newStatus = 'ตรวจสอบไม่ผ่าน'
          statusMessage = `ยอดสลิปเกิน แต่เลขบัญชีหรือสาขาไม่ตรง หรือมีข้อผิดพลาดในการตรวจสอบ\n\nยอดรวม: ฿${amountForCheck.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
        }
      } else {
        amountStatus = 'under'
        newStatus = 'ตรวจสอบไม่ผ่าน'
        statusMessage = `ยอดสลิปไม่พอ! ยอดรวม: ฿${amountForCheck.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`
      }

      if (errors.length > 0 && successfulVerifications.length < slipStoragePaths.length) {
        newStatus = 'ตรวจสอบไม่ผ่าน'
      }
      if (errors.length > 0) {
        statusMessage += `\n\nสลิปที่สำเร็จ: ${successfulVerifications.join(', ')}\nสลิปที่ล้มเหลว: ${errors.length} ใบ`
      }

      // หากมีสลิปซ้ำอย่างน้อย 1 ใบ ให้ตั้งสถานะบิลเป็น ตรวจสอบไม่ผ่าน
      if (duplicateChecks.some((d) => d.isDuplicate)) {
        newStatus = 'ตรวจสอบไม่ผ่าน'
      }

      const { error: updateError } = await supabase
        .from('or_orders')
        .update({ status: newStatus })
        .eq('id', orderId)

      if (updateError) {
        console.error('Error updating order status:', updateError)
        throw new Error('เกิดข้อผิดพลาดในการอัพเดตสถานะออเดอร์: ' + updateError.message)
      }

      const modalType: VerificationResultType = newStatus === 'ตรวจสอบแล้ว' ? 'success' : 'failed'
      setVerificationModal({
        type: modalType,
        accountMatch: allAccountNameMatch ? true : (errors.length === 0 ? false : null),
        bankCodeMatch: allBankCodeMatch ? true : (errors.length === 0 ? false : null),
        amountStatus,
        orderAmount,
        totalAmount: amountForCheck,
        overpayAmount: overpayAmount > 0 ? overpayAmount : undefined,
        errors,
        validationErrors,
        statusMessage,
      })
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

  const parseNumber = (value: unknown) => {
    if (value == null) return 0
    const n = parseFloat(String(value).replace(/,/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  const parseTimeString = (value: unknown) => {
    if (!value) return null
    const s = String(value).trim()
    if (!s) return null
    return s.length >= 5 ? s.substring(0, 5) : s
  }

  const toDateString = (d: Date | null) => (d && !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null)

  const excelDateToJSDate = (serial: unknown) => {
    if (typeof serial !== 'number' || isNaN(serial)) return null
    const utcDays = Math.floor(serial - 25569)
    const utcValue = utcDays * 86400
    const dateInfo = new Date(utcValue * 1000)
    const fractionalDay = serial - Math.floor(serial) + 0.0000001
    let totalSeconds = Math.floor(86400 * fractionalDay)
    const seconds = totalSeconds % 60
    totalSeconds -= seconds
    const hours = Math.floor(totalSeconds / (60 * 60))
    const minutes = Math.floor(totalSeconds / 60) % 60
    return new Date(dateInfo.getFullYear(), dateInfo.getMonth(), dateInfo.getDate(), hours, minutes, seconds)
  }

  const findHeader = (headers: string[], possibleNames: string[]) => {
    const lowerCaseNames = possibleNames.map((name) => name.toLowerCase().trim())
    for (const header of headers) {
      if (header && lowerCaseNames.includes(header.toLowerCase().trim())) return header
    }
    return null
  }

  const downloadStandardOrderTemplate = () => {
    const headers = [
      'ช่องทาง',
      'ชื่อลูกค้า',
      'ที่อยู่ลูกค้า',
      'ราคา',
      'ค่าส่ง',
      'ส่วนลด',
      'วิธีการชำระ',
      'ชื่อโปรโมชั่น',
      'วันที่ชำระ',
      'เวลาที่ชำระ',
      'ชื่อสินค้า',
      'สีหมึก',
      'ชั้นที่',
      'ลายการ์ตูน',
      'ลายเส้น',
      'ฟอนต์',
      'บรรทัด 1',
      'บรรทัด 2',
      'บรรทัด 3',
      'จำนวน',
      'หมายเหตุ',
      'ไฟล์แนบ',
    ]
    const sampleData = [
      [
        'SP',
        'สมชาย ใจดี',
        '123/45 ถ.สุขุมวิท พระโขนง คลองเตย กทม. 10110',
        300,
        30,
        0,
        'โอน',
        'โปร 9.9',
        '2025-10-15',
        '10:30',
        'ป้ายชื่อรีดติด',
        'ดำ',
        '1',
        'กระต่าย',
        'เส้นปกติ',
        'TH01',
        'ด.ช. รักเรียน',
        'ชั้น ป.1',
        '',
        2,
        'ไม่มี',
        '',
      ],
    ]
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...sampleData])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'OrderTemplate')
    XLSX.writeFile(workbook, 'TRKids_Multi_Order_Template_Simple.xlsx')
  }

  const downloadPgtrTemplate = () => {
    const headers = [
      '#',
      'วันที่สั่งซื้อ',
      'เวลา',
      'หลักฐานการโอน',
      'ราคาก่อนส่วนลด',
      'ค่าขนส่ง',
      'coupon',
      'ส่วนลด admin',
      'ยอดสุทธิ',
      'ตัวแทน',
      'แอดมิน',
      'ช่องทางการสั่งซื้อ',
      'เลขออร์เดอร์',
      'ชื่อสินค้า',
      'รหัสสินค้า',
      'ฟอนต์',
      'รหัสรูปแบบ',
      'Underline',
      'Ink',
      'สี',
      'Label1',
      'Label2',
      'Label3',
      'จำนวน',
      'comment',
      'remark',
      'ชื่อสกุลผู้รับ',
      'โทรศัพท์',
      'อีเมล',
      'จังหวัด',
      'เขตอำเภอ',
      'ตำบลปลายทาง',
      'รหัสไปษณีย์',
      'ที่อยู่ผู้รับ',
      'ที่อยู่เต็ม',
    ]
    const worksheet = XLSX.utils.aoa_to_sheet([headers])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'PGTR_Template')
    XLSX.writeFile(workbook, 'TRKids_PGTR_Order_Template.xlsx')
  }

  const downloadWyTemplate = () => {
    const headers = [
      'เลขบิล',
      'ชื่อลูกค้า',
      'รหัสลูกค้า',
      'วันที่สั่งซื้อ',
      'เลขอ้างอิงชำระ',
      'รหัส',
      'สินค้า',
      'บรรทัด1',
      'บรรทัด2',
      'font',
      'จำนวน',
      'ราคา',
      'โค้ดส่วนลด',
      'ส่วนลด',
      'ราคาก่อนลด',
      'ราคาหลังลด',
      'ค่าส่ง',
      'ยอดสุทธิ',
      'หมายเหตุ',
      'เลขพัสดุ',
      'ชื่อ',
      'นามสกุล',
      'เบอร์โทร',
      'ที่อยู่',
      'แขวง/ตำบล',
      'เขต/อำเภอ',
      'จังหวัด',
      'เลขไปษณีย์',
      'ชื่อที่อยู่-เบอร์โทรผู้รับ',
    ]
    const worksheet = XLSX.utils.aoa_to_sheet([headers])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'WY_Template')
    XLSX.writeFile(workbook, 'TRKids_WY_Order_Template.xlsx')
  }

  const checkImportedOrderCompleteness = (order: ImportedOrder) => {
    if (!order.customer_name || !order.customer_address) return false
    if (order.channel_code !== 'CLAIM' && order.channel_code !== 'INFU') {
      if (order.total_amount <= 0 || !order.payment_method) return false
    }
    if (!order.items || order.items.length === 0) return false
    for (const item of order.items) {
      if (!item.product_id) return false
    }
    return true
  }

  const applyStampInkLogicToOrderObject = (order: ImportedOrder) => {
    const originalItems = [...order.items]
    originalItems.forEach((item) => {
      const product = products.find((p) => p.id === item.product_id)
      if (!product || !product.product_category || !product.product_category.toUpperCase().includes('STAMP')) return
      const inkColor = item.ink_color || ''
      const targetColors = { เขียว: 'เขียว', ดำ: 'ดำ', แดง: 'แดง', น้ำเงิน: 'น้ำเงิน' }
      const matchedColor = Object.keys(targetColors).find(
        (c) => inkColor.includes(c) && inkColor.includes('พลาสติก')
      )
      if (!matchedColor) return
      const inkProductName = `หมึกแฟลชพลาสติก 5 ml. (${matchedColor})`
      const inkProductToAdd = products.find((p) => p.product_name === inkProductName)
      if (!inkProductToAdd) return
      if (!order.items.some((existing) => existing.product_id === inkProductToAdd.id)) {
        order.items.push({
          product_id: inkProductToAdd.id,
          product_name: inkProductToAdd.product_name,
          quantity: 1,
          ink_color: '',
          product_type: '',
          cartoon_pattern: '',
          line_pattern: '',
          font: '',
          line_1: '',
          line_2: '',
          line_3: '',
          notes: 'สินค้าแถม',
          file_attachment: '',
        })
      }
    })
  }

  const parseStandardRows = (rows: unknown[][]) => {
    const processed: ImportedOrder[] = []
    let current: ImportedOrder | null = null
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i] || []
      if (r.every((c) => String(c ?? '').trim() === '')) continue
      if (String(r[0] ?? '').trim() && String(r[1] ?? '').trim()) {
        const price = parseNumber(r[3])
        const shippingCost = parseNumber(r[4])
        const discount = parseNumber(r[5])
        current = {
          channel_code: String(r[0] || '').trim(),
          customer_name: String(r[1] || '').trim(),
          customer_address: String(r[2] || '').trim(),
          price,
          shipping_cost: shippingCost,
          discount,
          total_amount: price + shippingCost - discount,
          payment_method: String(r[6] || '').trim() || null,
          promotion: String(r[7] || '').trim() || null,
          payment_date: r[8] ? String(r[8]).trim() : null,
          payment_time: parseTimeString(r[9]),
          items: [],
        }
        processed.push(current)
      }
      if (String(r[10] || '').trim() && current) {
        const lookup = String(r[10] || '').trim().toLowerCase()
        const p = products.find(
          (x) =>
            ((x.product_code || '').toLowerCase() === lookup ||
              (x.product_name || '').toLowerCase().includes(lookup)) &&
            !String(x.product_code || '').startsWith('22')
        )
        current.items.push({
          product_id: p ? p.id : null,
          product_name: p ? p.product_name : String(r[10] || ''),
          ink_color: String(r[11] || ''),
          product_type: String(r[12] || ''),
          cartoon_pattern: String(r[13] || ''),
          line_pattern: String(r[14] || ''),
          font: String(r[15] || ''),
          line_1: String(r[16] || ''),
          line_2: String(r[17] || ''),
          line_3: String(r[18] || ''),
          quantity: parseInt(String(r[19] || '1'), 10) || 1,
          notes: String(r[20] || ''),
          file_attachment: String(r[21] || ''),
        })
      }
    }
    return processed
  }

  const parsePgtrJson = (json: Record<string, any>[]) => {
    const map = new Map<string, ImportedOrder>()
    const headers = Object.keys(json[0] || {})
    const orderH = findHeader(headers, ['เลขออร์เดอร์', 'เลขที่ออเดอร์', 'Order Number'])
    json.forEach((r) => {
      const rawB = String((orderH ? r[orderH] : r['เลขออร์เดอร์']) || '').trim()
      if (!rawB) return
      let billNo = rawB
      const lastDash = rawB.lastIndexOf('-')
      if (lastDash > 0 && !isNaN(Number(rawB.substring(lastDash + 1)))) {
        billNo = rawB.substring(0, lastDash)
      }
      if (!map.has(billNo)) {
        const pVal = parseNumber(r['ราคาก่อนส่วนลด'])
        const sVal = parseNumber(r['ค่าขนส่ง'])
        const dVal = parseNumber(r['ส่วนลด admin'])
        let pDate: string | null = null
        let pTime: string | null = null
        const rawDate = r['วันที่สั่งซื้อ']
        if (rawDate) {
          const dObj = typeof rawDate === 'number' ? excelDateToJSDate(rawDate) : new Date(rawDate)
          pDate = toDateString(dObj)
          if (dObj && dObj.getHours() + dObj.getMinutes() > 0) {
            pTime = `${String(dObj.getHours()).padStart(2, '0')}:${String(dObj.getMinutes()).padStart(2, '0')}`
          }
        }
        if (r['เวลา']) pTime = parseTimeString(r['เวลา'])
        map.set(billNo, {
          bill_no: billNo,
          channel_code: 'PGTR',
          channel_order_no: billNo,
          customer_name: String(r['ชื่อสกุลผู้รับ'] || ''),
          customer_address: String(r['ที่อยู่เต็ม'] || ''),
          price: pVal,
          shipping_cost: sVal,
          discount: dVal,
          total_amount: pVal + sVal - dVal,
          payment_method: 'โอน',
          payment_date: pDate,
          payment_time: pTime,
          items: [],
        })
      }
      const curr = map.get(billNo)
      if (!curr) return
      const pCode = String(r['รหัสสินค้า'] || '').split('-')[0]
      const p = products.find((x) => x.product_code === pCode && !String(x.product_code || '').startsWith('22'))
      curr.items.push({
        product_id: p ? p.id : null,
        product_name: p ? p.product_name : String(r['ชื่อสินค้า'] || 'รหัสไม่ตรง'),
        ink_color: String(r['Ink'] || r['สี'] || '').trim(),
        cartoon_pattern: p && (p.product_category || '').toUpperCase().includes('UV') ? String(r['ชื่อสินค้า'] || '') : '',
        line_pattern: String(r['Underline'] || ''),
        font: String(r['ฟอนต์'] || r['font'] || ''),
        line_1: String(r['Label1'] || ''),
        line_2: String(r['Label2'] || ''),
        line_3: String(r['Label3'] || ''),
        quantity: parseInt(String(r['จำนวน'] || '1'), 10) || 1,
        notes: String(r['comment'] || r['remark'] || ''),
      })
    })
    return Array.from(map.values())
  }

  const parseWyJson = (json: Record<string, any>[]) => {
    const map = new Map<string, ImportedOrder>()
    json.forEach((r) => {
      const billNo = String(r['เลขบิล'] || '').trim()
      if (!billNo) return
      if (!map.has(billNo)) {
        let pDate: string | null = null
        let pTime: string | null = null
        const rawDate = r['วันที่สั่งซื้อ']
        if (rawDate) {
          const dObj = typeof rawDate === 'number' ? excelDateToJSDate(rawDate) : new Date(rawDate)
          pDate = toDateString(dObj)
          if (dObj && dObj.getHours() + dObj.getMinutes() > 0) {
            pTime = `${String(dObj.getHours()).padStart(2, '0')}:${String(dObj.getMinutes()).padStart(2, '0')}`
          }
        }
        if (r['เวลา']) pTime = parseTimeString(r['เวลา'])
        map.set(billNo, {
          bill_no: billNo,
          channel_code: 'WY',
          channel_order_no: billNo,
          customer_name: String(r['ชื่อลูกค้า'] || ''),
          customer_address: String(r['ชื่อที่อยู่-เบอร์โทรผู้รับ'] || r['ที่อยู่'] || r['เลขพัสดุ'] || ''),
          price: parseNumber(r['ราคา']),
          shipping_cost: parseNumber(r['ค่าส่ง']),
          discount: parseNumber(r['ส่วนลด']),
          total_amount: parseNumber(r['ยอดสุทธิ']),
          payment_method: 'โอน',
          payment_date: pDate,
          payment_time: pTime,
          items: [],
        })
      }
      const curr = map.get(billNo)
      if (!curr) return
      const p = products.find(
        (x) => String(x.product_name || '').trim() === String(r['รหัส'] || '').trim() && String(x.product_code || '').startsWith('22')
      )
      curr.items.push({
        product_id: p ? p.id : null,
        product_name: p ? p.product_name : String(r['สินค้า'] || 'รหัสไม่ตรง'),
        cartoon_pattern: '',
        line_pattern: '',
        line_1: String(r['บรรทัด1'] || ''),
        line_2: String(r['บรรทัด2'] || ''),
        line_3: '',
        font: String(r['font'] || ''),
        quantity: parseInt(String(r['จำนวน'] || '1'), 10) || 1,
        notes: String(r['หมายเหตุ'] || ''),
      })
    })
    return Array.from(map.values())
  }

  async function processAndSaveImportedOrders(ordersToImport: ImportedOrder[], useProvidedBillNo = false) {
    if (!user) {
      setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเข้าสู่ระบบก่อนนำเข้าออเดอร์' })
      setImportBusy(false)
      return
    }
    if (ordersToImport.length === 0) {
      setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'ไม่พบข้อมูลออเดอร์ในไฟล์' })
      setImportBusy(false)
      return
    }
    setImportBusy(true)
    setImportSummary(null)
    const adminUser = user.username || user.email || ''
    const todayStr = new Date().toISOString().slice(0, 10)
    let successCount = 0
    let waitingCount = 0
    let skippedCount = 0
    let errorCount = 0
    const errorLines: string[] = []
    let existingBillNos = new Set<string>()
    if (useProvidedBillNo) {
      const billNos = ordersToImport.map((o) => o.bill_no).filter(Boolean) as string[]
      if (billNos.length > 0) {
        const { data } = await supabase.from('or_orders').select('bill_no').in('bill_no', billNos)
        existingBillNos = new Set((data || []).map((d: { bill_no: string }) => d.bill_no))
      }
    }

    for (const order of ordersToImport) {
      try {
        const billNo = useProvidedBillNo ? (order.bill_no || '') : await generateBillNo(order.channel_code)
        if (!billNo) {
          errorCount += 1
          errorLines.push('ไม่พบเลขบิลสำหรับออเดอร์ในไฟล์')
          continue
        }
        if (existingBillNos.has(billNo)) {
          skippedCount += 1
          continue
        }
        const isComplete = checkImportedOrderCompleteness(order)
        if (!isComplete) waitingCount += 1
        const orderData = {
          channel_code: order.channel_code,
          customer_name: order.customer_name || '',
          customer_address: order.customer_address || '',
          channel_order_no: order.channel_order_no ?? null,
          price: order.price || 0,
          shipping_cost: order.shipping_cost || 0,
          discount: order.discount || 0,
          total_amount: order.total_amount || 0,
          payment_method: order.payment_method || null,
          promotion: order.promotion || null,
          payment_date: order.payment_date || null,
          payment_time: order.payment_time || null,
          status: isComplete ? 'ลงข้อมูลเสร็จสิ้น' : 'รอลงข้อมูล',
          admin_user: adminUser,
          entry_date: todayStr,
        }
        const { data: inserted, error: insertErr } = await supabase
          .from('or_orders')
          .insert({ ...orderData, bill_no: billNo })
          .select()
          .single()
        if (insertErr || !inserted?.id) {
          errorCount += 1
          errorLines.push(`${billNo}: ${insertErr?.message || 'ไม่สามารถบันทึกออเดอร์ได้'}`)
          continue
        }
        const orderId = inserted.id
        applyStampInkLogicToOrderObject(order)
        const itemsToInsert = order.items
          .filter((item) => !!item.product_id)
          .map((item, index) => ({
            order_id: orderId,
            item_uid: `${billNo}-${index + 1}`,
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
            no_name_line: !!(item as { no_name_line?: boolean }).no_name_line,
            is_free: !!(item as { is_free?: boolean }).is_free,
            notes: item.notes || null,
            file_attachment: item.file_attachment || null,
          }))
        if (itemsToInsert.length === 0) {
          errorCount += 1
          errorLines.push(`${billNo}: ไม่มีรายการสินค้าที่จับคู่สินค้าได้`)
          continue
        }
        const { error: itemsErr } = await supabase.from('or_order_items').insert(itemsToInsert)
        if (itemsErr) {
          errorCount += 1
          errorLines.push(`${billNo}: ${itemsErr.message}`)
          continue
        }
        successCount += 1
      } catch (err: any) {
        errorCount += 1
        errorLines.push(err?.message || 'เกิดข้อผิดพลาดในการนำเข้า')
      }
    }
    const summaryLines = [
      'นำเข้าเสร็จสิ้น',
      `สำเร็จ: ${successCount}`,
      `รอลงข้อมูล: ${waitingCount}`,
      `ข้าม (บิลซ้ำ): ${skippedCount}`,
      `ผิดพลาด: ${errorCount}`,
    ]
    if (errorLines.length > 0) {
      summaryLines.push('', 'ตัวอย่างข้อผิดพลาด:', ...errorLines.slice(0, 5))
    }
    setImportSummary(summaryLines.join('\n'))
    setImportBusy(false)
  }

  async function handleSmartImport(file: File) {
    if (!file) return
    if (products.length === 0) {
      setMessageModal({ open: true, title: 'นำเข้าไม่สำเร็จ', message: 'ยังโหลดรายการสินค้าไม่เสร็จ กรุณาลองอีกครั้ง' })
      return
    }
    setImportBusy(true)
    setImportSummary(null)
    const reader = new FileReader()
    reader.onload = async (e) => {
      try {
        const buf = e.target?.result
        if (!buf) throw new Error('ไม่สามารถอ่านไฟล์ได้')
        const workbook = XLSX.read(new Uint8Array(buf as ArrayBuffer), { type: 'array', cellDates: true })
        const sheet = workbook.Sheets[workbook.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { raw: false, defval: '' })
        if (json.length === 0) throw new Error('ไฟล์ไม่มีข้อมูล')
        const headers = Object.keys(json[0])
        const orderH = findHeader(headers, ['เลขออร์เดอร์', 'เลขที่ออเดอร์', 'Order Number'])
        if (orderH) {
          const parsed = parsePgtrJson(json)
          await processAndSaveImportedOrders(parsed, true)
        } else if (headers.includes('เลขบิล') && String(json[0]['เลขบิล']).toUpperCase().startsWith('WY')) {
          const parsed = parseWyJson(json)
          await processAndSaveImportedOrders(parsed, true)
        } else {
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
          const parsed = parseStandardRows(rows)
          await processAndSaveImportedOrders(parsed, false)
        }
      } catch (err: any) {
        setMessageModal({ open: true, title: 'นำเข้าไม่สำเร็จ', message: err?.message || String(err) })
        setImportBusy(false)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  const repairWyCsvContent = (content: string) => {
    const allLines = content.split(/\r?\n/).filter((line) => line.trim() !== '')
    if (allLines.length === 0) return ''
    const processedLines: string[] = []
    const headerLine = allLines[0]
    processedLines.push(headerLine)
    for (let i = 1; i < allLines.length; i += 1) {
      const currentLine = allLines[i]
      if (currentLine.startsWith('WY')) {
        processedLines.push(currentLine)
      } else if (processedLines.length > 1) {
        processedLines[processedLines.length - 1] += `, ${currentLine}`
      }
    }
    return processedLines.join('\n')
  }

  type PapaParseResult<T> = { data?: T[] }
  type PapaParseConfig<T> = {
    delimiter?: string
    header?: boolean
    skipEmptyLines?: boolean
    transformHeader?: (h: string) => string
    complete?: (results: PapaParseResult<T>) => void | Promise<void>
  }
  const papaParse = (Papa as unknown as { parse: (input: string, config: PapaParseConfig<Record<string, string>>) => void }).parse

  async function handleWyConvert(file: File) {
    if (!file) return
    if (products.length === 0) {
      setMessageModal({ open: true, title: 'นำเข้าไม่สำเร็จ', message: 'ยังโหลดรายการสินค้าไม่เสร็จ กรุณาลองอีกครั้ง' })
      return
    }
    setWyStatus('กำลังประมวลผลไฟล์...')
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const content = String(e.target?.result || '')
        const repaired = repairWyCsvContent(content)
        papaParse(repaired, {
          delimiter: '\t',
          header: true,
          skipEmptyLines: true,
          transformHeader: (h: string) => h.trim(),
          complete: async (results: PapaParseResult<Record<string, string>>) => {
            const finalData = (results.data || [])
              .filter((row: Record<string, string>) => row['เลขบิล'] && row['เลขบิล'] !== 'เลขบิล')
              .map((row: Record<string, string>) => {
                const newRow: Record<string, string> = {}
                Object.keys(row || {}).forEach((key) => {
                  let value = row[key]?.toString() ?? ''
                  value = value.trim()
                  if (value.startsWith("'")) value = value.substring(1)
                  newRow[key.trim()] = value
                })
                return newRow
              })
            if (finalData.length > 0) {
              setWyStatus(`แปลงสำเร็จ! กำลังนำเข้า ${finalData.length} แถว...`)
              const parsed = parseWyJson(finalData)
              await processAndSaveImportedOrders(parsed, true)
              setWyStatus(`นำเข้าเสร็จสิ้น ${finalData.length} แถว`)
            } else {
              setWyStatus('ไม่พบข้อมูลที่สามารถแสดงผลได้ในไฟล์')
            }
          },
        })
      } catch (err: any) {
        setWyStatus(err?.message || 'เกิดข้อผิดพลาดในการอ่านไฟล์')
      }
    }
    reader.readAsText(file, 'UTF-8')
  }

  /** สร้างบิลเคลม: ดึงข้อมูลบิลอ้างอิง (ชื่อลูกค้า, ที่อยู่, รายการสินค้า) มาใส่บิลเคลม แล้วเปิดบิล */
  async function handleClaimConfirm() {
    if (!selectedClaimRefOrder?.bill_no || !selectedClaimRefOrder?.id || !selectedClaimType?.trim() || !onOpenOrder) return
    setClaimConfirmSubmitting(true)
    try {
      const ref = selectedClaimRefOrder
      const refBillNo = ref.bill_no
      const claimBillNo = `REQ${refBillNo}`
      const adminUser = user?.username ?? user?.email ?? ''

      // ดึงรายการสินค้าจากบิลอ้างอิง
      const { data: refItems, error: itemsErr } = await supabase
        .from('or_order_items')
        .select('*')
        .eq('order_id', ref.id)
        .order('created_at', { ascending: true })
      if (itemsErr) throw itemsErr

      // คัดลอกข้อมูลจากบิลอ้างอิง: ชื่อลูกค้า, ที่อยู่, billing_details, ยอด, รายการสินค้า
      const orderData = {
        channel_code: ref.channel_code,
        customer_name: ref.customer_name || '',
        customer_address: ref.customer_address || '',
        channel_order_no: ref.channel_order_no ?? null,
        recipient_name: ref.recipient_name ?? null,
        scheduled_pickup_at: ref.scheduled_pickup_at ?? null,
        price: ref.price ?? 0,
        shipping_cost: ref.shipping_cost ?? 0,
        discount: ref.discount ?? 0,
        total_amount: ref.total_amount ?? 0,
        payment_method: ref.payment_method ?? null,
        promotion: ref.promotion ?? null,
        payment_date: ref.payment_date ?? null,
        payment_time: ref.payment_time ?? null,
        status: 'รอลงข้อมูล' as const,
        admin_user: adminUser,
        entry_date: new Date().toISOString().slice(0, 10),
        bill_no: claimBillNo,
        claim_type: selectedClaimType.trim(),
        claim_details: null,
        billing_details: ref.billing_details ?? null,
        packing_meta: null,
        work_order_name: null,
        shipped_by: null,
        shipped_time: null,
        tracking_number: ref.tracking_number ?? null,
      }
      const { data: newOrder, error } = await supabase
        .from('or_orders')
        .insert(orderData)
        .select()
        .single()
      if (error) throw error
      const newOrderId = (newOrder as { id: string }).id

      // คัดลอกรายการสินค้าจากบิลอ้างอิงไปบิลเคลม (สร้าง item_uid เป็น bill_no-1, bill_no-2, ...)
      if (refItems && refItems.length > 0) {
        const itemsToInsert = refItems.map((item: Record<string, unknown>, index: number) => {
          const itemUid = `${claimBillNo}-${index + 1}`
          return {
            order_id: newOrderId,
            item_uid: itemUid,
            product_id: item.product_id,
            product_name: item.product_name ?? '',
            quantity: item.quantity ?? 1,
            unit_price: item.unit_price ?? 0,
            ink_color: item.ink_color ?? null,
            product_type: item.product_type ?? 'ชั้น1',
            cartoon_pattern: item.cartoon_pattern ?? null,
            line_pattern: item.line_pattern ?? null,
            font: item.font ?? null,
            line_1: item.line_1 ?? null,
            line_2: item.line_2 ?? null,
            line_3: item.line_3 ?? null,
            no_name_line: !!(item as { no_name_line?: boolean }).no_name_line,
            is_free: !!(item as { is_free?: boolean }).is_free,
            notes: item.notes ?? null,
            file_attachment: item.file_attachment ?? null,
          }
        })
        const { error: itemsError } = await supabase.from('or_order_items').insert(itemsToInsert)
        if (itemsError) throw itemsError
      }

      setClaimModalOpen(false)
      onOpenOrder(newOrder as Order)
    } catch (e: any) {
      console.error('Error creating claim order:', e)
      setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: e?.message || 'สร้างบิลเคลมไม่สำเร็จ' })
    } finally {
      setClaimConfirmSubmitting(false)
    }
  }

  function addItem() {
    const lastItem = items.length > 0 ? items[items.length - 1] : null
    // Copy เฉพาะชื่อสินค้า + product_id เพื่อรักษากฏตั้งค่าสินค้า (ข้อมูลที่อนุญาตให้กรอกต่อหมวดหมู่); คอลัมน์อื่นไม่ copy
    const newItem: Partial<OrderItem> =
      lastItem?.product_name || lastItem?.product_id
        ? {
            product_type: 'ชั้น1',
            quantity: 1,
            product_name: lastItem?.product_name ?? '',
            product_id: lastItem?.product_id ?? undefined,
          }
        : { product_type: 'ชั้น1', quantity: 1 }
    setItems([...items, newItem])

    setProductSearchTerm({ ...productSearchTerm, [items.length]: lastItem?.product_name ?? '' })
  }

  const CONDO_PRODUCTS = ['ตรายางคอนโด TWB ฟ้า', 'ตรายางคอนโด TWP ชมพู']

  function isCondoProduct(name?: string | null) {
    if (!name) return false
    return CONDO_PRODUCTS.includes(name.trim())
  }

  /** ตรวจว่าแถวนี้เป็นแถวย่อยของสินค้าคอนโด (ชั้น2-5) ที่ต้องล็อคราคา/หน่วย */
  function isCondoSubRow(item: Partial<OrderItem>) {
    return isCondoProduct(item.product_name) && item.product_type !== 'ชั้น1'
  }

  function normalizeProductName(value?: string | null) {
    return (value || '').toLowerCase().trim().replace(/\s+/g, ' ')
  }

  function findMatchedProduct(inputValue: string) {
    const search = normalizeProductName(inputValue)
    if (!search) return null
    return (
      products.find((p) => normalizeProductName(p.product_name) === search) ||
      products.find((p) => normalizeProductName(p.product_code || '') === search) ||
      null
    )
  }

  function ensureCondoRows(index: number, product: Product) {
    const layers = ['ชั้น1', 'ชั้น2', 'ชั้น3', 'ชั้น4', 'ชั้น5']

    // คำนวณ items ใหม่จาก items ปัจจุบันโดยตรง (ไม่ใช้ functional updater)
    // เพื่อให้ได้ผลลัพธ์ทันทีสำหรับ rebuild productSearchTerm
    const next = [...items]
    const oldItem = next[index]

    next[index] = {
      ...next[index],
      product_id: product.id,
      product_name: product.product_name,
      product_type: layers[0],
    }

    // ตรวจว่าแถวถัดไปเป็นแถวย่อยของคอนโดตัวใหม่ครบ 4 แถวแล้วหรือไม่
    const already = layers.slice(1).every((layer, offset) => {
      const row = next[index + 1 + offset]
      return (
        row &&
        (String(row.product_id || '') === String(product.id) || row.product_name === product.product_name) &&
        (row.product_type || 'ชั้น1') === layer
      )
    })

    if (already) {
      setItems(next)
      rebuildSearchTerms(next)
      return
    }

    // ลบแถวย่อยคอนโดเก่า (ถ้ามี) ที่อยู่ถัดจาก index
    // กรณีเปลี่ยนจากคอนโดตัวหนึ่งเป็นอีกตัว หรือแก้ไขรายการเดิมที่เคยเป็นคอนโด
    let oldSubCount = 0
    if (isCondoProduct(oldItem.product_name)) {
      for (let i = index + 1; i < next.length && i <= index + 4; i++) {
        const sub = next[i]
        if (
          isCondoProduct(sub.product_name) &&
          sub.product_type !== 'ชั้น1' &&
          (String(sub.product_id || '') === String(oldItem.product_id || '') || sub.product_name === oldItem.product_name)
        ) {
          oldSubCount++
        } else {
          break
        }
      }
    }
    if (oldSubCount > 0) {
      next.splice(index + 1, oldSubCount)
    }

    // แทรกแถวย่อย ชั้น2-5 ใหม่
    const newRows = layers.slice(1).map((layer) => ({
      product_id: product.id,
      product_name: product.product_name,
      product_type: layer,
      quantity: 1,
    }))
    next.splice(index + 1, 0, ...newRows)

    // set ทั้ง items และ productSearchTerm พร้อมกัน (React จะ batch ให้ render ครั้งเดียว)
    setItems(next)
    rebuildSearchTerms(next)
  }

  /** rebuild productSearchTerm ให้ตรงกับ items ปัจจุบัน */
  function rebuildSearchTerms(newItems: Partial<OrderItem>[]) {
    const terms: { [key: number]: string } = {}
    newItems.forEach((it, i) => { terms[i] = it.product_name || '' })
    setProductSearchTerm(terms)
  }

  function removeItem(index: number) {
    const item = items[index]
    const allBonusCodes = new Set(Object.values(PLASTIC_INK_BONUS_MAP).map(b => b.product_code))

    // ---- กรณีสินค้าคอนโด: ลบแถว ชั้น1 พร้อมแถวย่อย ชั้น2-5 ----
    if (isCondoProduct(item.product_name) && item.product_type === 'ชั้น1') {
      const indicesToRemove = new Set([index])
      for (let i = index + 1; i < items.length && i <= index + 4; i++) {
        const sub = items[i]
        if (
          isCondoProduct(sub.product_name) &&
          sub.product_type !== 'ชั้น1' &&
          (String(sub.product_id || '') === String(item.product_id || '') || sub.product_name === item.product_name)
        ) {
          indicesToRemove.add(i)
        } else {
          break
        }
      }
      const newItems = items.filter((_, i) => !indicesToRemove.has(i))
      setItems(newItems)
      rebuildSearchTerms(newItems)
      return
    }

    // ---- กรณีแถวย่อยคอนโด (ชั้น2-5): ลบทั้งกลุ่ม ชั้น1-5 ----
    if (isCondoProduct(item.product_name) && item.product_type !== 'ชั้น1') {
      let parentIndex = -1
      for (let i = index - 1; i >= 0; i--) {
        if (
          isCondoProduct(items[i].product_name) &&
          items[i].product_type === 'ชั้น1' &&
          (String(items[i].product_id || '') === String(item.product_id || '') || items[i].product_name === item.product_name)
        ) {
          parentIndex = i
          break
        }
      }
      if (parentIndex >= 0) {
        const indicesToRemove = new Set([parentIndex])
        for (let i = parentIndex + 1; i < items.length && i <= parentIndex + 4; i++) {
          const sub = items[i]
          if (
            isCondoProduct(sub.product_name) &&
            sub.product_type !== 'ชั้น1' &&
            (String(sub.product_id || '') === String(items[parentIndex].product_id || '') || sub.product_name === items[parentIndex].product_name)
          ) {
            indicesToRemove.add(i)
          } else {
            break
          }
        }
        const newItems = items.filter((_, i) => !indicesToRemove.has(i))
        setItems(newItems)
        rebuildSearchTerms(newItems)
        return
      }
    }

    // ---- กรณีปกติ (ไม่ใช่คอนโด) ----
    // ตรวจว่าแถวถัดไปเป็นแถวแถมหมึกพลาสติกหรือไม่
    const nextItem = items[index + 1]
    let removeBonus = false
    if (nextItem && (nextItem as { is_free?: boolean }).is_free) {
      const nextProduct = products.find(p => p.id === nextItem.product_id)
      if (nextProduct && allBonusCodes.has(nextProduct.product_code)) {
        removeBonus = true
      }
    }
    // ตรวจว่าแถวที่จะลบเป็นแถวแถมหมึกพลาสติกเองหรือไม่ → ถ้าใช่ ลบแค่แถวเดียว
    let newItems: Partial<OrderItem>[]
    if ((item as { is_free?: boolean }).is_free) {
      newItems = items.filter((_, i) => i !== index)
    } else if (removeBonus) {
      newItems = items.filter((_, i) => i !== index && i !== index + 1)
    } else {
      newItems = items.filter((_, i) => i !== index)
    }
    setItems(newItems)
    rebuildSearchTerms(newItems)
  }

  function updateItem(index: number, field: keyof OrderItem, value: any) {
    setItems((prev) => {
      const newItems = [...prev]
      newItems[index] = { ...newItems[index], [field]: value }
      return newItems
    })
  }

  function updateItemFields(index: number, fields: Partial<OrderItem>) {
    setItems((prev) => {
      const newItems = [...prev]
      newItems[index] = { ...newItems[index], ...fields }
      return newItems
    })
  }

  function getProductCategoryForItem(item: Partial<OrderItem>) {
    if (!item.product_id) return null
    const product = products.find((p) => p.id === item.product_id)
    return product?.product_category?.trim() || null
  }

  function getPatternByName(name: string) {
    const search = name.trim().toLowerCase()
    return cartoonPatterns.find((p) => p.pattern_name?.trim().toLowerCase() === search) || null
  }

  function getLineCountForPattern(name: string | null | undefined) {
    if (!name) return null
    const pattern = getPatternByName(name)
    return pattern?.line_count ?? null
  }

  function applyLineCountToItem(index: number, lineCount: number | null) {
    if (lineCount == null) return
    const updates: Partial<OrderItem> = {}
    if (lineCount === 0) {
      updates.line_1 = ''
      updates.line_2 = ''
      updates.line_3 = ''
    } else if (lineCount <= 1) {
      updates.line_2 = ''
      updates.line_3 = ''
    } else if (lineCount === 2) {
      updates.line_3 = ''
    }
    if (Object.keys(updates).length > 0) {
      updateItemFields(index, updates)
    }
  }

  function getFilteredPatterns(category: string | null, searchTerm: string) {
    const searchLower = searchTerm.trim().toLowerCase()
    let list = cartoonPatterns
    if (category) {
      list = list.filter((p) => (p.product_category || '').trim() === category)
    }
    if (searchLower) {
      list = list.filter((p) => (p.pattern_name || '').toLowerCase().includes(searchLower))
    }
    return list.slice().sort((a, b) => (a.pattern_name || '').localeCompare(b.pattern_name || ''))
  }

  /** โหมดดูอย่างเดียว (ตรวจสอบแล้ว/ยกเลิก): บล็อกทุกฟิลด์และป้องกันการลบสลิป */
  const formDisabled = readOnly || viewOnly

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        {reviewRemarks && (
          <div className="mb-4 p-4 bg-red-50 border-2 border-red-300 rounded-lg">
            <p className="text-sm font-semibold text-red-800 mb-1">หมายเหตุ (รายการที่ต้องแก้ไข):</p>
            <p className="text-red-900 whitespace-pre-wrap">{reviewRemarks}</p>
          </div>
        )}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-xl font-bold">ข้อมูลลูกค้า</h3>
          <div className="flex items-center gap-3 flex-wrap">
            {/* ช่องทาง + สร้างบิล — อยู่บรรทัดเดียวกัน */}
            <select
              value={formData.channel_code}
              onChange={(e) => setFormData({ ...formData, channel_code: e.target.value })}
              disabled={formDisabled || !!order?.bill_no}
              required
              className={`w-48 px-3 py-2 border rounded-lg text-sm ${
                (formDisabled || !!order?.bill_no) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''
              }`}
            >
              <option value="">-- เลือกช่องทาง --</option>
              {channels.map((ch) => (
                <option key={ch.channel_code} value={ch.channel_code}>
                  {ch.channel_name}
                </option>
              ))}
            </select>
            {!formDisabled && (
              <>
                {!order?.bill_no && (
                  <button
                    type="button"
                    disabled={creatingBill}
                    onClick={async () => {
                      if (!formData.channel_code || formData.channel_code.trim() === '') {
                        setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกช่องทางก่อนสร้างเลขบิล' })
                        return
                      }
                      setCreatingBill(true)
                      try {
                        const billNo = await generateBillNo(formData.channel_code)
                        const adminUser = user?.username ?? user?.email ?? ''
                        const { data: newOrder, error } = await supabase
                          .from('or_orders')
                          .insert({
                            channel_code: formData.channel_code.trim(),
                            bill_no: billNo,
                            status: 'รอลงข้อมูล',
                            customer_name: formData.customer_name?.trim() || '',
                            customer_address: formData.customer_address?.trim() || '',
                            admin_user: adminUser,
                            entry_date: new Date().toISOString().slice(0, 10),
                          })
                          .select()
                          .single()
                        if (error) throw error
                        if (onOpenOrder) onOpenOrder(newOrder as Order)
                      } catch (e: any) {
                        setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: e?.message || 'สร้างบิลไม่สำเร็จ' })
                      } finally {
                        setCreatingBill(false)
                      }
                    }}
                    className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
                  >
                    {creatingBill ? 'กำลังสร้าง...' : 'สร้างบิล'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setClaimModalOpen(true)}
                  className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600"
                >
                  เคลม
                </button>
              </>
            )}
            <span className="font-bold text-gray-700">
              ผู้ลงออเดอร์: {order?.admin_user ?? user?.username ?? user?.email ?? '-'}
            </span>
            {order?.bill_no && (
              <div className="text-right flex items-center gap-2 justify-end">
                <span className="text-sm text-gray-500">เลขบิล:</span>
                <span className="text-lg font-bold text-blue-600">
                  {order.bill_no}
                </span>
                {(order.claim_type != null || order.bill_no.toString().startsWith('REQ')) && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-800 border border-amber-200">
                    เคลม
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {/* แถวที่ 2: ที่อยู่ลูกค้า (ซ้าย) | ชื่อช่องทาง/เลขคำสั่งซื้อ + เลขพัสดุ + โปรโมชั่น (ขวา) — ซ่อนเมื่อยังไม่สร้างบิล */}
        {!order?.bill_no && !formDisabled && (
          <div className="mt-4 p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg text-center text-gray-500 text-sm">
            กรุณาเลือกช่องทาง แล้วกด <span className="font-semibold text-blue-600">สร้างบิล</span> เพื่อกรอกข้อมูลที่อยู่ลูกค้า
          </div>
        )}
        <div className={`mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 ${!order?.bill_no && !formDisabled ? 'hidden' : ''}`}>
          {/* ที่อยู่ลูกค้า — ฝั่งซ้าย */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-sm font-medium">ที่อยู่ลูกค้า</label>
              <button
                type="button"
                onClick={handleAutoFillAddress}
                disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled || autoFillAddressLoading}
                className="text-sm px-2 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {autoFillAddressLoading ? 'กำลังแยก...' : 'Auto fill'}
              </button>
            </div>
            <textarea
              value={formData.customer_address}
              onChange={(e) => setFormData({ ...formData, customer_address: e.target.value })}
              placeholder="วางที่อยู่พร้อมเบอร์โทรทั้งหมด แล้วกด Auto fill"
              required={!CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code)}
              disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
              rows={3}
              className={`w-full px-3 py-2 border rounded-lg ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${reviewErrorFields?.address ? 'ring-2 ring-red-500 border-red-500' : ''}`}
            />
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code) || CHANNELS_SHOW_ORDER_NO.includes(formData.channel_code)) && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <label className="block text-xs text-gray-500 mb-0.5">ชื่อลูกค้า</label>
                  <input
                    type="text"
                    value={CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code) ? formData.recipient_name : formData.customer_name}
                    onChange={(e) => {
                      if (CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code)) {
                        setFormData({ ...formData, recipient_name: e.target.value })
                      } else {
                        setFormData({ ...formData, customer_name: e.target.value })
                      }
                    }}
                    required={CHANNELS_SHOW_ORDER_NO.includes(formData.channel_code) && !CHANNELS_COMPLETE_TO_VERIFIED.includes(formData.channel_code)}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${reviewErrorFields?.customer_name ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">ที่อยู่</label>
                <input
                  type="text"
                  value={formData.address_line}
                  onChange={(e) => setFormData({ ...formData, address_line: e.target.value })}
                  disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                  className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">แขวง/ตำบล</label>
                {subDistrictOptions.length > 0 ? (
                  <select
                    value={(() => {
                      const i = subDistrictOptions.findIndex((o) => o.subDistrict === formData.sub_district)
                      return i >= 0 ? String(i) : ''
                    })()}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '') return
                      const i = parseInt(v, 10)
                      const o = subDistrictOptions[i]
                      if (o) setFormData((prev) => ({ ...prev, sub_district: o.subDistrict, district: o.district }))
                    }}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  >
                    <option value="">-- เลือกแขวง/ตำบล --</option>
                    {subDistrictOptions.map((o, i) => (
                      <option key={i} value={i}>{o.subDistrict}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.sub_district}
                    onChange={(e) => setFormData({ ...formData, sub_district: e.target.value })}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">เขต/อำเภอ</label>
                {subDistrictOptions.length > 0 ? (
                  <select
                    value={formData.district}
                    onChange={(e) => setFormData({ ...formData, district: e.target.value })}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  >
                    <option value="">-- เลือกเขต/อำเภอ --</option>
                    {Array.from(new Set(
                      (formData.sub_district
                        ? subDistrictOptions.filter((o) => o.subDistrict === formData.sub_district)
                        : subDistrictOptions
                      ).map((o) => o.district).filter(Boolean)
                    )).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.district}
                    onChange={(e) => setFormData({ ...formData, district: e.target.value })}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  />
                )}
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">จังหวัด</label>
                <input
                  type="text"
                  value={formData.province}
                  onChange={(e) => setFormData({ ...formData, province: e.target.value })}
                  disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                  className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">รหัสไปรษณีย์</label>
                <input
                  type="text"
                  value={formData.postal_code}
                  onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })}
                  disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                  className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">เบอร์โทรมือถือ</label>
                {mobilePhoneCandidates.length > 1 ? (
                  <select
                    value={formData.mobile_phone}
                    onChange={(e) => setFormData({ ...formData, mobile_phone: e.target.value })}
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  >
                    {mobilePhoneCandidates.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={formData.mobile_phone}
                    onChange={(e) => {
                      setFormData({ ...formData, mobile_phone: e.target.value })
                      if (mobilePhoneCandidates.length > 0) setMobilePhoneCandidates([])
                    }}
                    placeholder="0 ตามด้วย 9 หลัก (06-09)"
                    disabled={CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled}
                    className={`w-full px-2 py-1.5 text-sm border rounded ${(CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100' : ''}`}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            {/* ชื่อช่องทาง / เลขคำสั่งซื้อ — แสดงเฉพาะหลังสร้างบิล */}
            {CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code) && (
              <div>
                <label className="block text-sm font-medium mb-1">ชื่อช่องทาง</label>
                <input
                  type="text"
                  value={formData.customer_name}
                  onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                  required
                  disabled={formDisabled}
                  className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${reviewErrorFields?.channel_name ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                />
              </div>
            )}
            {CHANNELS_SHOW_ORDER_NO.includes(formData.channel_code) && (
              <div>
                <label className="block text-sm font-medium mb-1">เลขคำสั่งซื้อ</label>
                <input
                  type="text"
                  value={formData.channel_order_no}
                  onChange={(e) => setFormData({ ...formData, channel_order_no: e.target.value })}
                  disabled={formDisabled}
                  className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${reviewErrorFields?.channel_order_no ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                />
              </div>
            )}
            {formData.channel_code === 'SHOPP' && (
              <div>
                <label className="block text-sm font-medium mb-1">วันที่ เวลา นัดรับ <span className="text-red-500">*</span></label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (formDisabled) return
                    scheduledPickupInputRef.current?.showPicker?.()
                    scheduledPickupInputRef.current?.focus()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (formDisabled) return
                      scheduledPickupInputRef.current?.showPicker?.()
                      scheduledPickupInputRef.current?.focus()
                    }
                  }}
                  className={`w-full px-3 py-2 border rounded-lg cursor-pointer ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-white'}`}
                >
                  <input
                    ref={scheduledPickupInputRef}
                    type="datetime-local"
                    value={formData.scheduled_pickup_at ?? ''}
                    onChange={(e) => {
                      const v = e.target.value
                      setFormData((prev) => ({ ...prev, scheduled_pickup_at: v }))
                    }}
                    step={60}
                    required
                    disabled={formDisabled}
                    className="w-full bg-transparent border-none outline-none cursor-pointer min-h-[1.5rem] [color-scheme:light]"
                  />
                </div>
                {formData.scheduled_pickup_at && (() => {
                  const d = new Date(formData.scheduled_pickup_at)
                  if (isNaN(d.getTime())) return null
                  const day = String(d.getDate()).padStart(2, '0')
                  const month = String(d.getMonth() + 1).padStart(2, '0')
                  const year = d.getFullYear() + 543
                  const h = String(d.getHours()).padStart(2, '0')
                  const m = String(d.getMinutes()).padStart(2, '0')
                  return (
                    <p className="mt-1 text-sm text-gray-600">
                      เลือกแล้ว: {day}/{month}/{year} {h}:{m} น.
                    </p>
                  )
                })()}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-1">เลขพัสดุ</label>
              <input
                type="text"
                value={formData.tracking_number}
                onChange={(e) => setFormData({ ...formData, tracking_number: e.target.value })}
                placeholder="กรอกเลขพัสดุ"
                disabled={!CHANNELS_ENABLE_TRACKING.includes(formData.channel_code) || formDisabled}
                className={`w-full px-3 py-2 border rounded-lg ${(!CHANNELS_ENABLE_TRACKING.includes(formData.channel_code) || formDisabled) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${reviewErrorFields?.tracking_number ? 'ring-2 ring-red-500 border-red-500' : ''}`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">โปรโมชั่น</label>
              <select
                value={formData.promotion}
                onChange={(e) => setFormData({ ...formData, promotion: e.target.value })}
                disabled={formDisabled}
                className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
              >
                <option value="">-- เลือกโปรโมชั่น --</option>
                {promotions.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ขยายเต็มความกว้างของพื้นที่เนื้อหา (ไม่กระทบเมนูซ้าย) */}
      <div className="-mx-4 sm:-mx-6 lg:-mx-8 bg-white px-4 sm:px-6 lg:px-8 py-6 rounded-lg shadow" style={{ position: 'relative', overflow: 'hidden' }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h3 className="text-xl font-bold mr-auto">รายการสินค้า</h3>
          <button
            type="button"
            onClick={downloadStandardOrderTemplate}
            disabled={formDisabled}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700'}`}
          >
            Template (Standard)
          </button>
          <button
            type="button"
            onClick={downloadPgtrTemplate}
            disabled={formDisabled}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700'}`}
          >
            Template (PGTR)
          </button>
          <button
            type="button"
            onClick={downloadWyTemplate}
            disabled={formDisabled}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-teal-600 text-white hover:bg-teal-700'}`}
          >
            Template (WY)
          </button>
          <button
            type="button"
            onClick={() => {
              if (formDisabled) return
              if (!order?.bill_no) {
                setMessageModal({
                  open: true,
                  title: 'แจ้งเตือน',
                  message: 'กรุณาสร้างบิลก่อนจึงจะสามารถ Import Order from File ได้',
                })
                return
              }
              setImportTab('smart')
              setImportFile(null)
              setImportSummary(null)
              setWyFile(null)
              setWyStatus('')
              setImportModalOpen(true)
            }}
            disabled={formDisabled}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700'}`}
          >
            Import Orders from File
          </button>
        </div>
        <div className="overflow-x-auto" style={{ overflowY: 'hidden' }}>
          <table className="w-full border-collapse text-sm" style={{ position: 'relative' }}>
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-1 text-center w-10 text-[10px] leading-tight whitespace-nowrap">ฟรี</th>
                <th className="border p-1.5 ">ชื่อสินค้า</th>
                <th className="border p-1.5 w-32">สีหมึก</th>
                <th className="border p-1.5 w-16">ชั้น</th>
                <th className="border p-1.5 w-20">ลาย</th>
                {/* คอลัมน์เส้นซ่อนไว้ — เปิดใช้งานได้ในอนาคต */}
                {/* <th className="border p-1.5 w-16">เส้น</th> */}
                <th className="border p-1.5 w-20">ฟอนต์</th>
                <th className="border p-1 text-center w-14 text-[10px] leading-tight whitespace-nowrap">ไม่รับชื่อ</th>
                <th className="border p-1.5">บรรทัด 1</th>
                <th className="border p-1.5">บรรทัด 2</th>
                <th className="border p-1.5">บรรทัด 3</th>
                <th className="border p-1.5 w-14">จำนวน</th>
                <th className="border p-1 w-20 text-[10px] leading-tight whitespace-nowrap">ราคา/หน่วย</th>
                <th className="border p-1.5 w-28">หมายเหตุ</th>
                <th className="border p-1.5 w-20">ไฟล์แนบ</th>
                <th className="border p-1.5 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const productCategory = getProductCategoryForItem(item)
                const patternInputValue =
                  patternSearchTerm[index] !== undefined ? patternSearchTerm[index] : (item.cartoon_pattern || '')
                const lineLimit = getLineCountForPattern(item.cartoon_pattern)
                return (
                <tr key={index} className={(item as { is_free?: boolean }).is_free ? 'bg-green-50' : ''}>
                  <td className="border p-1 align-middle">
                    <div className="flex items-center justify-center min-h-[28px]">
                      <input
                        type="checkbox"
                        checked={!!(item as { is_free?: boolean }).is_free}
                        onChange={(e) => updateItem(index, 'is_free', e.target.checked)}
                        disabled={formDisabled}
                        title="สินค้าของแถม (ฟรี)"
                        className="w-4 h-4 rounded border-gray-300 accent-green-500"
                      />
                    </div>
                  </td>
                  <td className="border p-1.5">
                    <div className="relative">
                      <input
                        type="text"
                        list={`product-list-${index}`}
                        value={productSearchTerm[index] !== undefined ? productSearchTerm[index] : (item.product_name || '')}
                        disabled={formDisabled}
                        onChange={(e) => {
                          const searchTerm = e.target.value
                          setProductSearchTerm({ ...productSearchTerm, [index]: searchTerm })
                          
                          // ค้นหาสินค้าที่ตรงกับค่าที่พิมพ์ (ชื่อสินค้าหรือรหัสสินค้า)
                          const matchedProduct = findMatchedProduct(searchTerm)
                          
                          if (matchedProduct) {
                            if (isCondoProduct(matchedProduct.product_name)) {
                              ensureCondoRows(index, matchedProduct)
                            } else {
                              updateItem(index, 'product_id', matchedProduct.id)
                              updateItem(index, 'product_name', matchedProduct.product_name)
                              setProductSearchTerm({ ...productSearchTerm, [index]: matchedProduct.product_name })
                            }
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
                          
                          // ค้นหาสินค้าที่ตรงกับค่าที่พิมพ์ (ชื่อสินค้าหรือรหัสสินค้า)
                          const matchedProduct = findMatchedProduct(inputValue)
                          
                          if (matchedProduct) {
                            // อัพเดตให้ตรงกับสินค้าที่เลือก
                            if (isCondoProduct(matchedProduct.product_name)) {
                              ensureCondoRows(index, matchedProduct)
                            } else {
                              updateItem(index, 'product_id', matchedProduct.id)
                              updateItem(index, 'product_name', matchedProduct.product_name)
                              setProductSearchTerm({ ...productSearchTerm, [index]: matchedProduct.product_name })
                            }
                          } else if (item.product_id) {
                            // ถ้าไม่ตรงกับสินค้าใดๆ แต่มี product_id อยู่แล้ว ให้ใช้ชื่อสินค้าที่เลือกไว้
                            setProductSearchTerm({ ...productSearchTerm, [index]: item.product_name || '' })
                          } else {
                            // ถ้าไม่ตรงและไม่มี product_id ให้ล้าง
                            setProductSearchTerm({ ...productSearchTerm, [index]: '' })
                          }
                        }}
                        placeholder="ค้นหาหรือเลือกสินค้า..."
                        className={`w-full px-1.5 py-1 border rounded min-w-[160px] max-w-full ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['product_name'] ?? reviewErrorFields?.product_name) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
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
                          
                          // กรองสินค้าตามเงื่อนไข (ชื่อสินค้า หรือ รหัสสินค้า)
                          const filteredProducts = products.filter(p => {
                            // ถ้าไม่มีคำค้นหา ให้แสดงสินค้าทั้งหมด
                            if (!searchLower) return true
                            // ค้นหาในชื่อสินค้า
                            if (p.product_name.toLowerCase().includes(searchLower)) return true
                            // ค้นหาในรหัสสินค้า
                            if (p.product_code && p.product_code.toLowerCase().includes(searchLower)) return true
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
                  <td className="border p-1.5">
                    <select
                      value={item.ink_color || ''}
                      onChange={(e) => {
                        const selectedInk = e.target.value
                        updateItem(index, 'ink_color', selectedInk)

                        // รวม product_code ของหมึกแฟลชพลาสติกทั้งหมด (ใช้หาแถวแถมที่มีอยู่แล้ว)
                        const allBonusCodes = new Set(Object.values(PLASTIC_INK_BONUS_MAP).map(b => b.product_code))

                        // หาแถวแถมหมึกพลาสติกที่มีอยู่แล้วหลังแถวนี้ (แถวถัดไปที่เป็น is_free + product_code ตรง)
                        const findExistingBonusIndex = (fromIndex: number): number => {
                          const next = items[fromIndex + 1]
                          if (!next || !(next as { is_free?: boolean }).is_free) return -1
                          const nextProduct = products.find(p => p.id === next.product_id)
                          if (nextProduct && allBonusCodes.has(nextProduct.product_code)) return fromIndex + 1
                          return -1
                        }

                        const existingBonusIdx = findExistingBonusIndex(index)
                        const bonusInfo = PLASTIC_INK_BONUS_MAP[selectedInk]

                        if (bonusInfo) {
                          // เลือกหมึกพลาสติก → ต้องมีแถวแถม
                          const matchedProduct = products.find(p => p.product_code === bonusInfo.product_code)
                          if (matchedProduct) {
                            if (existingBonusIdx >= 0) {
                              // มีแถวแถมอยู่แล้ว → เปลี่ยนเป็นหมึกสีใหม่
                              setItems(prev => {
                                const newItems = [...prev]
                                newItems[existingBonusIdx] = {
                                  ...newItems[existingBonusIdx],
                                  product_id: matchedProduct.id,
                                  product_name: matchedProduct.product_name,
                                  is_free: true,
                                  unit_price: 0,
                                }
                                return newItems
                              })
                              setProductSearchTerm(prev => ({ ...prev, [existingBonusIdx]: matchedProduct.product_name }))
                            } else {
                              // ยังไม่มีแถวแถม → เพิ่มใหม่
                              setItems(prev => {
                                const newItems = [...prev]
                                const bonusItem: Partial<OrderItem> = {
                                  product_id: matchedProduct.id,
                                  product_name: matchedProduct.product_name,
                                  product_type: 'ชั้น1',
                                  quantity: 1,
                                  unit_price: 0,
                                  is_free: true,
                                }
                                newItems.splice(index + 1, 0, bonusItem as any)
                                return newItems
                              })
                              setProductSearchTerm(prev => ({ ...prev, [index + 1]: matchedProduct.product_name }))
                            }
                          }
                        } else {
                          // ไม่ได้เลือกหมึกพลาสติก → ลบแถวแถมถ้ามี
                          if (existingBonusIdx >= 0) {
                            setItems(prev => prev.filter((_, i) => i !== existingBonusIdx))
                          }
                        }
                      }}
                      disabled={formDisabled || !isFieldEnabled(index, 'ink_color')}
                      className={`w-full px-1.5 py-1 border rounded text-xs ${(formDisabled || !isFieldEnabled(index, 'ink_color')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['ink_color'] ?? reviewErrorFields?.ink_color) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    >
                      <option value="">เลือกสี</option>
                      {inkTypes.map((ink) => (
                        <option key={ink.id} value={ink.ink_name}>
                          {ink.ink_name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border p-1.5">
                    <div className="w-full px-1.5 py-1 border rounded text-xs bg-gray-100 text-gray-500 text-center">
                      {item.product_type || 'ชั้น1'}
                    </div>
                  </td>
                  <td className="border p-1.5">
                    <div className="relative">
                      <input
                        type="text"
                        list={`pattern-list-${index}`}
                        value={patternInputValue}
                        onChange={(e) => {
                          const nextValue = e.target.value
                          setPatternSearchTerm({ ...patternSearchTerm, [index]: nextValue })
                          if (nextValue.trim() === '') {
                            updateItem(index, 'cartoon_pattern', '')
                            return
                          }
                          // อนุญาตให้กรอก "0" เป็นค่าพิเศษ (ไม่ต้องการลาย)
                          if (nextValue.trim() === '0') {
                            updateItem(index, 'cartoon_pattern', '0')
                            return
                          }
                          const matchedPattern = getPatternByName(nextValue)
                          if (matchedPattern) {
                            updateItem(index, 'cartoon_pattern', matchedPattern.pattern_name)
                            setPatternSearchTerm({ ...patternSearchTerm, [index]: matchedPattern.pattern_name })
                            applyLineCountToItem(index, matchedPattern.line_count ?? null)
                          }
                        }}
                        onBlur={(e) => {
                          const inputValue = e.target.value.trim()
                          if (!inputValue) {
                            if (!item.cartoon_pattern) {
                              setPatternSearchTerm({ ...patternSearchTerm, [index]: '' })
                            }
                            return
                          }
                          // อนุญาตให้กรอก "0" เป็นค่าพิเศษ (ไม่ต้องการลาย)
                          if (inputValue === '0') {
                            updateItem(index, 'cartoon_pattern', '0')
                            setPatternSearchTerm({ ...patternSearchTerm, [index]: '0' })
                            return
                          }
                          const matchedPattern = getPatternByName(inputValue)
                          if (matchedPattern) {
                            updateItem(index, 'cartoon_pattern', matchedPattern.pattern_name)
                            setPatternSearchTerm({ ...patternSearchTerm, [index]: matchedPattern.pattern_name })
                            applyLineCountToItem(index, matchedPattern.line_count ?? null)
                          } else if (item.cartoon_pattern) {
                            setPatternSearchTerm({ ...patternSearchTerm, [index]: item.cartoon_pattern || '' })
                          } else {
                            setPatternSearchTerm({ ...patternSearchTerm, [index]: '' })
                          }
                        }}
                        disabled={formDisabled || !isFieldEnabled(index, 'cartoon_pattern')}
                        className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 max-w-[10rem] ${(formDisabled || !isFieldEnabled(index, 'cartoon_pattern')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['cartoon_pattern'] ?? reviewErrorFields?.cartoon_pattern) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                        placeholder="ลาย"
                        autoComplete="off"
                      />
                      <datalist id={`pattern-list-${index}`}>
                        {getFilteredPatterns(productCategory, patternInputValue).map((p) => (
                          <option key={p.id} value={p.pattern_name} />
                        ))}
                      </datalist>
                    </div>
                  </td>
                  {/* คอลัมน์เส้นซ่อนไว้ — เปิดใช้งานได้ในอนาคต */}
                  {/* <td className="border p-1.5">
                    <input
                      type="text"
                      value={item.line_pattern || ''}
                      onChange={(e) => updateItem(index, 'line_pattern', e.target.value)}
                      disabled={formDisabled || !isFieldEnabled(index, 'line_pattern')}
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 max-w-[4rem] ${(formDisabled || !isFieldEnabled(index, 'line_pattern')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['line_art'] ?? reviewErrorFields?.line_art) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                      placeholder="เส้น"
                    />
                  </td> */}
                  <td className="border p-1.5">
                    <div className="relative">
                      <input
                        type="text"
                        list={`font-list-${index}`}
                        value={fontSearchTerm[index] !== undefined ? fontSearchTerm[index] : (item.font || '')}
                        onChange={(e) => {
                          const nextValue = e.target.value
                          setFontSearchTerm({ ...fontSearchTerm, [index]: nextValue })
                          if (nextValue.trim() === '') {
                            updateItem(index, 'font', '')
                            return
                          }
                          // อนุญาตให้กรอก "0" เป็นค่าพิเศษ (ไม่ต้องการฟอนต์)
                          if (nextValue.trim() === '0') {
                            updateItem(index, 'font', '0')
                            return
                          }
                          const matchedFont = fonts.find(f => f.font_name.trim().toLowerCase() === nextValue.trim().toLowerCase())
                          if (matchedFont) {
                            updateItem(index, 'font', matchedFont.font_name)
                            setFontSearchTerm({ ...fontSearchTerm, [index]: matchedFont.font_name })
                          }
                        }}
                        onBlur={(e) => {
                          const inputValue = e.target.value.trim()
                          if (!inputValue) {
                            if (!item.font) {
                              setFontSearchTerm({ ...fontSearchTerm, [index]: '' })
                            }
                            return
                          }
                          // อนุญาตให้กรอก "0" เป็นค่าพิเศษ (ไม่ต้องการฟอนต์)
                          if (inputValue === '0') {
                            updateItem(index, 'font', '0')
                            setFontSearchTerm({ ...fontSearchTerm, [index]: '0' })
                            return
                          }
                          const matchedFont = fonts.find(f => f.font_name.trim().toLowerCase() === inputValue.toLowerCase())
                          if (matchedFont) {
                            updateItem(index, 'font', matchedFont.font_name)
                            setFontSearchTerm({ ...fontSearchTerm, [index]: matchedFont.font_name })
                          } else if (item.font) {
                            setFontSearchTerm({ ...fontSearchTerm, [index]: item.font || '' })
                          } else {
                            setFontSearchTerm({ ...fontSearchTerm, [index]: '' })
                          }
                        }}
                        disabled={formDisabled || !isFieldEnabled(index, 'font')}
                        className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || !isFieldEnabled(index, 'font')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['font'] ?? reviewErrorFields?.font) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                        placeholder="ฟอนต์"
                        autoComplete="off"
                      />
                      <datalist id={`font-list-${index}`}>
                        {fonts
                          .filter(f => {
                            const search = (fontSearchTerm[index] || '').trim().toLowerCase()
                            if (!search) return true
                            return f.font_name.toLowerCase().includes(search)
                          })
                          .map((font) => (
                            <option key={font.font_code} value={font.font_name} />
                          ))}
                      </datalist>
                    </div>
                  </td>
                  <td className="border p-1.5 align-middle">
                    <div className="flex items-center justify-center min-h-[28px]">
                      <input
                        type="checkbox"
                        checked={!!(item as { no_name_line?: boolean }).no_name_line}
                        onChange={(e) => updateItem(index, 'no_name_line', e.target.checked)}
                        disabled={formDisabled}
                        title="ติ๊ก = ไม่รับข้อความบรรทัด 1–3"
                        className="w-4 h-4 rounded border-gray-300"
                      />
                    </div>
                  </td>
                  <td className="border p-1.5">
                    <input
                      type="text"
                      value={item.line_1 || ''}
                      onChange={(e) => updateItem(index, 'line_1', e.target.value)}
                      disabled={formDisabled || !isFieldEnabled(index, 'line_1') || !!(item as { no_name_line?: boolean }).no_name_line || (lineLimit != null && lineLimit < 1)}
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || !isFieldEnabled(index, 'line_1') || (item as { no_name_line?: boolean }).no_name_line || (lineLimit != null && lineLimit < 1)) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['line_1'] ?? reviewErrorFields?.line_1) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    />
                  </td>
                  <td className="border p-1.5">
                    <input
                      type="text"
                      value={item.line_2 || ''}
                      onChange={(e) => updateItem(index, 'line_2', e.target.value)}
                      disabled={
                        formDisabled ||
                        !isFieldEnabled(index, 'line_2') ||
                        !!(item as { no_name_line?: boolean }).no_name_line ||
                        (lineLimit != null && lineLimit < 2)
                      }
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${
                        (formDisabled || !isFieldEnabled(index, 'line_2') || (item as { no_name_line?: boolean }).no_name_line || (lineLimit != null && lineLimit < 2))
                          ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                          : ''
                      } ${(reviewErrorFieldsByItem?.[index]?.['line_2'] ?? reviewErrorFields?.line_2) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    />
                  </td>
                  <td className="border p-1.5">
                    <input
                      type="text"
                      value={item.line_3 || ''}
                      onChange={(e) => updateItem(index, 'line_3', e.target.value)}
                      disabled={
                        formDisabled ||
                        !isFieldEnabled(index, 'line_3') ||
                        !!(item as { no_name_line?: boolean }).no_name_line ||
                        (lineLimit != null && lineLimit < 3)
                      }
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${
                        (formDisabled || !isFieldEnabled(index, 'line_3') || (item as { no_name_line?: boolean }).no_name_line || (lineLimit != null && lineLimit < 3))
                          ? 'bg-gray-100 text-gray-500 cursor-not-allowed'
                          : ''
                      } ${(reviewErrorFieldsByItem?.[index]?.['line_3'] ?? reviewErrorFields?.line_3) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    />
                  </td>
                  <td className="border p-1.5">
                    <input
                      type="number"
                      value={item.quantity || 1}
                      onChange={(e) => {
                        const v = e.target.value
                        updateItem(index, 'quantity', v === '' ? 0 : (parseInt(v) || 0))
                      }}
                      onBlur={() => {
                        if (!item.quantity) updateItem(index, 'quantity', 1)
                      }}
                      min="1"
                      disabled={formDisabled || !isFieldEnabled(index, 'quantity')}
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || !isFieldEnabled(index, 'quantity')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['quantity'] ?? reviewErrorFields?.quantity) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    />
                  </td>
                  <td className="border p-1.5">
                    <input
                      type="number"
                      value={item.unit_price || ''}
                      onChange={(e) => updateItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                      onWheel={(e) => (e.target as HTMLInputElement).blur()}
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
                      disabled={formDisabled || isManualPriceChannel || isCondoSubRow(item) || !isFieldEnabled(index, 'unit_price')}
                      className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || isManualPriceChannel || isCondoSubRow(item) || !isFieldEnabled(index, 'unit_price')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${(reviewErrorFieldsByItem?.[index]?.['unit_price'] ?? (!isManualPriceChannel && reviewErrorFields?.unit_price)) ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                    />
                  </td>
                  <td className="border p-1.5">
                    {(() => {
                      const noName = !!(item as { no_name_line?: boolean }).no_name_line
                      const displayValue = noName ? ('ไม่รับชื่อ' + (item.notes ? ' ' + item.notes : '')) : (item.notes || '')
                      const isExpanded = notesFocusedIndex === index
                      return isExpanded ? (
                        <textarea
                          value={displayValue}
                          onChange={(e) => {
                            const v = e.target.value
                            if (noName) {
                              const rest = v.startsWith('ไม่รับชื่อ') ? v.replace(/^ไม่รับชื่อ\s*/, '') : v
                              updateItem(index, 'notes', rest)
                            } else {
                              updateItem(index, 'notes', v)
                            }
                          }}
                          onBlur={() => setNotesFocusedIndex(null)}
                          disabled={formDisabled || !isFieldEnabled(index, 'notes')}
                          placeholder={noName ? 'ไม่รับชื่อ (พิมพ์หมายเหตุเพิ่มได้)' : 'หมายเหตุเพิ่มเติม'}
                          rows={4}
                          className={`w-full min-w-[120px] px-1.5 py-1 border rounded resize-y text-xs ${(formDisabled || !isFieldEnabled(index, 'notes')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
                          autoFocus
                        />
                      ) : (
                        <input
                          type="text"
                          value={displayValue}
                          onChange={(e) => {
                            const v = e.target.value
                            if (noName) {
                              const rest = v.startsWith('ไม่รับชื่อ') ? v.replace(/^ไม่รับชื่อ\s*/, '') : v
                              updateItem(index, 'notes', rest)
                            } else {
                              updateItem(index, 'notes', v)
                            }
                          }}
                          onFocus={() => setNotesFocusedIndex(index)}
                          disabled={formDisabled || !isFieldEnabled(index, 'notes')}
                          placeholder={noName ? 'ไม่รับชื่อ' : 'หมายเหตุเพิ่มเติม'}
                          className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || !isFieldEnabled(index, 'notes')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
                        />
                      )
                    })()}
                  </td>
                  <td className="border p-1.5">
                    {(() => {
                      const isFileExpanded = fileAttachmentFocusedIndex === index
                      const attachValue = (item.file_attachment || '').trim()
                      const isInvalidUrl = attachValue !== '' && !/^https?:\/\/.+/i.test(attachValue)
                      return (
                        <div>
                          {isFileExpanded ? (
                            <textarea
                              value={item.file_attachment || ''}
                              onChange={(e) => updateItem(index, 'file_attachment', e.target.value)}
                              onBlur={() => {
                                setFileAttachmentFocusedIndex(null)
                                const val = (item.file_attachment || '').trim()
                                if (val && !/^https?:\/\/.+/i.test(val)) {
                                  setMessageModal({
                                    open: true,
                                    title: 'แจ้งเตือน',
                                    message: `ไฟล์แนบรายการที่ ${index + 1} ไม่ใช่ลิงก์ (URL)\nกรุณาใส่ลิงก์ที่ขึ้นต้นด้วย http:// หรือ https://`,
                                  })
                                }
                              }}
                              disabled={formDisabled || !isFieldEnabled(index, 'attachment')}
                              placeholder="URL ไฟล์แนบ"
                              rows={3}
                              className={`w-full min-w-[80px] px-1.5 py-1 border rounded resize-y text-xs ${(formDisabled || !isFieldEnabled(index, 'attachment')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${isInvalidUrl ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                              autoFocus
                            />
                          ) : (
                            <input
                              type="text"
                              value={item.file_attachment || ''}
                              onChange={(e) => updateItem(index, 'file_attachment', e.target.value)}
                              onFocus={() => setFileAttachmentFocusedIndex(index)}
                              disabled={formDisabled || !isFieldEnabled(index, 'attachment')}
                              placeholder="ไฟล์แนบ"
                              className={`w-full px-1.5 py-1 border rounded text-xs min-w-0 ${(formDisabled || !isFieldEnabled(index, 'attachment')) ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${isInvalidUrl ? 'ring-2 ring-red-500 border-red-500' : ''}`}
                            />
                          )}
                          {isInvalidUrl && (
                            <p className="text-[10px] text-red-500 mt-0.5 leading-tight">ไม่ใช่ลิงก์ (URL)</p>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  <td className="border p-1.5 align-middle">
                    {!formDisabled && (
                    <button
                      type="button"
                      onClick={() => removeItem(index)}
                      className="px-2 py-0.5 bg-red-500 text-white rounded hover:bg-red-600 text-lg leading-tight"
                      title="ลบ"
                    >
                      ×
                    </button>
                    )}
                  </td>
                </tr>
              )
              })}
            </tbody>
          </table>
        </div>
        {!formDisabled && (
        <button
          type="button"
          onClick={addItem}
          className="mt-4 px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          + เพิ่มแถว
        </button>
        )}
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* ฝั่งซ้าย: อัพโหลดสลิปโอนเงิน — แสดงเฉพาะเมื่อช่องทางอยู่ใน bank_settings_channels */}
          <div>
            {(() => {
              const channelCode = formData.channel_code?.trim() || ''
              const channelRequiresSlip = formData.payment_method === 'โอน' && (channelCodesWithSlipVerification.has(channelCode) || CHANNELS_SHOW_SLIP_UPLOAD.includes(channelCode))
              const hasExistingSlips = uploadedSlipPaths.length > 0
              if (channelRequiresSlip || hasExistingSlips) {
                return (
                  <>
                    <h4 className="font-semibold mb-3 text-lg">อัพโหลดสลิปโอนเงิน</h4>
                    <SlipUploadSimple
                      billNo={order?.bill_no || null}
                      orderId={order?.id || null}
                      existingSlips={uploadedSlipPaths}
                      readOnly={formData.payment_method !== 'โอน' || formDisabled}
                      onSlipsUploaded={(slipStoragePaths) => {
                        setUploadedSlipPaths(slipStoragePaths)
                      }}
                      onBindSlipPaths={async (orderId, paths) => {
                        try {
                          const { data: existing } = await supabase
                            .from('ac_verified_slips')
                            .select('slip_storage_path')
                            .eq('order_id', orderId)
                            .eq('is_deleted', false)
                          const existingSet = new Set((existing || []).map((r: { slip_storage_path?: string | null }) => r.slip_storage_path).filter(Boolean))
                          for (const path of paths) {
                            if (existingSet.has(path)) continue
                            await supabase.from('ac_verified_slips').insert({
                              order_id: orderId,
                              slip_image_url: path,
                              slip_storage_path: path,
                              verified_amount: 0,
                            })
                          }
                        } catch (e) {
                          console.error('Bind slip paths:', e)
                        }
                      }}
                    />
                  </>
                )
              }
              if (formData.payment_method === 'โอน' && channelCode) {
                return (
                  <div className="text-amber-700 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
                    ช่องทางนี้ไม่อยู่ในตัวเลือกการตั้งค่าข้อมูลธนาคาร ไม่ต้องอัพโหลดสลิป
                  </div>
                )
              }
              return (
                <div className="text-gray-400 text-sm italic">
                  เลือกวิธีการชำระ &quot;โอน&quot; เพื่ออัพโหลดสลิป
                </div>
              )
            })()}
          </div>

          {/* ฝั่งขวา: ข้อมูลการชำระเงิน */}
          <div className="space-y-4">
            <h3 className="text-xl font-bold mb-2">ข้อมูลการชำระเงิน</h3>
            <div>
              <label className="block text-sm font-medium mb-1">ราคารวม</label>
              <input
                type="number"
                value={formData.price || ''}
                onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                onWheel={(e) => (e.target as HTMLInputElement).blur()}
                readOnly={!isManualPriceChannel}
                step="0.01"
                className={`w-full px-3 py-2 border rounded-lg font-semibold ${
                  isManualPriceChannel ? '' : 'bg-gray-100 text-gray-500'
                } ${reviewErrorFields?.unit_price ? 'ring-2 ring-red-500 border-red-500' : ''}`}
              />
              <p className="text-xs text-gray-500 mt-1">
                {isManualPriceChannel ? 'กรอกยอดเองสำหรับช่องทางที่รองรับ' : 'คำนวณจากรายการสินค้า'}
              </p>
              {isManualPriceChannel && (!formData.price || formData.price <= 0) && !formDisabled && (
                <p className="text-xs text-amber-600 font-medium mt-1">กรุณากรอกราคาก่อนบันทึก</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">ค่าส่ง</label>
              <input
                type="number"
                value={formData.shipping_cost || ''}
                onChange={(e) => setFormData({ ...formData, shipping_cost: parseFloat(e.target.value) || 0 })}
                onWheel={(e) => (e.target as HTMLInputElement).blur()}
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
                disabled={formDisabled}
                className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${
                  formData.shipping_cost === 0 ? 'text-gray-400' : ''
                }`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                รูปแบบการลด
              </label>
              <div className="flex gap-0 border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDiscountType('baht')}
                  disabled={formDisabled}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    discountType === 'baht'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  } ${formDisabled ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  บาท
                </button>
                <button
                  type="button"
                  onClick={() => setDiscountType('percent')}
                  disabled={formDisabled}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                    discountType === 'percent'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  } ${formDisabled ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  %
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                ส่วนลด {discountType === 'percent' ? '(%)' : '(บาท)'}
              </label>
              <input
                type="number"
                value={formData.discount || ''}
                onChange={(e) => {
                  let val = parseFloat(e.target.value) || 0
                  // จำกัดค่า % ไม่เกิน 100
                  if (discountType === 'percent' && val > 100) val = 100
                  setFormData({ ...formData, discount: val })
                }}
                onWheel={(e) => (e.target as HTMLInputElement).blur()}
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
                min="0"
                max={discountType === 'percent' ? '100' : undefined}
                placeholder="0"
                disabled={formDisabled}
                className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''} ${
                  formData.discount === 0 ? 'text-gray-400' : ''
                }`}
              />
              {discountType === 'percent' && formData.discount > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  = {getDiscountInBaht(formData.price || 0, formData.discount, 'percent').toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">ยอดสุทธิ</label>
              <input
                type="text"
                value={formData.total_amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                readOnly
                className="w-full px-3 py-2 border-2 border-blue-300 rounded-lg bg-blue-50 font-bold text-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">วิธีการชำระ</label>
              <select
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                disabled={formDisabled}
                className={`w-full px-3 py-2 border rounded-lg ${formDisabled ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
              >
                <option value="โอน">โอน</option>
                <option value="COD">COD</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {!viewOnly && (
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
              const willShow = !showCashBill
              setShowCashBill(willShow)
              setShowTaxInvoice(false)
              if (willShow) {
                const composedAddress = [formData.address_line, formData.sub_district, formData.district, formData.province, formData.postal_code].filter(Boolean).join(' ').trim()
                const addressForBill = composedAddress || formData.customer_address || ''
                const customerNameForBill = CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code) ? formData.recipient_name : formData.customer_name
                setCashBillData(prev => ({
                  ...prev,
                  company_name: customerNameForBill?.trim() || prev.company_name,
                  address: addressForBill || prev.address,
                  mobile_phone: formData.mobile_phone?.trim() || prev.mobile_phone,
                }))
              }
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
                <label className="block text-sm font-medium mb-1">เบอร์โทร</label>
                <input
                  type="text"
                  value={cashBillData.mobile_phone}
                  onChange={(e) => setCashBillData({ ...cashBillData, mobile_phone: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="เบอร์โทรศัพท์"
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
      )}

      <div className="flex gap-4">
        {viewOnly ? (
          <button
            type="button"
            onClick={onCancel}
            className="px-6 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
          >
            กลับ
          </button>
        ) : (
        <>
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
                setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกช่องทาง' })
                return
              }

              if (CHANNELS_SHOW_CHANNEL_NAME.includes(formData.channel_code)) {
                if (!formData.customer_name || formData.customer_name.trim() === '') {
                  setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกชื่อช่องทาง' })
                  return
                }
              }
              if (CHANNELS_SHOW_ORDER_NO.includes(formData.channel_code)) {
                if (!formData.channel_order_no || formData.channel_order_no.trim() === '') {
                  setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกเลขคำสั่งซื้อ' })
                  return
                }
                // ช่องทางใน CHANNELS_COMPLETE_TO_VERIFIED ไม่บังคับกรอกชื่อลูกค้าเมื่อบันทึกข้อมูลครบ
                if (!CHANNELS_COMPLETE_TO_VERIFIED.includes(formData.channel_code) && (!formData.customer_name || formData.customer_name.trim() === '')) {
                  setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกชื่อลูกค้า' })
                  return
                }
              }

              if (formData.channel_code === 'SHOPP') {
                if (!formData.scheduled_pickup_at || !formData.scheduled_pickup_at.trim()) {
                  setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณาเลือกวันที่ เวลา นัดรับ' })
                  return
                }
              }

              if (formData.tracking_number && formData.tracking_number.trim()) {
                const { data: dup, error } = await supabase
                  .from('or_orders')
                  .select('id')
                  .eq('tracking_number', formData.tracking_number.trim())
                  .neq('id', order?.id || '00000000-0000-0000-0000-000000000000')
                  .limit(1)
                if (error) {
                  setMessageModal({ open: true, title: 'เกิดข้อผิดพลาด', message: error.message })
                  return
                }
                if (dup && dup.length > 0) {
                  setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'เลขพัสดุซ้ำกับรายการในระบบ' })
                  return
                }
              }

              const isAddressBlockedSave = CHANNELS_BLOCK_ADDRESS.includes(formData.channel_code)
              const composedAddressSave = [formData.address_line, formData.sub_district, formData.district, formData.province, formData.postal_code].filter(Boolean).join(' ').trim()
              const hasAddressSave = (formData.customer_address?.trim() || composedAddressSave) !== ''
              if (!isAddressBlockedSave && !hasAddressSave) {
                setMessageModal({ open: true, title: 'แจ้งเตือน', message: 'กรุณากรอกที่อยู่ลูกค้า หรือวางที่อยู่แล้วกด Auto fill' })
                return
              }

              console.log('[บันทึกข้อมูลครบ] เริ่ม match สินค้า...')

              // พยายาม match สินค้าก่อน (รองรับกรณีเลือกจาก dropdown หรือพิมพ์รหัส/ชื่อ)
              let hasUpdates = false
              const updatedItems = items.map((item, _index) => {
                if (!item.product_id && item.product_name?.trim()) {
                  const searchName = item.product_name.toLowerCase().trim().replace(/\s+/g, ' ')
                  let matchedProduct = products.find(
                    p => p.product_code && p.product_code.toLowerCase().trim() === searchName
                  )
                  if (!matchedProduct) {
                    matchedProduct = products.find(
                      p => p.product_name.toLowerCase().trim().replace(/\s+/g, ' ') === searchName
                    )
                  }
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
                  setProductSelectAlertOpen(true)
                } else {
                  alert('กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ')
                }
                return
              }

              // ตรวจสอบว่ารายการสินค้ามีราคา/หน่วยหรือไม่
              if (isManualPriceChannel) {
                if (!formData.price || formData.price <= 0) {
                  setMessageModal({
                    open: true,
                    title: 'แจ้งเตือน',
                    message: 'กรุณากรอกราคาที่ข้อมูลการชำระเงิน',
                  })
                  return
                }
              } else {
                const itemsWithoutPrice = itemsWithProduct.filter(item => (!item.unit_price || item.unit_price <= 0) && !isCondoSubRow(item) && !(item as { is_free?: boolean }).is_free)
                if (itemsWithoutPrice.length > 0) {
                  const itemNames = itemsWithoutPrice.map(item => item.product_name || 'สินค้า').join(', ')
                  setMessageModal({
                    open: true,
                    title: 'แจ้งเตือน',
                    message: `กรุณากรอกราคา/หน่วยสำหรับรายการสินค้าทั้งหมด\n\nรายการที่ยังไม่มีราคา:\n${itemNames}`,
                  })
                  return
                }
              }

              // ตรวจสอบว่ารายการสินค้าที่เลือกแล้ว กรอกข้อมูลครบทุกฟิลด์ที่เปิดใช้งาน (ยกเว้น บรรทัด1-3, หมายเหตุ, ไฟล์แนบ) — สินค้าฟรียังต้องกรอก สีหมึก/ลาย/ฟอนต์/จำนวน
              const missingFieldItemsComplete: { index: number; productName: string; missingFields: string[] }[] = []
              itemsWithProduct.forEach((item) => {
                const itemIndex = itemsToValidate.indexOf(item)
                const missing: string[] = []
                if (isFieldEnabled(itemIndex, 'ink_color') && !item.ink_color?.trim()) {
                  missing.push('สีหมึก')
                }
                // ลาย (cartoon_pattern) — อนุญาตให้กรอก "0" ได้
                if (isFieldEnabled(itemIndex, 'cartoon_pattern') && !item.cartoon_pattern?.trim()) {
                  missing.push('ลาย (หากไม่ต้องการเลือกลาย กรุณาใส่เลข 0)')
                }
                // ฟอนต์ — อนุญาตให้กรอก "0" ได้
                if (isFieldEnabled(itemIndex, 'font') && !item.font?.trim()) {
                  missing.push('ฟอนต์ (หากไม่ต้องการเลือกฟอนต์ กรุณาใส่เลข 0)')
                }
                if (isFieldEnabled(itemIndex, 'quantity') && (!item.quantity || item.quantity <= 0)) {
                  missing.push('จำนวน')
                }
                if (missing.length > 0) {
                  missingFieldItemsComplete.push({
                    index: itemIndex + 1,
                    productName: item.product_name || 'สินค้า',
                    missingFields: missing,
                  })
                }
              })
              if (missingFieldItemsComplete.length > 0) {
                const details = missingFieldItemsComplete
                  .map(m => `รายการที่ ${m.index} (${m.productName}): ${m.missingFields.join(', ')}`)
                  .join('\n')
                setMessageModal({
                  open: true,
                  title: 'แจ้งเตือน',
                  message: `กรุณากรอกข้อมูลให้ครบทุกช่อง\n\n${details}`,
                })
                return
              }

              // ตรวจสอบว่ารายการสินค้าที่ไม่ได้ติ๊ก "ไม่รับชื่อ" ต้องกรอกบรรทัด 1-3 อย่างน้อย 1 ช่อง (รวมสินค้าฟรี)
              const itemsNoNameNotCheckedComplete = itemsWithProduct.filter((item) => {
                const itemIndex = itemsToValidate.indexOf(item)
                const noName = !!(item as { no_name_line?: boolean }).no_name_line
                if (noName) return false
                if (!isFieldEnabled(itemIndex, 'line_1')) return false
                return !item.line_1?.trim() && !item.line_2?.trim() && !item.line_3?.trim()
              })
              if (itemsNoNameNotCheckedComplete.length > 0) {
                const details = itemsNoNameNotCheckedComplete
                  .map(item => `- ${item.product_name || 'สินค้า'} (รายการที่ ${itemsToValidate.indexOf(item) + 1})`)
                  .join('\n')
                setMessageModal({
                  open: true,
                  title: 'แจ้งเตือน',
                  message: `มีรายการที่ไม่ได้กรอกชื่อ กรุณาติ๊ก "ไม่รับชื่อ" ที่รายการสินค้า\n\n${details}`,
                })
                return
              }

              // ตรวจสอบสลิปโอน — ช่องทาง SHOP PICKUP / SHOP SHIPPING บังคับอัพโหลดสลิปก่อนกด บันทึก(ข้อมูลครบ)
              if (formData.payment_method === 'โอน') {
                const channelCode = formData.channel_code?.trim() || ''
                if (CHANNELS_SHOW_SLIP_UPLOAD.includes(channelCode) && uploadedSlipPaths.length === 0) {
                  setMessageModal({
                    open: true,
                    title: 'แจ้งเตือน',
                    message: 'กรุณาอัพโหลดสลิปโอนเงิน',
                  })
                  return
                }
                // ช่องทางใน CHANNELS_COMPLETE_TO_VERIFIED (ที่ไม่ใช่ SHOP/SHOPP) บันทึก "ข้อมูลครบ" ไป "ตรวจสอบแล้ว" โดยตรง ไม่บังคับสลิป
                if (!CHANNELS_COMPLETE_TO_VERIFIED.includes(channelCode)) {
                  const { data: bscData, error: bscError } = await supabase
                    .from('bank_settings_channels')
                    .select('bank_setting_id')
                    .eq('channel_code', channelCode)
                  if (bscError) {
                    if (uploadedSlipPaths.length === 0) {
                      setMessageModal({
                        open: true,
                        title: 'แจ้งเตือน',
                        message: 'กรุณาอัพโหลดสลิปโอนเงิน',
                      })
                      return
                    }
                  } else if (bscData && bscData.length > 0) {
                    const ids = bscData.map((r: { bank_setting_id: string }) => r.bank_setting_id)
                    const { data: activeBank } = await supabase
                      .from('bank_settings')
                      .select('id')
                      .in('id', ids)
                      .eq('is_active', true)
                      .limit(1)
                    const channelHasSlipVerification = !!(activeBank && activeBank.length > 0)
                    if (channelHasSlipVerification && uploadedSlipPaths.length === 0) {
                      setMessageModal({
                        open: true,
                        title: 'แจ้งเตือน',
                        message: 'กรุณาอัพโหลดสลิปโอนเงิน',
                      })
                      return
                    }
                  }
                }
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
          onClick={(e) => {
            e.preventDefault()
            if (!order) {
              onCancel()
              return
            }
            setCancelOrderModal({ open: true })
          }}
          disabled={loading}
          className="px-6 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
        >
          ยกเลิก
        </button>
        </>
        )}
      </div>
    </form>

    {/* Popup ยกเลิกออเดอร์ (ถามยืนยัน → แสดงผลสำเร็จ/ผิดพลาด ใน popup เดียว) */}
    {cancelOrderModal.open && order && (
      <Modal
        open
        onClose={() => setCancelOrderModal({ open: false })}
        contentClassName="max-w-md"
        role="dialog"
        ariaModal
        ariaLabelledby="cancel-order-modal-title"
      >
          <div
            className={`shrink-0 px-6 py-4 ${
              cancelOrderModal.success
                ? 'bg-green-500'
                : cancelOrderModal.error
                  ? 'bg-red-500'
                  : 'bg-gray-600'
            } text-white`}
          >
            <h2 id="cancel-order-modal-title" className="text-lg font-semibold">
              {cancelOrderModal.success
                ? 'ยกเลิกออเดอร์สำเร็จ'
                : cancelOrderModal.error
                  ? 'เกิดข้อผิดพลาด'
                  : 'ยืนยันยกเลิกออเดอร์'}
            </h2>
          </div>
          <div className="flex-1 px-6 py-4 text-gray-700">
            {cancelOrderModal.success ? (
              <p className="text-sm">ออเดอร์ {order.bill_no} ถูกยกเลิกแล้ว</p>
            ) : cancelOrderModal.error ? (
              <p className="text-sm">{cancelOrderModal.error}</p>
            ) : (
              <p className="text-sm">
                ต้องการยกเลิกออเดอร์ {order.bill_no} หรือไม่?
              </p>
            )}
          </div>
          <div className="shrink-0 px-6 py-4 bg-gray-50 border-t border-gray-200 flex gap-2 justify-end">
            {cancelOrderModal.success ? (
              <button
                type="button"
                onClick={() => {
                  setCancelOrderModal({ open: false })
                  onSave()
                }}
                className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 text-sm font-medium"
              >
                ตกลง
              </button>
            ) : cancelOrderModal.error ? (
              <button
                type="button"
                onClick={() => setCancelOrderModal({ open: false })}
                className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 text-sm font-medium"
              >
                ตกลง
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setCancelOrderModal({ open: false })}
                  disabled={cancelOrderModal.submitting}
                  className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm font-medium"
                >
                  ไม่ยืนยัน
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setCancelOrderModal((prev) => ({ ...prev, submitting: true }))
                    try {
                      const { error } = await supabase
                        .from('or_orders')
                        .update({ status: 'ยกเลิก' })
                        .eq('id', order.id)
                      if (error) throw error
                      setCancelOrderModal((prev) => ({ ...prev, success: true, submitting: false }))
                    } catch (err: any) {
                      console.error('Error cancelling order:', err)
                      setCancelOrderModal((prev) => ({
                        ...prev,
                        success: false,
                        error: err?.message || 'เกิดข้อผิดพลาดในการยกเลิกออเดอร์',
                        submitting: false,
                      }))
                    }
                  }}
                  disabled={cancelOrderModal.submitting}
                  className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
                >
                  {cancelOrderModal.submitting ? (
                    <>
                      <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                      กำลังยกเลิก...
                    </>
                  ) : (
                    'ยืนยันยกเลิก'
                  )}
                </button>
              </>
            )}
          </div>
      </Modal>
    )}

    {verificationModal && (
      <VerificationResultModal
        open
        onClose={async () => {
          if (verificationModal.type === 'over_transfer' && verificationModal.orderId) {
            const { error } = await supabase
              .from('or_orders')
              .update({ status: 'ตรวจสอบไม่ผ่าน' })
              .eq('id', verificationModal.orderId)
            if (error) {
              console.error('Error updating order status:', error)
              alert('เกิดข้อผิดพลาดในการอัปเดตสถานะ: ' + error.message)
            } else {
              // สลับไปแท็บ "ตรวจสอบไม่ผ่าน" เพื่อให้ผู้ใช้เห็นบิลที่เพิ่งปฏิเสธโอนเกิน
              onSave({ switchToTab: 'complete' })
              setVerificationModal(null)
              return
            }
          }
          setVerificationModal(null)
          onSave()
        }}
        type={verificationModal.type}
        accountMatch={verificationModal.accountMatch}
        bankCodeMatch={verificationModal.bankCodeMatch}
        amountStatus={verificationModal.amountStatus}
        orderAmount={verificationModal.orderAmount}
        totalAmount={verificationModal.totalAmount}
        overpayAmount={verificationModal.overpayAmount}
        errors={verificationModal.errors}
        validationErrors={verificationModal.validationErrors}
        statusMessage={verificationModal.statusMessage}
        onConfirmOverpay={
          verificationModal.type === 'over_transfer' && verificationModal.orderId && verificationModal.overpayAmount != null
            ? async () => {
                setConfirmingOverpay(true)
                try {
                  const refundData = {
                    order_id: verificationModal.orderId,
                    amount: verificationModal.overpayAmount,
                    reason: `โอนเกิน (ยอดบิล: ฿${verificationModal.orderAmount.toLocaleString()}, สลิป: ฿${verificationModal.totalAmount.toLocaleString()})`,
                    status: 'pending' as const,
                  }

                  // เช็คว่ามี pending refund ของ order นี้อยู่แล้วหรือไม่ — ถ้ามีให้อัพเดตแทน insert
                  const { data: existingRefund } = await supabase
                    .from('ac_refunds')
                    .select('id')
                    .eq('order_id', verificationModal.orderId)
                    .eq('status', 'pending')
                    .limit(1)
                    .maybeSingle()

                  if (existingRefund) {
                    const { error: refundError } = await supabase
                      .from('ac_refunds')
                      .update({ amount: refundData.amount, reason: refundData.reason })
                      .eq('id', existingRefund.id)
                    if (refundError) throw new Error(refundError.message)
                  } else {
                    const { error: refundError } = await supabase.from('ac_refunds').insert(refundData)
                    if (refundError) throw new Error(refundError.message)
                  }
                  const { error: updateError } = await supabase
                    .from('or_orders')
                    .update({ status: 'ตรวจสอบแล้ว' })
                    .eq('id', verificationModal.orderId)
                  if (updateError) throw new Error(updateError.message)
                  setVerificationModal(null)
                  onSave()
                } catch (err: any) {
                  console.error('Error confirming overpay:', err)
                  alert('เกิดข้อผิดพลาด: ' + (err?.message || err))
                } finally {
                  setConfirmingOverpay(false)
                }
              }
            : undefined
        }
        confirmingOverpay={confirmingOverpay}
      />
    )}

    <Modal
      open={importModalOpen}
      onClose={() => {
        if (!importBusy) setImportModalOpen(false)
      }}
      contentClassName="max-w-2xl"
      closeOnBackdropClick={!importBusy}
    >
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">Import Orders from File</h3>
          <button
            type="button"
            onClick={() => {
              if (!importBusy) setImportModalOpen(false)
            }}
            className="text-gray-500 hover:text-red-500 text-xl"
          >
            ×
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setImportTab('smart')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
              importTab === 'smart' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Smart Import
          </button>
          <button
            type="button"
            onClick={() => setImportTab('wy')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
              importTab === 'wy' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            WY CSV → Excel
          </button>
        </div>
        {importTab === 'smart' ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              รองรับ Standard / PGTR / WY อัตโนมัติ (Excel หรือ CSV)
            </p>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                const file = e.target.files?.[0] || null
                setImportFile(file)
                setImportSummary(null)
              }}
              className="block w-full text-sm"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => importFile && handleSmartImport(importFile)}
                disabled={!importFile || importBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {importBusy ? 'กำลังนำเข้า...' : 'นำเข้า'}
              </button>
              {importFile && (
                <span className="text-xs text-gray-500">
                  ไฟล์: {importFile.name}
                </span>
              )}
            </div>
            {importSummary && (
              <div className="bg-gray-50 border rounded-lg p-3 text-sm whitespace-pre-line text-gray-700">
                {importSummary}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              แปลงไฟล์ CSV ของ WY แล้วนำเข้าอัตโนมัติ
            </p>
            <input
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={(e) => {
                const file = e.target.files?.[0] || null
                setWyFile(file)
                setWyStatus('')
                if (file) handleWyConvert(file)
              }}
              className="block w-full text-sm"
            />
            {wyFile && (
              <span className="text-xs text-gray-500">
                ไฟล์: {wyFile.name}
              </span>
            )}
            {wyStatus && (
              <div className="text-sm text-gray-700">{wyStatus}</div>
            )}
          </div>
        )}
      </div>
    </Modal>

    {/* Modal แจ้งเตือนทั่วไป (แทน alert เช่น กรุณาอัพโหลดสลิปโอนเงิน) */}
    <Modal
      open={messageModal.open}
      onClose={() => setMessageModal((prev) => ({ ...prev, open: false }))}
      contentClassName="max-w-md"
    >
      <div className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{messageModal.title}</h3>
        <p className="text-gray-700 text-sm whitespace-pre-line">{messageModal.message}</p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setMessageModal((prev) => ({ ...prev, open: false }))}
            className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
          >
            ตกลง
          </button>
        </div>
      </div>
    </Modal>

    <Modal
      open={claimModalOpen}
      onClose={() => setClaimModalOpen(false)}
      contentClassName="max-w-2xl max-h-[85vh] flex flex-col"
      closeOnBackdropClick
    >
      <div className="p-5 flex flex-col flex-1 min-h-0">
        <h3 className="text-lg font-bold mb-4">สร้างบิลเคลม</h3>
        {claimStep === 1 && (
          <>
            <p className="text-sm text-gray-600 mb-3">#1 เลือกบิลอ้างอิงที่ต้องการนำไปเคลม</p>
            <div className="flex gap-3 mb-3 flex-wrap">
              <input
                type="text"
                placeholder="ค้นหาเลขบิล / ชื่อลูกค้า / เลขคำสั่งซื้อ"
                value={claimFilterSearch}
                onChange={(e) => setClaimFilterSearch(e.target.value)}
                className="flex-1 min-w-[180px] px-3 py-2 border rounded-lg"
              />
              <select
                value={claimFilterChannel}
                onChange={(e) => setClaimFilterChannel(e.target.value)}
                className="px-3 py-2 border rounded-lg"
              >
                <option value="">ทุกช่องทาง</option>
                {channels.map((ch) => (
                  <option key={ch.channel_code} value={ch.channel_code}>{ch.channel_name}</option>
                ))}
              </select>
            </div>
            <div className="border rounded-lg overflow-auto flex-1 min-h-[200px] max-h-[320px]">
              {claimOrdersLoading ? (
                <div className="p-4 text-gray-500">กำลังโหลด...</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-100 sticky top-0">
                    <tr>
                      <th className="text-left p-2 w-10"></th>
                      <th className="text-left p-2">เลขบิล</th>
                      <th className="text-left p-2">ชื่อลูกค้า</th>
                      <th className="text-left p-2">ช่องทาง</th>
                      <th className="text-left p-2">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claimOrders
                      .filter((o) => {
                        const search = claimFilterSearch.trim().toLowerCase()
                        const ch = claimFilterChannel.trim()
                        if (ch && o.channel_code !== ch) return false
                        if (!search) return true
                        const bill = (o.bill_no || '').toLowerCase()
                        const name = (o.customer_name || '').toLowerCase()
                        const orderNo = (o.channel_order_no || '').toLowerCase()
                        return bill.includes(search) || name.includes(search) || orderNo.includes(search)
                      })
                      .map((o) => (
                        <tr
                          key={o.id}
                          className={`border-t cursor-pointer hover:bg-gray-50 ${selectedClaimRefOrder?.id === o.id ? 'bg-blue-50' : ''}`}
                          onClick={() => setSelectedClaimRefOrder(selectedClaimRefOrder?.id === o.id ? null : o)}
                        >
                          <td className="p-2">
                            <input
                              type="radio"
                              checked={selectedClaimRefOrder?.id === o.id}
                              onChange={() => setSelectedClaimRefOrder(selectedClaimRefOrder?.id === o.id ? null : o)}
                            />
                          </td>
                          <td className="p-2 font-medium">{o.bill_no}</td>
                          <td className="p-2">{o.customer_name || '-'}</td>
                          <td className="p-2">{channels.find((c) => c.channel_code === o.channel_code)?.channel_name ?? o.channel_code}</td>
                          <td className="p-2">{o.status}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setClaimModalOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-100">
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => selectedClaimRefOrder && setClaimStep(2)}
                disabled={!selectedClaimRefOrder}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                ถัดไป
              </button>
            </div>
          </>
        )}
        {claimStep === 2 && (
          <>
            <p className="text-sm text-gray-600 mb-2">#2 หัวข้อการเคลม (claim_type)</p>
            {selectedClaimRefOrder && (
              <p className="text-sm text-gray-700 mb-3">บิลอ้างอิง: <strong>{selectedClaimRefOrder.bill_no}</strong></p>
            )}
            <select
              value={selectedClaimType}
              onChange={(e) => setSelectedClaimType(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg mb-4"
            >
              <option value="">-- เลือกหัวข้อการเคลม --</option>
              {claimTypes.map((ct) => (
                <option key={ct.code} value={ct.code}>{ct.name}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClaimStep(1)}
                className="px-4 py-2 border rounded-lg hover:bg-gray-100"
              >
                ย้อนกลับ
              </button>
              <button type="button" onClick={() => setClaimModalOpen(false)} className="px-4 py-2 border rounded-lg hover:bg-gray-100">
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handleClaimConfirm}
                disabled={!selectedClaimType.trim() || claimConfirmSubmitting || !onOpenOrder}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {claimConfirmSubmitting ? 'กำลังสร้าง...' : 'ยืนยันสร้างบิลเคลม'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>

    <Modal
      open={productSelectAlertOpen}
      onClose={() => setProductSelectAlertOpen(false)}
      contentClassName="max-w-md"
      closeOnBackdropClick
    >
      <div className="p-5">
        <p className="text-gray-800 whitespace-pre-line">
          กรุณาเลือกสินค้าจากรายการที่สร้างไว้
          {'\n'}(กรุณาเลือกสินค้าจาก dropdown)
        </p>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setProductSelectAlertOpen(false)}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            ตกลง
          </button>
        </div>
      </div>
    </Modal>
    </>
  )
}
