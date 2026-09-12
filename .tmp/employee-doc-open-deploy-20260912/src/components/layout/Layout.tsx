import { ReactNode, useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (window.matchMedia('(max-width: 767px)').matches) return false
    const saved = localStorage.getItem('sidebarOpen')
    return saved !== null ? saved === 'true' : true
  })

  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) {
      localStorage.setItem('sidebarOpen', String(sidebarOpen))
    }
  }, [sidebarOpen])

  useEffect(() => {
    if (window.matchMedia('(max-width: 767px)').matches) setSidebarOpen(false)
  }, [location.pathname])

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen)
  }

  return (
    <div className="flex h-screen min-h-0 bg-slate-50 overflow-hidden">
      <Sidebar isOpen={sidebarOpen} onToggle={toggleSidebar} />
      {sidebarOpen && (
        <button
          type="button"
          aria-label="ปิดเมนู"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/40 md:hidden"
        />
      )}
      <div
        className={`ml-0 flex min-h-0 min-w-0 flex-1 flex-col bg-transparent transition-all duration-300 [--content-offset-left:0rem] ${sidebarOpen ? 'md:ml-64 md:[--content-offset-left:16rem]' : 'md:ml-20 md:[--content-offset-left:5rem]'}`}
      >
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
        <main
          data-app-scroll-container
          className="relative z-0 flex min-h-0 flex-1 flex-col overflow-auto bg-transparent px-3 pb-4 sm:px-4 md:px-6 md:pb-6"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
