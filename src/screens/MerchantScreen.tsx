import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RAIL_INSTANCES, type RailInstance } from '@recall/sdk'
import { ConnectButton } from '@/components/ConnectButton'
import { Chip, DemoPill, ErrorPanel, Skeleton } from '@/components/ui'
import { useCreditors } from '@/hooks/useMerchant'
import { useWallet } from '@/hooks/useWallet'
import { useNetwork, NETWORK_LABEL } from '@/lib/network'
import { BatchPrenotify } from './merchant/BatchPrenotify'
import { Coverage } from './merchant/Coverage'
import { MerchantContext } from './merchant/ctx'
import { Export } from './merchant/Export'
import { Mandates } from './merchant/Mandates'
import { Offers } from './merchant/Offers'
import { Operators } from './merchant/Operators'
import { Register } from './merchant/Register'
import { MerchantWatch } from './merchant/Watch'

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">{children}</main>
}

/** /merchant: the console for a creditor owner or operator. */
export function MerchantScreen() {
  const { network, info } = useNetwork()
  const w = useWallet()
  const [instance, setInstance] = useState<RailInstance>('prod')
  const [picked, setPicked] = useState<bigint | null>(null)
  const creditors = useCreditors(network, instance, w.address)
  // ?watch=<creditorId>&rail=prod|demo: a read-only view that needs no wallet.
  const [params] = useSearchParams()
  const watchRaw = params.get('watch')
  const watchId = watchRaw && /^\d{1,18}$/.test(watchRaw) && BigInt(watchRaw) > 0n ? BigInt(watchRaw) : undefined

  const gate = !w.isConnected ? 'Connect your wallet first.' : w.wrongChain ? `Switch your wallet to ${info.chain.name} first.` : undefined

  if (watchId !== undefined) return <MerchantWatch id={watchId} instance={params.get('rail') === 'demo' ? 'demo' : 'prod'} />

  const header = (
    <div className="max-w-2xl">
      <div className="eyebrow">Merchants</div>
      <h1 className="section-title mt-3">Collect with the refund right built in.</h1>
      <p className="lede mt-3">Register, back your debits with a reserve, send checkout links and run your collections.</p>
    </div>
  )

  if (!w.isConnected || !w.address) {
    return (
      <Shell>
        {header}
        <div className="panel mt-10 max-w-xl p-6 sm:p-8">
          <h2 className="text-[18px] font-medium tracking-tight">Connect the wallet you bill from.</h2>
          <p className="mt-2 text-[13.5px] leading-snug text-ink-3">
            The console works for the owner of a creditor, or an operator the owner added. Nothing is stored on a server: it reads the chain.
          </p>
          <div className="mt-5">
            <ConnectButton className="btn btn-light btn-sm" label="Connect wallet" />
          </div>
        </div>
      </Shell>
    )
  }

  const list = creditors.data ?? []
  const current = list.find((c) => c.id === picked) ?? list[0]

  return (
    <Shell>
      {header}
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="seg" role="group" aria-label="Rail">
          {RAIL_INSTANCES.map((i) => (
            <button key={i} type="button" aria-pressed={instance === i} onClick={() => (setInstance(i), setPicked(null))}>
              {i === 'prod' ? 'Prod' : 'Demo'}
            </button>
          ))}
        </div>
        {instance === 'demo' && <DemoPill />}
        {list.length > 1 && (
          <div className="seg" role="group" aria-label="Creditor">
            {list.map((c) => (
              <button key={c.id.toString()} type="button" aria-pressed={current?.id === c.id} onClick={() => setPicked(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        {current && (
          <Chip tone="quiet" dot={false} mono>
            #{current.id.toString()} · {current.role} · {NETWORK_LABEL[network]}
          </Chip>
        )}
        {w.wrongChain && (
          <button type="button" className="btn btn-line btn-xs" onClick={() => void w.ensureChain()} disabled={w.switching}>
            Switch to {info.chain.name}
          </button>
        )}
      </div>

      {creditors.isLoading && (
        <div className="mt-8 space-y-4" aria-busy="true">
          <p className="mono text-[12px] text-ink-3">Looking for your creditors in the rail&rsquo;s events, 9,000 blocks at a time…</p>
          <Skeleton className="h-64" />
        </div>
      )}
      {creditors.isError && (
        <div className="mt-8 max-w-xl">
          <ErrorPanel
            code="RpcError"
            title="Couldn't look up your creditors."
            action={
              <button type="button" className="btn btn-line btn-sm" onClick={() => void creditors.refetch()}>
                Try again
              </button>
            }
          >
            Reading the registration events failed. Nothing was changed.
          </ErrorPanel>
        </div>
      )}

      {creditors.data && !current && (
        <div className="mt-10">
          <Register instance={instance} gate={gate} />
        </div>
      )}

      {current && (
        <MerchantContext.Provider value={{ instance, creditor: current, wallet: w.address, isOwner: current.role === 'owner', gate }}>
          <div className="mt-12 space-y-16" key={`${instance}-${current.id}`}>
            <Coverage />
            <Offers />
            <Mandates />
            <div className="grid gap-6 lg:grid-cols-2">
              <BatchPrenotify />
              <div className="space-y-6">
                <Export />
                <Operators />
              </div>
            </div>
          </div>
        </MerchantContext.Provider>
      )}
    </Shell>
  )
}
