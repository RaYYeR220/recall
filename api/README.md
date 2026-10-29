# Serverless functions

Vercel-style functions (`api/*.ts`, Node runtime, web-standard `GET` / `POST` handlers) on viem and the SDK. They run unchanged under the dev server (`bun run dev` serves `/api/*` from this folder).

Every key is read from the environment and never from code. A function whose keys are missing stays inert and says so.

| Route | What it does | Needs |
| --- | --- | --- |
| `POST /api/relay` | Submits a payer's signed mandate acceptance (`activate`) or refund / refuse / revoke (`action`) so the payer pays no gas. Targets only the two deployed rails, simulates first and returns the contract's refusal instead of sending. 20 requests per IP and 200 in total per UTC day. | `RELAYER_KEY` |
| `GET\|POST /api/demo/<step>` | The one-click demo on the demo rail: `status`, `start`, `prenotify`, `collect`, `refund`, and `provoke` (`{ "case": ... }`, simulations only). One run at a time, 40 runs per UTC day, 0.02 EURC per run and the refund returns it. | `DEMO_CREDITOR_KEY`, `DEMO_DEBTOR_KEY`, `RELAYER_KEY` (`status` and `provoke` need none) |
| `GET /api/keeper` | Collects due scheduled debits and releases matured settled ones for the creditors in `KEEPER_CREDITORS`, at most 20 transactions per run. Send `x-cron-secret: $CRON_SECRET` or `Authorization: Bearer $CRON_SECRET`. | `CRON_SECRET`, `RELAYER_KEY`, `KEEPER_CREDITORS` |
| `GET /api/health` | Read-only `RailLens.health()` for both rails, cached 15 s. | nothing |

## Environment

| Variable | Purpose |
| --- | --- |
| `NETWORK` | `arc` (default, mainnet) or `arc-testnet`. |
| `RELAYER_KEY` | Private key that pays gas for relayed transactions and keeper runs. |
| `DEMO_CREDITOR_KEY` | Owner of a creditor registered on the demo rail, with a funded EURC reserve and gas. |
| `DEMO_DEBTOR_KEY` | The house payer: holds a little EURC; signs but never pays gas. |
| `CRON_SECRET` | Shared secret the scheduler sends to `/api/keeper`. |
| `KEEPER_CREDITORS` | Creditors to keep, for example `prod:1,demo:2`. |
| `RPC_URL` | Optional RPC override. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Optional. Vercel KV / Upstash REST store for limits and the demo lock. Without them an in-memory store is used, which only holds within one warm instance. |

Use dedicated keys that hold only what the job needs. Never commit them.

## Tests

`bun run api:test` covers the rate limits and caps, the demo lock, the demo step machine, relay validation and decisions, and the keeper plan.
