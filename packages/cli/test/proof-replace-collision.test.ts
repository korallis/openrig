// Patch 137, QA round 2: when --replace's temp name already exists, the exclusive create fails. The cleanup must then
// leave that file alone (it could be the --file source). Only a temp this run created is ever removed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:crypto", async (orig) => ({ ...(await orig<typeof import("node:crypto")>()), randomUUID: () => "fixed-uuid" }));
const { proofCommand } = await import("../src/commands/proof.js");

describe("rig proof add --replace temp-name collision (patch 137)", () => {
  let workRoot: string, proofDir: string;
  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-coll-"));
    const slice = path.join(workRoot, "missions", "m", "slices", "01-s");
    proofDir = path.join(slice, "proof");
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "m", "README.md"), "---\nid: M\n---\n");
    fs.writeFileSync(path.join(slice, "README.md"), "---\nid: M.1\nstatus: building\n---\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it("a pre-existing file with the temp's name is never deleted, and the drop fails", async () => {
    fs.writeFileSync(path.join(proofDir, "collision.md"), "old artifact\n");
    const squatter = path.join(proofDir, `.collision.md.${process.pid}.fixed-uuid.tmp`);
    fs.writeFileSync(squatter, "SOURCE MUST REMAIN\n");
    const cmd = proofCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(["node", "proof", "--workspace", workRoot, "add", "01-s", "--mission", "m",
      "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--file", squatter, "--name", "collision.md", "--replace"])).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(squatter, "utf8")).toBe("SOURCE MUST REMAIN\n");
    expect(fs.readFileSync(path.join(proofDir, "collision.md"), "utf8")).toBe("old artifact\n");
  });

  it("a successful --replace leaves no temp file behind", async () => {
    fs.writeFileSync(path.join(proofDir, "a.md"), "old\n");
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "proof", "--workspace", workRoot, "add", "01-s", "--mission", "m",
      "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "m",
      "--body", "new", "--name", "a.md", "--replace"]);
    expect(fs.readdirSync(proofDir)).toEqual(["a.md"]);
    expect(fs.readFileSync(path.join(proofDir, "a.md"), "utf8")).toMatch(/new$/);
  });
});
