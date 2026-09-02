const DB_NAME = 'packing_upload_queue'
const DB_VERSION = 1
const STORE_QUEUE = 'queue'
const STORE_SETTINGS = 'settings'

let processing = false
const STALE_UPLOAD_MS = 10 * 60 * 1000
// The current Edge Function reads the incoming multipart body and creates a
// second multipart Blob for Google Drive. Keep automatic uploads below this
// guard so one oversized video cannot exhaust the worker and block the queue.
const MAX_AUTOMATIC_UPLOAD_BYTES = 80 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 4 * 60 * 1000

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function withStore(storeName, mode, action) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = action(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
  )
}

async function getSetting(key) {
  const res = await withStore(STORE_SETTINGS, 'readonly', (store) => store.get(key))
  return res ? res.value : null
}

async function listQueueItems() {
  return withStore(STORE_QUEUE, 'readonly', (store) => store.getAll())
}

async function updateQueueItem(id, patch) {
  const existing = await withStore(STORE_QUEUE, 'readonly', (store) => store.get(id))
  if (!existing) return
  const next = { ...existing, ...patch, updatedAt: new Date().toISOString() }
  await withStore(STORE_QUEUE, 'readwrite', (store) => store.put(next))
}

async function reportQueueStatus(item, patch = {}) {
  const supabaseUrl = await getSetting('supabaseUrl')
  const supabaseAnonKey = await getSetting('supabaseAnonKey')
  const accessToken = await getSetting('accessToken')
  if (!supabaseUrl || !supabaseAnonKey || !accessToken || !item.recordedUserId) return

  const next = { ...item, ...patch }
  const response = await fetch(
    `${supabaseUrl}/rest/v1/pk_packing_upload_queue_reports?on_conflict=id`,
    {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: next.id,
        user_id: next.recordedUserId,
        recorded_by: next.recordedBy || 'unknown',
        device_id: next.deviceId || 'unknown',
        device_name: next.deviceName || 'ไม่ระบุชื่อเครื่อง',
        folder_name: next.folderName || null,
        folder_path: next.folderPath || null,
        work_order_name: next.workOrderName,
        tracking_number: next.trackingNumber,
        filename: next.filename,
        storage_path: next.storagePath,
        file_size_bytes: next.fileSize || 0,
        duration_seconds: next.durationSeconds || null,
        status: next.status,
        retry_count: next.retryCount || 0,
        last_error: next.lastError || null,
        local_deleted: !!next.localDeleted,
        quality_profile: next.qualityProfile || null,
        requested_width: next.requestedWidth || null,
        requested_height: next.requestedHeight || null,
        requested_fps: next.requestedFps || null,
        requested_bitrate: next.requestedBitrate || null,
        actual_width: next.actualWidth || null,
        actual_height: next.actualHeight || null,
        actual_fps: next.actualFps || null,
        mime_type: next.mimeType || next.fileType || null,
        codec: next.codec || null,
        recorder_bitrate: next.recorderBitrate || null,
        actual_bitrate: next.actualBitrate || null,
        recorded_at: next.recordedAt || next.createdAt,
        client_created_at: next.createdAt,
        client_updated_at: new Date().toISOString(),
        reported_at: new Date().toISOString(),
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`Queue report failed (${response.status})`)
  }
}

async function processQueue() {
  if (processing) return
  processing = true
  try {
    const supabaseUrl = await getSetting('supabaseUrl')
    const supabaseAnonKey = await getSetting('supabaseAnonKey')
    const accessToken = await getSetting('accessToken')
    if (!supabaseUrl || !supabaseAnonKey || !accessToken) return

    const items = await listQueueItems()
    const now = Date.now()
    const candidates = items
      .filter((i) => {
        // Failed items must only run again after the user explicitly changes
        // them back to pending. Otherwise every new recording retries all old
        // failures before reaching the healthy queue.
        if (i.status === 'pending') return true
        if (i.status !== 'uploading') return false
        const updatedAt = new Date(i.updatedAt || i.createdAt || 0).getTime()
        return !Number.isFinite(updatedAt) || now - updatedAt >= STALE_UPLOAD_MS
      })
      // Let small, likely-to-succeed recordings leave the queue first.
      .sort((a, b) => {
        const sizeDiff = Number(a.fileSize || a.blob?.size || 0) - Number(b.fileSize || b.blob?.size || 0)
        return sizeDiff || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
      })
    for (const item of candidates) {
      const itemSize = Number(item.fileSize || item.blob?.size || 0)
      if (itemSize > MAX_AUTOMATIC_UPLOAD_BYTES) {
        const retryCount = (item.retryCount || 0) + 1
        const maxMb = Math.round(MAX_AUTOMATIC_UPLOAD_BYTES / (1024 * 1024))
        const actualMb = (itemSize / (1024 * 1024)).toFixed(2)
        const lastError = `ไฟล์ใหญ่เกินขีดจำกัดอัปโหลดอัตโนมัติ (${actualMb} MB / สูงสุด ${maxMb} MB) ไฟล์สำรองยังอยู่ในเครื่อง กรุณาใช้ไฟล์สำรองหรือระบบอัปโหลดไฟล์ขนาดใหญ่`
        await updateQueueItem(item.id, {
          status: 'failed',
          retryCount,
          lastError,
        })
        await reportQueueStatus(item, {
          status: 'failed',
          retryCount,
          lastError,
        }).catch(() => null)
        continue
      }

      await updateQueueItem(item.id, { status: 'uploading', lastError: null })
      await reportQueueStatus(item, { status: 'uploading', lastError: null }).catch(() => null)
      try {
        if (!item.blob) throw new Error('ไม่พบไฟล์สำหรับอัปโหลด')

        const edgeFnUrl = `${supabaseUrl}/functions/v1/upload-gdrive`
        const formData = new FormData()
        formData.append('file', item.blob, item.filename || 'video.webm')
        formData.append(
          'metadata',
          JSON.stringify({
            order_id: item.orderId,
            work_order_name: item.workOrderName,
            tracking_number: item.trackingNumber,
            storage_path: item.storagePath,
            duration_seconds: item.durationSeconds || null,
            file_size_bytes: item.fileSize || item.blob.size,
            recorded_by: item.recordedBy || null,
            recorded_user_id: item.recordedUserId || null,
            recorded_at: item.recordedAt || null,
            upload_queue_id: item.id,
            device_id: item.deviceId || null,
            device_name: item.deviceName || null,
            folder_name: item.folderName || null,
            folder_path: item.folderPath || null,
            quality_profile: item.qualityProfile || null,
            requested_width: item.requestedWidth || null,
            requested_height: item.requestedHeight || null,
            requested_fps: item.requestedFps || null,
            requested_bitrate: item.requestedBitrate || null,
            actual_width: item.actualWidth || null,
            actual_height: item.actualHeight || null,
            actual_fps: item.actualFps || null,
            mime_type: item.mimeType || item.fileType || null,
            codec: item.codec || null,
            recorder_bitrate: item.recorderBitrate || null,
            actual_bitrate: item.actualBitrate || null,
          }),
        )

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
        let uploadRes
        try {
          uploadRes = await fetch(edgeFnUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
            body: formData,
            signal: controller.signal,
          })
        } catch (error) {
          if (error?.name === 'AbortError') {
            throw new Error('หมดเวลาอัปโหลด 4 นาที ระบบข้ามรายการนี้เพื่ออัปโหลดรายการถัดไป')
          }
          throw error
        } finally {
          clearTimeout(timeoutId)
        }

        const result = await uploadRes.json().catch(() => null)
        if (!uploadRes.ok || !result?.success) {
          throw new Error(
            result?.error || `Upload failed (${uploadRes.status})`,
          )
        }

        await updateQueueItem(item.id, {
          status: 'success',
          lastError: null,
          blob: null,
        })
        await reportQueueStatus(item, {
          status: 'success',
          lastError: null,
        }).catch(() => null)

        if (self.registration && Notification.permission === 'granted') {
          self.registration.showNotification('อัปโหลดวิดีโอสำเร็จ', {
            body: `${item.workOrderName} • ${item.trackingNumber}`,
          })
        }
      } catch (err) {
        const retryCount = (item.retryCount || 0) + 1
        const lastError = String(err?.message || err)
        await updateQueueItem(item.id, {
          status: 'failed',
          retryCount,
          lastError,
        })
        await reportQueueStatus(item, {
          status: 'failed',
          retryCount,
          lastError,
        }).catch(() => null)
        if (self.registration && Notification.permission === 'granted') {
          self.registration.showNotification('อัปโหลดวิดีโอล้มเหลว', {
            body: `${item.workOrderName} • ${item.trackingNumber}`,
          })
        }
      }
    }
  } finally {
    processing = false
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'packing-upload') {
    event.waitUntil(processQueue())
  }
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'sync-now') {
    processQueue()
  }
})
