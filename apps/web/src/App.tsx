import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import BoardPage from './pages/BoardPage'
import CalendarPage from './pages/CalendarPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ReviewPage from './pages/ReviewPage'
import SettingsPage from './pages/SettingsPage'
import WorkshopPage from './pages/WorkshopPage'

const nav = ({ isActive }: { isActive: boolean }) => (isActive ? 'font-semibold text-blue-600' : 'text-neutral-500')

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">ForgeCast</span>
        <nav className="flex gap-4 text-sm">
          <NavLink to="/board" className={nav}>项目看板</NavLink>
          <NavLink to="/workshop" className={nav}>素材工坊</NavLink>
          <NavLink to="/calendar" className={nav}>发布日历</NavLink>
          <NavLink to="/review" className={nav}>数据复盘</NavLink>
          <NavLink to="/settings" className={nav}>设置</NavLink>
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/workshop" replace />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
        </Routes>
      </main>
    </div>
  )
}
