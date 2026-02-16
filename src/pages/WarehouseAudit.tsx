import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAudits, getAuditKPI } from '../lib/auditApi'
import type { AuditKPI } from '../lib/auditApi'
import type { InventoryAudit } from '../types'
import AuditKPICards from '../components/audit/AuditKPICards'
import AuditList from '../components/audit/AuditList'

export default function WarehouseAudit() {
  const [audits, setAudits] = useState<InventoryAudit[]>([])
  const [kpi, setKpi] = useState<AuditKPI | null>(null)
  const [userMap, setUserMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [kpiLoading, setKpiLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    setKpiLoading(true)
    try {
      const [auditsData, kpiData, usersRes] = await Promise.all([
        fetchAudits(),
        getAuditKPI(),
        supabase.from('us_users').select('id, username'),
      ])
      setAudits(auditsData)
      setKpi(kpiData)

      const uMap: Record<string, string> = {}
      ;(usersRes.data || []).forEach((u: any) => {
        uMap[u.id] = u.username || u.id
      })
      setUserMap(uMap)
    } catch (e) {
      console.error('Load audit dashboard failed:', e)
    } finally {
      setLoading(false)
      setKpiLoading(false)
    }
  }

  return (
    <div className="space-y-6 mt-12">
      {/* KPI Cards */}
      <AuditKPICards kpi={kpi} loading={kpiLoading} />

      {/* Audit List */}
      <AuditList
        audits={audits}
        loading={loading}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        userMap={userMap}
      />
    </div>
  )
}
