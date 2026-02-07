import { useAuthContext } from '../contexts/AuthContext'
import AdminLayout from '../components/wms/admin/AdminLayout'
import ProductionLayout from '../components/wms/production/ProductionLayout'
import ManagerLayout from '../components/wms/manager/ManagerLayout'
import PickerLayout from '../components/wms/picker/PickerLayout'

export default function Wms() {
  const { user } = useAuthContext()

  if (!user) return null

  if (user.role === 'admin' || user.role === 'store' || user.role === 'superadmin') {
    return <AdminLayout />
  }

  if (user.role === 'production') {
    return <ProductionLayout />
  }

  if (user.role === 'manager') {
    return <ManagerLayout />
  }

  return <PickerLayout />
}
