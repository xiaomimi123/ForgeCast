import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import MarketPage from './pages/MarketPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutPage from './pages/ScoutPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import TailorDetailPage from './pages/TailorDetailPage'
import WorkshopPage from './pages/WorkshopPage'

/* 锻造车间导航：激活项 3px 炉火橙底边，文字加粗（C 稿 .vc-nav） */
const nav = ({ isActive }: { isActive: boolean }) =>
  `px-3 pb-[14px] pt-[17px] text-[13.5px] border-b-[3px] -mb-[2px] ${
    isActive ? 'font-bold text-ink border-fire' : 'text-sub border-transparent'
  }`

export default function App() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="flex h-14 items-center gap-7 border-b-2 border-ink bg-paper px-6">
        <span className="text-[17px] font-black tracking-tight">
          Forge<span className="text-fire">Cast</span>
          <i className="ml-2 text-[10px] font-normal not-italic tracking-[2px] text-faint">开源变现内容工厂</i>
        </span>
        <nav className="flex self-stretch">
          <NavLink to="/scout" className={nav}>找项目</NavLink>
          <NavLink to="/projects" className={nav}>拆解需求</NavLink>
          <NavLink to="/workshop" className={nav}>做内容</NavLink>
          <NavLink to="/market" className={nav}>分发营销</NavLink>
          <NavLink to="/tailor" className={nav}>定制项目</NavLink>
          <NavLink to="/settings" className={nav}>设置</NavLink>
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/scout" replace />} />
          <Route path="/scout" element={<ScoutPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/tailor" element={<TailorPage />} />
          <Route path="/tailor/:id" element={<TailorDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
          {/* 旧路由重定向：书签/肌肉记忆兼容 */}
          <Route path="/board" element={<Navigate to="/scout" replace />} />
          <Route path="/calendar" element={<Navigate to="/market?tab=calendar" replace />} />
          <Route path="/review" element={<Navigate to="/market?tab=review" replace />} />
        </Routes>
      </main>
    </div>
  )
}
