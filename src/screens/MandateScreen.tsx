import { RefreshCw } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { CheckoutLinkError, decodeCheckoutToken, type CheckoutLinkPayload } from '@recall/sdk'
import { Button, ErrorPanel, Skeleton } from '@/components/ui'
import { NotDeployed } from '@/components/NotDeployed'
import { useDeployed } from '@/hooks/useDeployed'
import { useOfferCheck } from '@/hooks/useOfferCheck'
import { fmtDate, shortAddress } from '@/lib/format'
import { NETWORK_LABEL, useNetwork } from '@/lib/network'
import { SignCard } from './mandate/SignCard'
import { Summary } from './mandate/Summary'

type Decoded = { ok: true; payload: CheckoutLinkPayload } | { ok: false; message: string }

/** The token travels in the path (`/m/<token>`) or, for long mandate texts, in the fragment (`/m/x#r=<token>`). */
function decodeFromLocation(pathToken: string | undefined, hash: string): Decoded {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('r')
  const token = fromHash ?? pathToken
  if (!token) return { ok: false, message: 'This link has no mandate in it.' }
  try {
    return { ok: true, payload: decodeCheckoutToken(token) }
  } catch (e) {
    return { ok: false, message: e instanceof CheckoutLinkError ? e.message : 'The link could not be read.' }
  }
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">{children}</main>
}

function Narrow({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <div className="mx-auto max-w-xl">{children}</div>
    </Shell>
  )
}

/** /m/:link — the payer's first touch. Decode, verify against the chain, explain in plain language, then sign. */
export function MandateScreen() {
  const { link } = useParams()
  const { hash } = useLocation()
  const { network: appNetwork, setNetwork } = useNetwork()

  const decoded = useMemo(() => decodeFromLocation(link, hash), [link, hash])
  const payload = decoded.ok ? decoded.payload : null
  const wrongNetwork = !!payload && payload.network !== appNetwork
  const deployed = useDeployed(payload?.network ?? appNetwork, payload?.instance ?? 'prod')
  const check = useOfferCheck(payload && !wrongNetwork && deployed.data !== false ? payload : null)

  // 1. a damaged or edited link
  if (!decoded.ok) {
    return (
      <Narrow>
        <ErrorPanel
          code="LinkInvalid"
          title="This link is damaged, or someone edited it."
          action={
            <Link className="btn btn-line btn-sm" to="/">
              Back home
            </Link>
          }
        >
          {decoded.message} Nothing was signed. Ask the merchant to send the link again.
        </ErrorPanel>
      </Narrow>
    )
  }

  const { payload: p } = decoded
  const { offer } = p

  // 2. the link is for the other network
  if (wrongNetwork) {
    return (
      <Narrow>
        <ErrorPanel
          code="WrongNetwork"
          title={`This mandate lives on ${NETWORK_LABEL[p.network]}.`}
          action={
            <Button size="sm" onClick={() => setNetwork(p.network)}>
              Switch to {NETWORK_LABEL[p.network]}
            </Button>
          }
        >
          You are viewing {NETWORK_LABEL[appNetwork]}. A mandate can only be accepted on the network it was signed for.
        </ErrorPanel>
      </Narrow>
    )
  }

  if (deployed.data === false) {
    return (
      <Shell>
        <NotDeployed network={p.network} instance={p.instance} />
      </Shell>
    )
  }

  // loading / read failure
  if (check.isError) {
    return (
      <Narrow>
        <ErrorPanel
          code="RpcError"
          title="Couldn't check this mandate against Arc."
          action={
            <Button variant="line" size="sm" onClick={() => void check.refetch()}>
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </Button>
          }
        >
          The link looks fine but the network didn&rsquo;t answer, so nothing can be verified yet. Nothing was signed.
        </ErrorPanel>
      </Narrow>
    )
  }
  if (!check.data) {
    return (
      <Shell>
        <div className="grid gap-8 lg:grid-cols-[1.35fr_1fr]" aria-busy="true" aria-label="Checking the mandate against the chain">
          <div className="space-y-4">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-24 w-full max-w-xl" />
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-[76px]" />
              ))}
            </div>
          </div>
          <Skeleton className="h-80" />
        </div>
      </Shell>
    )
  }

  const c = check.data

  // 3. the creditor does not exist, the signature is not theirs, or the token is not supported
  if (!c.creditor) {
    return (
      <Narrow>
        <ErrorPanel code="UnknownCreditor" title="This creditor isn't registered on this rail.">
          Creditor #{offer.creditorId.toString()} does not exist on the {p.instance} rail on {NETWORK_LABEL[p.network]}.
          Don&rsquo;t sign.
        </ErrorPanel>
      </Narrow>
    )
  }
  if (!c.signature.valid) {
    return (
      <Narrow>
        <ErrorPanel code="BadSignature" title="The creditor's signature doesn't check out.">
          {c.signature.reason ?? 'The offer was not signed by the creditor or one of its operators.'} The terms may have been
          changed after they were signed. Don&rsquo;t sign.
        </ErrorPanel>
      </Narrow>
    )
  }
  if (!c.token) {
    return (
      <Narrow>
        <ErrorPanel code="TokenNotAllowed" title="This offer asks for a token the rail does not accept.">
          Only EURC and USDC work. The offer names <span className="mono">{shortAddress(offer.token)}</span>. Don&rsquo;t sign.
        </ErrorPanel>
      </Narrow>
    )
  }

  // 4. cancelled, expired, used up
  if (c.cancelled) {
    return (
      <Narrow>
        <ErrorPanel code="OfferCancelled_" title="The creditor cancelled this offer.">
          It can no longer be accepted. Ask {c.creditor.name} for a new link.
        </ErrorPanel>
      </Narrow>
    )
  }
  if (offer.validUntil > 0n && BigInt(c.chainTime) > offer.validUntil) {
    return (
      <Narrow>
        <ErrorPanel code="OfferExpired" title={`This offer expired on ${fmtDate(offer.validUntil)}.`}>
          It could only be accepted until then. Ask {c.creditor.name} for a new link.
        </ErrorPanel>
      </Narrow>
    )
  }
  if (offer.maxUses > 0 && c.uses >= offer.maxUses) {
    return (
      <Narrow>
        <ErrorPanel code="OfferUsedUp" title="This offer has already been accepted the maximum number of times.">
          Ask {c.creditor.name} for a new link.
        </ErrorPanel>
      </Narrow>
    )
  }

  return (
    <Shell>
      <div className="grid gap-10 lg:grid-cols-[1.35fr_1fr] lg:gap-14">
        <Summary payload={p} check={c} token={c.token} creditorName={c.creditor.name} />
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SignCard payload={p} token={c.token} chainTime={c.chainTime} />
        </div>
      </div>
    </Shell>
  )
}
