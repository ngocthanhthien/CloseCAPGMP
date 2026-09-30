import { json, err } from "./util.js";
import { authenticate } from "./auth.js";

export async function handleGetAudit(request, env, url) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const { results } = await env.DB.prepare(
    "select id, ts, actor_id, actor_name, device, action, detail, area from gmp_audit order by ts desc, id desc limit ?"
  ).bind(limit).all();
  return json({ rows: results }, {}, request, env);
}
