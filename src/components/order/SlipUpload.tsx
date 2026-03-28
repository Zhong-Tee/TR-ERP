import React, { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { SlipVerificationResult, MultipleSlipVerificationResult } from '../../lib/easyslip'
import {
  computePostSlipVerificationStatus,
  fetchOrderOwnerSalesRole,
} from '../../lib/postSlipVerificationStatus'

interface SlipUploadProps {
  orderId: string
  orderAmount: number
  onVerificationComplete: (success: boolean, totalAmount: number) => void
}

export default function SlipUpload({
  orderId,
  orderAmount,
  onVerificationComplete,
}: SlipUploadProps) {
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [verificationResult, setVerificationResult] = useState<{
    success: boolean
    totalAmount: number
    message: string
  } | null>(null)

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files)
      setFiles(selectedFiles)
      setVerificationResult(null)
    }
  }

  async function handleVerify() {
    if (files.length === 0) {
      alert('กรุณาเลือกไฟล์สลิป')
      return
    }

    setUploading(true)
    try {
      // Check for duplicate slips first
      const slipUrls: string[] = []
      for (const file of files) {
        const fileExt = file.name.split('.').pop()
        const fileName = `slips/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`
        
        const { data: _uploadData, error: uploadError } = await supabase.storage
          .from('slip-images')
          .upload(fileName, file)
        
        if (uploadError) throw uploadError

        const { data: urlData } = supabase.storage
          .from('slip-images')
          .getPublicUrl(fileName)

        slipUrls.push(urlData.publicUrl)
      }

      // Check for duplicates
      const { data: existingSlips } = await supabase
        .from('ac_verified_slips')
        .select('slip_image_url')
        .in('slip_image_url', slipUrls)

      if (existingSlips && existingSlips.length > 0) {
        throw new Error('พบสลิปที่เคยใช้แล้ว กรุณาใช้สลิปใหม่')
      }

      // Verify slips using the uploaded URLs
      const results: SlipVerificationResult[] = []
      let totalAmount = 0
      const errors: string[] = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const url = slipUrls[i]

        // Call Edge Function to verify
        const { data, error: verifyError } = await supabase.functions.invoke('verify-slip', {
          body: { imageUrl: url }
        })

        if (verifyError) {
          errors.push(`Failed to verify ${file.name}: ${verifyError.message}`)
          results.push({
            success: false,
            error: verifyError.message
          })
        } else if (!data?.success) {
          errors.push(data?.error || `Failed to verify ${file.name}`)
          results.push({
            success: false,
            error: data?.error || 'Unknown error'
          })
        } else {
          const amount = data.amount || 0
          totalAmount += amount
          results.push({
            success: true,
            amount,
            message: data.message
          })
        }
      }

      const result: MultipleSlipVerificationResult = {
        success: errors.length === 0,
        totalAmount,
        results,
        errors: errors.length > 0 ? errors : undefined,
      }

      if (result.success) {
        // Save verified slips
        const slipsToInsert = result.results.map((r, idx) => ({
          order_id: orderId,
          slip_image_url: slipUrls[idx],
          verified_amount: r.amount || 0,
        })).filter(s => s.verified_amount > 0)

        if (slipsToInsert.length > 0) {
          const { error: insertError } = await supabase
            .from('ac_verified_slips')
            .insert(slipsToInsert)

          if (insertError) throw insertError
        }

        // Check if amount matches or exceeds
        if (result.totalAmount >= orderAmount) {
          const { data: orderRow, error: orderFetchError } = await supabase
            .from('or_orders')
            .select('admin_user, channel_code, requires_confirm_design')
            .eq('id', orderId)
            .single()

          if (orderFetchError) throw orderFetchError

          const ownerRole = await fetchOrderOwnerSalesRole(supabase, orderRow.admin_user)
          const nextStatus = computePostSlipVerificationStatus(
            ownerRole,
            orderRow.channel_code,
            orderRow.requires_confirm_design,
          )

          const { error: updateError } = await supabase
            .from('or_orders')
            .update({ status: nextStatus })
            .eq('id', orderId)

          if (updateError) throw updateError

          setVerificationResult({
            success: true,
            totalAmount: result.totalAmount,
            message: `ตรวจสอบสลิปสำเร็จ! ยอดรวม: ฿${result.totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()})`,
          })

          onVerificationComplete(true, result.totalAmount)
        } else {
          // Amount is less than order amount - create refund record
          const excessAmount = orderAmount - result.totalAmount
          const { error: refundError } = await supabase
            .from('ac_refunds')
            .insert({
              order_id: orderId,
              amount: excessAmount,
              reason: `ยอดสลิปไม่พอ (ยอดออเดอร์: ฿${orderAmount.toLocaleString()}, ยอดสลิป: ฿${result.totalAmount.toLocaleString()})`,
              status: 'pending',
            })

          if (refundError) throw refundError

          setVerificationResult({
            success: false,
            totalAmount: result.totalAmount,
            message: `ยอดสลิปไม่พอ! ยอดรวม: ฿${result.totalAmount.toLocaleString()} (ยอดออเดอร์: ฿${orderAmount.toLocaleString()}) - สร้างรายการโอนคืนแล้ว`,
          })

          onVerificationComplete(false, result.totalAmount)
        }
      } else {
        setVerificationResult({
          success: false,
          totalAmount: 0,
          message: `ตรวจสอบสลิปไม่สำเร็จ: ${result.errors?.join(', ') || 'Unknown error'}`,
        })
        onVerificationComplete(false, 0)
      }
    } catch (error: any) {
      console.error('Error verifying slips:', error)
      setVerificationResult({
        success: false,
        totalAmount: 0,
        message: `เกิดข้อผิดพลาด: ${error.message}`,
      })
      onVerificationComplete(false, 0)
    } finally {
      setUploading(false)
    }
  }

  function handleRemoveFile(index: number) {
    setFiles(files.filter((_, i) => i !== index))
    setVerificationResult(null)
  }

  const fileInputRef = React.useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-4">
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

      {files.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">ไฟล์ที่เลือก ({files.length} ไฟล์):</p>
          <div className="space-y-1">
            {files.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between bg-gray-50 p-2 rounded"
              >
                <span className="text-sm">{file.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveFile(index)}
                  className="text-red-500 hover:text-red-700 text-sm"
                >
                  ลบ
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={handleVerify}
            disabled={uploading}
            className="w-full px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            {uploading ? 'กำลังตรวจสอบ...' : 'ตรวจสอบสลิป'}
          </button>
        </div>
      )}

      {verificationResult && (
        <div
          className={`p-4 rounded-lg ${
            verificationResult.success
              ? 'bg-green-50 border border-green-200 text-green-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}
        >
          <p className="font-medium">{verificationResult.message}</p>
          {verificationResult.totalAmount > 0 && (
            <p className="text-sm mt-1">
              ยอดรวมจากสลิป: ฿{verificationResult.totalAmount.toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
