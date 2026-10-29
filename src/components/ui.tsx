import { ArrowUpRight } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { txUrl, type RailNetwork } from '@recall/sdk'
import { shortHash } from '@/lib/format'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** A transaction hash in mono with an arrow to the explorer. */
export function TxLink({ network, hash, label }: { network: RailNetwork; hash: string; label?: string }) {
  return (
    <a
      className="tx"
      href={txUrl(network, hash)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Transaction ${hash} on the explorer`}
    >
      {label ?? shortHash(hash)}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  )
}

export function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a className={cx('tx', className)} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  )
}

export type ChipTone = 'neutral' | 'ink' | 'lime' | 'limetext' | 'danger' | 'quiet'

const TONE: Record<ChipTone, string> = {
  neutral: '',
  ink: 'chip-ink',
  lime: 'chip-lime',
  limetext: 'chip-limetext',
  danger: 'chip-danger',
  quiet: 'chip-quiet',
}

export function Chip({
  tone = 'neutral',
  dot = true,
  mono = false,
  children,
  title,
}: {
  tone?: ChipTone
  dot?: boolean
  mono?: boolean
  children: ReactNode
  title?: string
}) {
  return (
    <span className={cx('chip', TONE[tone], mono && 'chip-mono')} title={title}>
      {dot && <i aria-hidden="true" />}
      {children}
    </span>
  )
}

/** Shown wherever the demo instance is in play. */
export function DemoPill() {
  return <span className="pill-demo">1 week = 1 minute</span>
}

type Variant = 'light' | 'line' | 'accent'
const VARIANT: Record<Variant, string> = { light: 'btn-light', line: 'btn-line', accent: 'btn-accent' }

export function Button({
  variant = 'light',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'sm' | 'xs' }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx('btn', VARIANT[variant], size === 'sm' && 'btn-sm', size === 'xs' && 'btn-xs', className)}
    />
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skel', className)} aria-hidden="true" />
}

/** A designed empty state: a dashed outline, a one-line explanation and an optional next step. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="dashed flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="flex w-40 flex-col gap-2" aria-hidden="true">
        <div className="h-2 rounded-pill bg-white/[.07]" />
        <div className="h-2 w-2/3 self-center rounded-pill bg-white/[.05]" />
        <div className="mt-1 grid grid-cols-8 gap-[3px]">
          {Array.from({ length: 8 }, (_, i) => (
            <i key={i} className="h-[6px] rounded-seg bg-ink-4/70" />
          ))}
        </div>
      </div>
      <h3 className="text-[15px] font-medium tracking-tight">{title}</h3>
      {children && <p className="max-w-md text-[13.5px] leading-relaxed text-ink-3 text-pretty">{children}</p>}
      {action}
    </div>
  )
}

/** Panel for errors that explain exactly what is wrong. */
export function ErrorPanel({
  code,
  title,
  children,
  action,
}: {
  code: string
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="panel p-6 sm:p-8" role="alert">
      <span className="chip chip-danger chip-mono">
        <i aria-hidden="true" />
        {code}
      </span>
      <h2 className="mt-4 text-[22px] font-medium leading-tight tracking-[-0.03em]">{title}</h2>
      <div className="mt-2 max-w-xl text-[14.5px] leading-relaxed text-ink-2 text-pretty">{children}</div>
      {action && <div className="mt-5 flex flex-wrap items-center gap-3">{action}</div>}
    </div>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('mono', className)}>{children}</span>
}
