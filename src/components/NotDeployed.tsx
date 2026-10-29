import { railAddresses, type RailInstance, type RailNetwork } from '@recall/sdk'
import { buildAddressUrl } from '@/lib/links'
import { NETWORK_LABEL, useNetwork } from '@/lib/network'
import { shortAddress } from '@/lib/format'
import { Button, ErrorPanel, ExtLink } from './ui'

/** Shown instead of a page when the recorded deployment has no code on the selected network. */
export function NotDeployed({ network, instance }: { network: RailNetwork; instance: RailInstance }) {
  const { setNetwork } = useNetwork()
  const rail = railAddresses(network)[instance].rail
  return (
    <div className="mx-auto max-w-xl">
      <ErrorPanel
        code="NoContract"
        title={`The ${instance} rail isn't live on ${NETWORK_LABEL[network]}.`}
        action={
          network !== 'arc' ? (
            <Button size="sm" onClick={() => setNetwork('arc')}>
              Switch to Arc mainnet
            </Button>
          ) : undefined
        }
      >
        There is no contract code at <ExtLink href={buildAddressUrl(network, rail)}><span className="mono">{shortAddress(rail)}</span></ExtLink>, the
        address recorded for this deployment. The testnet may have been reset since the contracts were deployed. Nothing here can be
        read or signed until they are deployed again.
      </ErrorPanel>
    </div>
  )
}
