import { useSearchParams } from 'react-router-dom'
import DemandPage from './DemandPage'
import ScoutPage from './ScoutPage'

// 找项目板块：项目池（供给侧）+ 需求信号（需求侧）两个 tab
const TABS = [
  { key: 'pool', label: '项目池' },
  { key: 'demand', label: '需求信号' },
] as const
type TabKey = (typeof TABS)[number]['key']

function normalizeTab(v: string | null): TabKey {
  return v === 'demand' ? 'demand' : 'pool'
}

export default function ScoutShellPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = normalizeTab(searchParams.get('tab'))
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''}
            onClick={() => setSearchParams({ tab: t.key }, { replace: true })}>{t.label}</button>
        ))}
      </div>
      {tab === 'pool' ? <ScoutPage /> : <DemandPage />}
    </div>
  )
}
