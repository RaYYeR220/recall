import { Loader2 } from 'lucide-react'
import { cx } from './ui'

export type ActionPath = 'sign' | 'self'

/**
 * Every payer action has two paths: sign it (no gas, a relay submits it) or send it yourself (your gas).
 * The lime button is only for exercising the payer's right (refund); other actions are hairline.
 */
export function ActionButtons({
  label,
  tone,
  busy,
  disabled,
  disabledReason,
  size = 'md',
  onRun,
}: {
  label: string
  tone: 'right' | 'plain' | 'primary'
  busy?: boolean
  disabled?: boolean
  disabledReason?: string
  size?: 'md' | 'sm'
  onRun: (path: ActionPath) => void
}) {
  const off = !!busy || !!disabled
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        disabled={off}
        title={disabled ? disabledReason : 'Sign with your wallet. No gas: a relay submits it.'}
        aria-label={`${label}: sign, no gas`}
        onClick={() => onRun('sign')}
        className={cx(
          tone === 'right' ? 'take' : tone === 'primary' ? 'btn btn-light btn-sm' : 'btn btn-line btn-xs',
          tone === 'right' && size === 'sm' && '!h-9 !px-4 !text-[13px]',
        )}
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Working…
          </span>
        ) : (
          label
        )}
      </button>
      <button
        type="button"
        className="btn-text"
        disabled={off}
        title={disabled ? disabledReason : 'Send the transaction from your wallet. You pay the gas.'}
        aria-label={`${label}: send it myself, you pay gas`}
        onClick={() => onRun('self')}
      >
        Send myself
      </button>
    </div>
  )
}
