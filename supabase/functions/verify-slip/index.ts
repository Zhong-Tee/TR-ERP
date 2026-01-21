import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EASYSLIP_API_URL = 'https://api.easyslip.com/v1/verify/bank/image'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
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
        amount: data.amount || 0,
        message: data.message || 'Verification completed',
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
        error: error.message || 'Internal server error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
