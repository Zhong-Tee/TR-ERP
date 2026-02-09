import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function SalesReports() {
  const [salesData, setSalesData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSalesData()
  }, [])

  async function loadSalesData() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('or_orders')
        .select('*, or_order_items(*)')
        .eq('status', 'จัดส่งแล้ว')
        .order('created_at', { ascending: false })
        .limit(100)

      if (error) throw error

      // Calculate sales by product
      const productSales: Record<string, { name: string; quantity: number; revenue: number }> = {}
      
      data?.forEach((order) => {
        order.or_order_items?.forEach((item: any) => {
          if (!productSales[item.product_name]) {
            productSales[item.product_name] = {
              name: item.product_name,
              quantity: 0,
              revenue: 0,
            }
          }
          productSales[item.product_name].quantity += item.quantity || 1
          productSales[item.product_name].revenue += order.total_amount / (order.or_order_items?.length || 1)
        })
      })

      setSalesData(Object.values(productSales))
    } catch (error: any) {
      console.error('Error loading sales data:', error)
      alert('เกิดข้อผิดพลาดในการโหลดข้อมูล: ' + error.message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    )
  }

  const totalRevenue = salesData.reduce((sum, item) => sum + item.revenue, 0)
  const totalQuantity = salesData.reduce((sum, item) => sum + item.quantity, 0)

  return (
    <div className="space-y-6 mt-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-600 mb-2">ยอดขายรวม</h3>
          <p className="text-3xl font-bold text-green-600">
            ฿{totalRevenue.toLocaleString()}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-600 mb-2">จำนวนสินค้า</h3>
          <p className="text-3xl font-bold text-blue-600">
            {totalQuantity.toLocaleString()}
          </p>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-medium text-gray-600 mb-2">จำนวนสินค้าประเภท</h3>
          <p className="text-3xl font-bold text-purple-600">
            {salesData.length}
          </p>
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow">
        <h2 className="text-xl font-bold mb-4">ยอดขายตามสินค้า</h2>
        {salesData.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            ไม่พบข้อมูลยอดขาย
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-blue-600 text-white">
                  <th className="p-3 text-left font-semibold rounded-tl-xl">สินค้า</th>
                  <th className="p-3 text-left font-semibold">จำนวน</th>
                  <th className="p-3 text-left font-semibold rounded-tr-xl">ยอดขาย</th>
                </tr>
              </thead>
              <tbody>
                {salesData
                  .sort((a, b) => b.revenue - a.revenue)
                  .map((item, index) => (
                    <tr key={index} className={`border-t border-surface-200 hover:bg-blue-50 transition-colors ${index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                      <td className="p-3 font-medium">{item.name}</td>
                      <td className="p-3">{item.quantity.toLocaleString()}</td>
                      <td className="p-3 font-bold text-green-600">
                        ฿{item.revenue.toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
