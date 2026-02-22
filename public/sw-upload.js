const DB_NAME = 'packing_upload_queue'
const DB_VERSION = 1
const STORE_QUEUE = 'queue'
const STORE_SETTINGS = 'settings'

let processing = false

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

async function processQueue() {
  if (processing) return
  processing = true
  try {
    const supabaseUrl = await getSetting('supabaseUrl')
    const supabaseAnonKey = await getSetting('supabaseAnonKey')
    const accessToken = await getSetting('accessToken')
    if (!supabaseUrl || !supabaseAnonKey || !accessToken) return

    const items = await listQueueItems()
    const candidates = items.filter((i) => i.status === 'pending' || i.status === 'failed')
    for (const item of candidates) {
      await updateQueueItem(item.id, { status: 'uploading', lastError: null })
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
            recorded_by: item.recordedBy || null,
            recorded_at: item.recordedAt || null,
          }),
        )

        const uploadRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: formData,
        })

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

        if (self.registration && Notification.permission === 'granted') {
          self.registration.showNotification('อัปโหลดวิดีโอสำเร็จ', {
            body: `${item.workOrderName} • ${item.trackingNumber}`,
          })
        }
      } catch (err) {
        await updateQueueItem(item.id, {
          status: 'failed',
          retryCount: (item.retryCount || 0) + 1,
          lastError: String(err?.message || err),
        })
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
