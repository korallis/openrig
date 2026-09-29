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
  it("never calls a working turn idle when a tall block sits between the status line and the composer", () => {
    // live layout: "• Working (… esc to interrupt)" followed by an incoming message block, then the composer
    const block = Array.from({ length: 10 }, (_, i) => `  message line ${i + 1}`).join("\n");
    const tall = busyAnsi.replace(/(\n[^\n]*Ask Codex to do anything)/, `\n${block}$1`);
    expect(tall).not.toBe(busyAnsi);
    expect(idleComposerEvidence(tall)).toBeNull();
  });
  it("never calls a typed draft idle", () => {
    expect(idleComposerEvidence(draftAnsi)).toBeNull();
  });
  it("colour parameters are not intensity: a coloured (RGB or palette) typed draft is never idle", () => {
    const placeholder = "\x1b[2mAsk Codex to do anything\x1b[0m";
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\x1b[38;2;246;226;183mtyped draft\x1b[39m"))).toBeNull();
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\x1b[38;5;2mtyped draft\x1b[39m"))).toBeNull();
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\x1b[48;2;2;2;2mtyped draft\x1b[0m"))).toBeNull();
    // a dim placeholder that also carries a colour stays a placeholder
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\x1b[2;38;5;244mAsk Codex to do anything\x1b[0m"))).toBe("› Ask Codex to do anything");
  });
  it("a multi-line draft is never idle: a composer line followed directly by a continuation line", () => {
    const placeholder = "\x1b[2mAsk Codex to do anything\x1b[0m";
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\n  typed draft"))).toBeNull();
    expect(idleComposerEvidence(idleAnsi.replace("anything\x1b[0m", "anything\x1b[0m\n  typed draft"))).toBeNull();
    // a blank line inside the draft is not a footer boundary
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\n\n  typed draft"))).toBeNull();
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "first line\n\n  second paragraph"))).toBeNull();
    // typed text that merely looks like a footer (no footer styling) is still a draft
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\n\n  gpt-6 high · note · done"))).toBeNull();
    expect(idleComposerEvidence(idleAnsi.replace(placeholder, "\n\n  ? for shortcuts"))).toBeNull();
  });
  it("the idle layout holds with or without a blank line before the footer", () => {
    const tight = idleAnsi.replace(/(Ask Codex to do anything\x1b\[0m)\n\n/, "$1\n");
    expect(tight).not.toBe(idleAnsi);
    expect(idleComposerEvidence(tight)).toBe("› Ask Codex to do anything");
  });
  it("unrecognised or too many lines under the composer are not the idle layout", () => {
    expect(idleComposerEvidence(idleAnsi + "\n  extra 1\n  extra 2")).toBeNull();
    const footer = idleAnsi.split("\n").filter(l => l.includes("for shortcuts"))[0]!;
    expect(idleComposerEvidence(idleAnsi + "\n" + footer + "\n" + footer)).toBeNull(); // 4 footer lines
  });
  it("accepts an empty composer; refuses numbered selections, permission questions and plain (non-ANSI) text", () => {
    const hint = idleAnsi.split("\n").find(l => l.includes("for shortcuts"))!;
    expect(idleComposerEvidence(`done\n\n\x1b[1m›\x1b[0m\n\n${hint}`)).toBe("›");
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
