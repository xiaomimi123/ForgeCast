import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

/* 单色描边图标：16px，stroke 继承导航项文字色（currentColor），激活时随之变墨色 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

const ScoutIcon = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="20" y1="20" x2="15.5" y2="15.5" />
  </Icon>
)
const ProjectsIcon = () => (
  <Icon>
    <path d="M12 3 3 8l9 5 9-5-9-5Z" />
    <path d="M3 13l9 5 9-5" />
  </Icon>
)
const WorkshopIcon = () => (
  <Icon>
    <path d="M14.5 5.5 18.5 9.5" />
    <path d="M13 7 4 16v3h3l9-9" />
    <path d="M16 4l4 4-1.5 1.5-4-4Z" />
  </Icon>
)
const MarketIcon = () => (
  <Icon>
    <path d="M3 10v4h3l5 4V6L6 10H3Z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
    <path d="M19 6.5a8 8 0 0 1 0 11" />
  </Icon>
)
const TailorIcon = () => (
  <Icon>
    <path d="M14.5 6.5a3 3 0 0 0-4.2 4.2L4 17v3h3l6.3-6.3a3 3 0 0 0 4.2-4.2l-2.3 2.3-2-2 2.3-2.3Z" />
  </Icon>
)
const TopicsIcon = () => (
  <Icon>
    <path d="M4 5h16M4 12h10M4 19h13" />
  </Icon>
)
const SettingsIcon = () => (
  <Icon>
    <line x1="4" y1="7" x2="20" y2="7" />
    <circle cx="9" cy="7" r="2" fill="var(--color-paper)" />
    <line x1="4" y1="14" x2="20" y2="14" />
    <circle cx="15" cy="14" r="2" fill="var(--color-paper)" />
    <line x1="4" y1="21" x2="20" y2="21" />
    <circle cx="11" cy="21" r="2" fill="var(--color-paper)" />
  </Icon>
)

const NAV = [
  { to: '/scout', label: '找项目', icon: ScoutIcon },
  { to: '/projects', label: '拆解需求', icon: ProjectsIcon },
  { to: '/workshop', label: '做内容', icon: WorkshopIcon },
  { to: '/market', label: '分发营销', icon: MarketIcon },
  { to: '/tailor', label: '定制项目', icon: TailorIcon },
  { to: '/topics', label: '选题库', icon: TopicsIcon },
]

/* 锻造车间导航：激活项 3px 炉火橙左边条 + 淡橙晕底 + 加粗墨字（原 C 稿 .vc-nav 的底边条改竖栏后转左边条） */
const nav = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 border-l-[3px] px-4 py-2.5 text-[13.5px] transition-colors ${
    isActive ? 'border-fire bg-fire-soft font-bold text-ink' : 'border-transparent text-sub hover:text-ink'
  }`

export default function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-[200px] shrink-0 flex-col border-r-2 border-ink bg-paper">
      <div className="border-b-2 border-ink px-5 py-4">
        <div className="text-[17px] font-black tracking-tight">
          Forge<span className="text-fire">Cast</span>
        </div>
        <div className="mt-1 text-[10px] font-normal tracking-[2px] text-faint">开源变现内容工厂</div>
      </div>
      <nav className="flex flex-1 flex-col overflow-y-auto py-2">
        {NAV.map(({ to, label, icon: ItemIcon }) => (
          <NavLink key={to} to={to} className={nav}>
            <ItemIcon />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-hairline py-2">
        <NavLink to="/settings" className={nav}>
          <SettingsIcon />
          设置
        </NavLink>
      </div>
    </aside>
  )
}
