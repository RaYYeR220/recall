import type { ReactNode } from 'react'
import { CollectionStatus, Scheme } from '@recall/sdk'
import { ActionButtons } from '@/components/ActionButtons'
import { ActBlock, Cover, CountdownText, DoneBlock, NoticeCard, WindowBlock, windowSegments } from '@/components/NoticeCard'
import { Chip, TxLink } from '@/components/ui'
import { useRefundTx } from '@/hooks/useRefundTx'
import type { Path } from '@/hooks/usePayerActions'
import { durationText, fmtDay, fmtDayTime, fmtMoment, formatToken, refText } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { bucketOf, refundDeadlineOf, statusOf, type DebitItem, type Windows } from '@/lib/model'

export interface ActionApi {
  busyKey: string | null
  blocked: string | undefined
  refund: (id: DebitItem['collectionId'], p: Path) => Promise<void>
  refuse: (id: DebitItem['collectionId'], p: Path) => Promise<void>
}

/** The one important object on /pay: the next refundable debit, drawn with the signature debit notice. */
export function FeatureCard({ item, now, w, actions }: { item: DebitItem; now: number; w: Windows; actions: ActionApi }) {
  const { network } = useNetwork()
  const c = item.collection
  const demo = item.instance === 'demo'
  const bucket = bucketOf(item, now, w)
  const st = statusOf(item, now, w)
  const refunded = c.status === CollectionStatus.REFUNDED
  const refundTx = useRefundTx(network, item.instance, item.collectionId, Number(c.settledAt), refunded)

  const refundWindow = Number(w.refundWindow)
  const settledAt = Number(c.settledAt)
  const deadline = refundDeadlineOf(item, w)
  const amountText = formatToken(c.amount, item.symbol)
  const name = item.creditorName
  const ref = refText(item.mandate.offerRef)

  let metaLabel = 'Debit taken'
  let metaWhen = settledAt > 0 ? fmtDayTime(settledAt) : ''
  let right: ReactNode

  const coverText =
    c.locked > 0n
      ? `${name} reserve · ${formatToken(c.locked, item.symbol)} locked${c.held > 0n ? ` · ${formatToken(c.held, item.symbol)} held` : ''}`
      : c.held > 0n
        ? `Held by the contract · ${formatToken(c.held, item.symbol)}`
        : `${name} reserve`

  if (bucket === 'refundable') {
    right = (
      <>
        <WindowBlock
          demo={demo}
          label="Refundable"
          value={<CountdownText seconds={deadline - now} />}
          segments={windowSegments(now - settledAt, refundWindow)}
          foot={[fmtMoment(settledAt, demo), durationText(refundWindow), fmtMoment(deadline, demo)]}
          cover={<Cover always>{coverText}</Cover>}
        />
        <ActBlock note={c.locked > 0n ? `Paid back at once from ${name}’s reserve.` : 'Paid back at once from funds the contract holds.'}>
          <ActionButtons
            label="Take it back"
            tone="right"
            busy={actions.busyKey === `refund:${item.collectionId}`}
            disabled={!!actions.blocked}
            disabledReason={actions.blocked}
            onRun={(p) => void actions.refund(item.collectionId, p)}
          />
        </ActBlock>
      </>
    )
  } else if (refunded) {
    right = (
      <>
        <WindowBlock
          dim
          demo={demo}
          label="Refunded"
          value={<span className="left">MD06</span>}
          segments={windowSegments(refundWindow, refundWindow)}
          foot={[fmtMoment(settledAt, demo), durationText(refundWindow), fmtMoment(deadline, demo)]}
          cover={<Cover always>{coverText}</Cover>}
        />
        <DoneBlock
          title={`${amountText} back in your wallet`}
          sub={
            <>
              Paid from {c.locked > 0n ? `${name}’s reserve` : 'held funds'}
              {refundTx.data ? (
                <>
                  {' · '}
                  <TxLink network={network} hash={refundTx.data} />
                </>
              ) : null}
            </>
          }
        />
      </>
    )
  } else if (bucket === 'upcoming') {
    metaLabel = 'Debit announced'
    metaWhen = fmtDayTime(c.dueAt)
    right = (
      <>
        <WindowBlock
          dim
          demo={demo}
          label="Due in"
          value={<CountdownText seconds={Number(c.dueAt) - now} />}
          segments={windowSegments(0, refundWindow)}
          foot={[fmtMoment(c.dueAt, demo), `then ${durationText(refundWindow)} to refund`, '']}
        />
        <ActBlock note="Refuse it before it runs and it never will.">
          <ActionButtons
            label="Refuse"
            tone="plain"
            busy={actions.busyKey === `refuse:${item.collectionId}`}
            disabled={!!actions.blocked}
            disabledReason={actions.blocked}
            onRun={(p) => void actions.refuse(item.collectionId, p)}
          />
        </ActBlock>
      </>
    )
  } else if (c.status === CollectionStatus.RETURNED || c.status === CollectionStatus.REFUSED || c.status === CollectionStatus.EXPIRED || c.status === CollectionStatus.CANCELLED) {
    metaLabel = 'Debit not taken'
    metaWhen = fmtDayTime(c.dueAt)
    right = (
      <>
        <WindowBlock
          dim
          demo={demo}
          label="Nothing was taken"
          value={<span className="left">{st.text.split(' · ')[1] ?? st.text}</span>}
          segments={windowSegments(0, refundWindow)}
          foot={[fmtMoment(c.dueAt, demo), '', '']}
        />
        <DoneBlock title="Your wallet was not charged" sub={`Due ${fmtDay(c.dueAt)} · ${st.text}`} />
      </>
    )
  } else {
    const b2b = item.mandate.scheme === Scheme.B2B
    right = (
      <>
        <WindowBlock
          dim
          demo={demo}
          label={b2b ? 'Final · B2B' : 'Window closed'}
          value={<span className="left">{b2b ? 'no refund right' : fmtMoment(deadline, demo)}</span>}
          segments={windowSegments(refundWindow, refundWindow)}
          foot={[fmtMoment(settledAt, demo), durationText(refundWindow), fmtMoment(deadline, demo)]}
        />
        <DoneBlock title="Paid, and final" sub={b2b ? 'Business mandates carry no refund right.' : 'The refund window has closed.'} />
      </>
    )
  }

  return (
    <NoticeCard
      refunded={refunded}
      metaLabel={metaLabel}
      metaWhen={metaWhen}
      creditorName={name}
      subtitle={`Mandate ${ref}`}
      amountText={amountText}
      tokenSymbol={item.symbol}
      datesLine={`Mandate ${ref} · due ${fmtDay(c.dueAt)}`}
      chip={
        <Chip tone={st.tone} mono={false}>
          {st.text}
        </Chip>
      }
      right={right}
    />
  )
}
