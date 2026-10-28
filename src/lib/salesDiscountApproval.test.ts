import { describe, expect, it, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }))
import { supabase } from './supabase'
import { checkSalesDiscount, discountBlocksCompletion, maySkipSlip, type DiscountCheck } from './salesDiscountApproval'
const state: DiscountCheck = { required: true, approved: true, zero_payment: true, status: 'approved', automatic_discount: 0 }
describe('sales discount completion and slip policy', () => {
 it('only approved exact zero bills skip slip', () => { expect(maySkipSlip(state,0)).toBe(true); for (const n of [0.01,1,-1,NaN,Infinity]) expect(maySkipSlip(state,n)).toBe(false) })
 it('pending/rejected/stale zero bills cannot skip', () => { for (const status of ['pending','rejected','stale']) { const s={...state,status,approved:false,zero_payment:false}; expect(discountBlocksCompletion(s)).toBe(true); expect(maySkipSlip(s,0)).toBe(false) } })
 it('automatic promotion does not block completion or claim approval', () => { expect(discountBlocksCompletion({...state,required:false,approved:false,zero_payment:false})).toBe(false); expect(maySkipSlip({...state,approved:false},0)).toBe(false) })
 it('requires both server approval and zero-payment eligibility', () => { expect(maySkipSlip({...state,zero_payment:false},0)).toBe(false); expect(maySkipSlip({...state,approved:false},0)).toBe(false) })
 it('fails closed when RPC is absent or malformed', async () => { const rpc=vi.mocked(supabase.rpc); rpc.mockResolvedValueOnce({data:null,error:{message:'migration missing'}} as never); await expect(checkSalesDiscount(null,{header:{},items:[],promotions:[]})).rejects.toMatchObject({message:'migration missing'}); rpc.mockResolvedValueOnce({data:{approved:true},error:null} as never); await expect(checkSalesDiscount(null,{header:{},items:[],promotions:[]})).rejects.toThrow() })
})
