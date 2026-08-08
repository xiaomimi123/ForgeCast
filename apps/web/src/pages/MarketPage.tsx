import { useSearchParams } from 'react-router-dom'
import CalendarPage from './CalendarPage'
import ReviewPage from './ReviewPage'

// 分发营销板块：发布日历 + 数据复盘两个 tab（组件不重写，只套壳）
const TABS = [
  { key: 'calendar', label: '发布日历' },
  { key: 'review', label: '数据复盘' },
] as const
type TabKey = (typeof TABS)[number]['key']

function normalizeTab(v: string | null): TabKey {
  return v === 'review' ? 'review' : 'calendar'
}

export default function MarketPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = normalizeTab(searchParams.get('tab'))
  return (
    <div className="space-y-4">
      <div className="seg-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'on' : ''}
            onClick={() => setSearchParams({ tab: t.key }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'calendar' ? <CalendarPage /> : <ReviewPage />}
    </div>
  )
}
