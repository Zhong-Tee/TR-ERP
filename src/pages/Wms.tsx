import { useAuthContext } from '../contexts/AuthContext'
import AdminLayout from '../components/wms/admin/AdminLayout'
import ProductionLayout from '../components/wms/production/ProductionLayout'
import ManagerLayout from '../components/wms/manager/ManagerLayout'
import PickerLayout from '../components/wms/picker/PickerLayout'

export default function Wms() {
  const { user } = useAuthContext()

  if (!user) return null

  // Mobile role: picker (หน้ามือถือหยิบสินค้า)
  if (user.role === 'picker') {
    return <PickerLayout />
  }

  // Mobile role: production_mb (หน้ามือถือสำหรับฝ่ายผลิต)
  if (user.role === 'production_mb') {
    return <ProductionLayout />
  }

  // Mobile role: manager (หน้ามือถืออนุมัติใบเบิก)
  if (user.role === 'manager') {
    return <ManagerLayout />
  }

  // Desktop roles: admin-tr, store, superadmin, production, account และ role อื่นๆ ทั้งหมด
  return <AdminLayout />
}
