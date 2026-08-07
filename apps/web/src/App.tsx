import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import MarketPage from './pages/MarketPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutPage from './pages/ScoutPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import WorkshopPage from './pages/WorkshopPage'

const nav = ({ isActive }: { isActive: boolean }) => (isActive ? 'font-semibold text-blue-600' : 'text-neutral-500')

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">ForgeCast</span>
        <nav className="flex gap-4 text-sm">
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
