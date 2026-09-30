import { json, err, uuid, nowISO, makePasswordHash, verifyPassword, signJWT, verifyJWT, bearerToken } from "./util.js";

const SESSION_SECONDS = 30 * 24 * 3600; // 30 days. Long-lived on purpose: every privileged
// request still re-checks `disabled`/`role` fresh from D1 (see authenticate() below), so a
// revoked account loses access immediately regardless of how much of the JWT's lifetime is
// left — the token only proves identity, D1 is always the source of truth for permission.

// Called by every other route module before touching D1. Returns {user} on success or
// {error:{message,status}} — callers just check `if(auth.error) return err(...)`.
export async function authenticate(request, env) {
  const token = bearerToken(request);
  if (!token) return { error: { message: "Chưa đăng nhập.", status: 401 } };
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload || !payload.sub) return { error: { message: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.", status: 401 } };
  const user = await env.DB.prepare(
    "select id, login_id, display_name, role, disabled from users where id = ?"
  ).bind(payload.sub).first();
  if (!user) return { error: { message: "Tài khoản không còn tồn tại.", status: 401 } };
  if (user.disabled) return { error: { message: "Tài khoản của bạn đã bị vô hiệu hóa.", status: 403 } };
  return { user };
}

export function requireAdmin(user) {
  return user.role === "admin";
}

export async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return err("Dữ liệu không hợp lệ.", 400, request, env); }
  const loginId = String(body.login_id || "").trim();
  const password = String(body.password || "");
  if (!loginId || !password) return err("Nhập tên đăng nhập/email và mật khẩu.", 400, request, env);

  const row = await env.DB.prepare(
    "select id, login_id, password_hash, password_salt, pbkdf2_iterations, display_name, role, disabled from users where login_id_lower = ?"
  ).bind(loginId.toLowerCase()).first();

  // Same error for "no such account" and "wrong password" — don't reveal which is which.
  if (!row) return err("Sai tên đăng nhập/email hoặc mật khẩu.", 401, request, env);
  const ok = await verifyPassword(password, row.password_salt, row.pbkdf2_iterations, row.password_hash);
  if (!ok) return err("Sai tên đăng nhập/email hoặc mật khẩu.", 401, request, env);
  if (row.disabled) return err("Tài khoản của bạn đã bị vô hiệu hóa.", 403, request, env);

  const token = await signJWT({ sub: row.id }, env.JWT_SECRET, SESSION_SECONDS);
  return json({
    token,
    user: { id: row.id, login_id: row.login_id, display_name: row.display_name, role: row.role },
  }, {}, request, env);
}

export async function handleMe(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);
  const u = auth.user;
  return json({ id: u.id, login_id: u.login_id, display_name: u.display_name, role: u.role }, {}, request, env);
}

// Used by admin.js when creating a user, and could be reused for a future "change my own
// password" self-service flow — kept here so the hashing policy lives in one place.
export async function createUserRow(env, { loginId, password, displayName, role }) {
  const { hash, salt, iterations } = await makePasswordHash(password);
  const id = uuid();
  await env.DB.prepare(
    `insert into users (id, login_id, login_id_lower, password_hash, password_salt, pbkdf2_iterations, display_name, role, disabled, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(id, loginId, loginId.toLowerCase(), hash, salt, iterations, displayName, role, nowISO()).run();
  return id;
}
