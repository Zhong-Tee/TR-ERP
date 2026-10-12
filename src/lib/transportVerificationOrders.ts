type TransportOrder = {
  status: string
  shipped_time?: string | null
  transport_meta?: { verified?: boolean } | null
}

/** Both sides of the progress counter, exports and rows share this population. */
export function partitionTransportOrders<T extends TransportOrder>(orders: T[]) {
  return {
    eligible: orders.filter((order) => order.status === 'จัดส่งแล้ว'),
    anomalies: orders.filter((order) => order.status !== 'จัดส่งแล้ว' && order.status !== 'ยกเลิก'
      && (!!order.shipped_time || order.transport_meta?.verified === true)),
  }
}
