// Port of RPC gmp_report_traffic. Any approved (non-disabled) member may report their own
// device's usage — self-reported estimate, not a privileged action (Soft/Hard limits
// themselves are edited through /records with kind='settings', which already requires admin).
import { json, err, nowISO } from "./util.js";
import { authenticate } from "./auth.js";

export async function handleReportTraffic(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);

  let body;
  try { body = await request.json(); } catch { return err("GMP_INVALID: bad request body", 400, request, env); }
  const date = String(body.date || "");
  const device = String(body.device || "");
  const bytes = Number(body.bytes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !device || !Number.isFinite(bytes) || bytes < 0) {
    return err("GMP_INVALID: bad traffic report", 400, request, env);
  }

  // Upsert GREATEST(old,new) — client reports its cumulative today total, not a delta, so
  // retries/out-of-order calls can never regress the counter.
  await env.DB.prepare(
    `insert into gmp_traffic_daily (date, device, bytes, updated_at) values (?,?,?,?)
     on conflict(date, device) do update set
       bytes = max(gmp_traffic_daily.bytes, excluded.bytes), updated_at = excluded.updated_at`
  ).bind(date, device.slice(0, 100), Math.floor(bytes), nowISO()).run();

  const { results } = await env.DB.prepare("select bytes from gmp_traffic_daily where date=?").bind(date).all();
  const total = results.reduce((s, r) => s + (r.bytes || 0), 0);
  return json({ ok: true, totalBytes: total }, {}, request, env);
}
