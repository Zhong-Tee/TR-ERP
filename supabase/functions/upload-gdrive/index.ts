import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------------------------------------------------------------------------
// Google Service-Account JWT  →  access_token
// ---------------------------------------------------------------------------

function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/[\r\n\s]/g, '')
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

async function getGoogleAccessToken(
  email: string,
  privateKeyPem: string,
): Promise<string> {
  const keyData = pemToArrayBuffer(privateKeyPem)
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  )

  const sigInput = new TextEncoder().encode(`${header}.${payload}`)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, sigInput)
  const jwt = `${header}.${payload}.${base64url(signature)}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token exchange failed (${res.status}): ${text}`)
  }

  const data = await res.json()
  return data.access_token as string
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------

async function findOrCreateFolder(
  name: string,
  parentId: string,
  accessToken: string,
): Promise<string> {
  const query = encodeURIComponent(
    `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  )
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (searchRes.ok) {
    const { files } = await searchRes.json()
    if (files && files.length > 0) return files[0].id as string
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  if (!createRes.ok) {
    const text = await createRes.text()
    throw new Error(`Failed to create folder "${name}": ${text}`)
  }
  const folder = await createRes.json()
  return folder.id as string
}

async function uploadFileToDrive(
  blob: Blob,
  fileName: string,
  parentFolderId: string,
  accessToken: string,
): Promise<{ id: string; webViewLink: string }> {
  const metadata = JSON.stringify({
    name: fileName,
    parents: [parentFolderId],
  })

  const boundary = '----EdgeFnBoundary' + crypto.randomUUID().replace(/-/g, '')
  const metaPart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
  const filePart = `--${boundary}\r\nContent-Type: ${blob.type || 'video/webm'}\r\n\r\n`
  const closing = `\r\n--${boundary}--`

  const body = new Blob([metaPart, filePart, blob, closing])

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Drive upload failed (${res.status}): ${text}`)
  }

  return (await res.json()) as { id: string; webViewLink: string }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ---- env / secrets ----
    const gdriveEmail = Deno.env.get('GDRIVE_SERVICE_ACCOUNT_EMAIL') || ''
    const gdriveKey = (Deno.env.get('GDRIVE_PRIVATE_KEY') || '').replace(/\\n/g, '\n')
    const gdriveFolderId = Deno.env.get('GDRIVE_FOLDER_ID') || ''
    const supabaseUrl =
      Deno.env.get('PROJECT_URL') || Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SERVICE_ROLE_KEY') || ''

    if (!gdriveEmail || !gdriveKey || !gdriveFolderId) {
      return jsonResponse(
        { success: false, error: 'Google Drive secrets not configured (GDRIVE_SERVICE_ACCOUNT_EMAIL, GDRIVE_PRIVATE_KEY, GDRIVE_FOLDER_ID)' },
        500,
      )
    }
    if (!supabaseUrl || !supabaseServiceKey) {
      return jsonResponse(
        { success: false, error: 'Supabase secrets not configured (PROJECT_URL, SERVICE_ROLE_KEY)' },
        500,
      )
    }

    // ---- auth: verify caller has a valid Supabase JWT ----
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return jsonResponse({ success: false, error: 'Missing Authorization header' }, 401)
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      return jsonResponse({ success: false, error: 'Unauthorized: ' + (authError?.message || 'invalid token') }, 401)
    }

    // ---- parse multipart form ----
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const metadataRaw = formData.get('metadata') as string | null

    if (!file) {
      return jsonResponse({ success: false, error: 'Missing "file" in form data' }, 400)
    }
    if (!metadataRaw) {
      return jsonResponse({ success: false, error: 'Missing "metadata" in form data' }, 400)
    }

    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(metadataRaw)
    } catch {
      return jsonResponse({ success: false, error: 'Invalid JSON in "metadata" field' }, 400)
    }

    const workOrderName = (meta.work_order_name as string) || 'unknown'
    const trackingNumber = (meta.tracking_number as string) || 'unknown'
    const storagePath = (meta.storage_path as string) || ''

    console.log(`[upload-gdrive] WO=${workOrderName} TN=${trackingNumber} size=${file.size}`)

    // ---- Google Drive: get access token ----
    const accessToken = await getGoogleAccessToken(gdriveEmail, gdriveKey)

    // ---- Google Drive: ensure work-order sub-folder exists ----
    const woFolderId = await findOrCreateFolder(workOrderName, gdriveFolderId, accessToken)

    // ---- Google Drive: upload file ----
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `${trackingNumber}_${timestamp}.webm`
    const driveFile = await uploadFileToDrive(file, fileName, woFolderId, accessToken)

    const gdriveUrl = `https://drive.google.com/file/d/${driveFile.id}/view`
    console.log(`[upload-gdrive] Uploaded → ${driveFile.id}  ${gdriveUrl}`)

    // ---- Insert metadata into pk_packing_videos ----
    const { error: insertError } = await supabaseAdmin
      .from('pk_packing_videos')
      .insert({
        order_id: meta.order_id || null,
        work_order_name: workOrderName,
        tracking_number: trackingNumber,
        storage_path: storagePath,
        duration_seconds: meta.duration_seconds ?? null,
        recorded_by: meta.recorded_by ?? null,
        recorded_at: meta.recorded_at ?? null,
        gdrive_file_id: driveFile.id,
        gdrive_url: gdriveUrl,
      })

    if (insertError) {
      console.error('[upload-gdrive] DB insert error:', insertError.message)
      return jsonResponse({
        success: false,
        error: 'File uploaded to Drive but DB insert failed: ' + insertError.message,
        gdrive_file_id: driveFile.id,
        gdrive_url: gdriveUrl,
      }, 500)
    }

    return jsonResponse({
      success: true,
      gdrive_file_id: driveFile.id,
      gdrive_url: gdriveUrl,
    })
  } catch (err: any) {
    console.error('[upload-gdrive] Unexpected error:', err.message, err.stack)
    return jsonResponse(
      { success: false, error: err.message || 'Internal server error' },
      500,
    )
  }
})

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
