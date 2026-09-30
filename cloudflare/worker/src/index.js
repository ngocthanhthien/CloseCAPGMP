import { corsHeaders, err } from "./util.js";
import { handleLogin, handleMe } from "./auth.js";
import { handleGetRecords, handleSaveRecord } from "./records.js";
import { handleGetAudit } from "./audit.js";
import { handleMediaUpload } from "./media.js";
import { handleReportTraffic } from "./traffic.js";
import { handleListUsers, handleCreateUser, handleChangeRole, handleSetStatus } from "./admin.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (path === "/auth/login" && method === "POST") return await handleLogin(request, env);
      if (path === "/me" && method === "GET") return await handleMe(request, env);

      if (path === "/records" && method === "GET") return await handleGetRecords(request, env, url);
      if (path === "/records" && method === "POST") return await handleSaveRecord(request, env);

      if (path === "/audit" && method === "GET") return await handleGetAudit(request, env, url);

      if (path === "/media/upload" && method === "PUT") return await handleMediaUpload(request, env, url);

      if (path === "/traffic/report" && method === "POST") return await handleReportTraffic(request, env);

      if (path === "/admin/users" && method === "GET") return await handleListUsers(request, env);
      if (path === "/admin/users" && method === "POST") return await handleCreateUser(request, env);
      const roleMatch = /^\/admin\/users\/([^/]+)\/role$/.exec(path);
      if (roleMatch && method === "PATCH") return await handleChangeRole(request, env, roleMatch[1]);
      const statusMatch = /^\/admin\/users\/([^/]+)\/status$/.exec(path);
      if (statusMatch && method === "PATCH") {
        let body = {};
        try { body = await request.clone().json(); } catch {}
        return await handleSetStatus(request, env, statusMatch[1], !!body.disabled);
      }

      return err("Not found", 404, request, env);
    } catch (e) {
      return err("Internal error: " + (e && e.message ? e.message : String(e)), 500, request, env);
    }
  },

  // Replaces pg_cron jobs gmp_purge_old_audit (7 days) and gmp_purge_old_traffic (14 days).
  // Scheduled per [triggers].crons in wrangler.toml (daily 03:00 UTC).
  async scheduled(event, env) {
    const now = Date.now();
    const auditCutoff = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const trafficCutoff = new Date(now - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("delete from gmp_audit where ts < ?").bind(auditCutoff),
      env.DB.prepare("delete from gmp_traffic_daily where date < ?").bind(trafficCutoff),
    ]);
  },
};
