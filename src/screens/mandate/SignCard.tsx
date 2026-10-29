import { useQueryClient } from '@tanstack/react-query'
import { Check, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Hex } from 'viem'
import {
  decodeRailError,
  MandateStatus,
  RelayError,
  ZERO_ADDRESS,
  type CheckoutLinkPayload,
  type MandateAcceptance,
  type PermitData,
  type TokenInfo,
} from '@recall/sdk'
import { ConnectButton } from '@/components/ConnectButton'
import { Button, Chip, Skeleton, TxLink } from '@/components/ui'
import { useExistingMandate } from '@/hooks/useExistingMandate'
import { useWalletFigures } from '@/hooks/useBalances'
import { useRail, useWallet } from '@/hooks/useWallet'
import { isUserRejection, runTx } from '@/lib/actions'
import { formatToken, mandateReference, shortAddress } from '@/lib/format'
import { notify } from '@/lib/notify'
import { NETWORK_LABEL } from '@/lib/network'

/** The permit grants the current allowance plus this many periods of the cap. Never unlimited. */
const PERIODS_OF_ALLOWANCE = 12n

type Step = 'idle' | 'acceptance' | 'permit' | 'submitting' | 'signed' | 'done'

interface Signed {
  acceptance: MandateAcceptance
  sig: Hex
  permit: PermitData
}

function Stepper({ step, hasTx }: { step: Step; hasTx: boolean }) {
  const order: Step[] = ['acceptance', 'permit', 'submitting']
  const idx = order.indexOf(step)
  const reached = (i: number) => step === 'signed' || step === 'done' || (idx >= 0 && idx > i)
  const items = [
    { label: 'Sign the acceptance', i: 0 },
    { label: 'Sign the allowance permit', i: 1 },
    { label: 'Submit to Arc', i: 2 },
  ]
  return (
    <ol className="mt-4 space-y-2" aria-label="Progress">
      {items.map(({ label, i }) => {
        const done = i === 2 ? step === 'done' || hasTx : reached(i)
        const active = idx === i
        return (
          <li key={label} className="flex items-center gap-2.5 text-[13px]" aria-current={active ? 'step' : undefined}>
            <span
              className={`grid h-5 w-5 flex-none place-items-center rounded-full text-[10px] ${
                done ? 'bg-accent text-ground' : active ? 'ring-1 ring-accent text-accent' : 'ring-1 ring-line-2 text-ink-3'
              }`}
            >
              {done ? <Check size={11} aria-hidden="true" /> : active ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : i + 1}
            </span>
            <span className={done || active ? 'text-ink' : 'text-ink-3'}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function SignCard({ payload, token, chainTime }: { payload: CheckoutLinkPayload; token: TokenInfo; chainTime: number }) {
  const { offer, network, instance } = payload
  const { address, isConnected, wrongChain, walletClient, ensureChain, switching } = useWallet()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const figures = useWalletFigures(network, address)
  const existing = useExistingMandate(payload, address)

  const [step, setStep] = useState<Step>('idle')
  const [signed, setSigned] = useState<Signed | null>(null)
  const [relayError, setRelayError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<Hex | null>(null)

  const sym = token.symbol === 'EURC' ? 'eurc' : 'usdc'
  const current = figures.data?.allowance[instance][sym]
  const balance = figures.data ? figures.data[sym] : undefined
  const permitValue = current !== undefined ? current + PERIODS_OF_ALLOWANCE * offer.maxPerPeriod : undefined

  const notYours = offer.debtor !== ZERO_ADDRESS && !!address && offer.debtor.toLowerCase() !== address.toLowerCase()
  const status = existing.data?.status
  const busy = step === 'acceptance' || step === 'permit' || step === 'submitting'

  async function submit(s: Signed, path: 'relay' | 'self') {
    setStep('submitting')
    setRelayError(null)
    const res = await runTx({
      network,
      pendingTitle: 'Activate mandate',
      title: 'Mandate active',
      successDetail: 'You can see it, and take it back, from Pay.',
      send: () =>
        path === 'relay'
          ? rail.relayActivate(offer, payload.offerSig, s.acceptance, s.sig, s.permit)
          : rail.activate(offer, payload.offerSig, s.acceptance, s.sig, s.permit),
      onError: (e) => {
        if (e instanceof RelayError) {
          setRelayError(e.message)
          return true
        }
        return false
      },
    })
    if (res.ok && res.hash) {
      setTxHash(res.hash)
      setStep('done')
      await qc.invalidateQueries({ queryKey: ['existing-mandate'] })
      await qc.invalidateQueries({ queryKey: ['wallet-figures'] })
      await qc.invalidateQueries({ queryKey: ['debtor'] })
    } else {
      setStep('signed')
    }
  }

  async function signAndSend(path: 'relay' | 'self') {
    if (!address || !walletClient || permitValue === undefined) return
    try {
      await ensureChain()
      setStep('acceptance')
      const { acceptance, sig } = await rail.signAcceptance(offer)
      setStep('permit')
      const permit = await rail.signPermit(offer.token, permitValue, acceptance.deadline)
      const s = { acceptance, sig, permit }
      setSigned(s)
      await submit(s, path)
    } catch (e) {
      setStep(signed ? 'signed' : 'idle')
      if (isUserRejection(e)) {
        notify.info({ title: 'Cancelled', detail: 'Nothing was signed or sent.' })
        return
      }
      const err = decodeRailError(e)
      notify.info({ title: 'Could not sign', detail: err.message, duration: 10_000 })
    }
  }

  // ── done ──
  if (step === 'done' && address) {
    return (
      <div className="panel p-6" role="status">
        <Chip tone="lime">Mandate active</Chip>
        <h2 className="mt-4 text-[22px] font-medium leading-tight tracking-[-0.03em]">You&rsquo;re set.</h2>
        <dl className="mt-4 space-y-3 text-[13.5px]">
          <div>
            <dt className="text-ink-3">Mandate reference</dt>
            <dd className="mono mt-1 break-all text-ink">{mandateReference(offer.offerRef, address)}</dd>
          </div>
          {txHash && (
            <div>
              <dt className="text-ink-3">Transaction</dt>
              <dd className="mt-1">
                <TxLink network={network} hash={txHash} />
              </dd>
            </div>
          )}
        </dl>
        <Link className="btn btn-light mt-6 w-full" to={`/pay?i=${instance}`}>
          Go to your debits
        </Link>
      </div>
    )
  }

  // ── already accepted ──
  if (address && status !== undefined && status !== MandateStatus.NONE) {
    const active = status === MandateStatus.ACTIVE
    return (
      <div className="panel p-6" role="status">
        <Chip tone={active ? 'lime' : 'danger'}>{active ? 'Already accepted' : status === MandateStatus.REVOKED ? 'Revoked · MD01' : 'Used'}</Chip>
        <h2 className="mt-4 text-[20px] font-medium leading-tight tracking-[-0.03em]">
          {active ? 'This wallet has already accepted this offer.' : 'This wallet already used this offer.'}
        </h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {active
            ? `Reference ${mandateReference(offer.offerRef, address)}.`
            : 'An offer can be accepted once per wallet. Ask the creditor for a new one.'}
        </p>
        <Link className="btn btn-light mt-5 w-full" to={`/pay?i=${instance}`}>
          Go to your debits
        </Link>
      </div>
    )
  }

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[18px] font-medium tracking-[-0.025em]">Sign mandate</h2>
        <Chip tone="quiet">You never pay gas</Chip>
      </div>

      {/* the allowance the permit grants, shown as a number */}
      <div className="inner mt-5 p-4">
        <div className="text-[12px] text-ink-3">Allowance you grant this rail</div>
        {permitValue !== undefined ? (
          <>
            <div className="mono mt-1.5 text-[22px] leading-none tracking-tight text-ink">{formatToken(permitValue, token.symbol)}</div>
            <div className="mono mt-2 text-[11.5px] leading-relaxed text-ink-3">
              {formatToken(current ?? 0n, token.symbol)} now + 12 × {formatToken(offer.maxPerPeriod, token.symbol)}
            </div>
          </>
        ) : isConnected && figures.isLoading ? (
          <Skeleton className="mt-2 h-7 w-40" />
        ) : (
          <div className="mt-1.5 text-[13px] text-ink-3">
            Connect to see the number. It is your current allowance plus 12 periods of the cap, never unlimited.
          </div>
        )}
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          The rail can never pull more than the mandate allows per debit and per period. You can lower this allowance any time on
          Pay.
        </p>
        {balance !== undefined && (
          <div className="mono mt-3 border-t border-line pt-3 text-[11.5px] text-ink-3">
            Your balance {formatToken(balance, token.symbol)}
          </div>
        )}
      </div>

      {notYours && (
        <div className="mt-4 rounded-panel border border-danger/30 p-3.5" role="alert">
          <div className="mono text-[13px] text-danger">NotOfferedDebtor</div>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-2">
            This offer is for <span className="mono">{shortAddress(offer.debtor)}</span>. You are connected as{' '}
            <span className="mono">{shortAddress(address ?? '')}</span>. Connect the wallet the offer names.
          </p>
        </div>
      )}

      {relayError && (
        <div className="mt-4 rounded-panel border border-line-2 p-3.5" role="alert">
          <div className="text-[13.5px] font-medium">The gasless relay isn&rsquo;t available</div>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-3">{relayError} Your signatures are kept: nothing needs signing again.</p>
        </div>
      )}

      <div className="mt-5 grid gap-2.5">
        {!isConnected ? (
          <ConnectButton className="btn btn-light w-full" label="Connect wallet to sign" />
        ) : wrongChain ? (
          <Button className="w-full" disabled={switching} onClick={() => void ensureChain()}>
            Switch wallet to {NETWORK_LABEL[network]}
          </Button>
        ) : step === 'signed' && signed ? (
          <>
            <Button className="w-full" onClick={() => void submit(signed, 'relay')}>
              Try the relay again
            </Button>
            <Button variant="line" className="w-full" onClick={() => void submit(signed, 'self')}>
              Submit it myself (you pay gas)
            </Button>
          </>
        ) : (
          <>
            <Button
              className="w-full"
              disabled={busy || notYours || permitValue === undefined || !walletClient}
              onClick={() => void signAndSend('relay')}
            >
              {busy ? (
                <>
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                  {step === 'acceptance' ? 'Sign the acceptance…' : step === 'permit' ? 'Sign the permit…' : 'Submitting…'}
                </>
              ) : (
                'Sign mandate'
              )}
            </Button>
            <button
              type="button"
              className="btn-text mx-auto"
              disabled={busy || notYours || permitValue === undefined || !walletClient}
              onClick={() => void signAndSend('self')}
            >
              Sign and send it myself (you pay gas)
            </button>
          </>
        )}
      </div>

      {(busy || step === 'signed') && <Stepper step={step} hasTx={false} />}

      <p className="mt-5 text-[12px] leading-relaxed text-ink-3">
        Two signatures, nothing sent from your wallet. Valid for one hour, as of block time{' '}
        <span className="mono">{new Date(chainTime * 1000).toISOString().slice(11, 16)} UTC</span>.
      </p>
    </div>
  )
}
