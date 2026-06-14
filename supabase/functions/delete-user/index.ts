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

    const { userId } = await req.json()
    if (!userId) throw new Error('userId is required')

    // ป้องกันลบตัวเอง
    if (callerAuthUser.id === userId) {
      return new Response(JSON.stringify({ error: 'ไม่สามารถลบบัญชีตัวเองได้' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Admin client (service role — bypass RLS)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // ป้องกันลบ superadmin คนอื่น
    const { data: targetProfile } = await admin
      .from('us_users')
      .select('role, email')
      .eq('id', userId)
      .single()

    if (targetProfile?.role === 'superadmin') {
      return new Response(JSON.stringify({ error: 'ไม่สามารถลบบัญชี superadmin ได้' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── FK Cleanup: nullable columns → SET NULL ──────────────────────
    const nullableUpdates: { table: string; column: string }[] = [
      { table: 'ac_verified_slips', column: 'verified_by' },
      { table: 'ac_verified_slips', column: 'deleted_by' },
      { table: 'ac_slip_verification_logs', column: 'verified_by' },
      { table: 'wms_return_requisitions', column: 'created_by' },
      { table: 'wms_return_requisitions', column: 'approved_by' },
      { table: 'wms_borrow_requisitions', column: 'created_by' },
      { table: 'wms_borrow_requisitions', column: 'approved_by' },
      { table: 'wms_orders', column: 'assigned_to' },
      { table: 'wms_order_summaries', column: 'picker_id' },
      { table: 'or_order_amendments', column: 'requested_by' },
      { table: 'or_order_amendments', column: 'approved_by' },
      { table: 'or_claim_requests', column: 'submitted_by' },
      { table: 'or_claim_requests', column: 'reviewed_by' },
      { table: 'inv_samples', column: 'testing_started_by' },
      { table: 'inv_samples', column: 'approved_by' },
      { table: 'pp_production_orders', column: 'created_by' },
      { table: 'pp_production_orders', column: 'approved_by' },
      { table: 'pp_production_orders', column: 'rejected_by' },
      { table: 'wh_sub_warehouses', column: 'created_by' },
      { table: 'wh_sub_warehouse_stock_moves', column: 'created_by' },
      { table: 'wms_packing_unit_scans', column: 'scanned_by' },
      { table: 'inv_epoch_opening', column: 'created_by' },
    ]

    for (const { table, column } of nullableUpdates) {
      await admin.from(table).update({ [column]: null }).eq(column, userId)
    }

    // ── FK Cleanup: NOT NULL columns → DELETE rows ───────────────────
    const rowDeletes: { table: string; column: string }[] = [
      { table: 'or_issue_reads', column: 'user_id' },
      { table: 'or_issue_messages', column: 'sender_id' },
      { table: 'or_order_chat_reads', column: 'user_id' },
      { table: 'or_order_chat_logs', column: 'sender_id' },
      { table: 'or_order_reviews', column: 'reviewed_by' },
      { table: 'wms_requisitions', column: 'created_by' },
      { table: 'or_issues', column: 'created_by' },
    ]

    for (const { table, column } of rowDeletes) {
      await admin.from(table).delete().eq(column, userId)
    }

    // ── ลบจาก us_users ───────────────────────────────────────────────
    const { error: usersErr } = await admin.from('us_users').delete().eq('id', userId)
    if (usersErr) throw new Error(`us_users: ${usersErr.message}`)

    // ── ลบจาก auth.users ─────────────────────────────────────────────
    const { error: authDeleteErr } = await admin.auth.admin.deleteUser(userId)
    if (authDeleteErr) throw new Error(`auth.users: ${authDeleteErr.message}`)

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error('[delete-user]', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
