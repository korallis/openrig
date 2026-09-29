// #132 — proof show/judge resolve a project-qualified scope through the workspace catalog, applying
// containment per project root; unqualified scopes keep the selected `workspace.slices_root` behavior.
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { Hono } from "hono";
import { proofRoutes } from "../src/routes/proof.js";
import { readSliceReadiness } from "../src/domain/proof/judgments.js";

const fixtures: string[] = [];
afterEach(() => { for (const p of fixtures.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const write = (p: string, data: string | object) => { fs.mkdirSync(join(p, ".."), { recursive: true }); fs.writeFileSync(p, typeof data === "string" ? data : YAML.stringify(data)); };

function project(root: string, id: string, judge: string) {
  write(join(root, "project.yaml"), { kind: "project", metadata: { id }, proofPolicy: { judges: [judge] }, missions: { root: "missions" } });
  write(join(root, "README.md"), `# ${id}\n`);
  const mission = join(root, "missions", "m0"), slice = join(mission, "slices", "01-t001");
  write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "m0", status: "active" }, composition: { slices: [{ ref: "slices/01-t001/slice.yaml", order: 1, active: true }] } });
  write(join(slice, "slice.yaml"), { kind: "slice", metadata: { id: "01-t001", status: "draft" } });
  write(join(slice, "SPEC.md"), `---\nid: 01-t001\n---\n# ${id}\n\n## Proof contract\n- [ ] Prove ${id}.\n`);
  write(join(slice, "proof", "evidence.md"), `Observed ${id}.\n`);
  return { missions: join(root, "missions"), slice };
}

function fixture() {
  const workspace = fs.mkdtempSync(join(tmpdir(), "proof-catalog-")); fixtures.push(workspace);
  write(join(workspace, "workspace.yaml"), { projects: [{ id: "hc-prime", root: "hc-prime" }, { id: "mta", root: "mta" }] });
  const hc = project(join(workspace, "hc-prime"), "hc-prime", "judge@hc");
  const mta = project(join(workspace, "mta"), "mta", "judge@hc");
  // The daemon's single selected slices root is a different (legacy) project.
  const legacy = project(join(workspace, "legacy"), "legacy", "judge@hc");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, { isReady: () => true, slicesRoot: legacy.missions, invalidate: () => {} } as never);
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? workspace : join(workspace, "workspace.yaml") }) } as never);
    await next();
  });
  app.route("/api/proof", proofRoutes());
  const get = (query: string) => app.request(`/api/proof?${query}`);
  const judge = async (scope: string, extra: Record<string, unknown> = {}, readDir = hc.slice) => {
    const item = readSliceReadiness(readDir).items[0]!;
    return app.request("/api/proof/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "judge@hc" },
      body: JSON.stringify({ scope, item: item.id, verdict: "accept", reason: "Observed", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: null, ...extra }),
    });
  };
  return { workspace, hc, mta, legacy, get, judge };
}

describe("project-qualified proof scope (#132)", () => {
  it("show resolves `<project>:<scope>` and `project=` through the catalog, not the selected slices root", async () => {
    const f = fixture();
    const qualified = await f.get(`scope=${encodeURIComponent("hc-prime:m0/slices/01-t001")}`);
    expect(qualified.status).toBe(200);
    expect((await qualified.json()).items[0].text).toContain("Prove hc-prime.");
    const byFlag = await f.get("project=mta&scope=m0/slices/01-t001");
    expect(byFlag.status).toBe(200);
    expect((await byFlag.json()).items[0].text).toContain("Prove mta.");
    const readiness = await f.get("project=mta");
    expect(readiness.status).toBe(200);
    expect((await readiness.json()).missions.map((m: { name: string }) => m.name)).toEqual(["m0"]);
  });

  it("an unqualified scope keeps today's selected-workspace behavior", async () => {
    const f = fixture();
    const res = await f.get("scope=m0/slices/01-t001");
    expect(res.status).toBe(200);
    expect((await res.json()).items[0].text).toContain("Prove legacy.");
  });

  it("judge records the receipt inside the named project only", async () => {
    const f = fixture();
    const res = await f.judge("hc-prime:m0/slices/01-t001");
    expect(res.status).toBe(201);
    expect((await res.json()).judgment).toMatchObject({ scope: "missions/m0/slices/01-t001", actor: "judge@hc" });
    expect(fs.existsSync(join(f.hc.slice, "proof/judgments/00000001.md"))).toBe(true);
    for (const other of [f.mta.slice, f.legacy.slice]) expect(fs.existsSync(join(other, "proof/judgments"))).toBe(false);
    const flagged = await f.judge("m0/slices/01-t001", { project: "mta" }, f.mta.slice);
    expect(flagged.status).toBe(201);
    expect(fs.existsSync(join(f.mta.slice, "proof/judgments/00000001.md"))).toBe(true);
  });

  it("applies path_escape per project root — a sibling project or the workspace is outside", async () => {
    const f = fixture();
    const sibling = await f.get(`scope=${encodeURIComponent("hc-prime:../../mta/missions/m0/slices/01-t001")}`);
    expect(sibling.status).toBe(400);
    expect((await sibling.json()).error).toBe("path_escape");
    const judged = await f.judge("hc-prime:../../legacy/missions/m0/slices/01-t001", {}, f.legacy.slice);
    expect((await judged.json()).error).toBe("path_escape");
    const outside = fs.mkdtempSync(join(tmpdir(), "proof-outside-")); fixtures.push(outside);
    fs.writeFileSync(join(outside, "evidence.md"), "outside");
    fs.symlinkSync(outside, join(f.hc.slice, "proof/outside"));
    const evidence = await f.judge("hc-prime:m0/slices/01-t001", { evidence: ["proof/outside/evidence.md"] });
    expect((await evidence.json()).error).toBe("path_escape");
    expect(fs.existsSync(join(f.hc.slice, "proof/judgments"))).toBe(false);
  });

  it("refuses an unknown project, an invalid id, and a scope/flag project conflict", async () => {
    const f = fixture();
    const unknown = await f.get(`scope=${encodeURIComponent("nope:m0/slices/01-t001")}`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("project_not_found");
    const invalid = await f.get("project=..%2Fescape&scope=m0");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_project");
    const conflict = await f.judge("hc-prime:m0/slices/01-t001", { project: "mta" });
    expect(conflict.status).toBe(400);
    expect((await conflict.json()).error).toBe("project_conflict");
    expect(fs.existsSync(join(f.hc.slice, "proof/judgments"))).toBe(false);
  });
});
