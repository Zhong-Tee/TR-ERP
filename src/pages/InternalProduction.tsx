import { useEffect, useState } from 'react'
import { useAuthContext } from '../contexts/AuthContext'
import ProductionCreate from '../components/production/ProductionCreate'
import ProcessedProductSettings from '../components/production/ProcessedProductSettings'

type ActiveMenu = 'create' | 'settings'

export default function InternalProduction() {
  const { user } = useAuthContext()
  const canAccessSettings = !['store', 'production'].includes(user?.role || '')
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>(() => {
    const saved = sessionStorage.getItem('internal-production-active-menu')
    return saved === 'settings' ? 'settings' : 'create'
  })

  const changeMenu = (menu: ActiveMenu) => {
    setActiveMenu(menu)
    sessionStorage.setItem('internal-production-active-menu', menu)
  }

  const menus: { key: ActiveMenu; label: string }[] = [
    { key: 'create', label: 'สร้างผลิตภายใน' },
    ...(canAccessSettings
      ? [{ key: 'settings' as ActiveMenu, label: 'ตั้งค่าสินค้าแปรรูป' }]
      : []),
  ]

  useEffect(() => {
    if (!canAccessSettings && activeMenu === 'settings') {
      setActiveMenu('create')
      sessionStorage.setItem('internal-production-active-menu', 'create')
    }
  }, [activeMenu, canAccessSettings])

  return (
    <div className="space-y-5 mt-4">
      <div className="flex border-b border-gray-200 bg-white px-2">
        {menus.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => changeMenu(m.key)}
            className={`px-6 py-3 text-base font-semibold border-b-2 transition-colors ${
              activeMenu === m.key
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {activeMenu === 'create' && <ProductionCreate />}
      {activeMenu === 'settings' && canAccessSettings && <ProcessedProductSettings />}
    </div>
  )
}
