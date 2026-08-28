import { useEffect, useState, type ReactNode } from 'react'

/** 通用右侧抽屉外壳：Esc/点遮罩关闭 + 滑入过渡。从 CandidateDrawer.tsx 抽出，ProjectDrawer/TailorDrawer 复用。 */
export default function Drawer({ onClose, width = 480, children }: { onClose: () => void; width?: number; children: ReactNode }) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  useEffect(() => { requestAnimationFrame(() => setEntered(true)) }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <div
        className={`absolute right-0 top-0 h-full w-full overflow-y-auto bg-paper border-l-2 border-ink p-5 shadow-xl transition-transform duration-200 ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
