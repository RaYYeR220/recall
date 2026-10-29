export const INSTALL = `git clone <your fork of this repo>
cd recall && bun install

# The SDK lives in packages/sdk and is imported as '@recall/sdk'.
# viem is its only dependency.`

export const CLIENT = `import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcMainnet, createRailClient } from '@recall/sdk'

const account = privateKeyToAccount(process.env.MERCHANT_KEY as \`0x\${string}\`)
const publicClient = createPublicClient({ chain: arcMainnet, transport: http() })
const walletClient = createWalletClient({ account, chain: arcMainnet, transport: http() })

// 'prod' = real time windows, 'demo' = 1 week is 1 minute
const rail = createRailClient({ network: 'arc', instance: 'prod', publicClient, walletClient })`

export const LINK = `import { debitRailAbi, encodeCheckoutLink, mandateTextForOffer, refToBytes32, Scheme, termsHash } from '@recall/sdk'

const name = (await publicClient.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'getCreditor', args: [1n] })).name

const draft = {
  creditorId: 1n, token: eurc, scheme: Scheme.CORE, oneOff: false,
  maxPerCollection: 25_000000n, maxPerPeriod: 50_000000n,
  periodLength: 30 * 86400, prenoticeLength: 14 * 86400,
  offerRef: refToBytes32('GYM-2026'), termsHash: '0x' + '00'.repeat(32),
  maxUses: 0, validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  timeScale: rail.timeScale, debtor: '0x0000000000000000000000000000000000000000',
}
// The text is written from the offer's own fields, so it cannot promise what the offer doesn't.
const terms = mandateTextForOffer(draft, { creditorName: name, network: 'arc', instance: 'prod', rail: rail.rail, token: 'EURC' })
const offer = { ...draft, termsHash: termsHash(terms) }
const offerSig = await rail.signOffer(offer)

const link = encodeCheckoutLink('https://your.app/m', { network: 'arc', instance: 'prod', offer, offerSig, creditorName: name, terms })`

export const PRENOTIFY = `// announce a debit: amount, due date (at least the pre-notice from now), an end-to-end id, a note
const e2eId = refToBytes32('INV-2026-11-001')
await rail.prenotify(mandateId, 12_000000n, BigInt(dueAt), e2eId, 'Monthly membership')

// the payer can refuse it until it runs. On or after dueAt, anyone can collect:
const collectionId = rail.collectionId(mandateId, e2eId)
await rail.collect(collectionId)`

export const REFUND = `// the payer, within the refund window (8 weeks on prod): one call...
await rail.refund(collectionId)

// ...or one signature, submitted by anyone, no gas for the payer
const { action, debtor, sig } = await rail.signDebtorAction('REFUND', collectionId)
await rail.relayDebtorAction(action, debtor, sig) // POST /api/relay
// or: await rail.executeDebtorAction(action, debtor, sig) from any funded wallet`

export const ERRORS = `import { decodeRailError } from '@recall/sdk'

try {
  await rail.refund(collectionId)
} catch (e) {
  const { name, code, message } = decodeRailError(e)
  // name: 'RefundWindowClosed', code: null, message: 'The 8-week refund window has closed.'
}`

export const MCP_TOOLS: { name: string; does: string }[] = [
  { name: 'recall_create_checkout_link', does: 'Build and sign a mandate offer and return the checkout link.' },
  { name: 'recall_list_mandates', does: 'A creditor\u2019s mandates with their newest collections.' },
  { name: 'recall_prenotify', does: 'Announce a debit within an active mandate\u2019s limits.' },
  { name: 'recall_collect', does: 'Collect a due debit.' },
  { name: 'recall_status', does: 'The state of one collection, its refund deadline, and the reserve behind it.' },
  { name: 'recall_export_camt054', does: 'ISO 20022 camt.054 or CSV of settled, refunded and returned collections.' },
]
