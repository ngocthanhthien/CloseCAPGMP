// Save/read path for gmp_records: the same 17 validation rules the app has always enforced
// (optimistic concurrency by revision, admin-only settings/delete, action-review locking,
// embedded-image format, 20 MB cap, etc.) — ported from the original Postgres RPC when the
// backend moved to Cloudflare; see HANDOFF_WEB.md for that migration's history.
import { json, err, validId, validEmbeddedImage, bytesOf, nowISO } from "./util.js";
import { authenticate, requireAdmin } from "./auth.js";

function stable(value) {
  return JSON.stringify(value, function (key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
  });
}
const same = (a, b) => stable(a) === stable(b);
function omit(obj, keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function rowOut(row) {
  return { kind: row.kind, id: row.id, record_key: row.record_key, data: JSON.parse(row.data), revision: row.revision, deleted: !!row.deleted, updated_at: row.updated_at };
}

export async function handleGetRecords(request, env, url) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);

  const since = url.searchParams.get("since") || "";
  let last = url.searchParams.get("cursor") || "";
  const rows = [];
  // Keyset pagination on the unique record_key, same fixed `since` boundary across every
  // page — identical approach to the retired changedRows() in cloud.js.
  for (;;) {
    let sql = "select kind,id,record_key,data,revision,deleted,updated_at from gmp_records where 1=1";
    const binds = [];
    if (since) { sql += " and updated_at > ?"; binds.push(since); }
    if (last) { sql += " and record_key > ?"; binds.push(last); }
    sql += " order by record_key limit 100";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    if (!results.length) break;
    rows.push(...results);
    last = results[results.length - 1].record_key;
    if (results.length < 100) break;
  }
  return json({ rows: rows.map(rowOut) }, {}, request, env);
}

export async function handleSaveRecord(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);
  const actor = auth.user;
  const isAdmin = requireAdmin(actor);

  let body;
  try { body = await request.json(); } catch { return err("GMP_INVALID: bad request body", 400, request, env); }
  const { p_kind: kind, p_id: id, p_data: data, p_deleted: deleted, p_revision: revision, p_device: device } = body;

  // Rule 2
  if ((kind !== "finding" && kind !== "settings") || !validId(id) ||
      typeof revision !== "number" || revision < 0 || typeof deleted !== "boolean" || data == null || typeof data !== "object") {
    return err("GMP_INVALID: invalid record", 400, request, env);
  }
  const recordKey = `${kind}:${id}`;

  const previous = await env.DB.prepare("select * from gmp_records where kind=? and id=?").bind(kind, id).first();

  // Rule 4 — optimistic concurrency
  const prevRevision = previous ? previous.revision : 0;
  if (prevRevision !== revision) return err("GMP_CONFLICT: record changed on another device", 409, request, env);

  // Rule 5
  if ((deleted || kind === "settings" || (previous && previous.deleted)) && !isAdmin) {
    return err("GMP_FORBIDDEN: administrator required", 403, request, env);
  }

  if (kind === "settings") {
    // Rule 6
    if (id !== "main" || deleted || typeof data !== "object" ||
        typeof data.target !== "number" || data.target < 0 || data.target > 100 ||
        typeof data.company !== "string") {
      return err("GMP_INVALID: settings", 400, request, env);
    }
  } else if (!deleted) {
    // Rule 7
    if (typeof data !== "object" || data.id !== id ||
        !String(data.issue || "").trim() || !String(data.area || "").trim() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(data.date || "") || !Array.isArray(data.actions) ||
        typeof data.issue !== "string" || typeof data.area !== "string" || typeof data.date !== "string") {
      return err("GMP_INVALID: finding", 400, request, env);
    }
    for (const k of ["loc", "owner", "reason"]) {
      if (data[k] != null && typeof data[k] !== "string") return err("GMP_INVALID: finding text fields", 400, request, env);
    }

    const oldActions = (previous ? JSON.parse(previous.data).actions : null) || [];
    // Rule 8
    if (previous) {
      if (data.actions.length > Math.max(1, oldActions.length)) return err("GMP_INVALID: at most one new action", 400, request, env);
    } else if (!isAdmin && data.actions.length > 1) {
      return err("GMP_INVALID: at most one new action", 400, request, env);
    }

    // Rule 9 — non-admin can only touch actions/updatedAt on an existing finding
    if (!isAdmin && previous) {
      const prevData = JSON.parse(previous.data);
      if (!same(omit(data, ["actions", "updatedAt"]), omit(prevData, ["actions", "updatedAt"]))) {
        return err("GMP_FORBIDDEN: only admin edits finding fields", 403, request, env);
      }
    }

    // Rule 10 — no duplicate action ids
    const ids = data.actions.map(a => a && a.id);
    if (new Set(ids).size !== ids.length) return err("GMP_INVALID: duplicate action id", 400, request, env);

    // Rule 11 — non-admin can't drop/alter a reviewed (Pending/Closed) action
    if (!isAdmin) {
      for (const oldItem of oldActions) {
        if ((oldItem.status === "Pending" || oldItem.status === "Closed") &&
            !data.actions.some(a => same(a, oldItem))) {
          return err("GMP_FORBIDDEN: reviewed action is locked", 403, request, env);
        }
      }
    }

    // Rule 12 — per-action shape validation
    for (const item of data.actions) {
      if (typeof item !== "object" || item == null || !validId(item.id) ||
          !["Open", "Pending", "Closed"].includes(item.status)) {
        return err("GMP_INVALID: action", 400, request, env);
      }
      for (const k of ["action", "pic", "due", "confirmedBy", "rejectReason"]) {
        if (item[k] != null && typeof item[k] !== "string") return err("GMP_INVALID: action text fields", 400, request, env);
      }
      const oldItem = oldActions.find(a => a.id === item.id) || null;
      if (!isAdmin) {
        if (!oldItem) {
          if (item.status === "Closed" || item.confirmedBy || item.confirmEvidence || item.confirmedAt || item.rejectReason) {
            return err("GMP_FORBIDDEN: confirmation requires admin", 403, request, env);
          }
        } else {
          const keys = ["action", "pic", "due", "evidence", "status"];
          if (!same(omit(item, keys), omit(oldItem, keys)) || (item.status === "Closed" && oldItem.status !== "Closed")) {
            return err("GMP_FORBIDDEN: confirmation requires admin", 403, request, env);
          }
        }
        if (item.status === "Pending" && !item.evidence) return err("GMP_INVALID: evidence required", 400, request, env);
      }
    }

    // Rule 13 — embedded image format
    const images = [data.findingImg, ...data.actions.flatMap(a => [a.evidence, a.confirmEvidence])];
    for (const img of images) {
      if (img && !validEmbeddedImage(img)) return err("GMP_INVALID: embedded raster image required", 400, request, env);
    }

    // Rule 14 — size cap
    if (bytesOf(data) > 20000000) return err("GMP_INVALID: finding exceeds 20 MB", 400, request, env);
  }

  const updatedAt = nowISO();
  const newRevision = revision + 1;
  const finalData = deleted ? (previous ? previous.data : "{}") : JSON.stringify(data);

  // Rule 15 — atomic upsert + audit insert (D1 batch = single atomic round trip).
  // The DO UPDATE...WHERE guard re-checks revision AT WRITE TIME (not just the SELECT we did
  // above) so a genuine race between two near-simultaneous requests for the same record can't
  // silently overwrite — if another write landed in between, this WHERE fails, `changes`
  // comes back 0, and we report GMP_CONFLICT instead of corrupting the row.
  const actionLabel = deleted ? "Xoá Finding" : (previous ? `Cập nhật ${kind}` : `Tạo ${kind}`);
  const detail = `${id} · ${String((deleted ? (previous && JSON.parse(previous.data).issue) : data.issue) || "Cài đặt").slice(0, 200)}`;
  const area = deleted ? (previous ? JSON.parse(previous.data).area || "" : "") : (data.area || "");

  const [upsertResult] = await env.DB.batch([
    env.DB.prepare(
      `insert into gmp_records (kind,id,record_key,data,revision,deleted,updated_at) values (?,?,?,?,?,?,?)
       on conflict(kind,id) do update set data=excluded.data, revision=excluded.revision, deleted=excluded.deleted, updated_at=excluded.updated_at
       where gmp_records.revision = ?`
    ).bind(kind, id, recordKey, finalData, newRevision, deleted ? 1 : 0, updatedAt, prevRevision),
    env.DB.prepare(
      `insert into gmp_audit (ts,actor_id,actor_name,device,action,detail,area) values (?,?,?,?,?,?,?)`
    ).bind(updatedAt, actor.id, actor.display_name, String(device || "").slice(0, 100), actionLabel, detail, area),
  ]);
  if (previous && upsertResult.meta.changes === 0) {
    // Lost a last-second race against another device — audit row above still gets written
    // (harmless no-op record of the attempt); nothing was corrupted, so it's safe to just
    // report the conflict and let the client re-sync and retry.
    return err("GMP_CONFLICT: record changed on another device", 409, request, env);
  }

  return json({ kind, id, record_key: recordKey, data: deleted ? JSON.parse(finalData) : data, revision: newRevision, deleted, updated_at: updatedAt }, {}, request, env);
}
