import { useState } from 'react'
import DemandPage from './DemandPage'
import ScoutPage from './ScoutPage'

// 找项目板块：项目池（供给侧）+ 需求信号（需求侧）两个 tab
const TABS = [
  { key: 'pool', label: '项目池' },
  { key: 'demand', label: '需求信号' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function ScoutShellPage({ onOpenProject }: { onOpenProject: (slug: string) => void }) {
  const [tab, setTab] = useState<TabKey>('pool')
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''}
            onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'pool' ? <ScoutPage onOpenProject={onOpenProject} /> : <DemandPage />}
    </div>
  )
}
