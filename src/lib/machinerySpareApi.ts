import { supabase } from './supabase'

export type MachinerySpareProduct = {
  product_id: string
  product_code: string
  product_name: string
  product_category: string | null
  unit_name: string | null
  main_qty: number
  machinery_qty: number
  average_unit_cost: number
}

export type MachineryStockTransfer = {
  id: string
  transfer_no: string
  product_id: string
  qty: number
  status: 'pending' | 'confirmed' | 'cancelled'
  direction: 'to_machinery' | 'to_main'
  note: string | null
  requested_at: string
  confirmed_at: string | null
  product_code: string
  product_name: string
  unit_name: string | null
}

export type MachineryPartUsage = {
  id: string
  incident_id: string
  machine_id: string
  product_id: string
  event_type: 'use' | 'return'
  qty: number
  unit_cost: number
  return_of_id: string | null
  note: string | null
  performed_by: string | null
  performed_at: string
  product_code: string
  product_name: string
  unit_name: string | null
  ticket_no: string
  performed_by_name: string
}

type PurchaseProductRpcRow = {
  product_id: string
  product_code: string
  product_name: string
  product_category: string | null
  unit_name: string | null
  on_hand: number | string | null
  enabled: boolean
}

export async function fetchMachinerySpareProducts(): Promise<MachinerySpareProduct[]> {
  const [{ data: products, error: productError }, { data: balances, error: balanceError }] = await Promise.all([
    supabase.rpc('get_machinery_purchase_products', { p_include_disabled: false }),
    supabase.from('pr_machinery_stock_balances').select('product_id, qty, average_unit_cost'),
  ])
  if (productError) throw productError
  if (balanceError) throw balanceError
  const balanceMap = new Map((balances || []).map((row) => [row.product_id, row]))
  return ((products || []) as PurchaseProductRpcRow[]).map((product) => {
    const balance = balanceMap.get(product.product_id)
    return {
      product_id: product.product_id,
      product_code: product.product_code,
      product_name: product.product_name,
      product_category: product.product_category,
      unit_name: product.unit_name,
      main_qty: Number(product.on_hand || 0),
      machinery_qty: Number(balance?.qty || 0),
      average_unit_cost: Number(balance?.average_unit_cost || 0),
    }
  })
}

export async function fetchMachineryStockTransfers(): Promise<MachineryStockTransfer[]> {
  const { data, error } = await supabase
    .from('pr_machinery_stock_transfers')
    .select('id, transfer_no, product_id, qty, status, direction, note, requested_at, confirmed_at, pr_products(product_code, product_name, unit_name)')
    .order('requested_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return (data || []).map((row: any) => ({
    id: row.id,
    transfer_no: row.transfer_no,
    product_id: row.product_id,
    qty: Number(row.qty || 0),
    status: row.status,
    direction: row.direction || 'to_machinery',
    note: row.note,
    requested_at: row.requested_at,
    confirmed_at: row.confirmed_at,
    product_code: row.pr_products?.product_code || '-',
    product_name: row.pr_products?.product_name || '-',
    unit_name: row.pr_products?.unit_name || null,
  }))
}

export async function requestMachineryStockTransfer(productId: string, qty: number, note = ''): Promise<void> {
  const { error } = await supabase.rpc('rpc_request_machinery_stock_transfer', {
    p_product_id: productId,
    p_qty: qty,
    p_note: note.trim() || null,
  })
  if (error) throw error
}

export async function requestMachineryStockReturn(productId: string, qty: number, note = ''): Promise<void> {
  const { error } = await supabase.rpc('rpc_request_machinery_stock_return', {
    p_product_id: productId,
    p_qty: qty,
    p_note: note.trim() || null,
  })
  if (error) throw error
}

export async function confirmMachineryStockTransfer(transferId: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_confirm_machinery_stock_transfer', { p_transfer_id: transferId })
  if (error) throw error
}

export async function saveMachinePartAssignments(machineId: string, productIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('rpc_set_machinery_machine_parts', {
    p_machine_id: machineId,
    p_product_ids: [...new Set(productIds)],
  })
  if (error) throw error
}

export async function fetchMachinePartIds(): Promise<Record<string, string[]>> {
  const { data, error } = await supabase.from('pr_machinery_machine_parts').select('machine_id, product_id')
  if (error) throw error
  const result: Record<string, string[]> = {}
  ;(data || []).forEach((row) => {
    if (!result[row.machine_id]) result[row.machine_id] = []
    result[row.machine_id].push(row.product_id)
  })
  return result
}

export async function fetchAvailableMachineParts(machineId: string): Promise<MachinerySpareProduct[]> {
  const [products, assignments] = await Promise.all([
    fetchMachinerySpareProducts(),
    supabase.from('pr_machinery_machine_parts').select('product_id').eq('machine_id', machineId),
  ])
  if (assignments.error) throw assignments.error
  const allowed = new Set((assignments.data || []).map((row) => row.product_id))
  return products.filter((product) => allowed.has(product.product_id))
}

export async function useMachineryPart(incidentId: string, productId: string, qty: number, note: string, performedAt: string): Promise<void> {
  const { error } = await supabase.rpc('rpc_use_machinery_part_at', {
    p_incident_id: incidentId,
    p_product_id: productId,
    p_qty: qty,
    p_note: note.trim() || null,
    p_performed_at: performedAt,
  })
  if (error) throw error
}

export async function returnMachineryPart(usageId: string, qty: number, note = ''): Promise<void> {
  const { error } = await supabase.rpc('rpc_return_machinery_part', {
    p_usage_id: usageId,
    p_qty: qty,
    p_note: note.trim() || null,
  })
  if (error) throw error
}

export async function fetchMachineryPartHistory(machineId?: string, incidentId?: string): Promise<MachineryPartUsage[]> {
  let query = supabase
    .from('pr_machinery_incident_parts')
    .select('id, incident_id, machine_id, product_id, event_type, qty, unit_cost, return_of_id, note, performed_by, performed_at, pr_products(product_code, product_name, unit_name), pr_machinery_incidents(ticket_no)')
    .order('performed_at', { ascending: false })
  if (machineId) query = query.eq('machine_id', machineId)
  if (incidentId) query = query.eq('incident_id', incidentId)
  const { data, error } = await query
  if (error) throw error
  const rows = data || []
  const userIds = [...new Set(rows.map((row: any) => row.performed_by).filter(Boolean))]
  const userMap = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users } = await supabase.from('us_users').select('id, username, email').in('id', userIds)
    ;(users || []).forEach((user) => userMap.set(user.id, user.username || user.email || user.id))
  }
  return rows.map((row: any) => ({
    id: row.id,
    incident_id: row.incident_id,
    machine_id: row.machine_id,
    product_id: row.product_id,
    event_type: row.event_type,
    qty: Number(row.qty || 0),
    unit_cost: Number(row.unit_cost || 0),
    return_of_id: row.return_of_id,
    note: row.note,
    performed_by: row.performed_by,
    performed_at: row.performed_at,
    product_code: row.pr_products?.product_code || '-',
    product_name: row.pr_products?.product_name || '-',
    unit_name: row.pr_products?.unit_name || null,
    ticket_no: row.pr_machinery_incidents?.ticket_no || '-',
    performed_by_name: row.performed_by ? (userMap.get(row.performed_by) || row.performed_by) : '-',
  }))
}
