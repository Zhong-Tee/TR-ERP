import { useAuthContext } from '../contexts/AuthContext'
import AdminLayout from '../components/wms/admin/AdminLayout'
import ProductionLayout from '../components/wms/production/ProductionLayout'
import ManagerLayout from '../components/wms/manager/ManagerLayout'
import PickerLayout from '../components/wms/picker/PickerLayout'
import { getActiveMobileMode } from '../lib/mobileMode'

export default function Wms() {
  const { user } = useAuthContext()

  if (!user) return null

  // role จริง หรือโหมดมือถือที่สวมจากหน้าเลือกโหมด (/mode)
  const effectiveRole = getActiveMobileMode(user) ?? user.role

  // Mobile role: picker (หน้ามือถือหยิบสินค้า)
  if (effectiveRole === 'picker') {
    return <PickerLayout />
  }

  // Mobile role: production_mb (หน้ามือถือสำหรับฝ่ายผลิต)
  if (effectiveRole === 'production_mb') {
    return <ProductionLayout />
  }

  // Mobile role: manager (หน้ามือถืออนุมัติใบเบิก)
  if (effectiveRole === 'manager') {
    return <ManagerLayout />
  }

  // Desktop roles: sales-tr, store, superadmin, production, account และ role อื่นๆ ทั้งหมด
  return <AdminLayout />
}
