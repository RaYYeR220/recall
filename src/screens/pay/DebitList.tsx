import type { ReactNode } from 'react'
import { ActionButtons } from '@/components/ActionButtons'
import { CountdownText } from '@/components/NoticeCard'
import { Chip, EmptyState } from '@/components/ui'
import { durationText, fmtDay, fmtDayTime, fmtMoment, formatToken, refText } from '@/lib/format'
import { refundDeadlineOf, statusOf, type DebitItem, type Windows } from '@/lib/model'
import type { ActionApi } from './FeatureCard'

export function SectionHead({ title, count, hint }: { title: string; count?: number; hint?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-[19px] font-medium tracking-[-0.03em]">{title}</h2>
      {count !== undefined && <span className="mono text-[12px] text-ink-3">{count}</span>}
      {hint && <span className="text-[12.5px] text-ink-3">{hint}</span>}
    </div>
  )
}

function Row({ item, now, w, children, sub }: { item: DebitItem; now: number; w: Windows; children?: ReactNode; sub: ReactNode }) {
  const st = statusOf(item, now, w)
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5">
      <span className="avatar !h-9 !w-9 !text-[14px]" aria-hidden="true">
        {item.creditorName.trim().charAt(0) || '·'}
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-[14.5px] font-medium tracking-tight">{item.creditorName}</div>
        <div className="mono truncate text-[11.5px] text-ink-3">{sub}</div>
      </div>
      <div className="mono text-right text-[15px] tabular-nums">
        {formatToken(item.collection.amount, item.symbol)}
        <span className="ml-1.5 text-[11px] text-ink-3">{item.symbol}</span>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:w-auto sm:justify-end">
        <Chip tone={st.tone}>{st.text}</Chip>
        {children}
      </div>
    </li>
  )
}

function List({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul className="panel divide-y divide-line overflow-hidden" aria-label={label}>
      {children}
    </ul>
  )
}

export function UpcomingList({ items, now, w, actions }: { items: DebitItem[]; now: number; w: Windows; actions: ActionApi }) {
  if (items.length === 0) {
    return (
      <EmptyState title="Nothing is announced right now.">
        When a merchant plans a debit you see it here at least a day ahead (a few seconds on the demo rail), with a Refuse button.
      </EmptyState>
    )
  }
  return (
    <List label="Upcoming debits">
      {items.map((it) => (
        <Row
          key={it.key}
          item={it}
          now={now}
          w={w}
          sub={`${refText(it.mandate.offerRef)} · due ${fmtDayTime(it.collection.dueAt)}`}
        >
          <span className="mono text-[12px] text-ink-2">
            in <CountdownText seconds={Number(it.collection.dueAt) - now} />
          </span>
          <ActionButtons
            label="Refuse"
            tone="plain"
            busy={actions.busyKey === `refuse:${it.collectionId}`}
            disabled={!!actions.blocked}
            disabledReason={actions.blocked}
            onRun={(p) => void actions.refuse(it.collectionId, p)}
          />
        </Row>
      ))}
    </List>
  )
}

export function RefundableList({ items, now, w, actions }: { items: DebitItem[]; now: number; w: Windows; actions: ActionApi }) {
  if (items.length === 0) {
    return (
      <EmptyState title="No debit is inside its refund window.">
        After any Core debit you get {durationText(Number(w.refundWindow))} to take it back in full. It shows up here with a live
        countdown.
      </EmptyState>
    )
  }
  return (
    <List label="Refundable debits">
      {items.map((it) => {
        const deadline = refundDeadlineOf(it, w)
        return (
          <Row
            key={it.key}
            item={it}
            now={now}
            w={w}
            sub={`${refText(it.mandate.offerRef)} · taken ${fmtMoment(it.collection.settledAt, it.instance === 'demo')}`}
          >
            <span className="mono text-[12px] text-ink-2">
              <CountdownText seconds={deadline - now} />
            </span>
            <ActionButtons
              label="Refund"
              tone="right"
              size="sm"
              busy={actions.busyKey === `refund:${it.collectionId}`}
              disabled={!!actions.blocked}
              disabledReason={actions.blocked}
              onRun={(p) => void actions.refund(it.collectionId, p)}
            />
          </Row>
        )
      })}
    </List>
  )
}

export function HistoryList({
  items,
  now,
  w,
  more,
}: {
  items: DebitItem[]
  now: number
  w: Windows
  more?: ReactNode
}) {
  if (items.length === 0) {
    return (
      <EmptyState title="No history yet.">
        Paid, refunded, returned and refused debits are listed here, each with its ISO 20022 reason code.
      </EmptyState>
    )
  }
  return (
    <>
      <List label="Debit history">
        {items.map((it) => (
          <Row
            key={it.key}
            item={it}
            now={now}
            w={w}
            sub={`${refText(it.mandate.offerRef)} · ${fmtDay(it.collection.settledAt > 0n ? it.collection.settledAt : it.collection.dueAt)}`}
          />
        ))}
      </List>
      {more}
    </>
  )
}
