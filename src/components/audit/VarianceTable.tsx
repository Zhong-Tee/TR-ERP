import { getPublicUrl } from '../../lib/qcApi'
import type { InventoryAuditItem } from '../../types'

interface VarianceTableProps {
  items: InventoryAuditItem[]
  showOnlyMismatch: boolean
}

export default function VarianceTable({ items, showOnlyMismatch }: VarianceTableProps) {
  const filtered = showOnlyMismatch
    ? items.filter((i) => i.is_counted && Number(i.variance) !== 0)
    : items.filter((i) => i.is_counted)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-blue-600 text-white">
            <th className="p-3 text-center font-semibold rounded-tl-xl w-16">รูป</th>
            <th className="p-3 text-left font-semibold">สินค้า</th>
            <th className="p-3 text-left font-semibold">หมวด</th>
            <th className="p-3 text-left font-semibold">จุดเก็บ</th>
            <th className="p-3 text-right font-semibold">ในระบบ</th>
            <th className="p-3 text-right font-semibold">นับได้</th>
            <th className="p-3 text-right font-semibold rounded-tr-xl">ผลต่าง</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={7} className="p-6 text-center text-gray-400">
                {showOnlyMismatch ? 'ไม่มีรายการที่มีผลต่าง' : 'ไม่มีรายการที่นับแล้ว'}
              </td>
            </tr>
          ) : (
            filtered.map((item, idx) => {
              const variance = Number(item.variance || 0)
              const isMatch = variance === 0
              const rowClass = isMatch
                ? 'bg-green-50'
                : Math.abs(variance) <= 2
                  ? 'bg-yellow-50'
                  : 'bg-red-50'

              return (
                <tr
                  key={item.id}
                  className={`border-b border-gray-100 ${idx % 2 === 0 ? rowClass : rowClass}`}
                >
                  <td className="p-2">
                    <div className="w-12 h-12 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center">
                      {item.pr_products?.product_code ? (
                        <img
                          src={getPublicUrl('product-images', item.pr_products.product_code, '.jpg')}
                          alt={item.pr_products.product_code}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <span className="text-gray-300 text-lg">&#128247;</span>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="font-medium">{item.pr_products?.product_code || '-'}</div>
                    <div className="text-xs text-gray-500">{item.pr_products?.product_name || ''}</div>
                  </td>
                  <td className="p-3 text-xs text-gray-600">{item.product_category || '-'}</td>
                  <td className="p-3 text-xs text-gray-600">{item.storage_location || '-'}</td>
                  <td className="p-3 text-right font-medium">{Number(item.system_qty).toLocaleString()}</td>
                  <td className="p-3 text-right font-medium">{Number(item.counted_qty).toLocaleString()}</td>
                  <td className={`p-3 text-right font-bold ${
                    isMatch ? 'text-green-600' : variance > 0 ? 'text-blue-600' : 'text-red-600'
                  }`}>
                    {isMatch ? '0' : (variance > 0 ? '+' : '') + variance.toLocaleString()}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
