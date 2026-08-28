import { useState } from 'react'
import CalendarPage from './CalendarPage'
import ReviewPage from './ReviewPage'

const TABS = [
  { key: 'calendar', label: '发布日历' },
  { key: 'review', label: '数据复盘' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function MarketPage({ onOpenTailor }: { onOpenTailor: (id: number) => void }) {
  const [tab, setTab] = useState<TabKey>('calendar')
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'calendar' ? <CalendarPage /> : <ReviewPage onOpenTailor={onOpenTailor} />}
    </div>
  )
}
