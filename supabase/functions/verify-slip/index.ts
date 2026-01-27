import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EASYSLIP_API_URL = 'https://developer.easyslip.com/api/v1/verify'
const MAX_RETRIES = 3
const RETRY_DELAY = 1000 // 1 second

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// Helper function to sleep
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// No need to download - we receive base64 directly from frontend

// Helper function to call Easyslip API with multipart/form-data (file upload)
async function callEasyslipAPIWithFile(
  file: File | Blob,
  apiKey: string,
  retries = MAX_RETRIES
): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Easyslip] Attempt ${attempt}/${retries} - Verifying slip with file upload...`)
      
      // Create multipart/form-data manually for Deno
      const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`
      const fileBuffer = await file.arrayBuffer()
      const fileBytes = new Uint8Array(fileBuffer)
      
      // Build multipart body
      const parts: Uint8Array[] = []
      
      // Add file field
      const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slip.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
      parts.push(new TextEncoder().encode(fileHeader))
      parts.push(fileBytes)
      parts.push(new TextEncoder().encode(`\r\n--${boundary}--\r\n`))
      
      // Combine all parts
      const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
      const body = new Uint8Array(totalLength)
      let offset = 0
      for (const part of parts) {
        body.set(part, offset)
        offset += part.length
      }
      
      const response = await fetch(EASYSLIP_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: body,
      })

      // Try to parse response (even if not ok, to get error details)
      let data
      try {
        const responseText = await response.text()
        if (responseText) {
          data = JSON.parse(responseText)
        } else {
          data = { status: response.status, message: `HTTP ${response.status}` }
        }
      } catch {
        data = { status: response.status, message: `HTTP ${response.status}` }
      }

      if (!response.ok) {
        console.error(`[Easyslip] HTTP ${response.status} error:`, data)
        
        // Don't retry on client errors (4xx) - return error data so we can log it
        if (response.status >= 400 && response.status < 500) {
          // Return error data so Edge Function can include it in response
          const error = new Error(data.message || `EasySlip API error: ${response.status}`)
          ;(error as any).easyslipResponse = data
          throw error
        }
        
        // Retry on server errors (5xx) or network errors
        if (attempt < retries) {
          console.log(`[Easyslip] Retry ${attempt}/${retries} after ${RETRY_DELAY}ms`)
          await sleep(RETRY_DELAY * attempt) // Exponential backoff
          continue
        }
        
        const error = new Error(data.message || `EasySlip API error: ${response.status}`)
        ;(error as any).easyslipResponse = data
        throw error
      }

      console.log(`[Easyslip] Success - Amount: ${data.data?.amount?.amount || data.amount || 0}`)
      return data
    } catch (error: any) {
      console.error(`[Easyslip] Attempt ${attempt}/${retries} failed:`, error.message)
      
      // If it's the last attempt, throw the error
      if (attempt === retries) {
        throw error
      }
      
      // Wait before retrying
      await sleep(RETRY_DELAY * attempt)
    }
  }
  
  throw new Error('Max retries exceeded')
}

// Helper function to call Easyslip API with retry (base64 - legacy)
async function callEasyslipAPI(
  imageBase64: string,
  apiKey: string,
  retries = MAX_RETRIES
): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Easyslip] Attempt ${attempt}/${retries} - Verifying slip with base64 image...`)
      
      const response = await fetch(EASYSLIP_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          image: imageBase64,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        let errorData
        try {
          errorData = JSON.parse(errorText)
        } catch {
          errorData = { message: errorText || `HTTP ${response.status}` }
        }
        
        console.error(`[Easyslip] HTTP ${response.status} error:`, errorData)
        
        // Don't retry on client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw new Error(errorData.message || `EasySlip API error: ${response.status}`)
        }
        
        // Retry on server errors (5xx) or network errors
        if (attempt < retries) {
          console.log(`[Easyslip] Retry ${attempt}/${retries} after ${RETRY_DELAY}ms`)
          await sleep(RETRY_DELAY * attempt) // Exponential backoff
          continue
        }
        
        throw new Error(errorData.message || `EasySlip API error: ${response.status}`)
      }

      const data = await response.json()
      console.log(`[Easyslip] Success - Amount: ${data.data?.amount?.amount || data.amount || 0}`)
      return data
    } catch (error: any) {
      console.error(`[Easyslip] Attempt ${attempt}/${retries} failed:`, error.message)
      
      // If it's the last attempt, throw the error
      if (attempt === retries) {
        throw error
      }
      
      // Wait before retrying
      await sleep(RETRY_DELAY * attempt)
    }
  }
  
  throw new Error('Max retries exceeded')
}

// Helper function to convert blob to base64 (legacy - not used for storage method anymore)
async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const uint8Array = new Uint8Array(arrayBuffer)
  const binaryString = String.fromCharCode(...uint8Array)
  return btoa(binaryString)
}

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:198',message:'Edge Function called',data:{method:req.method,url:req.url},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    console.log('[Edge Function] verify-slip called')
    
    // Log authentication headers for debugging
    const authHeader = req.headers.get('Authorization')
    const apikeyHeader = req.headers.get('apikey')
    console.log('[Edge Function] Auth header present:', !!authHeader)
    console.log('[Edge Function] Apikey header present:', !!apikeyHeader)
    
    // Note: Supabase Edge Functions can be called with or without authentication
    // We'll allow both authenticated and service role access
    
    // Get request body FIRST to check if it's a test request
    // Test requests should be allowed even if secrets are missing
    let requestBody
    try {
      const bodyText = await req.text()
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:214',message:'Request body parsed',data:{bodyTextLength:bodyText?.length||0,hasBody:!!bodyText},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      if (bodyText) {
        requestBody = JSON.parse(bodyText)
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:216',message:'Request body JSON parsed',data:{method:requestBody?.method,hasMethod:!!requestBody?.method},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
      }
    } catch (e) {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:218',message:'Request body parse error',data:{error:String(e)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      console.error('[Edge Function] Error parsing request body:', e)
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid request body',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        }
      )
    }
    
    // Get API key from Supabase secrets
    const easyslipApiKey = Deno.env.get('EASYSLIP_API_KEY')
    console.log('[Edge Function] EASYSLIP_API_KEY present:', !!easyslipApiKey)
    
    // Get Supabase credentials for Storage access
    // Use PROJECT_URL secret (not SUPABASE_URL to avoid reserved prefix)
    // Supabase Edge Functions may have SUPABASE_URL available automatically, but we use PROJECT_URL for consistency
    const supabaseUrl = Deno.env.get('PROJECT_URL') ||
                       Deno.env.get('SUPABASE_URL') || 
                       Deno.env.get('SUPABASE_PROJECT_URL') ||
                       req.headers.get('x-supabase-url') ||
                       'https://zkzjbhvsltbwbtteihiy.supabase.co'
    const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY') || ''
    console.log('[Edge Function] SERVICE_ROLE_KEY present:', !!supabaseServiceKey)
    console.log('[Edge Function] PROJECT_URL present:', !!Deno.env.get('PROJECT_URL'))
    console.log('[Edge Function] Using Supabase URL:', supabaseUrl ? 'configured' : 'not configured')
    
    // For non-test requests, return error if secrets are missing
    // Test requests will handle missing secrets gracefully
    const isTestRequest =
      requestBody &&
      (requestBody.method === 'test' ||
        requestBody.method === 'test-with-image' ||
        requestBody.method === 'test-storage' ||
        requestBody.method === 'me')
    
    if (!isTestRequest) {
      if (!easyslipApiKey) {
        console.error('[Edge Function] EASYSLIP_API_KEY not configured')
        return new Response(
          JSON.stringify({
            success: false,
            error: 'EASYSLIP_API_KEY not configured. Please set it in Supabase Dashboard → Settings → Edge Functions → Secrets',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          }
        )
      }
      
      if (!supabaseServiceKey) {
        console.error('[Edge Function] SERVICE_ROLE_KEY not configured')
        return new Response(
          JSON.stringify({
            success: false,
            error: 'SERVICE_ROLE_KEY not configured. Please set it in Supabase Dashboard → Settings → Edge Functions → Secrets',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          }
        )
      }
    }

    // Handle test-with-image method - test with actual slip image
    if (requestBody && requestBody.method === 'test-with-image') {
      console.log('[Edge Function] Test with image requested')
      
      // Check if secrets are configured
      const hasEasyslipKey = !!easyslipApiKey
      const hasServiceKey = !!supabaseServiceKey
      
      if (!hasEasyslipKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'EASYSLIP_API_KEY not configured',
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: false,
              easyslipApiReachable: false,
              error: 'EASYSLIP_API_KEY not configured',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      // Get image file from request
      const imageBase64 = requestBody.imageBase64
      if (!imageBase64) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'imageBase64 is required for test-with-image method',
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: hasEasyslipKey,
              easyslipApiReachable: false,
              error: 'imageBase64 is required for test-with-image method',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      try {
        // Convert base64 to blob
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
        const binaryString = atob(base64Data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        
        // Call EasySlip API with file
        const data = await callEasyslipAPIWithFile(blob, easyslipApiKey)
        
        // Extract verification data
        const amount = data.data?.amount?.amount || data.amount || 0
        const transRef = data.data?.transRef
        const date = data.data?.date
        const receiverBank = data.data?.receiver?.bank
        const receiverAccount = data.data?.receiver?.account
        
        return new Response(
          JSON.stringify({
            success: true,
            message: 'การตรวจสอบสลิปสำเร็จ',
            amount: amount,
            transRef: transRef,
            date: date,
            receiverBank: receiverBank,
            receiverAccount: receiverAccount,
            data: data.data,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      } catch (error: any) {
        console.error('[Edge Function] EasySlip API call failed:', error.message)
        console.error('[Edge Function] Error stack:', error.stack)
        
        // Provide more detailed error message
        let errorMessage = error.message || 'Unknown error'
        if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
          errorMessage = `EasySlip API Authentication failed (401)\n\nสาเหตุ: API Key อาจไม่ถูกต้องหรือหมดอายุ\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า EASYSLIP_API_KEY ถูกต้อง (ใน Supabase Dashboard → Settings → Edge Functions → Secrets)\n2. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว (ไปที่ https://developer.easyslip.com)\n3. ตรวจสอบว่า API Key ยังใช้งานได้หรือไม่\n4. ลองขอ API Key ใหม่จาก EasySlip Dashboard`
        } else if (errorMessage.includes('403') || errorMessage.includes('access_denied') || errorMessage.includes('forbidden')) {
          errorMessage = `EasySlip API Access denied (403)\n\nสาเหตุ: ไม่มีสิทธิ์เข้าถึง API\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว (ไปที่ https://developer.easyslip.com)\n2. ตรวจสอบว่า Package/Plan ยังใช้งานได้หรือไม่\n3. ตรวจสอบว่ามีการเติมเงินหรือต่ออายุแพ็กเกจหรือไม่\n4. ติดต่อ EasySlip Support: support@easyslip.com`
        } else if (errorMessage.includes('404') || errorMessage.includes('not_found')) {
          errorMessage = `EasySlip API Not Found (404)\n\nสาเหตุ: API endpoint ไม่ถูกต้อง\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า API URL ถูกต้อง: https://developer.easyslip.com/api/v1/verify\n2. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว`
        } else {
          errorMessage = `EasySlip API Error: ${errorMessage}\n\nกรุณาตรวจสอบ:\n1. EasySlip service เปิดใช้งานแล้วหรือไม่\n2. EASYSLIP_API_KEY ถูกต้องหรือไม่\n3. Package/Plan ยังใช้งานได้หรือไม่\n4. ตรวจสอบ Logs ใน Supabase Dashboard → Edge Functions → verify-slip → Logs`
        }
        
        // Return 200 status with error details (like test method) so frontend can display proper error message
        return new Response(
          JSON.stringify({
            success: false,
            error: errorMessage,
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: hasEasyslipKey && hasServiceKey,
              easyslipApiReachable: false,
              error: errorMessage,
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200, // Return 200 so frontend can parse error details
          }
        )
      }
    }

    // Handle test-storage method - upload to Storage then verify
    if (requestBody && requestBody.method === 'test-storage') {
      console.log('[Edge Function] Test with storage requested')

      const hasEasyslipKey = !!easyslipApiKey
      const hasServiceKey = !!supabaseServiceKey

      if (!hasEasyslipKey || !hasServiceKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: !hasEasyslipKey
              ? 'EASYSLIP_API_KEY not configured'
              : 'SERVICE_ROLE_KEY not configured',
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: false,
              easyslipApiReachable: false,
              error: !hasEasyslipKey
                ? 'EASYSLIP_API_KEY not configured'
                : 'SERVICE_ROLE_KEY not configured',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      const storagePath = requestBody.storagePath
      if (!storagePath) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'storagePath is required for test-storage method',
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: hasEasyslipKey && hasServiceKey,
              easyslipApiReachable: false,
              error: 'storagePath is required for test-storage method',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey)
        const [bucket, ...pathParts] = storagePath.split('/')
        const filePath = pathParts.join('/')

        console.log('[Edge Function] Test download from bucket:', bucket, 'path:', filePath)

        const { data: fileData, error: downloadError } = await supabase.storage
          .from(bucket)
          .download(filePath)

        if (downloadError || !fileData) {
          return new Response(
            JSON.stringify({
              success: false,
              error: downloadError?.message || 'Failed to download file from storage',
              message: 'การตรวจสอบสลิปล้มเหลว',
              details: {
                secretsConfigured: true,
                easyslipApiReachable: false,
                error: downloadError?.message || 'Failed to download file from storage',
              },
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 200,
            }
          )
        }

        const data = await callEasyslipAPIWithFile(fileData, easyslipApiKey)
        const amount = data.data?.amount?.amount || data.amount || 0
        const transRef = data.data?.transRef
        const date = data.data?.date
        const receiverBank = data.data?.receiver?.bank
        const receiverAccount = data.data?.receiver?.account

        return new Response(
          JSON.stringify({
            success: true,
            message: 'การตรวจสอบสลิปสำเร็จ',
            amount: amount,
            transRef: transRef,
            date: date,
            receiverBank: receiverBank,
            receiverAccount: receiverAccount,
            data: data.data,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      } catch (error: any) {
        return new Response(
          JSON.stringify({
            success: false,
            error: error.message || 'Failed to verify slip',
            message: 'การตรวจสอบสลิปล้มเหลว',
            details: {
              secretsConfigured: true,
              easyslipApiReachable: false,
              error: error.message || 'Failed to verify slip',
            },
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }
    }

    // Handle test method
    if (requestBody && requestBody.method === 'test') {
      console.log('[Edge Function] Test connection requested')
      
      // Check if secrets are configured
      const hasEasyslipKey = !!easyslipApiKey
      const hasServiceKey = !!supabaseServiceKey
      
      // Try to test EasySlip API connection
      let easyslipReachable = false
      let easyslipError = ''
      
      if (hasEasyslipKey) {
        try {
          // Test with a minimal request (just check if API is reachable)
          const testResponse = await fetch(EASYSLIP_API_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${easyslipApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              image: 'test', // Minimal test payload
            }),
          })
          
          // Even if it fails, if we get a response (not network error), API is reachable
          easyslipReachable = testResponse.status !== 0
          
          if (!testResponse.ok) {
            const errorText = await testResponse.text()
            let errorDetail = errorText.substring(0, 200)
            
            // Provide more helpful error messages
            if (testResponse.status === 401) {
              easyslipError = `EasySlip API Authentication failed (401)\n\nสาเหตุ: API Key อาจไม่ถูกต้องหรือหมดอายุ\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า EASYSLIP_API_KEY ถูกต้อง (ใน Supabase Dashboard → Settings → Edge Functions → Secrets)\n2. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว (ไปที่ https://developer.easyslip.com)\n3. ตรวจสอบว่า API Key ยังใช้งานได้หรือไม่\n4. ลองขอ API Key ใหม่จาก EasySlip Dashboard`
            } else if (testResponse.status === 403) {
              easyslipError = `EasySlip API Access denied (403)\n\nสาเหตุ: ไม่มีสิทธิ์เข้าถึง API\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว (ไปที่ https://developer.easyslip.com)\n2. ตรวจสอบว่า Package/Plan ยังใช้งานได้หรือไม่\n3. ตรวจสอบว่ามีการเติมเงินหรือต่ออายุแพ็กเกจหรือไม่\n4. ติดต่อ EasySlip Support: support@easyslip.com`
            } else if (testResponse.status === 404) {
              easyslipError = `EasySlip API Not Found (404)\n\nสาเหตุ: API endpoint ไม่ถูกต้อง หรือ test payload ไม่ถูกต้อง\n\nหมายเหตุ: Test method ใช้ payload 'test' ซึ่งอาจไม่ถูกต้องตาม EasySlip API\n\nวิธีแก้ไข:\n1. ตรวจสอบว่า API URL ถูกต้อง: https://developer.easyslip.com/api/v1/verify\n2. ตรวจสอบว่า EasySlip service เปิดใช้งานแล้ว\n3. ลองทดสอบด้วยรูปภาพจริงในส่วน "ทดสอบการตรวจสอบสลิปด้วยรูปภาพจริง" ด้านล่าง`
            } else {
              easyslipError = `EasySlip API returned ${testResponse.status}: ${errorDetail}\n\nกรุณาตรวจสอบ:\n1. EasySlip service เปิดใช้งานแล้วหรือไม่\n2. EASYSLIP_API_KEY ถูกต้องหรือไม่\n3. Package/Plan ยังใช้งานได้หรือไม่`
            }
          } else {
            // If response is OK, API is definitely reachable
            easyslipReachable = true
          }
        } catch (error: any) {
          easyslipReachable = false
          easyslipError = error.message || 'Network error connecting to EasySlip API'
        }
      }
      
      // Always return 200 for test method, even if secrets are missing
      // This allows frontend to see the details about what's missing
      return new Response(
        JSON.stringify({
          success: hasEasyslipKey && hasServiceKey && easyslipReachable,
          message: hasEasyslipKey && hasServiceKey && easyslipReachable
            ? 'EasySlip API connection test successful'
            : 'EasySlip API connection test failed',
          details: {
            edgeFunctionReachable: true,
            secretsConfigured: hasEasyslipKey && hasServiceKey,
            easyslipApiReachable: easyslipReachable,
            hasEasyslipKey,
            hasServiceKey,
            error: easyslipError || (!hasEasyslipKey ? 'EASYSLIP_API_KEY not configured' : !hasServiceKey ? 'SERVICE_ROLE_KEY not configured' : undefined)
          },
          // Also include error in top level for easier parsing
          error: easyslipError || (!hasEasyslipKey ? 'EASYSLIP_API_KEY not configured' : !hasServiceKey ? 'SERVICE_ROLE_KEY not configured' : undefined)
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200, // Always 200 for test method
        }
      )
    }

    // Continue with normal request handling
    if (!requestBody) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Request body is required',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        }
      )
    }

    const { method, storagePath, imageBase64, expectedAmount, bankAccount, bankCode } = requestBody || {}
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:623',message:'Extracted method from requestBody',data:{method,hasRequestBody:!!requestBody},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    // Handle method "me" - get EasySlip quota information
    if (method === 'me') {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:626',message:'Method me handler entered',data:{hasApiKey:!!easyslipApiKey},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      console.log('[Edge Function] Get EasySlip quota information requested')
      
      if (!easyslipApiKey) {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:630',message:'EASYSLIP_API_KEY missing',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        console.error('[Edge Function] EASYSLIP_API_KEY not configured for /me method')
        return new Response(
          JSON.stringify({
            success: false,
            error: 'EASYSLIP_API_KEY not configured',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      try {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:644',message:'Calling EasySlip /me endpoint',data:{url:'https://developer.easyslip.com/api/v1/me'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        console.log('[Edge Function] Calling EasySlip /me endpoint...')
        // Call EasySlip /me endpoint
        const meResponse = await fetch('https://developer.easyslip.com/api/v1/me', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${easyslipApiKey}`,
          },
        })

        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:653',message:'EasySlip /me response received',data:{status:meResponse.status,ok:meResponse.ok},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        console.log('[Edge Function] EasySlip /me response status:', meResponse.status)

        if (!meResponse.ok) {
          const errorText = await meResponse.text()
          let errorData
          try {
            errorData = JSON.parse(errorText)
          } catch {
            errorData = { message: errorText || `HTTP ${meResponse.status}` }
          }
          
          // #region agent log
          fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:664',message:'EasySlip /me error response',data:{status:meResponse.status,errorData},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          console.error('[Edge Function] EasySlip /me error:', errorData)
          return new Response(
            JSON.stringify({
              success: false,
              error: errorData.message || `EasySlip API error: ${meResponse.status}`,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 200,
            }
          )
        }

        const meData = await meResponse.json()
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:677',message:'EasySlip /me JSON parsed',data:{hasData:!!meData.data,hasMeData:!!meData,keys:meData?Object.keys(meData):[]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        console.log('[Edge Function] EasySlip /me success, data:', meData)
        
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:680',message:'Returning /me response',data:{success:true,hasDataField:!!meData.data},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        return new Response(
          JSON.stringify({
            success: true,
            data: meData.data,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      } catch (error: any) {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/2fe77463-fda7-4f3b-a785-814209082e75',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'index.ts:691',message:'Exception in /me handler',data:{error:error?.message,stack:error?.stack?.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        console.error('[Edge Function] Error calling EasySlip /me:', error)
        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to get quota information: ${error.message}`,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }
    }

    // Handle method "storage" - download file from Storage
    if (method === 'storage') {
      if (!storagePath) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'storagePath is required when method is "storage"',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 400,
          }
        )
      }

      console.log('[Edge Function] Method: storage, storagePath:', storagePath)

      // Create Supabase client with service role key for Storage access
      const supabase = createClient(supabaseUrl, supabaseServiceKey)

      // Parse bucket and file path
      const [bucket, ...pathParts] = storagePath.split('/')
      const filePath = pathParts.join('/')

      console.log('[Edge Function] Downloading from bucket:', bucket, 'path:', filePath)

      // Download file from Storage
      const { data: fileData, error: downloadError } = await supabase.storage
        .from(bucket)
        .download(filePath)

      if (downloadError || !fileData) {
        console.error('[Edge Function] Download error:', downloadError)
        return new Response(
          JSON.stringify({
            success: false,
            error: downloadError?.message || 'Failed to download file from storage',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      // Call EasySlip API with file (multipart/form-data) - better than base64
      console.log('[Edge Function] Calling EasySlip API with file, size:', fileData.size, 'bytes')
      if (!easyslipApiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'EASYSLIP_API_KEY not configured',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }
      let data
      try {
        data = await callEasyslipAPIWithFile(fileData, easyslipApiKey)
        console.log('[Edge Function] Easyslip API response received')
      } catch (apiError: any) {
        console.error('[Edge Function] Easyslip API call failed:', apiError.message)
        // Include easyslipResponse if available (even on error)
        const easyslipResponse = (apiError as any).easyslipResponse || null
        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to verify slip: ${apiError.message}`,
            details: apiError.message,
            easyslipResponse: easyslipResponse,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      // Extract verification data (use receiver info from EasySlip)
      const amount = data.data?.amount?.amount || data.amount || 0
      const slipAccountNumber =
        data.data?.receiver?.account?.bank?.account ||
        data.data?.accountNumber ||
        data.accountNumber
      const slipBankCode =
        data.data?.receiver?.bank?.id ||
        data.data?.bankCode ||
        data.bankCode

      // Normalize digits and handle masked numbers (xxx)
      const normalizeDigits = (value?: string | null) =>
        (value || '').replace(/\D/g, '')

      // Match bank account numbers by position, ignoring masked digits (x, xxx)
      // Example: "xxx-x-x2973-x" should match "167-8-42973-9" if digits at same positions match
      const matchAccountNumber = (slipAccount: string, expectedAccount: string): boolean => {
        if (!slipAccount || !expectedAccount) return false
        
        // Extract digit positions from both strings (ignoring dashes and x)
        const slipDigits: Array<{char: string, pos: number}> = []
        const expectedDigits: Array<{char: string, pos: number}> = []
        
        // Build digit arrays with positions (ignoring dashes)
        let slipDigitPos = 0
        for (let i = 0; i < slipAccount.length; i++) {
          const char = slipAccount[i].toLowerCase()
          if (char === '-') continue
          if (char === 'x') {
            slipDigitPos++
            continue // Skip x positions
          }
          if (char >= '0' && char <= '9') {
            slipDigits.push({char, pos: slipDigitPos})
            slipDigitPos++
          }
        }
        
        let expectedDigitPos = 0
        for (let i = 0; i < expectedAccount.length; i++) {
          const char = expectedAccount[i]
          if (char === '-') continue
          if (char >= '0' && char <= '9') {
            expectedDigits.push({char, pos: expectedDigitPos})
            expectedDigitPos++
          }
        }
        
        // Check if all slip digits match expected digits at the same positions
        // We only check positions where slip has actual digits (not x)
        for (const slipDigit of slipDigits) {
          // Find corresponding digit in expected at the same position
          const expectedDigit = expectedDigits.find(d => d.pos === slipDigit.pos)
          
          if (!expectedDigit) {
            // Position doesn't exist in expected
            return false
          }
          
          if (expectedDigit.char !== slipDigit.char) {
            // Digit at this position doesn't match
            return false
          }
        }
        
        // All checked positions match
        return true
      }

      // Validate bank account and bank code if provided
      let validationErrors: string[] = []
      let accountNameMatch: boolean | null = null
      let bankCodeMatch: boolean | null = null
      let amountMatch: boolean | null = null
      
      if (bankAccount) {
        if (!slipAccountNumber) {
          validationErrors.push('ไม่พบเลขบัญชีจากสลิป')
          accountNameMatch = false
        } else {
          const matched = matchAccountNumber(slipAccountNumber, bankAccount)
          accountNameMatch = matched
          if (!matched) {
            validationErrors.push(`เลขบัญชีไม่ตรง: ตรวจพบ ${slipAccountNumber} แต่คาดหวัง ${bankAccount}`)
          }
        }
      } else {
        accountNameMatch = null // Not validated
      }
      
      if (bankCode && slipBankCode) {
        bankCodeMatch = slipBankCode === bankCode
        if (!bankCodeMatch) {
          validationErrors.push(`รหัสธนาคารไม่ตรง: ตรวจพบ ${slipBankCode} แต่คาดหวัง ${bankCode}`)
        }
      } else if (bankCode && !slipBankCode) {
        validationErrors.push('ไม่พบรหัสธนาคารจากสลิป')
        bankCodeMatch = false
      } else {
        bankCodeMatch = null // Not validated
      }

      // Validate amount if provided
      if (expectedAmount !== undefined && expectedAmount !== null) {
        const matched = Math.abs(amount - expectedAmount) <= 0.01
        amountMatch = matched
        if (!matched) {
          validationErrors.push(`ยอดเงินไม่ตรง: ตรวจพบ ${amount.toFixed(2)} แต่คาดหวัง ${expectedAmount.toFixed(2)}`)
        }
      } else {
        amountMatch = null // Not validated
      }

      // Prepare response
      const responseData = {
        success: (data.status === 200 || data.success !== false) && validationErrors.length === 0,
        amount: amount,
        message: validationErrors.length > 0 
          ? `ตรวจสอบสำเร็จ แต่พบข้อผิดพลาด: ${validationErrors.join(', ')}`
          : (data.data?.message || data.message || 'Verification completed'),
        validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
        slipAccountNumber,
        slipBankCode,
        easyslipResponse: data,
        data: data.data,
        // Individual validation statuses
        accountNameMatch: accountNameMatch,
        bankCodeMatch: bankCodeMatch,
        amountMatch: amountMatch,
      }

      // Log response for debugging
      console.log('[Edge Function] Returning response:', {
        success: responseData.success,
        amount: responseData.amount,
        hasEasyslipResponse: !!responseData.easyslipResponse,
        easyslipResponseKeys: responseData.easyslipResponse ? Object.keys(responseData.easyslipResponse) : [],
        validationErrors: responseData.validationErrors,
      })

      // Return response with validation results
      return new Response(
        JSON.stringify(responseData),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    }

    // Handle legacy method - direct base64 image
    if (imageBase64 && typeof imageBase64 === 'string') {
      console.log('[Edge Function] Method: base64, size:', imageBase64.length, 'chars')

      if (!easyslipApiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'EASYSLIP_API_KEY not configured',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        )
      }

      // Call EasySlip API with base64 image
      let data
      try {
        data = await callEasyslipAPI(imageBase64, easyslipApiKey)
        console.log('[Edge Function] Easyslip API response received')
      } catch (apiError: any) {
        console.error('[Edge Function] Easyslip API call failed:', apiError.message)
        return new Response(
          JSON.stringify({
            success: false,
            error: `Failed to verify slip: ${apiError.message}`,
            details: apiError.message,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          }
        )
      }

      // Return success response
      const amount = data.data?.amount?.amount || data.amount || 0
      return new Response(
        JSON.stringify({
          success: data.status === 200 || data.success !== false,
          amount: amount,
          message: data.data?.message || data.message || 'Verification completed',
          data: data.data,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      )
    }

    // No valid method provided
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Either method="storage" with storagePath, or imageBase64 must be provided',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  } catch (error: any) {
    console.error('[Edge Function] Unexpected error:', error.message)
    console.error('[Edge Function] Error stack:', error.stack)
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Internal server error',
        details: error.stack || 'No additional details',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
