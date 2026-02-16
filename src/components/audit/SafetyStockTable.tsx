import { getPublicUrl } from '../../lib/qcApi'
import type { InventoryAuditItem } from '../../types'

interface SafetyStockTableProps {
  items: InventoryAuditItem[]
}

export default function SafetyStockTable({ items }: SafetyStockTableProps) {
  const mismatched = items.filter((i) => i.safety_stock_match === false)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-purple-600 text-white">
            <th className="p-3 text-center font-semibold rounded-tl-xl w-16">รูป</th>
            <th className="p-3 text-left font-semibold">สินค้า</th>
            <th className="p-3 text-left font-semibold">หมวด</th>
            <th className="p-3 text-left font-semibold">จุดเก็บ</th>
            <th className="p-3 text-right font-semibold">Safety ในระบบ</th>
            <th className="p-3 text-right font-semibold">Safety นับได้</th>
            <th className="p-3 text-right font-semibold rounded-tr-xl">ผลต่าง</th>
          </tr>
        </thead>
        <tbody>
          {mismatched.length === 0 ? (
            <tr>
              <td colSpan={7} className="p-6 text-center text-gray-400">
                ไม่มีรายการที่ Safety Stock ไม่ตรง
              </td>
            </tr>
          ) : (
            mismatched.map((item, idx) => {
              const systemSafety = Number(item.system_safety_stock || 0)
              const countedSafety = Number(item.counted_safety_stock || 0)
              const diff = countedSafety - systemSafety

              return (
                <tr
                  key={item.id}
                  className={`border-b border-gray-100 ${idx % 2 === 0 ? 'bg-purple-50' : 'bg-white'}`}
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
                  <td className="p-3 text-right font-medium">{systemSafety.toLocaleString()}</td>
                  <td className="p-3 text-right font-medium">{countedSafety.toLocaleString()}</td>
                  <td className={`p-3 text-right font-bold ${diff >= 0 ? 'text-blue-600' : 'text-red-600'}`}>
                    {diff > 0 ? '+' : ''}{diff.toLocaleString()}
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
