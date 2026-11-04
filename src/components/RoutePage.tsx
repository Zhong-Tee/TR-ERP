import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

class PageLoadBoundary extends Component<{ children: ReactNode; pathname: string }, { failed: boolean; pathname: string }> {
  state = { failed: false, pathname: '' }
  static getDerivedStateFromProps(props: { pathname: string }, state: { pathname: string }) {
    return props.pathname === state.pathname ? null : { failed: false, pathname: props.pathname }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page load failed:', error, info.componentStack)
  }
  render() {
    if (this.state.failed) return (
      <div role="alert" className="p-8 text-center text-slate-700">
        <p>เปิดหน้านี้ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองโหลดใหม่</p>
        <button type="button" className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white"
          onClick={() => window.location.reload()}>โหลดใหม่</button>
      </div>
    )
    return this.props.children
  }
}

/** Keep desktop navigation visible while only the requested page downloads. */
export default function RoutePage({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <PageLoadBoundary pathname={pathname}>
      <Suspense fallback={
        <div role="status" className="flex items-center justify-center gap-3 py-20 text-slate-600">
          <span aria-hidden="true" className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
          กำลังเปิดหน้า…
        </div>
      }>{children}</Suspense>
    </PageLoadBoundary>
  )
}
