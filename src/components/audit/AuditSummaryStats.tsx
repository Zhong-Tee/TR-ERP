interface AuditSummaryStatsProps {
  totalItems: number
  qtyMatched: number
  qtyMismatch: number
  accuracyPercent: number | null
  locationChecked: number
  locationMatched: number
  locationMismatch: number
  locationAccuracy: number | null
  safetyChecked: number
  safetyMatched: number
  safetyMismatch: number
  safetyAccuracy: number | null
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string
  value: string
  sub?: string
  color: 'blue' | 'green' | 'red' | 'orange' | 'purple'
}) {
  const bgMap = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    red: 'bg-red-50 border-red-200',
    orange: 'bg-orange-50 border-orange-200',
    purple: 'bg-purple-50 border-purple-200',
  }
  const textMap = {
    blue: 'text-blue-700',
    green: 'text-green-700',
    red: 'text-red-700',
    orange: 'text-orange-700',
    purple: 'text-purple-700',
  }

  return (
    <div className={`rounded-xl border p-4 ${bgMap[color]}`}>
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${textMap[color]}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

export default function AuditSummaryStats(props: AuditSummaryStatsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      <StatCard
        label="ความถูกต้องจำนวน"
        value={props.accuracyPercent != null ? `${props.accuracyPercent.toFixed(1)}%` : '-'}
        sub={`ตรง ${props.qtyMatched} / ต่าง ${props.qtyMismatch} จาก ${props.totalItems} รายการ`}
        color={
          props.accuracyPercent != null && props.accuracyPercent >= 95
            ? 'green'
            : props.accuracyPercent != null && props.accuracyPercent >= 80
              ? 'orange'
              : 'red'
        }
      />
      <StatCard
        label="ความถูกต้องจุดจัดเก็บ"
        value={props.locationAccuracy != null ? `${props.locationAccuracy.toFixed(1)}%` : '-'}
        sub={`ตรง ${props.locationMatched} / ผิด ${props.locationMismatch} จาก ${props.locationChecked} รายการ`}
        color={
          props.locationAccuracy != null && props.locationAccuracy >= 98
            ? 'green'
            : props.locationAccuracy != null && props.locationAccuracy >= 90
              ? 'orange'
              : 'red'
        }
      />
      <StatCard
        label="ความถูกต้อง Safety Stock"
        value={props.safetyAccuracy != null ? `${props.safetyAccuracy.toFixed(1)}%` : '-'}
        sub={`ตรง ${props.safetyMatched} / ไม่ตรง ${props.safetyMismatch} จาก ${props.safetyChecked} รายการ`}
        color={
          props.safetyAccuracy != null && props.safetyAccuracy >= 90
            ? 'green'
            : props.safetyAccuracy != null && props.safetyAccuracy >= 70
              ? 'orange'
              : 'red'
        }
      />
    </div>
  )
}
