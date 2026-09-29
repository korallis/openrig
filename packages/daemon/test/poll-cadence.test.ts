// Local patch 136 (0.6.1): background poll cadence. Every tmux/ps spawn blocks the event loop while the daemon forks,
// so the structural and identity sweeps must not run at 1Hz / 5Hz-overlapping rates on a large fleet.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_STRUCTURAL_POLL_INTERVAL_MS,
  DEFAULT_STRUCTURAL_STALE_MS,
} from "../src/domain/seat-structural-activity-service.js";
import { DEFAULT_IDENTITY_POLL_INTERVAL_MS, SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";

afterEach(() => { vi.useRealTimers(); });

describe("background poll cadence (patch 136)", () => {
  it("structural sweep runs every 5s and a cached verdict stays current for 5 sweeps", () => {
    expect(DEFAULT_STRUCTURAL_POLL_INTERVAL_MS).toBe(5000);
    expect(DEFAULT_STRUCTURAL_STALE_MS).toBe(25000);
    expect(DEFAULT_STRUCTURAL_STALE_MS).toBe(5 * DEFAULT_STRUCTURAL_POLL_INTERVAL_MS);
  });

  it("identity sweep runs every 15s", () => {
    expect(DEFAULT_IDENTITY_POLL_INTERVAL_MS).toBe(15000);
  });

  it("the hook authority window is independent of the structural cadence", () => {
    // seat-activity arbitration runs on its own 1Hz window sampler; patch 136 does not touch it.
    expect(HOOK_AUTHORITY_WINDOW_MS).toBe(15_000);
  });

  it("a slow identity sweep is never overlapped by the next tick (single-flight)", async () => {
    vi.useFakeTimers();
    const rec = new SeatIdentityReconciler({ db: {} as never, tmux: {} as never });
    let release!: () => void;
    const calls = { n: 0 };
    rec.reconcileAll = vi.fn(() => { calls.n++; return new Promise<void>((r) => { release = r; }); });
    rec.start(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.n).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); // ten more ticks while the first sweep is still running
    expect(calls.n).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.n).toBe(2);
    rec.stop();
  });

  it("a failed sweep releases the guard and still surfaces its rejection, as before the guard", async () => {
    vi.useFakeTimers();
    const rec = new SeatIdentityReconciler({ db: {} as never, tmux: {} as never });
    const calls = { n: 0 };
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    rec.reconcileAll = vi.fn(async () => { calls.n++; throw new Error("tmux gone"); });
    rec.start(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.n).toBe(3);
    await vi.waitFor(() => expect(onUnhandled).toHaveBeenCalledTimes(3));
    rec.stop();
    process.off("unhandledRejection", onUnhandled);
  });
});
