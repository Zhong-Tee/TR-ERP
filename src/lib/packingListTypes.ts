export type PackingShippedGroup = {
  work_order_id: string | null
  work_order_name: string
  order_count: number
  shipped_time: string | null
  channels: string[]
  packers: string[]
}

export type PackingShippedPage = {
  rows: PackingShippedGroup[]
  total: number
  page: number
  channels: string[]
  packers: string[]
}

export type PackingReportPage<T> = {
  rows: T[]
  total: number
  page: number
  as_of: string
  summary: Record<'pending' | 'uploading' | 'success' | 'failed', number>
  devices: Array<{ device_id: string; device_name: string }>
}
