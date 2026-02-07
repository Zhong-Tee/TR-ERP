const DB_NAME = 'packing_upload_queue'
const DB_VERSION = 1
const STORE_QUEUE = 'queue'
const STORE_SETTINGS = 'settings'

export type UploadStatus = 'pending' | 'uploading' | 'success' | 'failed'

export interface UploadQueueItem {
  id: string
  workOrderName: string
  trackingNumber: string
  orderId: string
  filename: string
  storagePath: string
  status: UploadStatus
  createdAt: string
  updatedAt: string
  retryCount: number
  lastError?: string | null
  durationSeconds?: number | null
  fileType?: string | null
  fileSize?: number | null
  recordedBy?: string | null
  recordedAt?: string | null
  blob?: Blob | null
  localDeleted?: boolean
}

function openDb(): Promise<IDBDatabase> {
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

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = action(store)
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
      })
  )
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await withStore(STORE_SETTINGS, 'readwrite', (store) => store.put({ key, value }))
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const res = await withStore<{ key: string; value: T } | undefined>(STORE_SETTINGS, 'readonly', (store) =>
    store.get(key)
  )
  return res ? (res.value as T) : null
}

export async function setFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await setSetting('folderHandle', handle)
}

export async function getFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  return getSetting<FileSystemDirectoryHandle>('folderHandle')
}

export async function setSupabaseConfig(url: string, anonKey: string): Promise<void> {
  await setSetting('supabaseUrl', url)
  await setSetting('supabaseAnonKey', anonKey)
}

export async function getSupabaseConfig(): Promise<{ supabaseUrl: string; supabaseAnonKey: string } | null> {
  const supabaseUrl = await getSetting<string>('supabaseUrl')
  const supabaseAnonKey = await getSetting<string>('supabaseAnonKey')
  if (!supabaseUrl || !supabaseAnonKey) return null
  return { supabaseUrl, supabaseAnonKey }
}

export async function setAccessToken(token: string | null): Promise<void> {
  await setSetting('accessToken', token || '')
}

export async function getAccessToken(): Promise<string | null> {
  const token = await getSetting<string>('accessToken')
  return token || null
}

export async function addQueueItem(item: UploadQueueItem): Promise<void> {
  await withStore(STORE_QUEUE, 'readwrite', (store) => store.put(item))
}

export async function updateQueueItem(id: string, patch: Partial<UploadQueueItem>): Promise<void> {
  const existing = await withStore<UploadQueueItem | undefined>(STORE_QUEUE, 'readonly', (store) => store.get(id))
  if (!existing) return
  const next: UploadQueueItem = { ...existing, ...patch, updatedAt: new Date().toISOString() }
  await withStore(STORE_QUEUE, 'readwrite', (store) => store.put(next))
}

export async function deleteQueueItem(id: string): Promise<void> {
  await withStore(STORE_QUEUE, 'readwrite', (store) => store.delete(id))
}

export async function listQueueItems(): Promise<UploadQueueItem[]> {
  return withStore<UploadQueueItem[]>(STORE_QUEUE, 'readonly', (store) => store.getAll())
}

export async function getQueueItem(id: string): Promise<UploadQueueItem | null> {
  const res = await withStore<UploadQueueItem | undefined>(STORE_QUEUE, 'readonly', (store) => store.get(id))
  return res || null
}
