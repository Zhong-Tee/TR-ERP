import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('No authorization header')

    // Client สำหรับตรวจสอบตัวผู้เรียก
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: callerAuthUser }, error: authErr } = await callerClient.auth.getUser()
    if (authErr || !callerAuthUser) throw new Error('Unauthorized')

    // ตรวจสอบ role ผู้เรียก — superadmin เท่านั้น
    const { data: callerProfile, error: profileErr } = await callerClient
      .from('us_users')
      .select('role')
      .eq('id', callerAuthUser.id)
      .single()

    if (profileErr || callerProfile?.role !== 'superadmin') {
      return new Response(JSON.stringify({ error: 'Permission denied: superadmin only' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { email, password, username, role } = await req.json()
    if (!email) throw new Error('email is required')
    if (!password) throw new Error('password is required')
    if (!role) throw new Error('role is required')

    // Admin client (service role — bypass RLS)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // สร้าง user ใน auth.users
    const { data: newAuthUser, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createErr) throw new Error(createErr.message)

    const newUserId = newAuthUser.user.id

    // สร้าง profile ใน us_users
    const { error: insertErr } = await admin.from('us_users').insert({
      id: newUserId,
      email,
      username: username?.trim() || null,
      role,
      is_active: true,
    })
    if (insertErr) {
      // rollback: ลบ auth user ที่เพิ่งสร้าง
      await admin.auth.admin.deleteUser(newUserId)
      throw new Error(`us_users insert failed: ${insertErr.message}`)
    }

    return new Response(JSON.stringify({ success: true, userId: newUserId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error('[create-user]', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
