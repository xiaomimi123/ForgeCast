import { useRef, useState } from 'react'
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
import Topbar, { type SectionKey } from './Topbar'

export default function App() {
  const [activeSection, setActiveSection] = useState<SectionKey>('scout')
  /**
   * 「离开做内容工位」的未保存改动守卫。工位也是**条件渲染**：点面包屑切走会把 WorkshopPage
   * 连同 EditorPage 一起卸载，剪辑台里没保存的编辑态照样无声蒸发——所以同一条闸要在这一层
   * 再拦一次。WorkshopPage 通过这个 ref 把守卫挂进来（它内部再决定当前 tab 要不要转调剪辑台的
   * confirmLeave），卸载时清空；ref 为 null ＝ 没什么可丢，直接放行。
   * 用 props 传 ref 而不是让 WorkshopPage 反向 import App —— 后者会成模块环（P1 撞过 TDZ 白屏）。
   */
  const workshopLeaveGuard = useRef<(() => Promise<boolean>) | null>(null)

  /**
   * 离开做内容工位是否放行：当前不在工位或没挂守卫 → 直接放行；挂了守卫则问它
   * （确认丢弃/已保存 → true，取消 → false）。switchSection 和 openProject/openTailor
   * 共用这一条闸——后两者虽不是「切工位」触发的，但一样会把工位卸载，改动照样蒸发。
   */
  async function canLeaveWorkshop() {
    if (activeSection !== 'workshop' || !workshopLeaveGuard.current) return true
    return workshopLeaveGuard.current()
  }

  /** 切工位：只有从做内容工位离开时才查闸，其它工位互切一律直通。 */
  async function switchSection(next: SectionKey) {
    if (next === activeSection) return
    if (!(await canLeaveWorkshop())) return
    setActiveSection(next)
  }
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(null)
  const [selectedTailorId, setSelectedTailorId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [topicsOpen, setTopicsOpen] = useState(false)

  // 原路由行为：NavLink 到 /projects、/tailor 对 /projects/:slug、/tailor/:id 前缀匹配也会高亮——
  // 打开对应抽屉时一并切到该工位，保持"打开详情=进入该板块"的原有观感。
  // 同样要过 canLeaveWorkshop 这道闸：取消时不改抽屉 state，也不切工位，原地留着。
  const openProject = async (slug: string) => {
    if (!(await canLeaveWorkshop())) return
    setSelectedProjectSlug(slug)
    setActiveSection('projects')
  }
  const openTailor = async (id: number) => {
    if (!(await canLeaveWorkshop())) return
    setSelectedTailorId(id)
    setActiveSection('tailor')
  }

  return (
    <div className="min-h-screen bg-paper text-ink">
      <Topbar
        active={activeSection}
        onChange={(k) => { void switchSection(k) }}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenTopics={() => setTopicsOpen(true)}
      />
      <main className="p-7">
        {activeSection === 'scout' && <ScoutShellPage onOpenProject={openProject} />}
        {activeSection === 'projects' && <ProjectsPage onOpenProject={openProject} />}
        {activeSection === 'workshop' && <WorkshopPage onOpenProject={openProject} leaveGuardRef={workshopLeaveGuard} />}
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
