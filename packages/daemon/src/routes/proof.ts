import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { EventBus } from "../domain/event-bus.js";
import { JudgmentError, evidenceAt, readSliceReadiness, readMissionReadiness, readProjectReadiness, recordJudgment, resolveProofScope, type JudgeInput } from "../domain/proof/judgments.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";
import { projectById } from "../domain/workspace/project-read.js";
import { ProjectReadError } from "../domain/workspace/project-catalog.js";

// #132 — `<project-id>:<scope>` names a scope inside one workspace-catalog project. Project ids share the
// catalog's id grammar, which cannot contain "/", so an ordinary mission/slice path never matches.
const QUALIFIED_SCOPE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(.*)$/;

export function proofRoutes(): Hono {
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof JudgmentError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    return c.json({ error: "proof_unavailable", message: e.message }, 503);
  });
  const indexer = (c: { get: (key: never) => unknown }): SliceIndexer => {
    const value = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!value?.isReady()) throw new JudgmentError("workspace_unavailable", "Configure the daemon workspace before reading or recording judgments", 503);
    return value;
  };
  /**
   * The missions root a proof read/judgment resolves against. Unqualified scopes keep the daemon's
   * selected workspace (`workspace.slices_root`). A project named by `--project`/`project` or by a
   * `<project-id>:` scope prefix resolves through the workspace catalog entry's root and missions root,
   * so contained() is then applied per project root.
   */
  const target = (c: Parameters<typeof indexer>[0], rawScope: string | undefined, project: unknown) => {
    if (project !== undefined && typeof project !== "string") throw new JudgmentError("judgment_invalid", "Project must be a catalog project id");
    const qualified = rawScope === undefined ? null : QUALIFIED_SCOPE.exec(rawScope);
    const id = qualified?.[1] ?? project;
    if (qualified && project !== undefined && project !== qualified[1]) throw new JudgmentError("project_conflict", `Scope names project ${qualified[1]} but --project names ${project}; select one project`);
    const scope = qualified ? qualified[2]! : rawScope;
    if (id === undefined) { const owner = indexer(c); return { root: owner.slicesRoot, evidenceRoot: path.dirname(owner.slicesRoot), scope, owner }; }
    // Evidence is prepared against the project root (where project.yaml lives), the same root recordJudgment derives,
    // so prepared references still match at judgment time under a nested authored missions.root.
    try { const p = projectById(c, id); return { root: p.missionsRoot, evidenceRoot: p.root, scope, owner: null }; }
    catch (e) {
      if (!(e instanceof ProjectReadError)) throw e;
      throw new JudgmentError(e.code, e.message, e.code === "project_not_found" ? 404 : e.code === "invalid_project" ? 400 : 409);
    }
  };
  app.get("/", c => {
    const { root, evidenceRoot, scope } = target(c, c.req.query("scope"), c.req.query("project"));
    if (!scope) return c.json({ ...readProjectReadiness(root), sourceObservation: proofSourceObservation(c) });
    const dir = resolveProofScope(root, scope);
    if (path.basename(path.dirname(dir)) !== "slices") return c.json({ ...readMissionReadiness(dir), sourceObservation: proofSourceObservation(c) });
    const refs = c.req.queries("evidence") ?? [];
    return c.json({ ...readSliceReadiness(dir), sourceObservation: proofSourceObservation(c), ...(refs.length ? { preparedEvidence: refs.map(ref => evidenceAt(evidenceRoot, dir, ref)) } : {}) });
  });
  app.post("/judge", async c => {
    const body = await c.req.json<JudgeInput & { actorSession?: string; project?: string }>().catch(() => null);
    if (!body || typeof body.scope !== "string" || typeof body.item !== "string" || typeof body.expectedRevision !== "string" || !(body.expectedPrevious === null || typeof body.expectedPrevious === "string") || (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some(e => typeof e !== "string")))) throw new JudgmentError("judgment_invalid", "Provide scope, item, expected revision/predecessor and evidence references; rig proof judge resolves these in the ordinary path");
    if ((body.actorSession !== undefined && typeof body.actorSession !== "string") || typeof body.reason !== "string" || (body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim())) || (body.subject !== undefined && (!body.subject || typeof body.subject !== "object" || typeof body.subject.kind !== "string" || typeof body.subject.ref !== "string")) || (body.replace !== undefined && typeof body.replace !== "boolean")) throw new JudgmentError("judgment_invalid", "Reason, operation identity and subject must have their declared types");
    if (body.expectedEvidence !== undefined && (!Array.isArray(body.expectedEvidence) || body.expectedEvidence.some(e => !e || typeof e.ref !== "string" || typeof e.sha256 !== "string"))) throw new JudgmentError("judgment_invalid", "Expected evidence must be prepared reference/digest pairs");
    if (body.subject?.comparison !== undefined && typeof body.subject.comparison !== "string") throw new JudgmentError("judgment_invalid", "Comparison must be an evidence reference");
    const identity = requireSenderIdentity(c, { verb: "proof judgment", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    const { project: _project, ...input } = body;
    const { root, scope, owner } = target(c, body.scope, body.project);
    const result = recordJudgment(root, { ...input, scope: scope! }, identity.session, resolveRecordedProvenance(c, identity));
    owner?.invalidate();
    // The receipt is already durable. A lost notification must not turn a committed write into a claimed rollback.
    let notification = "unchanged";
    if (!result.replayed) {
      try {
        const bus = c.get("eventBus" as never) as EventBus | undefined;
        if (!bus) notification = "unavailable; direct reads are current, quiet refresh repairs views";
        else { bus.emit({ type: "proof.judged", scope: body.scope, revision: result.readiness.revision }); notification = "emitted"; }
      } catch { notification = "unavailable; quiet refresh repairs views"; }
    }
    return c.json({ ...result, notification }, result.replayed ? 200 : 201);
  });
  return app;
}
