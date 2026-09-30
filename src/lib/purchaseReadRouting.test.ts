import { describe, expect, it } from 'vitest'
import { routePurchaseRead } from './purchaseReadRouting'

describe('server-masked purchasing reads', () => {
  it('routes direct reads and preserves filters', () => {
    const result = new URL(routePurchaseRead('https://db.test/rest/v1/inv_po?select=*&status=eq.partial'))
    expect(result.pathname).toBe('/rest/v1/v_cost_safe_inv_po')
    expect(result.searchParams.get('status')).toBe('eq.partial')
  })
  it('preserves nested aliases, foreign-key hints, join types and response shape', () => {
    const select = '*,inv_po(po_no,inv_po_items(qty,pr_products(product_code))),item:pr_products!inv_sample_items_product_id_fkey!inner(id)'
    const result = new URL(routePurchaseRead(`https://db.test/rest/v1/inv_gr?select=${encodeURIComponent(select)}`))
    expect(result.searchParams.get('select')).toBe('*,inv_po:v_cost_safe_inv_po(po_no,inv_po_items:v_cost_safe_inv_po_items(qty,pr_products:v_cost_safe_pr_products(product_code))),item:v_cost_safe_pr_products!inv_sample_items_product_id_fkey!inner(id)')
  })
  it('does not rewrite mutations, RPCs, storage or auth requests', () => {
    for (const [url, method] of [
      ['https://db.test/rest/v1/pr_products?select=id','POST'],
      ['https://db.test/rest/v1/rpc/rpc_receive_gr','GET'],
      ['https://db.test/storage/v1/object/pr_products','GET'],
      ['https://db.test/auth/v1/user','GET'],
    ]) expect(routePurchaseRead(url, method)).toBe(url)
  })
})
