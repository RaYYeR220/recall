import type { CSSProperties, ReactNode } from 'react'
import { Mark } from './Brand'
import { DemoPill } from './ui'

/** One of the 8 window segments (one per week; one per minute on the demo rail). */
export interface Segment {
  state: 'elapsed' | 'part' | 'left'
  /** For `part`: share of the segment already elapsed, "0%".."100%". */
  p?: string
}

/** elapsed / total of the refund window, spread over 8 segments. */
export function windowSegments(elapsed: number, total: number): Segment[] {
  const e = total > 0 ? Math.min(Math.max(elapsed, 0), total) / (total / 8) : 8
  return Array.from({ length: 8 }, (_, i): Segment => {
    if (e >= i + 1) return { state: 'elapsed' }
    if (e > i) return { state: 'part', p: `${((e - i) * 100).toFixed(3)}%` }
    return { state: 'left' }
  })
}

export function WindowBar({ segments, dim = false }: { segments: Segment[]; dim?: boolean }) {
  return (
    <div className={dim ? 'bar dim' : 'bar'} aria-hidden="true">
      {segments.map((s, i) =>
        s.state === 'part' ? (
          <i key={i} className="part" style={{ '--p': s.p } as CSSProperties} />
        ) : (
          <i key={i} className={s.state === 'left' ? 'on' : undefined} />
        ),
      )}
    </div>
  )
}

/** "7d 23h 41m 07s" with the small units dimmed, as in the approved hero. */
export function CountdownText({ seconds }: { seconds: number }) {
  const t = Math.max(0, Math.floor(seconds))
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    <span className="left" role="timer" aria-label={`${d} days ${h} hours ${m} minutes ${s} seconds left`}>
      {d > 0 ? (
        <>
          {d}d {h}h <small>{p(m)}m {p(s)}s</small>
        </>
      ) : h > 0 ? (
        <>
          {h}h <small>{p(m)}m {p(s)}s</small>
        </>
      ) : (
        <>
          {p(m)}m <small>{p(s)}s</small>
        </>
      )}
    </span>
  )
}

export interface NoticeCardProps {
  /** "Debit taken", "Debit announced"... */
  metaLabel: string
  metaWhen: string
  creditorName: string
  subtitle: string
  chip: ReactNode
  /** Already formatted, e.g. "€12.00". */
  amountText: string
  tokenSymbol: string
  datesLine: ReactNode
  right: ReactNode
  refunded?: boolean
  label?: string
}

/** The signature object: a debit notice. The same component renders the hero and the payer's real debits. */
export function NoticeCard(p: NoticeCardProps) {
  return (
    <article className={p.refunded ? 'notice refunded' : 'notice'} aria-label={p.label ?? `Debit from ${p.creditorName}`}>
      <div className="meta">
        <Mark muted />
        Recall <span style={{ color: 'var(--ink-4)' }}>·</span> {p.metaLabel}
        <span className="when">{p.metaWhen}</span>
      </div>
      <div className="c-left">
        <div className="who">
          <span className="avatar" aria-hidden="true">
            {p.creditorName.trim().charAt(0) || '·'}
          </span>
          <div>
            <div className="who-name">{p.creditorName}</div>
            <div className="who-sub">{p.subtitle}</div>
          </div>
          {p.chip}
        </div>
        <div className="amount">
          <b>{p.amountText}</b>
          <span>{p.tokenSymbol}</span>
        </div>
        <div className="dates">{p.datesLine}</div>
      </div>
      <div className="c-right">{p.right}</div>
    </article>
  )
}

export function WindowBlock({
  label,
  value,
  segments,
  foot,
  cover,
  demo = false,
  dim = false,
}: {
  label: ReactNode
  value: ReactNode
  segments: Segment[]
  foot: [ReactNode, ReactNode, ReactNode]
  cover?: ReactNode
  demo?: boolean
  dim?: boolean
}) {
  return (
    <div className="window">
      <div className="w-head">
        <span className="flex flex-wrap items-center gap-2">
          {label}
          {demo && <DemoPill />}
        </span>
        {value}
      </div>
      <WindowBar segments={segments} dim={dim} />
      <div className="w-foot">
        <span>{foot[0]}</span>
        <span>{foot[1]}</span>
        <span>{foot[2]}</span>
      </div>
      {cover}
    </div>
  )
}

/** "Covered by | Northwind reserve · €12.00 locked". `always` keeps it visible on narrow screens (the hero hides it). */
export function Cover({ children, always = false }: { children: ReactNode; always?: boolean }) {
  return (
    <div className={always ? 'cover always' : 'cover'}>
      <span>Covered by</span>
      <b>{children}</b>
    </div>
  )
}

export function ActBlock({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="act">
      {children}
      {note && <p>{note}</p>}
    </div>
  )
}

export function DoneBlock({ title, sub, trailing }: { title: ReactNode; sub: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="done" role="status">
      <div>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      {trailing}
    </div>
  )
}
