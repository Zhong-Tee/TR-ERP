interface CountProgressProps {
  counted: number
  total: number
}

export default function CountProgress({ counted, total }: CountProgressProps) {
  const percent = total > 0 ? Math.round((counted / total) * 100) : 0

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm font-medium text-gray-700">
          ความคืบหน้า
        </span>
        <span className="text-sm font-bold text-blue-600">
          {counted}/{total} ({percent}%)
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-3">
        <div
          className={`h-3 rounded-full transition-all duration-500 ${
            percent === 100 ? 'bg-green-500' : 'bg-blue-500'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
