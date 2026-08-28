import { useState } from 'react'
import MarketPage from './pages/MarketPage'
import ProjectsPage from './pages/ProjectsPage'
import ScoutShellPage from './pages/ScoutShellPage'
import SettingsPage from './pages/SettingsPage'
import TailorPage from './pages/TailorPage'
import TopicsPage from './pages/TopicsPage'
import WorkshopPage from './pages/WorkshopPage'
import Drawer from './components/Drawer'
import ProjectDrawer from './drawers/ProjectDrawer'
import TailorDrawer from './drawers/TailorDrawer'
import Rail, { type SectionKey } from './Rail'
import Topbar from './Topbar'

export default function App() {
  const [activeSection, setActiveSection] = useState<SectionKey>('scout')
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedTailorId, setSelectedTailorId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [topicsOpen, setTopicsOpen] = useState(false)

  // 原路由行为：NavLink 到 /projects、/tailor 对 /projects/:slug、/tailor/:id 前缀匹配也会高亮——
  // 打开对应抽屉时一并切到该工位，保持"打开详情=进入该板块"的原有观感
  const openProject = (slug: string) => { setSelectedProjectSlug(slug); setActiveSection('projects') }
  const openTailor = (id: number) => { setSelectedTailorId(id); setActiveSection('tailor') }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Topbar onOpenSettings={() => setSettingsOpen(true)} onOpenTopics={() => setTopicsOpen(true)} />
      <div className="mt-4 px-7">
        <Rail active={activeSection} onChange={setActiveSection} />
      </div>
      <main className="p-7">
        {activeSection === 'scout' && <ScoutShellPage onOpenProject={openProject} />}
        {activeSection === 'projects' && <ProjectsPage onOpenProject={openProject} />}
        {activeSection === 'workshop' && <WorkshopPage onOpenProject={openProject} />}
        {activeSection === 'market' && <MarketPage onOpenTailor={openTailor} />}
        {activeSection === 'tailor' && <TailorPage onOpenTailor={openTailor} />}
      </main>

      {selectedProjectSlug && (
        <ProjectDrawer slug={selectedProjectSlug} onClose={() => setSelectedProjectSlug(null)} />
      )}
      {selectedTailorId != null && (
        <TailorDrawer id={selectedTailorId} onClose={() => setSelectedTailorId(null)} />
      )}
      {settingsOpen && (
        <Drawer onClose={() => setSettingsOpen(false)} width={720}>
          <SettingsPage />
        </Drawer>
      )}
      {topicsOpen && (
        <Drawer onClose={() => setTopicsOpen(false)} width={900}>
          <TopicsPage />
        </Drawer>
      )}
    </div>
  )
}
