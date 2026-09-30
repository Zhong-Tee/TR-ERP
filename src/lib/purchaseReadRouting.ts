// Reads use server-side masked views; writes keep the original table/RPC and RLS.
// View aliases preserve response keys and embedded filters used by existing screens.
const maskedTables = new Set(['pr_products', 'inv_po', 'inv_po_items', 'inv_pr_items'])
export function routePurchaseRead(input: string, method = 'GET'): string {
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) return input
  const url = new URL(input)
  const match = url.pathname.match(/\/rest\/v1\/([^/]+)$/)
  if (!match) return input
  if (maskedTables.has(match[1])) url.pathname = url.pathname.replace(/[^/]+$/, `v_cost_safe_${match[1]}`)
  const select = url.searchParams.get('select')
  if (select) url.searchParams.set('select', select.replace(/(^|[,(:])\s*(?:(\w+):)?(pr_products|inv_po_items|inv_po|inv_pr_items)(?=[!(])/g,
    (_, prefix: string, alias: string | undefined, table: string) => `${prefix}${alias || table}:v_cost_safe_${table}`))
  return url.toString()
}
