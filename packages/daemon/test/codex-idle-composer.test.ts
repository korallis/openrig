// Codex 0.158 idle seats read activity "unknown": the idle composer shows a DIM placeholder ("› Ask Codex to do
// anything") that the plain-text idle signatures can't see, and Codex draws the same composer during a turn.
// Fixtures are real 0.158 pane tails (redacted), plain and ANSI.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPaneActivity, idleComposerEvidence } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/codex-0158-panes", name), "utf8");
const idleAnsi = fx("idle.ansi"), idleTxt = fx("idle.txt"), busyAnsi = fx("busy.ansi"), busyTxt = fx("busy.txt");
// A typed draft: Codex renders it at normal weight where the placeholder is dim.
const draftAnsi = idleAnsi.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "fix the flaky test");

describe("idleComposerEvidence (Codex >= 0.158)", () => {
  it("recognises the idle composer with its dim placeholder", () => {
    expect(idleComposerEvidence(idleAnsi)).toBe("› Ask Codex to do anything");
  });
  it("never calls a working turn idle, though the same composer and footer are drawn", () => {
    expect(busyTxt).toContain("esc to interrupt");
    expect(idleComposerEvidence(busyAnsi)).toBeNull();
  });
  it("never calls a typed draft idle", () => {
    expect(idleComposerEvidence(draftAnsi)).toBeNull();
  });
  it("accepts an empty composer; refuses numbered selections, permission questions and plain (non-ANSI) text", () => {
    expect(idleComposerEvidence("done\n\n\x1b[1m›\x1b[0m\n\n  footer")).toBe("›");
    expect(idleComposerEvidence("Pick one\n› 1. Yes\n  2. No")).toBeNull();
    expect(idleComposerEvidence("Do you want to proceed?\n\x1b[1m›\x1b[0m \x1b[2mAsk\x1b[0m")).toBeNull();
    expect(idleComposerEvidence(idleTxt)).toBeNull(); // without SGR a placeholder can't be told from a draft
  });
  it("the plain classifier alone reads the idle pane as unknown (the bug) and the busy pane as active", () => {
    expect(classifyPaneActivity(idleTxt).state).toBe("unknown");
    expect(classifyPaneActivity(busyTxt)).toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
  });
});

describe("SeatStructuralActivityService uses the ANSI capture only when nothing else classified the pane", () => {
  const service = (plain: string, ansi: string | null, reads: string[]) => new SeatStructuralActivityService({
    capturePaneContent: async () => plain,
    ...(ansi === null ? {} : { capturePaneContentAnsi: async () => { reads.push("ansi"); return ansi; } }),
  });
  it("idle Codex seat -> agent_idle / idle_composer", async () => {
    const reads: string[] = [];
    expect(await service(idleTxt, idleAnsi, reads).pollSeat("s")).toMatchObject({ state: "agent_idle", reason: "idle_composer", evidence: "› Ask Codex to do anything" });
    expect(reads).toEqual(["ansi"]);
  });
  it("busy Codex seat stays active and needs no ANSI read", async () => {
    const reads: string[] = [];
    expect(await service(busyTxt, busyAnsi, reads).pollSeat("s")).toMatchObject({ state: "agent_active" });
    expect(reads).toEqual([]);
  });
  it("an adapter without the ANSI capture behaves exactly as before", async () => {
    expect(await service(idleTxt, null, []).pollSeat("s")).toMatchObject({ state: "unknown" });
  });
});
