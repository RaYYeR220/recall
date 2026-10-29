import { Outlet } from 'react-router-dom'
import { Footer } from './Footer'
import { Nav } from './Nav'

export function AppLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <Nav variant="app" />
      <div className="flex-1">
        <Outlet />
      </div>
      <Footer />
    </div>
  )
}
