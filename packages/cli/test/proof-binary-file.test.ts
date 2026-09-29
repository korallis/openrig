// Local patch 137 (0.6.1): `rig proof add --file` read any file as UTF-8 and wrote it back under a C1 header, named after
// the file. `--file proof/shot.png` therefore rewrote the screenshot in place as a YAML header plus mangled bytes (8 PNGs
// lost on matilda-v2, 2026-09-29). An artifact is now always a text .md file that never silently replaces another file.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proofCommand, nonTextReason } from "../src/commands/proof.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0xd8]);

describe("rig proof add: binary --file, .md names, no overwrite (patch 137)", () => {
  let workRoot: string, sliceDir: string, proofDir: string, errs: string[];

  beforeEach(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proof-bin-"));
    sliceDir = path.join(workRoot, "missions", "release-x", "slices", "19-signal-layer");
    proofDir = path.join(sliceDir, "proof");
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(workRoot, "missions", "release-x", "README.md"), "---\nid: OPR.X\n---\n# m\n");
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.X.19\nstatus: building\n---\n# slice\n");
    errs = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(a.join(" ")); });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  async function add(...extra: string[]): Promise<void> {
    const cmd = proofCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "proof", "--workspace", workRoot, "add", "19-signal-layer", "--mission", "release-x",
      "--artifact-type", "qa", "--verdict", "CLEAR", "--candidate-sha", "abc1234", "--money-evidence", "m", ...extra]);
  }
  const listing = () => fs.readdirSync(proofDir).sort();

  it("the reported case: --file proof/shot.png is refused and the PNG is byte-identical afterwards", async () => {
    const shot = path.join(proofDir, "shot.png");
    fs.writeFileSync(shot, PNG);
    await add("--file", shot);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(shot).equals(PNG)).toBe(true);
    expect(listing()).toEqual(["shot.png"]);
    expect(errs.join("\n")).toMatch(/is not a text file \(its extension \.png is a binary type\)[\s\S]*--media <name>/);
  });

  it("binary content is refused whatever the extension: NUL bytes, invalid UTF-8", async () => {
    const nul = path.join(workRoot, "capture.txt");
    fs.writeFileSync(nul, Buffer.from("text\u0000more"));
    await add("--file", nul);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("it contains NUL bytes");
    process.exitCode = undefined;
    const latin1 = path.join(workRoot, "notes.log");
    fs.writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Latin-1
    await add("--file", latin1);
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("it is not valid UTF-8");
    expect(listing()).toEqual([]);
  });

  it("nonTextReason: text of any extension passes; binary types and bytes are named", () => {
    expect(nonTextReason("a.md", Buffer.from("# ok — ünïcode ✓\n"))).toBeNull();
    expect(nonTextReason("run.log", Buffer.from("plain\n"))).toBeNull();
    expect(nonTextReason("clip.MP4", Buffer.from("x"))).toBe("its extension .mp4 is a binary type");
    expect(nonTextReason("report.pdf", Buffer.from("%PDF"))).toBe("its extension .pdf is a binary type");
  });

  it("a text --file defaults to <stem>.md, and the source is left alone", async () => {
    const log = path.join(workRoot, "qa-run.txt");
    fs.writeFileSync(log, "all 12 journeys green\n");
    await add("--file", log);
    expect(process.exitCode).toBeUndefined();
    expect(listing()).toEqual(["qa-run.md"]);
    expect(fs.readFileSync(path.join(proofDir, "qa-run.md"), "utf8")).toMatch(/^---\n[\s\S]*\n---\n\nall 12 journeys green\n$/);
    expect(fs.readFileSync(log, "utf8")).toBe("all 12 journeys green\n");
  });

  it("--name must end in .md", async () => {
    for (const name of ["shot.png", "qa-clear", "notes.txt", ".md"]) {
      process.exitCode = undefined;
      await add("--body", "b", "--name", name);
      expect(process.exitCode, name).toBe(1);
    }
    expect(errs.join("\n")).toContain("does not end in .md");
    expect(listing()).toEqual([]);
    process.exitCode = undefined;
    await add("--body", "b", "--name", "QA-Clear.MD");
    expect(process.exitCode).toBeUndefined();
    expect(listing()).toEqual(["QA-Clear.MD"]);
  });

  it("an existing artifact is never overwritten without --replace; --replace overwrites only that .md", async () => {
    await add("--body", "first", "--name", "qa-clear.md");
    await add("--body", "second", "--name", "qa-clear.md");
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("proof/qa-clear.md already exists");
    expect(fs.readFileSync(path.join(proofDir, "qa-clear.md"), "utf8")).toMatch(/first$/);
    process.exitCode = undefined;
    await add("--body", "second", "--name", "qa-clear.md", "--replace");
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(path.join(proofDir, "qa-clear.md"), "utf8")).toMatch(/second$/);
  });

  it("a text --file in proof/ is never replaced by its own artifact, even with --replace", async () => {
    const note = path.join(proofDir, "walkthrough.md");
    fs.writeFileSync(note, "# what I saw\n");
    for (const extra of [[], ["--replace"]]) {
      process.exitCode = undefined;
      await add("--file", note, ...extra);
      expect(process.exitCode).toBe(1);
    }
    expect(errs.join("\n")).toContain("would overwrite its own --file source");
    expect(fs.readFileSync(note, "utf8")).toBe("# what I saw\n");
  });

  // QA round 1: --replace must never write THROUGH the existing name
  it("--replace over a hardlink of the --file source is refused, and the source is unchanged", async () => {
    const source = path.join(workRoot, "source.txt");
    fs.writeFileSync(source, "the original evidence\n");
    fs.linkSync(source, path.join(proofDir, "linked.md"));
    await add("--file", source, "--name", "linked.md", "--replace");
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("would overwrite its own --file source");
    expect(fs.readFileSync(source, "utf8")).toBe("the original evidence\n");
  });

  it("--replace over a hardlink of some other file replaces only the proof/ entry, never the other file", async () => {
    const other = path.join(workRoot, "other.md");
    fs.writeFileSync(other, "someone else's notes\n");
    fs.linkSync(other, path.join(proofDir, "notes.md"));
    await add("--body", "new note", "--name", "notes.md", "--replace");
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(other, "utf8")).toBe("someone else's notes\n");
    expect(fs.readFileSync(path.join(proofDir, "notes.md"), "utf8")).toMatch(/new note$/);
  });

  it("--replace over a symlink to an image outside proof/ replaces the link, never the image", async () => {
    const outside = path.join(workRoot, "outside.png");
    fs.writeFileSync(outside, PNG);
    fs.symlinkSync(outside, path.join(proofDir, "image-link.md"));
    await add("--body", "note", "--name", "image-link.md", "--replace");
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(outside).equals(PNG)).toBe(true);
    expect(fs.lstatSync(path.join(proofDir, "image-link.md")).isSymbolicLink()).toBe(false);
    expect(listing().filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // without --replace, an existing link of that name is refused and left alone
    fs.rmSync(path.join(proofDir, "image-link.md"));
    fs.symlinkSync(outside, path.join(proofDir, "image-link.md"));
    process.exitCode = undefined;
    await add("--body", "note", "--name", "image-link.md");
    expect(process.exitCode).toBe(1);
    expect(fs.lstatSync(path.join(proofDir, "image-link.md")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside).equals(PNG)).toBe(true);
  });

  it("--replace over a symlink to the --file source is refused", async () => {
    const source = path.join(workRoot, "src.md");
    fs.writeFileSync(source, "keep me\n");
    fs.symlinkSync(source, path.join(proofDir, "src-link.md"));
    await add("--file", source, "--name", "src-link.md", "--replace");
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(source, "utf8")).toBe("keep me\n");
  });

  it("images stay attachable the supported way: --media next to a text body", async () => {
    fs.writeFileSync(path.join(proofDir, "shot.png"), PNG);
    await add("--body", "the dashboard shows real data", "--media", "shot.png", "--name", "qa-clear.md");
    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(path.join(proofDir, "shot.png")).equals(PNG)).toBe(true);
    expect(fs.readFileSync(path.join(proofDir, "qa-clear.md"), "utf8")).toContain("![shot.png](shot.png)");
  });
});
