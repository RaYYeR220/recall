import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Brand } from './Brand'
import { ConnectButton } from './ConnectButton'
import { NetworkBadge } from './NetworkBadge'

const LINKS = [
  { to: '/pay', label: 'Pay' },
  { to: '/merchant', label: 'Merchants' },
  { to: '/proof', label: 'Proof' },
  { to: '/developers', label: 'Developers' },
] as const

/**
 * The top nav. `landing` is the approved hero nav (with "Open app"); `app` swaps that for the wallet button.
 * Both carry the network badge.
 */
export function Nav({ variant }: { variant: 'landing' | 'app' }) {
  // The menu is open for the page it was opened on, so navigating closes it without an effect.
  const { pathname } = useLocation()
  const [openAt, setOpenAt] = useState<string | null>(null)
  const open = openAt === pathname
  const setOpen = (fn: (v: boolean) => boolean) => setOpenAt(fn(open) ? pathname : null)

  return (
    <nav className={variant === 'app' ? 'nav nav-app' : 'nav'} aria-label="Primary">
      <Brand />
      <div className="links">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to}>
            {l.label}
          </NavLink>
        ))}
      </div>
      <div className="nav-right">
        <NetworkBadge />
        {variant === 'landing' ? (
          <Link className="nav-cta" to="/pay">
            Open app
          </Link>
        ) : (
          <ConnectButton />
        )}
      </div>
      <button
        className="menu"
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((v) => !v)}
      >
        <i />
        Menu
      </button>
      {open && (
        <div className="menu-panel" id="mobile-menu">
          {LINKS.map((l) => (
            <Link key={l.to} className="m-link" to={l.to}>
              {l.label}
            </Link>
          ))}
          <div className="m-row">
            <NetworkBadge />
            {variant === 'landing' ? (
              <Link className="nav-cta" to="/pay">
                Open app
              </Link>
            ) : (
              <ConnectButton />
            )}
          </div>
        </div>
      )}
    </nav>
  )
}
