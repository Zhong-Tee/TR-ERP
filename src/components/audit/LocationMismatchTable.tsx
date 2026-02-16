import { getPublicUrl } from '../../lib/qcApi'
import type { InventoryAuditItem } from '../../types'

interface LocationMismatchTableProps {
  items: InventoryAuditItem[]
}

export default function LocationMismatchTable({ items }: LocationMismatchTableProps) {
  const mismatched = items.filter((i) => i.location_match === false)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-orange-600 text-white">
            <th className="p-3 text-center font-semibold rounded-tl-xl w-16">รูป</th>
            <th className="p-3 text-left font-semibold">สินค้า</th>
            <th className="p-3 text-left font-semibold">หมวด</th>
            <th className="p-3 text-left font-semibold">จุดเก็บในระบบ</th>
            <th className="p-3 text-left font-semibold">จุดเก็บจริง</th>
            <th className="p-3 text-center font-semibold rounded-tr-xl">สถานะ</th>
          </tr>
        </thead>
        <tbody>
          {mismatched.length === 0 ? (
            <tr>
              <td colSpan={6} className="p-6 text-center text-gray-400">
                ไม่มีรายการที่จุดจัดเก็บไม่ตรง
              </td>
            </tr>
          ) : (
            mismatched.map((item, idx) => (
              <tr
                key={item.id}
                className={`border-b border-gray-100 ${idx % 2 === 0 ? 'bg-orange-50' : 'bg-white'}`}
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
                <td className="p-3 font-medium text-gray-600">{item.system_location || '-'}</td>
                <td className="p-3 font-bold text-orange-700">{item.actual_location || '-'}</td>
                <td className="p-3 text-center">
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-bold bg-orange-500 text-white">
                    ไม่ตรง
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
