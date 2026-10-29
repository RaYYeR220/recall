export type DemoStepName = 'start' | 'prenotify' | 'collect' | 'refund'

export interface DemoEvent {
  name: string
  args: Record<string, string>
}

export interface DemoTx {
  txHash: string
  explorerUrl: string
  blockNumber: string
  events: DemoEvent[]
}

export interface PublicRun {
  id: string
  phase: 'started' | 'prenotified' | 'collected' | 'refunded' | 'expired' | 'failed'
  createdAt: number
  mandateId?: string
  collectionId?: string
  dueAt?: number
  settledAt?: number
  refundWindow?: number
  txs: Partial<Record<DemoStepName, string>>
  explorer: Partial<Record<DemoStepName, string>>
}

export interface DemoStatus {
  network: 'arc' | 'arc-testnet'
  chainId: number
  rail: string
  lens: string
  timeScale: number
  /** Chain time, unix seconds, when the server answered. */
  chainNow: number
  runsToday: number
  runsPerDay: number
  run: PublicRun | null
  active: boolean
  next: DemoStepName | null
  countdowns: { noticeLeft: number | null; refundLeft: number | null }
  configured: boolean
  missing?: string[]
  ready: boolean
  problems: string[]
  windows?: { refundWindow: number; minPrenotice: number }
  houseCreditor?: string
  housePayer?: string
}

export interface StepReply {
  step: DemoStepName
  tx: DemoTx
  run: PublicRun
  runId?: string
  runToken?: string
  outcome?: 'settled' | 'not-settled'
  note?: string
}

export interface ProvokeReply {
  case: string
  label: string
  expected: string
  source: 'live' | 'replayed' | 'recorded'
  refusal: { name: string; code: string | null; message: string } | null
  reproduced: boolean
  note: string
  recorded: { label: string; rail: string; error: string; txHash: string; explorerUrl: string } | null
}

export class DemoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly refusal?: { name: string; code: string | null; message: string },
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'DemoApiError'
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new DemoApiError('The demo server could not be reached.', 0, 'Unreachable')
  }
  const text = await res.text()
  let json: Record<string, unknown> | undefined
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = undefined
  }
  if (!json) throw new DemoApiError('The demo backend is not running at this address.', res.status, 'NoBackend')
  if (!res.ok) {
    throw new DemoApiError(
      typeof json['error'] === 'string' ? json['error'] : `The demo answered ${res.status}.`,
      res.status,
      typeof json['code'] === 'string' ? json['code'] : undefined,
      json['refusal'] as DemoApiError['refusal'],
      typeof json['retryAfterSeconds'] === 'number' ? json['retryAfterSeconds'] : undefined,
    )
  }
  return json as T
}

export const demoApi = {
  status: () => call<DemoStatus>('GET', '/api/demo/status'),
  step: (step: DemoStepName, auth?: { runId: string; token: string }) =>
    call<StepReply>('POST', `/api/demo/${step}`, auth ? { runId: auth.runId, token: auth.token } : {}),
  provoke: (c: string) => call<ProvokeReply>('POST', '/api/demo/provoke', { case: c }),
}

const KEY = 'recall.demo.run'

export function loadRunAuth(): { runId: string; token: string } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as { runId: string; token: string }) : null
  } catch {
    return null
  }
}

export function saveRunAuth(a: { runId: string; token: string } | null): void {
  try {
    if (a) window.sessionStorage.setItem(KEY, JSON.stringify(a))
    else window.sessionStorage.removeItem(KEY)
  } catch {
    /* storage can be blocked */
  }
}
