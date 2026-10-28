import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
const auth = vi.hoisted(() => ({ role: 'superadmin' }))
vi.mock('../../contexts/AuthContext', () => ({ useAuthContext: () => ({ user: { role: auth.role } }) }))
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
import DiscountApprovalWorkspace from './DiscountApprovalWorkspace'
describe('discount review workspace role access', () => {
 it('superadmin sees combined bill/QT/PC filters', () => { auth.role='superadmin'; const html=renderToStaticMarkup(createElement(DiscountApprovalWorkspace,{onChanged:()=>{}})); expect(html).toContain('บิลขาย'); expect(html).toContain('QT'); expect(html).toContain('PC'); expect(html).toContain('รออนุมัติ') })
 it('other roles cannot see review UI even when directly mounted', () => { for (const role of ['admin','sales-tr','sales-pump','account','store']) { auth.role=role; const html=renderToStaticMarkup(createElement(DiscountApprovalWorkspace,{onChanged:()=>{}})); expect(html).toContain('เฉพาะ superadmin'); expect(html).not.toContain('<table') } })
})
