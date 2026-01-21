import { supabase } from './supabase'

export interface SlipVerificationResult {
  success: boolean
  amount?: number
  message?: string
  error?: string
}

export interface MultipleSlipVerificationResult {
  success: boolean
  totalAmount: number
  results: SlipVerificationResult[]
  errors?: string[]
}

/**
 * Verify a single slip image using EasySlip API via Edge Function
 * Note: This function expects the file to already be uploaded to storage
 * and the URL to be provided, or it will upload the file first
 */
export async function verifySlipImage(
  imageFile: File,
  imageUrl?: string
): Promise<SlipVerificationResult> {
  try {
    let finalUrl = imageUrl

    // If no URL provided, upload the file first
    if (!finalUrl) {
      const fileExt = imageFile.name.split('.').pop()
      const fileName = `slips/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('slip-images')
        .upload(fileName, imageFile)
      
      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`)
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('slip-images')
        .getPublicUrl(fileName)

      finalUrl = urlData.publicUrl
    }

    // Call Edge Function to verify slip
    const { data, error } = await supabase.functions.invoke('verify-slip', {
      body: { imageUrl: finalUrl }
    })

    if (error) {
      throw error
    }

    return data as SlipVerificationResult
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to verify slip'
    }
  }
}

/**
 * Verify multiple slip images and sum the amounts
 */
export async function verifyMultipleSlips(
  imageFiles: File[]
): Promise<MultipleSlipVerificationResult> {
  const results: SlipVerificationResult[] = []
  const errors: string[] = []
  let totalAmount = 0

  // Loop through each image and verify
  for (const file of imageFiles) {
    const result = await verifySlipImage(file)
    results.push(result)
    
    if (result.success && result.amount) {
      totalAmount += result.amount
    } else {
      errors.push(result.error || 'Unknown error')
    }
  }

  return {
    success: errors.length === 0,
    totalAmount,
    results,
    errors: errors.length > 0 ? errors : undefined
  }
}
