import { ConnectKitButton } from 'connectkit'
import { shortAddress } from '@/lib/format'

export function ConnectButton({ className = 'nav-cta', label = 'Connect' }: { className?: string; label?: string }) {
  return (
    <ConnectKitButton.Custom>
      {({ isConnected, isConnecting, show, address }) => (
        <button type="button" className={className} onClick={show} aria-label={isConnected ? 'Wallet menu' : 'Connect wallet'}>
          {isConnected && address ? (
            <>
              <i className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              <span className="mono text-[12.5px]">{shortAddress(address)}</span>
            </>
          ) : isConnecting ? (
            'Connecting…'
          ) : (
            label
          )}
        </button>
      )}
    </ConnectKitButton.Custom>
  )
}
