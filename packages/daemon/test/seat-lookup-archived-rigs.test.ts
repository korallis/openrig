// Local patch 138 (0.6.1): seat lookups by <member>@<rig> matched nodes in ARCHIVED rigs of the same name too, so a live
// seat became "matched multiple nodes" once older generations of its rig were archived (hc, 2026-09-30: two archived
// 'hc' rigs blocked `rig seat handover impl-astra@hc`). Live rigs win; archived-only names stay addressable.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

describe("seat lookup with archived same-name rigs (patch 138)", () => {
  let db: Database.Database, rigRepo: RigRepository, sessions: SessionRegistry;
  let status: SeatStatusService, lifecycle: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    status = new SeatStatusService({ rigRepo });
    lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry: sessions, eventBus: new EventBus(db), tmuxAdapter: {} as never });
  });
  afterEach(() => db.close());

  /** An older generation of rig `name`, archived, with its own unbound impl.astra node. */
  function archivedGeneration(name: string) {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "impl.astra", { runtime: "claude-code", model: "fable" });
    expect(rigRepo.archiveRig(rig.id)).toBe(true);
    return { rig, node };
  }
  function liveGeneration(name: string) {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "impl.astra", { runtime: "claude-code", model: "fable" });
    const s = sessions.registerSession(node.id, `impl-astra@${name}`);
    sessions.updateStatus(s.id, "running");
    return { rig, node };
  }

  it("one live + two archived rigs of the same name: the seat resolves to exactly the live node", async () => {
    archivedGeneration("hc");
    archivedGeneration("hc");
    const live = liveGeneration("hc");
    expect(rigRepo.findRigsByName("hc")).toHaveLength(3);   // the raw lookup still sees every generation

    const st = status.getStatus("impl-astra@hc");
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status.rig_id).toBe(live.rig.id);

    const r = await lifecycle.setModel({ seatRef: "impl-astra@hc", model: "fable", reason: "patch 138 regression" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.seat.nodeId).toBe(live.node.id); expect(r.changed).toBe(false); }
  });

  it("archived-only name: the seat still resolves (archived seats stay addressable)", async () => {
    const old = archivedGeneration("legacy");
    // seat-status matches a session-less node by its logical id (pre-existing: it doesn't derive the dashed canonical
    // name the way seat-lifecycle does), so address it that way here
    const st = status.getStatus("impl.astra@legacy");
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status.rig_id).toBe(old.rig.id);
    const r = await lifecycle.setModel({ seatRef: "impl-astra@legacy", model: "fable", reason: "patch 138 regression" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.seat.nodeId).toBe(old.node.id);
  });

  it("two archived rigs and no live one: still ambiguous (honest), never silently picks one", () => {
    archivedGeneration("gone");
    archivedGeneration("gone");
    const st = status.getStatus("impl-astra@gone");
    expect(st.ok).toBe(false);
  });

  it("two LIVE rigs of the same name stay ambiguous: the fix only sets archived generations aside", () => {
    liveGeneration("twin");
    liveGeneration("twin");
    const st = status.getStatus("impl-astra@twin");
    expect(st.ok).toBe(false);
  });

  it("findRigsByNamePreferLive: live ones when any exist, else every rig of that name", () => {
    const a1 = archivedGeneration("x"), a2 = archivedGeneration("x");
    expect(rigRepo.findRigsByNamePreferLive("x").map((r) => r.id)).toEqual([a1.rig.id, a2.rig.id]);
    const l = liveGeneration("x");
    expect(rigRepo.findRigsByNamePreferLive("x").map((r) => r.id)).toEqual([l.rig.id]);
    expect(rigRepo.findRigsByNamePreferLive("nope")).toEqual([]);
  });
});
