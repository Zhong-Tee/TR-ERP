import { useState } from 'react'
import ProductionCreate from '../components/production/ProductionCreate'
import ProcessedProductSettings from '../components/production/ProcessedProductSettings'

type ActiveMenu = 'create' | 'settings'

export default function InternalProduction() {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>('create')

  const menus: { key: ActiveMenu; label: string }[] = [
    { key: 'create', label: 'สร้างผลิตภายใน' },
    { key: 'settings', label: 'ตั้งค่าสินค้าแปรรูป' },
  ]

  return (
    <div className="space-y-5 mt-4">
      <div className="flex border-b border-gray-200 bg-white px-2">
        {menus.map((m) => (
          <button
            key={m.key}
            onClick={() => setActiveMenu(m.key)}
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
      {activeMenu === 'settings' && <ProcessedProductSettings />}
    </div>
  )
}
