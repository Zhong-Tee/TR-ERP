import { useState } from 'react'
import AssetRegistry from './AssetRegistry'
import AssetHistory from './AssetHistory'

type SubTab = 'list' | 'history'

const TABS: { key: SubTab; label: string }[] = [
  { key: 'list', label: 'รายการทรัพย์สิน' },
  { key: 'history', label: 'ประวัติทรัพย์สิน' },
]

export default function AssetRegistryPage() {
  const [tab, setTab] = useState<SubTab>('list')

  return (
    <div className="mt-4">
      <div className="flex gap-2 border-b border-surface-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-t-xl font-medium text-sm ${
              tab === t.key
                ? 'bg-emerald-100 text-emerald-800 border border-b-0 border-emerald-200'
                : 'bg-surface-50 text-gray-600 hover:bg-surface-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'list' ? <AssetRegistry /> : <AssetHistory />}
    </div>
  )
}
