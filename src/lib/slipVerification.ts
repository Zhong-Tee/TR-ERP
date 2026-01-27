/**
 * Slip Verification API Functions
 * 
 * Functions for uploading slips to Supabase Storage and verifying them
 * using the Edge Function with storage method
 */

import { supabase } from './supabase'

/**
 * Get EasySlip quota information from /me endpoint
 * @returns Quota information including used, max, remaining, expiredAt, and currentCredit
 */
export async function getEasySlipQuota(): Promise<{
  success: boolean
  data?: {
    application: string
    usedQuota: number
    maxQuota: number
    remainingQuota: number
    expiredAt: string
    currentCredit: number
  }
  error?: string
}> {
  // Get session for authentication
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return {
      success: false,
      error: 'กรุณาเข้าสู่ระบบก่อน',
    }
  }

  try {
    console.log('[getEasySlipQuota] Calling Edge Function with method "me"')
    // Call Edge Function with 'me' method
    const { data, error } = await supabase.functions.invoke('verify-slip', {
      body: {
        method: 'me',
      },
    })

    console.log('[getEasySlipQuota] Edge Function response:', { data, error })

    if (error) {
      let errorMessage = error.message || `HTTP ${error.status || 'unknown'}: ${error.name || 'Unknown error'}`
      
      // Handle 401 specifically
      if (error.status === 401 || errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        errorMessage = 'การยืนยันตัวตนล้มเหลว - กรุณาตรวจสอบว่า Access Token ถูกต้อง'
      }
      
      console.error('[getEasySlipQuota] Error from Edge Function:', errorMessage)
      return {
        success: false,
        error: errorMessage,
      }
    }

    // Check if data contains error (Edge Function returns 200 with error in body)
    if (data && data.success === false) {
      console.error('[getEasySlipQuota] Edge Function returned success: false:', data.error || data.message)
      return {
        success: false,
        error: data.error || data.message || 'Unknown error',
      }
    }

    if (!data || !data.data) {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'slipVerification.ts:70',message:'No data in response',data:{hasData:!!data,hasDataData:!!data?.data,dataStructure:data?JSON.stringify(data).substring(0,200):'null'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      console.error('[getEasySlipQuota] No data in response:', data)
      return {
        success: false,
        error: 'No data received from Edge Function',
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'slipVerification.ts:78',message:'Success - returning quota data',data:{hasDataData:!!data.data,dataDataKeys:data.data?Object.keys(data.data):[]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    console.log('[getEasySlipQuota] Success, quota data:', data.data)
    return {
      success: true,
      data: data.data,
    }
  } catch (error: any) {
    console.error('[getEasySlipQuota] Exception:', error)
    return {
      success: false,
      error: error.message || 'เกิดข้อผิดพลาดในการเรียก API',
    }
  }
}

async function extractInvokeErrorMessage(error: any): Promise<string> {
  const context = error?.context
  if (!context) return ''

  try {
    if (typeof context.text === 'function') {
      const text = await context.text()
      try {
        const parsed = JSON.parse(text)
        return parsed.error || parsed.message || text
      } catch {
        return text
      }
    }

    if (context.body) {
      if (typeof context.body === 'string') return context.body
      try {
        return JSON.stringify(context.body)
      } catch {
        return String(context.body)
      }
    }
  } catch {
    return ''
  }

  return ''
}

/**
 * Upload file to Supabase Storage bucket
 * @param file - File to upload
 * @param bucket - Bucket name (default: 'slip-images')
 * @param folderPath - Optional folder path within bucket
 * @returns Storage path (bucket/path/to/file)
 */
export async function uploadToStorage(
  file: File,
  bucket: string = 'slip-images',
  folderPath?: string
): Promise<string> {
  // Generate unique filename
  const fileExt = file.name.split('.').pop() || 'jpg'
  const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`
  const filePath = folderPath ? `${folderPath}/${fileName}` : fileName

  // Upload file to Supabase Storage
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || `image/${fileExt}`,
    })

  if (error) {
    throw new Error(error.message || 'Failed to upload file to storage')
  }

  // Return storage path in format: bucket/path/to/file
  return `${bucket}/${data.path}`
}

/**
 * Verify slip from Storage using Edge Function
 * @param storagePath - Storage path (format: bucket/path/to/file)
 * @param expectedAmount - Expected amount to verify against
 * @param bankAccount - Bank account number to verify
 * @param bankCode - Bank code to verify
 * @returns Verification result
 */
export async function verifySlipFromStorage(
  storagePath: string,
  expectedAmount?: number,
  bankAccount?: string,
  bankCode?: string
): Promise<{
  success: boolean
  amount?: number
  message?: string
  error?: string
  data?: any
  easyslipResponse?: any
}> {
  // No need to check environment variables - supabase client is already initialized

  // Get session for authentication
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('กรุณาเข้าสู่ระบบก่อนตรวจสอบสลิป')
  }

  // Use supabase.functions.invoke() instead of fetch for better authentication handling
  const { data, error } = await supabase.functions.invoke('verify-slip', {
    body: {
      method: 'storage',
      storagePath,
      expectedAmount,
      bankAccount,
      bankCode,
    },
  })

  if (error) {
    let errorMessage = error.message || `HTTP ${error.status || 'unknown'}: ${error.name || 'Unknown error'}`
    
    // Handle 401 specifically with better error message
    if (error.status === 401 || errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      errorMessage = `การยืนยันตัวตนล้มเหลว (HTTP 401)\n\nสาเหตุ: ${errorMessage}\n\nวิธีแก้ไข:\n1. ลองออกจากระบบและเข้าสู่ระบบใหม่\n2. ตรวจสอบว่า Session token ยังใช้งานได้ (ไม่หมดอายุ)\n3. ตรวจสอบว่า Edge Function ตั้งค่า Secrets ถูกต้องแล้ว\n   - EASYSLIP_API_KEY\n   - SERVICE_ROLE_KEY\n   - PROJECT_URL\n4. ตรวจสอบ Logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs`
    }
    
    throw new Error(errorMessage)
  }

  // Return data directly (supabase.functions.invoke already handles JSON parsing)
  return data
}

/**
 * Upload multiple files and return storage paths
 * @param files - Array of files to upload
 * @param bucket - Bucket name (default: 'slip-images')
 * @param folderPath - Optional folder path within bucket
 * @returns Array of storage paths
 */
export async function uploadMultipleToStorage(
  files: File[],
  bucket: string = 'slip-images',
  folderPath?: string
): Promise<string[]> {
  const paths: string[] = []
  
  for (const file of files) {
    try {
      const path = await uploadToStorage(file, bucket, folderPath)
      paths.push(path)
    } catch (error: any) {
      console.error(`Failed to upload ${file.name}:`, error)
      throw new Error(`ไม่สามารถอัปโหลดไฟล์ ${file.name}: ${error.message}`)
    }
  }
  
  return paths
}

/**
 * Verify multiple slips from Storage
 * @param storagePaths - Array of storage paths
 * @param expectedAmount - Expected total amount
 * @param bankAccount - Bank account number to verify
 * @param bankCode - Bank code to verify
 * @returns Array of verification results
 */
export async function verifyMultipleSlipsFromStorage(
  storagePaths: string[],
  expectedAmount?: number,
  bankAccount?: string,
  bankCode?: string
): Promise<Array<{
  storagePath: string
  success: boolean
  amount?: number
  message?: string
  error?: string
  easyslipResponse?: any
}>> {
  const results = []
  
  for (const storagePath of storagePaths) {
    try {
      const result = await verifySlipFromStorage(
        storagePath,
        expectedAmount,
        bankAccount,
        bankCode
      )
      
      // Log full response for debugging
      console.log(`[verifyMultipleSlipsFromStorage] Response for ${storagePath}:`, {
        success: result.success,
        amount: result.amount,
        message: result.message,
        error: result.error,
        hasEasyslipResponse: !!result.easyslipResponse,
        easyslipResponse: result.easyslipResponse,
      })
      
      results.push({
        storagePath,
        ...result,
      })
    } catch (error: any) {
      let errorMessage = error.message || 'เกิดข้อผิดพลาดในการตรวจสอบสลิป'
      
      // Improve error message for common issues
      if (errorMessage.includes('HTTP 401') || errorMessage.includes('Invalid JWT')) {
        errorMessage = `การยืนยันตัวตนล้มเหลว\n\nวิธีแก้ไข:\n1. ลองออกจากระบบและเข้าสู่ระบบใหม่\n2. ตรวจสอบว่า Session token ยังใช้งานได้\n3. ตรวจสอบว่า Edge Function ตั้งค่า Secrets ถูกต้องแล้ว`
      } else if (errorMessage.includes('EASYSLIP_API_KEY') || errorMessage.includes('SERVICE_ROLE_KEY')) {
        errorMessage = `Secrets ยังไม่ได้ตั้งค่า\n\nกรุณาตั้งค่าใน Supabase Dashboard:\n- Settings → Edge Functions → Secrets\n- EASYSLIP_API_KEY\n- SERVICE_ROLE_KEY`
      }
      
      console.error(`[verifyMultipleSlipsFromStorage] Error for ${storagePath}:`, error)
      
      results.push({
        storagePath,
        success: false,
        error: errorMessage,
        // Try to extract easyslipResponse from error if available
        easyslipResponse: (error as any).easyslipResponse || null,
      })
    }
  }
  
  return results
}

/**
 * Test EasySlip API connection
 * @returns Connection test result
 */
export async function testEasySlipConnection(): Promise<{
  success: boolean
  message: string
  details?: {
    edgeFunctionReachable: boolean
    secretsConfigured: boolean
    easyslipApiReachable: boolean
    error?: string
  }
}> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      success: false,
      message: 'Missing Supabase environment variables',
      details: {
        edgeFunctionReachable: false,
        secretsConfigured: false,
        easyslipApiReachable: false,
        error: 'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY not configured'
      }
    }
  }

  // Get session for authentication
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return {
      success: false,
      message: 'กรุณาเข้าสู่ระบบก่อนทดสอบการเชื่อมต่อ',
      details: {
        edgeFunctionReachable: false,
        secretsConfigured: false,
        easyslipApiReachable: false,
        error: 'No active session'
      }
    }
  }

  try {
    // Test 1: Check if Edge Function is reachable using supabase.functions.invoke()
    const { data: testData, error: testError } = await supabase.functions.invoke('verify-slip', {
      body: {
        method: 'test',
      },
    })

    // Log for debugging
    console.log('[testEasySlipConnection] testError:', testError)
    console.log('[testEasySlipConnection] testData:', testData)

    // Edge Function is reachable if we got a response (even if error)
    // We'll determine this based on error status
    let edgeFunctionReachable = true // Default to true, will be set based on error

    // Try to get response to check for secrets
    let secretsConfigured = false
    let easyslipApiReachable = false
    let errorMessage = ''

    // Check if we got an error response
    if (testError) {
      // If there's an error, try to extract information
      const errorStatus = testError.status || (testError as any).code
      const errorMsg = testError.message || (testError as any).message || 'Unknown error'
      
      // Try to parse error context if available
      const contextMessage = await extractInvokeErrorMessage(testError)
      
      console.log('[testEasySlipConnection] Error details:', {
        status: errorStatus,
        message: errorMsg,
        contextMessage,
        fullError: testError
      })
      
      if (errorStatus === 401) {
        errorMessage = 'Authentication failed - check session token. ลองออกจากระบบและเข้าสู่ระบบใหม่'
        edgeFunctionReachable = true // Function is reachable, just auth failed
        // 401 doesn't mean secrets are missing, just auth failed
        secretsConfigured = true // Assume secrets might be configured
      } else if (errorStatus === 500) {
        // 500 error - could be missing secrets or other error
        // Check error message for secret-related errors
        if (errorMsg.includes('EASYSLIP_API_KEY') || errorMsg.includes('SERVICE_ROLE_KEY') || 
            errorMsg.includes('not configured') || errorMsg.includes('not set')) {
          secretsConfigured = false
          errorMessage = errorMsg || 'Secrets not configured'
        } else {
          errorMessage = 'Edge Function error - check logs'
          secretsConfigured = true // Assume secrets might be configured but there's an error
        }
        edgeFunctionReachable = true
      } else if (errorStatus === 404) {
        errorMessage = 'Edge Function not found - check deployment'
        edgeFunctionReachable = false
        secretsConfigured = false
      } else {
        // Other errors - try to parse error message
        errorMessage = errorMsg
        edgeFunctionReachable = errorStatus !== 404
        // If error message mentions secrets, they're not configured
        if (errorMsg.includes('EASYSLIP_API_KEY') || errorMsg.includes('SERVICE_ROLE_KEY') ||
            errorMsg.includes('not configured') || errorMsg.includes('not set')) {
          secretsConfigured = false
        } else {
          // For other errors, assume secrets might be configured
          secretsConfigured = true
        }
      }

      if (contextMessage) {
        errorMessage = `${errorMessage}\n\nรายละเอียดจาก Edge Function: ${contextMessage}`
      }
    } else if (testData) {
      // Got successful response
      edgeFunctionReachable = true
      
      // PRIORITY: Check details first - this is the most reliable source
      if (testData.details) {
        // Use details.secretsConfigured as the primary source
        if (testData.details.secretsConfigured !== undefined) {
          secretsConfigured = testData.details.secretsConfigured === true
        }
        if (testData.details.easyslipApiReachable !== undefined) {
          easyslipApiReachable = testData.details.easyslipApiReachable === true
        }
        if (testData.details.error) {
          errorMessage = testData.details.error
        }
        
        // Also check hasEasyslipKey and hasServiceKey if available (more reliable)
        if (testData.details.hasEasyslipKey !== undefined && testData.details.hasServiceKey !== undefined) {
          secretsConfigured = testData.details.hasEasyslipKey && testData.details.hasServiceKey
        }
      }
      
      // Fallback: Check top-level error
      if (testData.error && !errorMessage) {
        if (testData.error.includes('EASYSLIP_API_KEY') || testData.error.includes('SERVICE_ROLE_KEY') ||
            testData.error.includes('not configured') || testData.error.includes('not set')) {
          secretsConfigured = false
          errorMessage = testData.error
        } else if (testData.error.includes('EasySlip')) {
          // Edge Function is reachable and secrets are configured, but EasySlip API might have issues
          if (secretsConfigured === undefined) secretsConfigured = true
          easyslipApiReachable = false
          errorMessage = testData.error
        } else {
          // Other errors - assume secrets are configured
          if (secretsConfigured === undefined) secretsConfigured = true
          errorMessage = testData.error
        }
      }
      
      // Fallback: If we still don't know, check success/message
      if (secretsConfigured === undefined) {
        if (testData.success !== undefined || testData.message) {
          // Got a response, assume secrets are configured
          secretsConfigured = true
          if (testData.message && testData.message.includes('EasySlip')) {
            easyslipApiReachable = true
          }
        }
      }
    }

    const allChecksPassed = edgeFunctionReachable && secretsConfigured && easyslipApiReachable

    return {
      success: allChecksPassed,
      message: allChecksPassed 
        ? 'การเชื่อมต่อ EasySlip API สำเร็จ ✅'
        : `การเชื่อมต่อมีปัญหา:\n${!edgeFunctionReachable ? '- Edge Function ไม่สามารถเข้าถึงได้\n' : ''}${!secretsConfigured ? '- Secrets ยังไม่ได้ตั้งค่า (EASYSLIP_API_KEY, SERVICE_ROLE_KEY)\n' : ''}${!easyslipApiReachable && secretsConfigured ? '- EasySlip API ไม่สามารถเข้าถึงได้\n' : ''}`,
      details: {
        edgeFunctionReachable,
        secretsConfigured,
        easyslipApiReachable,
        error: errorMessage || undefined
      }
    }
  } catch (error: any) {
    return {
      success: false,
      message: `เกิดข้อผิดพลาดในการทดสอบ: ${error.message}`,
      details: {
        edgeFunctionReachable: false,
        secretsConfigured: false,
        easyslipApiReachable: false,
        error: error.message
      }
    }
  }
}

/**
 * Test EasySlip API with actual slip image
 * @param imageFile - Image file to test
 * @returns Verification result
 */
export async function testEasySlipWithImage(
  imageFile: File
): Promise<{
  success: boolean
  message: string
  amount?: number
  transRef?: string
  date?: string
  receiverBank?: any
  receiverAccount?: any
  data?: any
  error?: string
}> {
  // Get session for authentication
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    return {
      success: false,
      message: 'กรุณาเข้าสู่ระบบก่อนทดสอบ',
      error: 'No active session',
    }
  }

  try {
    // Upload to Storage first to avoid large base64 payloads
    const storagePath = await uploadToStorage(imageFile, 'slip-images', 'test-slips')

    // Call Edge Function with test-storage method
    const { data, error } = await supabase.functions.invoke('verify-slip', {
      body: {
        method: 'test-storage',
        storagePath,
      },
    })

    if (error) {
      let errorMessage = error.message || `HTTP ${error.status || 'unknown'}: ${error.name || 'Unknown error'}`
      const contextMessage = await extractInvokeErrorMessage(error)
      
      // Handle specific error cases
      if (error.status === 401 || errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        errorMessage = 'การยืนยันตัวตนล้มเหลว - ลองออกจากระบบและเข้าสู่ระบบใหม่'
      } else if (error.status === 500) {
        // Try to get more details from error
        if (errorMessage.includes('EASYSLIP_API_KEY')) {
          errorMessage = 'EASYSLIP_API_KEY ยังไม่ได้ตั้งค่า - กรุณาตั้งค่าใน Supabase Dashboard'
        } else if (errorMessage.includes('Authentication failed')) {
          errorMessage = 'EasySlip API Authentication failed - ตรวจสอบว่า EASYSLIP_API_KEY ถูกต้อง'
        } else if (errorMessage.includes('Access denied')) {
          errorMessage = 'EasySlip API Access denied - ตรวจสอบว่า service เปิดใช้งานแล้วและ Package/Plan ยังใช้งานได้'
        } else {
          errorMessage = `Edge Function error: ${errorMessage}\n\nกรุณาตรวจสอบ Logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs`
        }
      } else if (error.status === 400) {
        errorMessage = `Invalid request: ${errorMessage}`
      }
      
      if (contextMessage) {
        errorMessage = `${errorMessage}\n\nรายละเอียดจาก Edge Function: ${contextMessage}`
      }

      return {
        success: false,
        message: 'การตรวจสอบสลิปล้มเหลว',
        error: errorMessage,
      }
    }

    // Check if data contains error (Edge Function returns 200 with error in body)
    if (data && data.success === false) {
      return {
        success: false,
        message: data.message || 'การตรวจสอบสลิปล้มเหลว',
        error: data.error || data.details?.error || 'Unknown error',
      }
    }

    return {
      success: data.success !== false,
      message: data.message || 'การตรวจสอบสลิปสำเร็จ',
      amount: data.amount,
      transRef: data.transRef,
      date: data.date,
      receiverBank: data.receiverBank,
      receiverAccount: data.receiverAccount,
      data: data.data,
    }
  } catch (error: any) {
    return {
      success: false,
      message: `เกิดข้อผิดพลาด: ${error.message}`,
      error: error.message,
    }
  }
}
