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
    <div className="flex min-h-screen bg-gray-100">
      <Sidebar isOpen={sidebarOpen} onToggle={toggleSidebar} />
      <div className={`flex-1 min-w-0 transition-all duration-300 bg-white ${sidebarOpen ? 'ml-64' : 'ml-20'}`}>
        <TopBar sidebarOpen={sidebarOpen} />
        <main className="mt-16 p-6 bg-white">{children}</main>
      </div>
    </div>
  )
}
