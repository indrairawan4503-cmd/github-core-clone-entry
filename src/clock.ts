// Deterministic time and sequencing for the forge.
//
// The grading suite replays a trial's requests and expects the same answers.
// Nothing in a response may come from the wall clock or from unseeded
// randomness: every timestamp comes from MAKEFUN_TRIAL_NOW (the trial's
// opening instant), and every ordering comes from a plain counter that only
// moves when the same requests arrive in the same order.

/** The trial's opening instant, as an ISO string and as epoch milliseconds. */
export interface TrialClock {
  /** ISO-8601 instant every created_at / updated_at / merged_at carries. */
  readonly nowIso: string;
  /** The same instant as epoch milliseconds. */
  readonly nowMs: number;
  /** The trial seed, when the harness provides one. */
  readonly seed: string;
}

function parseTrialNow(raw: string | undefined): number {
  if (raw === undefined || raw === '') return Date.now();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.trunc(asNumber);
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return Date.now();
}

/** Build the clock from the process environment (local runs fall back to now). */
export function trialClockFromEnv(env: NodeJS.ProcessEnv): TrialClock {
  const nowMs = parseTrialNow(env.MAKEFUN_TRIAL_NOW);
  return {
    nowIso: new Date(nowMs).toISOString(),
    nowMs,
    seed: env.MAKEFUN_TRIAL_SEED ?? '',
  };
}

/** A counter that hands out 1, 2, 3, ... in call order. Deterministic by construction. */
export class Sequence {
  private next = 1;
  take(): number {
    const value = this.next;
    this.next += 1;
    return value;
  }
  peek(): number {
    return this.next;
  }
}
