# cpa-deck

A local control deck for CLIProxyAPI's Claude accounts. Open `http://127.0.0.1:1338` and you see which
account is serving traffic, how much room each one has left, when each window resets, whether a
Claude reset is available, and the request history. You can act on any account from the same page.

One Bun process. It binds 127.0.0.1 only, reads keeper's SQLite read-only, and talks to CPA's
management API with the key from keeper's env file. A LaunchAgent keeps it running.

```sh
bun install
bun run src/main.ts                       # http://127.0.0.1:1338
cp launchd/com.kinsyu.cpa-deck.plist ~/Library/LaunchAgents/ && launchctl load -w ~/Library/LaunchAgents/com.kinsyu.cpa-deck.plist
```

## What you see

```
┌ cpa-deck ───────────────────────────────────────────── routing: fill-first ⇄ ─── + Add account ┐
│ SERVING  account1 (prio 50, fill-first target)   also: account2 (session affinity, 33s ago)   │
│ Session headroom 1.3 / 3   Weekly headroom 1.7 / 3   Next reset: account3 session in 1h 54m    │
│ Claimable now: account3 · cedar_ember "Launch grant" (2 of 3 left)              [ Claim… ]     │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ account1@…  Team · Max 5x ───── SERVING ┐ ┌ account3@…  Team · Max 5x ─── BLOCKED 1h 54m ┐ ┌ account2@… Max 20x ─ standby ┐
│ priority 50              [Make primary] │ │ credential_quota cooldown → 15:20  [Clear]    │ │ priority 10  [Make primary]   │
│ Session      ██░░░░░░  17%  ↻ 4h 34m    │ │ Session  ████████ 100% critical  ↻ 1h 54m     │ │ Weekly  ░░░░░░░░  1%  ↻ 5d 20h│
│              live · 3s   (poll 15% 4m)  │ │ "monthly spend limit" (status_message)        │ │ ...                           │
│ Weekly       ███░░░░░  27%  ↻ 1d 15h    │ │ Spend  $101 / $100  cap reached               │ │                               │
│ Opus weekly  █░░░░░░░   8%  ↻ 1d 15h    │ │ Resets                                        │ │                               │
│ Spend        off (group_zero_credit_lim)│ │   juniper_tide  CLAIMABLE          [Claim…]   │ │                               │
│ Resets                                  │ │   cedar_ember   waiting → Thu 09:00           │ │                               │
│   juniper_tide  held: unlocks at wall   │ │ ▂▅█▆▄▁▁▂█▆▂▄▃▁▁▁▁▁▁▁  req / 10 min             │ │                               │
│   cedar_ember   not enrolled            │ │                                               │ │                               │
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂█▅  req / 10 min       │ │                                               │ │                               │
│ CPA 2s · headers 3s · limits 41s · resets 9m (rate-limited, retry 14:02) · profile 2h      ⋯ menu │
└─────────────────────────────────────────┘ └───────────────────────────────────────────────┘ └───────────────────────────────┘
┌ History  [24h] 7d 30d   requests | tokens ─────────────────────────────── keeper: last row 12s ago ┐
│ stacked bars per account per hour/day · per-model table · recent errors and 429s                   │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

How to read it:

- **Serving** comes from evidence. An account counts as serving if CPA saw an Anthropic response
  on it in the last 2 minutes. The fill-first target is a prediction and is labelled as one. Both
  are shown because session affinity keeps older sessions on lower-priority accounts.
- **Each limit row** shows one number and names its source. `live` means the passive CPA header
  snapshot, which updates with every real response. `poll` means the authoritative Anthropic
  `/api/oauth/usage` call. When both sources exist, the newer one is drawn and the other is shown
  as a faint tick with its age, so a disagreement between them stays visible. When a window's
  `resets_at` passes, the row turns `rolled` until fresh data arrives. It never keeps showing the
  old percent as if it were current.
- **Every source shows how old its data is** in the card footer: CPA (polled every 5 s), headers
  (updated by traffic), limits and spend (Anthropic usage poll), resets (Anthropic at-wall poll),
  and profile. A failing source shows why it failed and when it will retry.
- **Reset programs** have six states. `claimable` and `waiting → time` explain themselves.
  `held` means the program is checked at the wall and the account isn't at the wall.
  `ineligible: reason` names the reason. `in flight` means a claim is pending or unresolved.
  `unknown` means there is no data yet.

## What you do

| Control | Effect | Safety |
| --- | --- | --- |
| **Claim…** on a claimable reset | Opens a dialog that names the account, the program, the grant, what it clears, the resets left afterwards, and the age of the data behind it. The confirm button reads "Reset session limit on account3@example.com". On `reset` or `not_limited`, the server then calls CPA `reset-quota`. | Irreversible, so it takes two phases (prepare, then confirm). The server journals the claim before sending and uses compare-and-set state transitions. A double-click or retry returns the same claim. After a crash mid-send, the claim is marked `in_doubt` and is never sent again automatically. The next at-wall poll resolves it. |
| Enable / Disable | `PATCH /auth-files/status` | Sets a value, so repeating it is safe. |
| Priority stepper, **Make primary** | `PATCH /auth-files/fields`. Make primary sets `max(others) + 10` and enables the account if it is disabled. | Make primary is a no-op if the account already outranks every other account. |
| Clear cooldown | CPA `POST /reset-quota`. It affects CPA's local scheduler only. | Repeating it is safe. |
| Refresh token | CPA `POST /auth-files/refresh` | The response holds tokens. The server keeps only `ok` and drops the rest. |
| Routing fill-first ⇄ round-robin | `PUT /routing/strategy` | Sets a value, so repeating it is safe. |
| Refresh (per card, or all) | Moves the account's next Anthropic poll earlier | Debounced to once per 20 s per account. Never bypasses a rate-limit backoff or the 60 s per-endpoint floor. |
| + Add account | Opens Anthropic's OAuth page in a new tab. The server polls CPA for the result, and the new account card appears. | One flow at a time. It expires after 5 minutes. |

Each mutation completes only after the server has re-read CPA. When the button stops spinning,
the card already shows CPA's new state. The UI keeps no optimistic copy of CPA state.

## HTTP API (as the UI calls it)

All routes reject requests whose `Host` is not `127.0.0.1:1338` or `localhost:1338`, which blocks
DNS rebinding. `POST` also requires a same-origin `Origin`, `Sec-Fetch-Site: same-origin` when the
browser sends it, `Content-Type: application/json`, and `X-Deck-Csrf` matching the token from
`/api/session`. The server sends no CORS headers.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | The app (a Bun HTML import, bundled at startup) |
| GET | `/api/session` | `{ csrf }`, a per-process secret. Only a same-origin page can read it. |
| GET | `/api/snapshot` | `Snapshot` (shared/domain.ts): normalized observations, claims, OAuth flows, link state |
| GET | `/api/stream` | Server-sent events. One `snapshot` event with the full `Snapshot` on every change (about 10 KB), plus a keepalive every 5 s. |
| GET | `/api/history?range=24h\|7d\|30d` | `HistoryView` from keeper: hourly or daily per-account series, per-model totals, recent errors |
| POST | `/api/act` | Body `{ kind, input }`, one entry from the action table in shared/actions.ts. Returns that action's typed output, or `{ error: { code, message } }`. |

There is one mutation endpoint. Every action, including the two claim phases, is a row in
`ACTIONS`. The `Action` type, the request parser, and the server's handler table all derive from
that row, so a missing handler fails the build.

The UI never receives a view model. It receives the `Snapshot` and runs `deriveDeck(snapshot, now)`
(shared/derive.ts) once a second. Countdowns, freshness ages, rolled windows, and expired cooldowns
therefore update without any server push. The server calls the same function when it decides
whether a claim is allowed.

## Call sites

**1. A card's "Make primary" button** (src/ui/components/AccountCard.tsx)

```tsx
const makePrimary = useAction('account.makePrimary');

<button
  disabled={!account.can.makePrimary || makePrimary.pending}
  onClick={() => makePrimary.run({ account: account.id })}
>
  Make primary
</button>
// makePrimary.run resolves with { priority: 60, changed: true } after the server has re-read CPA.
// By then the SSE snapshot shows account.routing.isTarget === true.
```

**2. Claiming a reset** (src/ui/components/ClaimDialog.tsx)

```tsx
// Opening the dialog prepares the claim. The server checks deriveOffers() against the latest
// at-wall data, refreshes that data if it is older than 90 s and the rate budget allows, and
// records the preflight facts.
const claim = await act('claim.prepare', { account: a.id, program: 'cedar_ember', grant: offer.defaultGrant });
// claim.preflight → { programsAt, resetsLeft: 2, clears: ['five_hour'], available: true }

// The confirm button echoes account and program. The server rejects the request if they don't
// match the prepared row, so a stale dialog can't confirm a different claim.
const done = await act('claim.confirm', { claim: claim.id, account: a.id, program: 'cedar_ember' });
// done.state → { kind: 'settled', outcome: { result: 'reset', resetsLeft: 1, cleared: ['five_hour'] }, followup: 'done' }
// Click again, or retry after a network error, and the same ClaimRecord comes back. Nothing is sent twice.
```

**3. The server's claim preflight reuses the UI's derivation** (src/server/claims.ts)

```ts
const programs = await observer.ensureFresh(account, 'programs', 90_000);
const offer = deriveOffers(programs, table.open(account), now).find((o) => o.program === program);
if (offer?.state.kind !== 'claimable') throw new DeckError('not_claimable', explainOffer(offer));
```

**4. From a terminal (read-only)**

```sh
curl -s 127.0.0.1:1338/api/snapshot | jq '.feeds | map_values(.programs.last.value.juniperTide.available)'
```

## What it never does

- Never consumes CPA's usage queue (`/usage-queue`, `LPOP`) and never writes to keeper's DB.
  `test/boundaries.test.ts` fails the build if the source mentions either.
- Never sends a management request without the key, and never retries after a 401 or 403. One
  rejection latches the link until the env file changes. A persisted budget caps this process at
  2 auth failures per 30 minutes, across restarts, so a LaunchAgent restart loop can't trip
  CPA's 5-strike ban.
- Never forwards token material. `refreshToken` parses `{ ok }` and drops the rest of the
  response inside cpa.ts.
- Never calls Anthropic more than once per 5 s overall, or more than once per 60 s per account
  per endpoint. Rate limits back off per account, and the backoff state survives restarts.
