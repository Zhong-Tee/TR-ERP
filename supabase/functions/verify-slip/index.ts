import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EASYSLIP_API_URL = 'https://api.easyslip.com/v1/verify/bank/image'
<<<<<<< HEAD
const MAX_RETRIES = 3
const RETRY_DELAY = 1000 // 1 second

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Helper function to sleep
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Helper function to call Easyslip API with retry
async function callEasyslipAPI(
  imageUrl: string,
  apiKey: string,
  retries = MAX_RETRIES
): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[Easyslip] Attempt ${attempt}/${retries} - Verifying slip: ${imageUrl.substring(0, 50)}...`)
      
      const response = await fetch(EASYSLIP_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          image_url: imageUrl,
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
      console.log(`[Easyslip] Success - Amount: ${data.amount || 0}`)
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
=======
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
<<<<<<< HEAD
    console.log('[Edge Function] verify-slip called')
    
    // Get API key from Supabase secrets
    const easyslipApiKey = Deno.env.get('EASYSLIP_API_KEY')
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

    // Get image URL from request
    let requestBody
    try {
      requestBody = await req.json()
    } catch (error) {
      console.error('[Edge Function] Invalid JSON in request body:', error)
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid request body. Expected JSON with imageUrl field.',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        }
      )
    }

    const { imageUrl } = requestBody
    if (!imageUrl || typeof imageUrl !== 'string') {
      console.error('[Edge Function] imageUrl is missing or invalid')
      return new Response(
        JSON.stringify({
          success: false,
          error: 'imageUrl is required and must be a string',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        }
      )
    }

    console.log('[Edge Function] Verifying slip with URL:', imageUrl.substring(0, 100))

    // Call EasySlip API with retry logic
    const data = await callEasyslipAPI(imageUrl, easyslipApiKey)

    // Return success response
    return new Response(
      JSON.stringify({
        success: data.success !== false, // Default to true if not explicitly false
=======
    // Get API key from Supabase secrets
    const easyslipApiKey = Deno.env.get('EASYSLIP_API_KEY')
    if (!easyslipApiKey) {
      throw new Error('EASYSLIP_API_KEY not configured')
    }

    // Get image URL from request
    const { imageUrl } = await req.json()
    if (!imageUrl) {
      throw new Error('imageUrl is required')
    }

    // Call EasySlip API
    const response = await fetch(EASYSLIP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${easyslipApiKey}`,
      },
      body: JSON.stringify({
        image_url: imageUrl,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.message || 'EasySlip API error')
    }

    const data = await response.json()

    return new Response(
      JSON.stringify({
        success: data.success || false,
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
        amount: data.amount || 0,
        message: data.message || 'Verification completed',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )
  } catch (error: any) {
<<<<<<< HEAD
    console.error('[Edge Function] Error:', error.message, error.stack)
    
=======
>>>>>>> 5799147c33d410ddc7b97eb4cc2ead5021147208
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Internal server error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
