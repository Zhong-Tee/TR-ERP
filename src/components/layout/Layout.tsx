import { ReactNode, useState, useEffect } from 'react'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('sidebarOpen')
    return saved !== null ? saved === 'true' : true
  })

  useEffect(() => {
    localStorage.setItem('sidebarOpen', String(sidebarOpen))
  }, [sidebarOpen])

  const toggleSidebar = () => {
    setSidebarOpen(!sidebarOpen)
  }

  return (
    <div className="flex h-screen min-h-0 bg-gradient-to-br from-primary-50 via-secondary-50 to-accent-50 overflow-hidden">
      <Sidebar isOpen={sidebarOpen} onToggle={toggleSidebar} />
      <div
        className={`flex-1 min-w-0 min-h-0 flex flex-col transition-all duration-300 bg-transparent ${sidebarOpen ? 'ml-64' : 'ml-20'}`}
        style={{ ['--content-offset-left' as string]: sidebarOpen ? '16rem' : '5rem' } as React.CSSProperties}
      >
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
        <main
          className="flex-1 min-h-0 overflow-auto flex flex-col px-6 pb-6 bg-transparent relative z-0"
          style={{ paddingTop: 'calc(4rem + var(--subnav-height, 0rem))' }}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
