// #132 — rig proof show/judge carry a catalog project to the daemon (--project or a <project>: prefix).
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
vi.mock("../src/client.js", () => ({
  DaemonClient: class {
    async get(url: string) {
      calls.push({ method: "GET", url });
      return { status: 200, data: { items: [{ id: "i1", text: "Prove it.", index: 1, revision: "r1", judgment: null }] } };
    }
    async post(url: string, body: Record<string, unknown>) {
      calls.push({ method: "POST", url, body });
      return { status: 201, data: { ok: true } };
    }
  },
}));
const { proofCommand } = await import("../src/commands/proof.js");

const run = (args: string[]) => proofCommand().parseAsync(["node", "proof", ...args]);
beforeEach(() => { calls.length = 0; vi.spyOn(console, "log").mockImplementation(() => {}); });

describe("rig proof --project (#132)", () => {
  it("show passes --project and the scope as query parameters", async () => {
    await run(["show", "m0/slices/01-t001", "--project", "hc-prime"]);
    expect(calls[0]!.url).toBe("/api/proof?project=hc-prime&scope=m0%2Fslices%2F01-t001");
  });
  it("show without a scope reads that project's readiness; without --project the request is unchanged", async () => {
    await run(["show", "--project", "mta"]);
    await run(["show", "m0/slices/01-t001"]);
    await run(["show"]);
    expect(calls.map(c => c.url)).toEqual(["/api/proof?project=mta", "/api/proof?scope=m0%2Fslices%2F01-t001", "/api/proof"]);
  });
  it("judge forwards --project on the preparation read and the judgment body", async () => {
    await run(["judge", "m0/slices/01-t001#i1", "--project", "hc-prime", "--verdict", "accept", "--reason", "seen", "--evidence", "proof/e.md"]);
    expect(calls[0]!.url).toBe("/api/proof?project=hc-prime&scope=m0%2Fslices%2F01-t001&evidence=proof%2Fe.md");
    expect(calls[1]!.body).toMatchObject({ scope: "m0/slices/01-t001", item: "i1", project: "hc-prime" });
  });
  it("judge passes a <project>: prefixed scope through verbatim and adds no project field", async () => {
    await run(["judge", "hc-prime:m0/slices/01-t001#i1", "--verdict", "reject", "--reason", "no"]);
    expect(calls[0]!.url).toBe("/api/proof?scope=hc-prime%3Am0%2Fslices%2F01-t001");
    expect(calls[1]!.body).toMatchObject({ scope: "hc-prime:m0/slices/01-t001" });
    expect(calls[1]!.body).not.toHaveProperty("project");
  });
});
