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
      <div className="flex gap-2 text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`rounded-full border px-4 py-1.5 ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-white text-neutral-600'}`}
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
