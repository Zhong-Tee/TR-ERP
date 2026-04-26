import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import JSZip from 'https://esm.sh/jszip@3.10.1'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TRANSACTIONAL_TABLES = [
  'or_claim_requests',
  'pk_packing_unit_scans',
  'inv_gr_item_images',
  'ac_ecommerce_sale_lines',
  'ac_ecommerce_import_batches',
  'pr_machinery_status_events',
  'wh_sub_warehouse_stock_moves',
  'plan_jobs',
  'roll_usage_logs',
  'or_work_orders',
  'or_order_chat_reads',
  'qc_skip_logs',
  'wms_orders',
  'wms_order_summaries',
  'wms_notifications',
  'or_order_reviews',
  'or_order_chat_logs',
  'or_order_amendments',
  'or_order_revisions',
  'or_issue_messages',
  'or_issue_reads',
  'pk_packing_logs',
  'pk_packing_videos',
  'qc_records',
  'ac_verified_slips',
  'ac_refunds',
  'ac_slip_verification_logs',
  'ac_bill_edit_logs',
  'ac_manual_slip_checks',
  'ac_credit_note_items',
  'inv_lot_consumptions',
  'inv_pr_items',
  'inv_po_items',
  'inv_gr_items',
  'inv_audit_count_logs',
  'inv_adjustment_items',
  'inv_return_items',
  'inv_sample_items',
  'wms_requisition_items',
  'wms_return_requisition_items',
  'wms_borrow_requisition_items',
  'pp_production_order_items',
  'or_order_items',
  'or_issues',
  'qc_sessions',
  'ac_credit_notes',
  'inv_stock_lots',
  'inv_stock_movements',
  'inv_stock_balances',
  'inv_audit_items',
  'inv_gr',
  'inv_returns',
  'inv_samples',
  'wms_requisitions',
  'wms_return_requisitions',
  'wms_borrow_requisitions',
  'pp_production_orders',
  'or_orders',
  'inv_audits',
  'inv_po',
  'inv_adjustments',
  'inv_pr',
]

const PRESERVED_GROUPS = {
  hr: [
    'hr_employees',
    'hr_departments',
    'hr_positions',
    'hr_leave_types',
    'hr_contract_templates',
    'hr_document_categories',
    'hr_exams',
    'hr_onboarding_templates',
    'hr_career_tracks',
    'hr_career_levels',
    'hr_assets',
  ],
  settings: [
    'us_users',
    'pr_products',
    'channels',
    'bank_settings',
    'bill_header_settings',
    'st_user_menus',
    'settings_reasons',
    'ac_ecommerce_channels',
    'ac_ecommerce_channel_maps',
    'wh_sub_warehouses',
    'wh_sub_warehouse_products',
    'wh_sub_wms_map_groups',
    'wh_sub_wms_map_spares',
    'wh_sub_wms_map_sources',
  ],
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function countTable(supabaseAdmin: ReturnType<typeof createClient>, tableName: string) {
  const { count, error } = await supabaseAdmin
    .from(tableName)
    .select('*', { count: 'exact', head: true })

  if (error) {
    return { table_name: tableName, row_count: null, error: error.message }
  }

  return { table_name: tableName, row_count: count ?? 0 }
}

async function exportTablePages({
  supabaseAdmin,
  bucketName,
  operationPrefix,
  tableName,
  pageSize,
  zip,
}: {
  supabaseAdmin: ReturnType<typeof createClient>
  bucketName: string
  operationPrefix: string
  tableName: string
  pageSize: number
  zip?: JSZip
}) {
  const files: Array<{ path: string; rows: number }> = []
  let page = 0

  while (true) {
    const from = page * pageSize
    const to = from + pageSize - 1
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select('*')
      .range(from, to)

    if (error) {
      return { table_name: tableName, success: false, error: error.message, files }
    }

    const rows = data ?? []
    if (rows.length === 0 && page > 0) break

    const relativePath = `tables/${tableName}/page-${String(page + 1).padStart(4, '0')}.json`
    const filePath = `${operationPrefix}/${relativePath}`
    const jsonText = JSON.stringify(rows, null, 2)
    const blob = new Blob([jsonText], { type: 'application/json' })
    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(filePath, blob, {
        contentType: 'application/json',
        upsert: true,
      })

    if (uploadError) {
      return { table_name: tableName, success: false, error: uploadError.message, files }
    }

    zip?.file(relativePath, jsonText)
    files.push({ path: filePath, rows: rows.length })
    if (rows.length < pageSize) break
    page += 1
  }

  return {
    table_name: tableName,
    success: true,
    total_rows: files.reduce((sum, file) => sum + file.rows, 0),
    files,
  }
}

async function downloadJsonFromStorage(
  supabaseAdmin: ReturnType<typeof createClient>,
  bucketName: string,
  path: string,
) {
  const { data, error } = await supabaseAdmin.storage.from(bucketName).download(path)
  if (error) throw new Error(`Storage download failed (${path}): ${error.message}`)

  const text = await data.text()
  return JSON.parse(text)
}

function getManifestPath(operation: Record<string, unknown>) {
  const summary = (operation.summary || {}) as Record<string, unknown>
  const manifest = (summary.backup_manifest || {}) as Record<string, unknown>
  const storage = (manifest.storage || {}) as Record<string, unknown>
  const manifestPath = String(storage.manifest_path || '')
  if (manifestPath) return manifestPath

  const operationType = String(operation.operation_type || '')
  const targetYear = operation.target_year ? String(operation.target_year) : 'manual'
  const operationId = String(operation.id || '')
  if (!operationType || !operationId) return ''

  return `${operationType}/${targetYear}/${operationId}/manifest.json`
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405)
  }

  try {
    const supabaseUrl = Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY') || ''
    const bucketName = Deno.env.get('ERP_BACKUP_BUCKET') || 'erp-data-backups'
    const pageSize = Number(Deno.env.get('ERP_BACKUP_PAGE_SIZE') || '1000')

    if (!supabaseUrl || !supabaseServiceKey) {
      return jsonResponse({ success: false, error: 'Supabase secrets not configured' }, 500)
    }

    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return jsonResponse({ success: false, error: 'Missing Authorization header' }, 401)
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !authData.user) {
      return jsonResponse({ success: false, error: authError?.message || 'Unauthorized' }, 401)
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('us_users')
      .select('role')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (profileError) throw profileError
    if (profile?.role !== 'superadmin') {
      return jsonResponse({ success: false, error: 'ต้องใช้สิทธิ์ superadmin เท่านั้น' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const action = String(body.action || 'create_backup')

    if (action === 'list_backups') {
      const { data, error } = await supabaseAdmin
        .from('erp_data_operations')
        .select('id, operation_type, target_year, status, requested_by, requested_at, backup_verified_at, summary')
        .not('backup_verified_at', 'is', null)
        .order('backup_verified_at', { ascending: false })
        .limit(50)

      if (error) throw error

      const backups = (data ?? []).map((operation) => {
        const manifestPath = getManifestPath(operation)
        const manifest = ((operation.summary || {}).backup_manifest || {}) as Record<string, unknown>
        const exportedTables = Array.isArray(manifest.exported_tables) ? manifest.exported_tables : []

        return {
          id: operation.id,
          operation_type: operation.operation_type,
          target_year: operation.target_year,
          status: operation.status,
          requested_by: operation.requested_by,
          requested_at: operation.requested_at,
          backup_verified_at: operation.backup_verified_at,
          manifest_path: manifestPath,
          exported_table_count: exportedTables.length,
        }
      })

      return jsonResponse({ success: true, backups })
    }

    const operationId = String(body.operation_id || '')
    if (!operationId) {
      return jsonResponse({ success: false, error: 'Missing operation_id' }, 400)
    }

    const { data: operation, error: opError } = await supabaseAdmin
      .from('erp_data_operations')
      .select('*')
      .eq('id', operationId)
      .single()

    if (opError) throw opError
    if (!operation) {
      return jsonResponse({ success: false, error: 'Operation not found' }, 404)
    }

    if (action === 'get_manifest') {
      const manifestPath = getManifestPath(operation)
      if (!manifestPath) {
        return jsonResponse({ success: false, error: 'Manifest path not found' })
      }

      const manifest = await downloadJsonFromStorage(supabaseAdmin, bucketName, manifestPath)
      return jsonResponse({ success: true, manifest })
    }

    if (action === 'get_table_page') {
      const tableName = String(body.table_name || '')
      const pageIndex = Number(body.page_index || 0)
      if (!tableName) {
        return jsonResponse({ success: false, error: 'Missing table_name' }, 400)
      }

      const manifestPath = getManifestPath(operation)
      if (!manifestPath) {
        return jsonResponse({ success: false, error: 'Manifest path not found' })
      }

      const manifest = await downloadJsonFromStorage(supabaseAdmin, bucketName, manifestPath) as Record<string, unknown>
      const exportedTables = Array.isArray(manifest.exported_tables) ? manifest.exported_tables : []
      const tableExport = exportedTables.find((entry) => {
        const item = entry as Record<string, unknown>
        return item.table_name === tableName
      }) as Record<string, unknown> | undefined

      if (!tableExport) {
        return jsonResponse({ success: false, error: 'Table not found in manifest' })
      }

      if (tableExport.success === false) {
        return jsonResponse({
          success: false,
          error: String(tableExport.error || 'Table export failed'),
          table_export: tableExport,
        })
      }

      const files = Array.isArray(tableExport.files) ? tableExport.files : []
      const file = files[pageIndex] as Record<string, unknown> | undefined
      const filePath = String(file?.path || '')
      if (!filePath) {
        return jsonResponse({ success: false, error: 'Page not found' })
      }

      const rows = await downloadJsonFromStorage(supabaseAdmin, bucketName, filePath)
      return jsonResponse({
        success: true,
        operation_id: operationId,
        table_name: tableName,
        page_index: pageIndex,
        page_count: files.length,
        file_path: filePath,
        rows,
      })
    }

    if (action !== 'create_backup') {
      return jsonResponse({ success: false, error: 'Unknown action' }, 400)
    }

    await supabaseAdmin
      .from('erp_data_operations')
      .update({ status: 'backup_running', backup_started_at: new Date().toISOString(), error_message: null })
      .eq('id', operationId)

    const transactionalCounts = await Promise.all(
      TRANSACTIONAL_TABLES.map((tableName) => countTable(supabaseAdmin, tableName)),
    )

    const preservedCounts: Record<string, unknown[]> = {}
    for (const [groupName, tables] of Object.entries(PRESERVED_GROUPS)) {
      preservedCounts[groupName] = await Promise.all(
        tables.map((tableName) => countTable(supabaseAdmin, tableName)),
      )
    }

    const uniqueTables = Array.from(new Set([
      ...TRANSACTIONAL_TABLES,
      ...Object.values(PRESERVED_GROUPS).flat(),
    ]))
    const operationPrefix = `${operation.operation_type}/${operation.target_year || 'manual'}/${operationId}`
    const manifestPath = `${operationPrefix}/manifest.json`
    const zipPath = `${operationPrefix}/archive.zip`
    const exportedTables = []
    const zip = new JSZip()

    const { data: buckets } = await supabaseAdmin.storage.listBuckets()
    if (!buckets?.some((bucket) => bucket.name === bucketName)) {
      const { error: createBucketError } = await supabaseAdmin.storage.createBucket(bucketName, {
        public: false,
      })
      if (createBucketError) {
        throw new Error(`Backup bucket creation failed: ${createBucketError.message}`)
      }
    }

    for (const tableName of uniqueTables) {
      exportedTables.push(await exportTablePages({
        supabaseAdmin,
        bucketName,
        operationPrefix,
        tableName,
        pageSize,
        zip,
      }))
    }

    const manifest = {
      success: true,
      kind: 'erp-data-backup-manifest',
      operation_id: operationId,
      operation_type: operation.operation_type,
      target_year: operation.target_year,
      created_at: new Date().toISOString(),
      created_by: authData.user.id,
      note: 'This is an application-level JSON backup. Use Supabase platform/database dump for full physical restore.',
      transactional_tables: transactionalCounts,
      preserved_tables: preservedCounts,
      exported_tables: exportedTables,
      hr_policy: {
        preserve_default: true,
        message: 'HR data is preserved by backup/clear operations unless a future dedicated HR option is explicitly added.',
      },
      storage: {
        bucket: bucketName,
        object_prefix: operationPrefix,
        manifest_path: manifestPath,
        zip_path: zipPath,
      },
    }

    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], {
      type: 'application/json',
    })

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(manifestPath, manifestBlob, {
        contentType: 'application/json',
        upsert: true,
      })

    if (uploadError) {
      throw new Error(`Backup manifest upload failed: ${uploadError.message}`)
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2))

    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })

    const { error: zipUploadError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(zipPath, zipBlob, {
        contentType: 'application/zip',
        upsert: true,
      })

    if (zipUploadError) {
      throw new Error(`Backup ZIP upload failed: ${zipUploadError.message}`)
    }

    const { data: signedUrlData } = await supabaseAdmin.storage
      .from(bucketName)
      .createSignedUrl(zipPath, 60 * 60)

    const { error: markError } = await supabaseAdmin.rpc('rpc_data_operation_mark_backup_verified', {
      p_operation_id: operationId,
      p_manifest: manifest,
    })

    if (markError) throw markError

    return jsonResponse({
      success: true,
      operation_id: operationId,
      manifest_path: manifestPath,
      zip_path: zipPath,
      zip_signed_url: signedUrlData?.signedUrl || null,
      transactional_table_count: transactionalCounts.length,
      warning: manifest.note,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ success: false, error: message })
  }
})
