import { Navigate, Route, Routes } from 'react-router-dom'
import MarketPage from './pages/MarketPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutPage from './pages/ScoutPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import TailorDetailPage from './pages/TailorDetailPage'
import WorkshopPage from './pages/WorkshopPage'
import Sidebar from './Sidebar'

export default function App() {
  return (
    <div className="flex min-h-screen bg-paper text-ink">
      <Sidebar />
      <main className="min-w-0 flex-1 p-6">
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

