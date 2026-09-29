// 0.6.1 regression: resolveGuardTarget matched bound AND unbound nodes in one pass and required exactly one row, so the
// unbound nodes of ARCHIVED rigs with the same name made every live seat's session ambiguous ("Cannot establish managed
// input target impl-codex-1@hc"). A bound binding match wins; derived-name matching only applies among unbound rows.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

function fleet() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('live','hc'),('old1','hc'),('old2','hc');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES
      ('n-live','live','impl.codex-1'), ('n-old1','old1','impl.codex-1'), ('n-old2','old2','impl.codex-1'),
      ('n-new','live','qa.codex-9');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b-live','n-live','impl-codex-1@hc','%5');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g1','n-live',1,'gen-live','fresh');`);
  return db;
}

describe("resolveGuardTarget with archived rigs of the same name", () => {
  it("the bound live seat wins over unbound archived nodes, by session name and by pane", () => {
    const db = fleet();
    expect(resolveGuardTarget(db, "impl-codex-1@hc")).toMatchObject({ nodeId: "n-live", session: "impl-codex-1@hc", pane: "%5", occupant: "gen-live" });
    expect(resolveGuardTarget(db, "%5")).toMatchObject({ nodeId: "n-live" });
  });
  it("an exact node id still resolves that node", () => {
    expect(resolveGuardTarget(fleet(), "n-old1")).toMatchObject({ nodeId: "n-old1" });
  });
  it("derived-name matching still works for a single unbound node, and stays ambiguous for several", () => {
    const db = fleet();
    expect(resolveGuardTarget(db, "qa-codex-9@hc")).toMatchObject({ nodeId: "n-new", session: "qa-codex-9@hc", pane: null });
    db.exec("DELETE FROM bindings WHERE id='b-live'"); // now three unbound impl.codex-1 nodes named impl-codex-1@hc
    expect(resolveGuardTarget(db, "impl-codex-1@hc")).toBeNull();
  });
  it("a bare logical id never resolves to an archived twin of a bound live node", () => {
    const db = fleet();
    db.exec("DELETE FROM nodes WHERE id='n-old2'"); // one archived twin left
    expect(resolveGuardTarget(db, "impl.codex-1")).toBeNull();
    expect(resolveGuardTarget(db, "qa.codex-9")).toMatchObject({ nodeId: "n-new" });
  });
  it("two bound rows for one name stay ambiguous", () => {
    const db = fleet();
    db.exec("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('b-dup','n-old1','impl-codex-1@hc','%9')");
    expect(resolveGuardTarget(db, "impl-codex-1@hc")).toBeNull();
  });
});
