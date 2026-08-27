import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RETENTION_DAYS = 7
const BATCH_SIZE = 100

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size))
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !serviceRoleKey) return json({ error: 'Supabase environment is not configured' }, 500)

    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'Unauthorized' }, 401)

    const admin = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user }, error: authError } = await admin.auth.getUser(token)
    if (authError || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json().catch(() => ({})) as { orphan_path?: string }
    let orphanDeleted = 0

    // If uploading succeeded but inserting hr_time_entries failed, remove that
    // unreferenced object immediately. Never remove a path still referenced by a row.
    const orphanPath = String(body.orphan_path || '').trim()
    if (orphanPath) {
      const { count } = await admin
        .from('hr_time_entries')
        .select('id', { count: 'exact', head: true })
        .eq('photo_url', orphanPath)
      if ((count || 0) === 0) {
        const { error } = await admin.storage.from('hr-time-clock').remove([orphanPath])
        if (!error) orphanDeleted = 1
      }
    }

    // Entries deleted directly, or through ON DELETE CASCADE when an employee
    // is deleted, place their paths in this durable queue via a DB trigger.
    const { data: queuedRows, error: queueError } = await admin
      .from('hr_time_clock_photo_cleanup_queue')
      .select('path')
      .order('queued_at', { ascending: true })
      .limit(1000)
    if (queueError) throw queueError

    let deletedFromQueue = 0
    for (const batch of chunks((queuedRows || []).map((row) => String(row.path)).filter(Boolean), BATCH_SIZE)) {
      const { error } = await admin.storage.from('hr-time-clock').remove(batch)
      if (error) continue
      await admin.from('hr_time_clock_photo_cleanup_queue').delete().in('path', batch)
      deletedFromQueue += batch.length
    }

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    let expiredPhotos = 0
    // Process up to 5,000 on the first deployment so an existing backlog does
    // not need many days to drain; normal daily volume is much smaller.
    for (let pass = 0; pass < 5; pass += 1) {
      const { data: expiredRows, error: expiredError } = await admin
        .from('hr_time_entries')
        .select('id, photo_url')
        .not('photo_url', 'is', null)
        .lt('entry_time', cutoff)
        .order('entry_time', { ascending: true })
        .limit(1000)
      if (expiredError) throw expiredError
      if (!expiredRows?.length) break

      let updatedThisPass = 0
      for (const batch of chunks(expiredRows, BATCH_SIZE)) {
        const paths = batch.map((row) => String(row.photo_url || '')).filter(Boolean)
        if (paths.length === 0) continue
        const { error: removeError } = await admin.storage.from('hr-time-clock').remove(paths)
        if (removeError) continue

        const ids = batch.map((row) => String(row.id))
        const { error: updateError } = await admin
          .from('hr_time_entries')
          .update({ photo_url: null, photo_expired_at: new Date().toISOString() })
          .in('id', ids)
        if (!updateError) {
          expiredPhotos += ids.length
          updatedThisPass += ids.length
        }
      }
      if (updatedThisPass === 0) break
    }

    return json({
      success: true,
      retention_days: RETENTION_DAYS,
      expired_photos: expiredPhotos,
      deleted_from_queue: deletedFromQueue,
      orphan_deleted: orphanDeleted,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})
