import { useState } from 'react'
import ProductionCreate from '../components/production/ProductionCreate'
import ProcessedProductSettings from '../components/production/ProcessedProductSettings'

type ActiveMenu = 'create' | 'settings'

export default function InternalProduction() {
  const [activeMenu, setActiveMenu] = useState<ActiveMenu>('create')

  const menus: { key: ActiveMenu; label: string; icon: string }[] = [
    { key: 'create', label: 'สร้างผลิตภายใน', icon: 'fa-plus-circle' },
    { key: 'settings', label: 'ตั้งค่าสินค้าแปรรูป', icon: 'fa-cog' },
  ]

  return (
    <div className="space-y-5 mt-4">
      <div className="flex gap-3">
        {menus.map((m) => (
          <button
            key={m.key}
            onClick={() => setActiveMenu(m.key)}
            className={`px-6 py-3 rounded-xl text-base font-semibold transition-all ${
              activeMenu === m.key
                ? 'bg-blue-600 text-white shadow-md'
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <i className={`fas ${m.icon} mr-2 text-lg`}></i>
            {m.label}
          </button>
        ))}
      </div>

      {activeMenu === 'create' && <ProductionCreate />}
      {activeMenu === 'settings' && <ProcessedProductSettings />}
    </div>
  )
}
