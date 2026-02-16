import type { AuditKPI } from '../../lib/auditApi'

interface AuditKPICardsProps {
  kpi: AuditKPI | null
  loading: boolean
}

function KPICard({
  title,
  value,
  suffix,
  sub,
  color,
}: {
  title: string
  value: string
  suffix?: string
  sub?: string
  color: 'blue' | 'green' | 'orange' | 'purple'
}) {
  const bg = {
    blue: 'from-blue-500 to-blue-600',
    green: 'from-green-500 to-green-600',
    orange: 'from-orange-500 to-orange-600',
    purple: 'from-purple-500 to-purple-600',
  }

  return (
    <div className={`bg-gradient-to-br ${bg[color]} rounded-xl p-5 text-white shadow-sm`}>
      <div className="text-sm font-medium opacity-90">{title}</div>
      <div className="text-3xl font-bold mt-2">
        {value}
        {suffix && <span className="text-lg font-medium ml-0.5">{suffix}</span>}
      </div>
      {sub && <div className="text-xs opacity-80 mt-1">{sub}</div>}
    </div>
  )
}

export default function AuditKPICards({ kpi, loading }: AuditKPICardsProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-gray-100 rounded-xl p-5 animate-pulse h-28" />
        ))}
      </div>
    )
  }

  if (!kpi) return null

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <KPICard
        title="Audit ทั้งหมด"
        value={String(kpi.totalAudits)}
        sub={`${kpi.totalItemsAudited.toLocaleString()} รายการที่ตรวจ`}
        color="blue"
      />
      <KPICard
        title="ความถูกต้องจำนวน"
        value={kpi.avgQuantityAccuracy != null ? kpi.avgQuantityAccuracy.toFixed(1) : '-'}
        suffix="%"
        sub="ค่าเฉลี่ยทั้งหมด"
        color="green"
      />
      <KPICard
        title="ความถูกต้องจุดจัดเก็บ"
        value={kpi.avgLocationAccuracy != null ? kpi.avgLocationAccuracy.toFixed(1) : '-'}
        suffix="%"
        sub="ค่าเฉลี่ยทั้งหมด"
        color="orange"
      />
      <KPICard
        title="ความถูกต้อง Safety Stock"
        value={kpi.avgSafetyStockAccuracy != null ? kpi.avgSafetyStockAccuracy.toFixed(1) : '-'}
        suffix="%"
        sub="ค่าเฉลี่ยทั้งหมด"
        color="purple"
      />
    </div>
  )
}
