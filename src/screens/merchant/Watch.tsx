import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ZERO_ADDRESS, RAIL_INSTANCES, debitRailAbi, railAddresses, type RailInstance } from '@recall/sdk'
import { Chip, DemoPill, ErrorPanel, Skeleton } from '@/components/ui'
import type { CreditorRef } from '@/hooks/useMerchant'
import { getPublicClient } from '@/lib/clients'
import { NETWORK_LABEL, useNetwork } from '@/lib/network'
import { Coverage } from './Coverage'
import { MerchantContext } from './ctx'
import { Export } from './Export'
import { Mandates } from './Mandates'
import { Operators } from './Operators'

export const WATCH_HINT = 'Read-only view of this creditor. Open the console with your wallet to act.'

/** /merchant?watch=<creditorId>&rail=prod|demo: coverage and mandates of a creditor, no wallet needed, no writes. */
export function MerchantWatch({ id, instance }: { id: bigint; instance: RailInstance }) {
  const { network } = useNetwork()
  const [params, setParams] = useSearchParams()
  const creditor = useQuery({
    queryKey: ['creditor-watch', network, instance, id.toString()],
    queryFn: async (): Promise<CreditorRef | null> => {
      const c = await getPublicClient(network).readContract({
        address: railAddresses(network)[instance].rail,
        abi: debitRailAbi,
        functionName: 'getCreditor',
        args: [id],
      })
      if (c.owner === ZERO_ADDRESS) return null
      return { id, name: c.name, payout: c.payout, owner: c.owner, role: 'owner' }
    },
    staleTime: 60_000,
    retry: 1,
  })

  const setRail = (i: RailInstance) => {
    const next = new URLSearchParams(params)
    if (i === 'prod') next.delete('rail')
    else next.set('rail', i)
    setParams(next, { replace: true })
  }

  return (
    <main className="mx-auto w-full max-w-app px-4 pb-8 pt-10 sm:px-8 sm:pt-16">
      <div className="max-w-2xl">
        <div className="eyebrow">Merchants · watching</div>
        <h1 className="section-title mt-3">{creditor.data ? creditor.data.name : `Creditor #${id.toString()}`}</h1>
        <p className="lede mt-3">A read-only view of this creditor&rsquo;s reserve and mandates, read straight from the rail. No wallet needed.</p>
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="seg" role="group" aria-label="Rail">
          {RAIL_INSTANCES.map((i) => (
            <button key={i} type="button" aria-pressed={instance === i} onClick={() => setRail(i)}>
              {i === 'prod' ? 'Prod' : 'Demo'}
            </button>
          ))}
        </div>
        {instance === 'demo' && <DemoPill />}
        <Chip tone="quiet" dot={false} mono>
          #{id.toString()} · read-only · {NETWORK_LABEL[network]}
        </Chip>
      </div>

      {creditor.isLoading && <Skeleton className="mt-8 h-64" />}
      {creditor.isError && (
        <div className="mt-8 max-w-xl">
          <ErrorPanel code="RpcError" title="Couldn't read this creditor." action={<button type="button" className="btn btn-line btn-sm" onClick={() => void creditor.refetch()}>Try again</button>}>
            The network did not answer.
          </ErrorPanel>
        </div>
      )}
      {creditor.data === null && (
        <div className="mt-8 max-w-xl">
          <ErrorPanel code="UnknownCreditor" title={`There is no creditor #${id.toString()} on the ${instance} rail.`}>
            Check the number, or look at the other rail.
          </ErrorPanel>
        </div>
      )}
      {creditor.data && (
        <MerchantContext.Provider value={{ instance, creditor: creditor.data, wallet: ZERO_ADDRESS, isOwner: false, gate: WATCH_HINT, readOnly: true }}>
          <div className="mt-12 space-y-16">
            <Coverage />
            <Mandates />
            <div className="grid gap-6 lg:grid-cols-2">
              <Export />
              <Operators />
            </div>
          </div>
        </MerchantContext.Provider>
      )}
    </main>
  )
}
