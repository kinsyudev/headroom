/**
 * The Anthropic read schedule and the single writer of every account's feeds.
 *
 * One read per account per cycle. The mode comes from `isAtWall`, the same pure function the UI
 * shows: `wall` every 3 min while at the wall, `normal` every 5 min otherwise. Profile at start,
 * then every 6 h. First reads are staggered 15 s per account. A manual refresh moves the next
 * read to now, once per 60 s per account, and never during backoff or while the read cap is full.
 * The budget itself (10 s gap, backoff, read cap) is enforced in anthropic.ts, where requests
 * leave. Each account's last read comes from that budget at start, so a restarted process keeps
 * the cadence of the one before it.
 */
import { DeckError } from '../shared/errors';
import {
  isAtWall,
  MANUAL_REFRESH_EVERY_MS,
  NORMAL_READ_EVERY_MS,
  PROFILE_READ_EVERY_MS,
  WALL_READ_EVERY_MS,
} from '../shared/derive';
import {
  emptySource,
  type AccountFeeds,
  type AccountId,
  type CpaAccount,
  type Instant,
  type Profile,
  type ReadMode,
  type Source,
} from '../shared/domain';
import type { RefreshHeld } from '../shared/actions';
import type { Anthropic, Clock, Polled, UsageRead } from './anthropic';

export const FIRST_READ_STAGGER_MS = 15_000;
export const PROFILE_RETRY_MS = 15 * 60_000;
export const TICK_MS = 1_000;

export interface ReadClock {
  readonly firstAt: Instant;
  readonly lastAttemptAt: Instant | null;
  readonly requestedAt: Instant | null;
  readonly wallWanted: Instant | null;
  readonly backoffUntil: Instant | null;
  readonly capUntil: Instant | null;
}

export function readDueAt(c: ReadClock, atWall: boolean): Instant {
  const last = c.lastAttemptAt ?? -Infinity;
  const cadence = Math.max(c.firstAt, last + (atWall ? WALL_READ_EVERY_MS : NORMAL_READ_EVERY_MS));
  // A request pulls the next read earlier until a read is attempted after it; then the cadence retries.
  const pull = (t: Instant | null) => (t !== null && t > last ? t : Infinity);
  return Math.max(Math.min(cadence, pull(c.requestedAt), pull(c.wallWanted)), c.backoffUntil ?? -Infinity, c.capUntil ?? -Infinity) as Instant;
}

export function profileDueAt(c: { readonly firstAt: Instant; readonly attemptAt: Instant | null; readonly okAt: Instant | null; readonly backoffUntil: Instant | null }): Instant {
  const base = c.okAt !== null ? c.okAt + PROFILE_READ_EVERY_MS : c.attemptAt !== null ? c.attemptAt + PROFILE_RETRY_MS : c.firstAt;
  return Math.max(base, c.backoffUntil ?? -Infinity) as Instant;
}

type Kind = ReadMode | 'profile';

interface AccountState {
  readonly firstAt: Instant;
  lastAttemptAt: Instant | null;
  requestedAt: Instant | null;
  /**
   * Reads from this instant on are `wall`, whatever isAtWall says, until one succeeds: a claim's
   * result shows only there, and an account the claim took off the wall would otherwise get
   * `normal` reads forever.
   */
  wallWanted: Instant | null;
  manualAt: Instant | null;
  profileAttemptAt: Instant | null;
  profileOkAt: Instant | null;
  pending: Kind[];
  chain: Promise<unknown>;
  feeds: Omit<AccountFeeds, 'gate'>;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Starts every read that is due. The interval calls it; tests call it directly. */
  tick(): void;
  feeds(): Readonly<Record<AccountId, AccountFeeds>>;
  kick(account: AccountId | 'all'): { account: AccountId; held: RefreshHeld | null }[];
  /** One `wall` read now, behind any read already queued for the account. For claims. */
  readWall(account: AccountId): Promise<Polled<UsageRead>>;
  /** A `wall` read at `at` or later, retried on the normal cadence until one succeeds. Used after a claim. */
  wantWall(account: AccountId, at: Instant): void;
  profile(account: AccountId): Profile | null;
}

export function createPoller(deps: {
  readonly anthropic: Anthropic;
  readonly accounts: () => readonly CpaAccount[];
  readonly linkOk: () => boolean;
  readonly clock: Clock;
  readonly staggerMs?: number;
}): Poller {
  const stagger = deps.staggerMs ?? FIRST_READ_STAGGER_MS;
  const states = new Map<AccountId, AccountState>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function reconcile(list: readonly CpaAccount[], now: Instant): void {
    const ids = new Set(list.map((a) => a.id));
    for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
    let fresh = 0;
    for (const a of list) {
      if (states.has(a.id)) continue;
      states.set(a.id, {
        firstAt: (now + fresh++ * stagger) as Instant,
        lastAttemptAt: deps.anthropic.budget(a.id).lastReadAt,
        requestedAt: null,
        wallWanted: null,
        manualAt: null,
        profileAttemptAt: null,
        profileOkAt: null,
        pending: [],
        chain: Promise.resolve(),
        feeds: { limits: emptySource(), spend: emptySource(), cedar: emptySource(), juniper: emptySource(), profile: emptySource() },
      });
    }
  }

  function enqueue(id: AccountId, st: AccountState, kind: Kind): Promise<Polled<unknown>> {
    st.pending.push(kind);
    const run = async (): Promise<Polled<unknown>> => {
      try {
        if (kind === 'profile') {
          const r = await deps.anthropic.profile(id);
          st.profileAttemptAt = r.at;
          if (r.ok) st.profileOkAt = r.at;
          st.feeds = { ...st.feeds, profile: record(st.feeds.profile, r, (v) => v) };
          return r;
        }
        const r = await deps.anthropic.read(id, kind);
        st.lastAttemptAt = r.at;
        if (kind === 'wall' && r.ok && st.wallWanted !== null && r.at >= st.wallWanted) st.wallWanted = null;
        const f = st.feeds;
        st.feeds = {
          ...f,
          limits: record(f.limits, r, (v) => v.limits),
          cedar: record(f.cedar, r, (v) => v.cedar),
          ...(kind === 'normal'
            ? { spend: record(f.spend, r, (v) => (v.mode === 'normal' ? v.spend : null)) }
            : { juniper: record(f.juniper, r, (v) => (v.mode === 'wall' ? v.juniper : null)) }),
        };
        return r;
      } finally {
        st.pending.shift();
      }
    };
    const p = st.chain.then(run, run);
    st.chain = p.catch(() => undefined);
    return p;
  }

  function tick(): void {
    if (!deps.linkOk()) return;
    const now = deps.clock.now();
    const list = deps.accounts();
    reconcile(list, now);
    for (const a of list) {
      const st = states.get(a.id)!;
      if (st.pending.length > 0) continue;
      const { backoffUntil, capUntil } = deps.anthropic.budget(a.id);
      if (now >= profileDueAt({ firstAt: st.firstAt, attemptAt: st.profileAttemptAt, okAt: st.profileOkAt, backoffUntil })) {
        void enqueue(a.id, st, 'profile');
        continue;
      }
      const atWall = isAtWall(a, st.feeds.limits.last, now);
      if (now < readDueAt({ ...st, backoffUntil, capUntil }, atWall)) continue;
      void enqueue(a.id, st, atWall || (st.wallWanted !== null && now >= st.wallWanted) ? 'wall' : 'normal');
    }
  }

  return {
    tick,
    start() {
      timer ??= setInterval(tick, TICK_MS);
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    feeds() {
      const now = deps.clock.now();
      const linkOk = deps.linkOk();
      const out: Record<AccountId, AccountFeeds> = {};
      for (const a of deps.accounts()) {
        const st = states.get(a.id);
        if (!st) continue;
        const { backoffUntil, capUntil } = deps.anthropic.budget(a.id);
        const atWall = isAtWall(a, st.feeds.limits.last, now);
        const due = linkOk ? readDueAt({ ...st, backoffUntil, capUntil }, atWall) : null;
        const f = st.feeds;
        out[a.id] = {
          limits: { ...f.limits, nextAt: due },
          cedar: { ...f.cedar, nextAt: due },
          spend: { ...f.spend, nextAt: atWall ? null : due },
          juniper: { ...f.juniper, nextAt: atWall ? due : null },
          profile: { ...f.profile, nextAt: linkOk ? profileDueAt({ firstAt: st.firstAt, attemptAt: st.profileAttemptAt, okAt: st.profileOkAt, backoffUntil }) : null },
          gate: { backoffUntil, capUntil, manualAt: st.manualAt, reading: st.pending[0] ?? null },
        };
      }
      return out;
    },
    kick(account) {
      const now = deps.clock.now();
      const ids = account === 'all' ? [...states.keys()] : [account];
      const result = ids.flatMap((id) => {
        const st = states.get(id);
        if (!st) return [];
        const b = deps.anthropic.budget(id);
        const held: RefreshHeld | null =
          st.pending.length > 0
            ? 'reading'
            : b.backoffUntil !== null
              ? 'rate_limited'
              : b.capUntil !== null
                ? 'capped'
                : st.manualAt !== null && now - st.manualAt < MANUAL_REFRESH_EVERY_MS
                  ? 'debounced'
                  : null;
        if (held === null) st.manualAt = st.requestedAt = now;
        return [{ account: id, held }];
      });
      tick();
      return result;
    },
    readWall(account) {
      const st = states.get(account);
      if (!st) throw new DeckError('unknown_account', `no reads scheduled for ${account}`);
      return enqueue(account, st, 'wall') as Promise<Polled<UsageRead>>;
    },
    wantWall(account, at) {
      const st = states.get(account);
      if (st) st.wallWanted = Math.max(st.wallWanted ?? -Infinity, at) as Instant;
      tick();
    },
    profile(account) {
      return states.get(account)?.feeds.profile.last?.value ?? null;
    },
  };
}

/** A success replaces the value and clears the error; a failure keeps the last value and records why. */
function record<T, V>(src: Source<T>, r: Polled<V>, pick: (v: V) => T): Source<T> {
  return r.ok
    ? { last: { value: pick(r.value), at: r.at }, error: null, attemptedAt: r.at, nextAt: null }
    : { ...src, error: { value: r.error, at: r.at }, attemptedAt: r.at };
}
