import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import ProjectDetailPage from './pages/ProjectDetailPage'
import WorkshopPage from './pages/WorkshopPage'

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-6">
        <span className="font-bold text-lg">ForgeCast</span>
        <nav className="flex gap-4 text-sm">
          <NavLink to="/workshop" className={({ isActive }) => isActive ? 'font-semibold text-blue-600' : 'text-neutral-500'}>素材工坊</NavLink>
        </nav>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/workshop" replace />} />
          <Route path="/workshop" element={<WorkshopPage />} />
          <Route path="/projects/:slug" element={<ProjectDetailPage />} />
        </Routes>
      </main>
    </div>
  )
}
