// Admin-only user management: create/list accounts, change role, enable/disable. Same guard
// rails as always (can't demote the sole active admin, can't disable yourself). login_id is
// stored exactly as typed (Username or Email, Admin's choice) — see schema.sql.
import { json, err, nowISO } from "./util.js";
import { authenticate, requireAdmin, createUserRow } from "./auth.js";

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdminCaller(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return { error: auth.error };
  if (!requireAdmin(auth.user)) return { error: { message: "Chỉ Quản trị viên mới có quyền thực hiện chức năng này.", status: 403 } };
  return { user: auth.user };
}

async function logAdminAction(env, actor, action, detail) {
  await env.DB.prepare(
    `insert into gmp_audit (ts,actor_id,actor_name,device,action,detail,area) values (?,?,?,?,?,?,?)`
  ).bind(nowISO(), actor.id, actor.display_name, "Worker", action, detail, "").run();
}

export async function handleListUsers(request, env) {
  const admin = await requireAdminCaller(request, env);
  if (admin.error) return err(admin.error.message, admin.error.status, request, env);
  const { results } = await env.DB.prepare(
    "select id, login_id, display_name, role, disabled, created_at from users order by role desc, display_name"
  ).all();
  const users = results.map(u => ({
    userId: u.id, displayName: u.display_name, login_id: u.login_id,
    role: u.role, status: u.disabled ? "Disabled" : "Active", createdAt: u.created_at,
  }));
  return json({ users }, {}, request, env);
}

export async function handleCreateUser(request, env) {
  const admin = await requireAdminCaller(request, env);
  if (admin.error) return err(admin.error.message, admin.error.status, request, env);

  let body;
  try { body = await request.json(); } catch { return err("Dữ liệu JSON không hợp lệ", 400, request, env); }
  const displayName = String(body.displayName || "").trim();
  const password = String(body.password || "");
  const role = body.role === "admin" ? "admin" : "user";
  // Accepts either field name the frontend might send (username-first form, or an email
  // typed into that same field — see index.html's "mail accept" handling) or a real `email`
  // field from the Admin-role branch of the form.
  const loginIdRaw = String(body.username || body.email || "").trim();

  if (!displayName) return err("Họ và tên không được để trống.", 400, request, env);
  const isEmailShaped = loginIdRaw.includes("@");
  if (isEmailShaped ? !EMAIL_RE.test(loginIdRaw) : !USERNAME_RE.test(loginIdRaw.toLowerCase())) {
    return err(isEmailShaped ? "Địa chỉ email không đúng định dạng." : "Tên đăng nhập không hợp lệ.", 400, request, env);
  }
  if (password.length < 6) return err("Mật khẩu phải có tối thiểu 6 ký tự.", 400, request, env);

  const loginId = isEmailShaped ? loginIdRaw.toLowerCase() : loginIdRaw.toLowerCase();
  const existing = await env.DB.prepare("select id from users where login_id_lower = ?").bind(loginId).first();
  if (existing) return err(isEmailShaped ? "Email đã được sử dụng." : "Tên đăng nhập đã được sử dụng.", 400, request, env);

  const id = await createUserRow(env, { loginId: loginIdRaw, password, displayName, role });
  await logAdminAction(env, admin.user, "USER_CREATED", `Tạo người dùng ${displayName} (${loginIdRaw}), vai trò: ${role}`);
  return json({ ok: true, user: { userId: id, displayName, login_id: loginIdRaw, role, status: "Active" } }, {}, request, env);
}

export async function handleChangeRole(request, env, targetUserId) {
  const admin = await requireAdminCaller(request, env);
  if (admin.error) return err(admin.error.message, admin.error.status, request, env);
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const newRole = body.newRole;
  if (!["user", "admin"].includes(newRole)) return err("Vai trò mới không hợp lệ.", 400, request, env);

  if (targetUserId === admin.user.id && newRole !== "admin") {
    const { count } = await env.DB.prepare(
      "select count(*) as count from users where role='admin' and disabled=0 and id != ?"
    ).bind(admin.user.id).first();
    if (!count) return err("Không thể hạ quyền: Bạn là Quản trị viên đang hoạt động duy nhất của hệ thống.", 400, request, env);
  }

  const target = await env.DB.prepare("select display_name, role from users where id=?").bind(targetUserId).first();
  await env.DB.prepare("update users set role=? where id=?").bind(newRole, targetUserId).run();
  await logAdminAction(env, admin.user, "ROLE_CHANGED", `Đổi vai trò người dùng ${target?.display_name || targetUserId} từ ${target?.role || "user"} thành ${newRole}`);
  return json({ ok: true, role: newRole }, {}, request, env);
}

export async function handleSetStatus(request, env, targetUserId, disabled) {
  const admin = await requireAdminCaller(request, env);
  if (admin.error) return err(admin.error.message, admin.error.status, request, env);
  if (disabled && targetUserId === admin.user.id) return err("Không thể tự vô hiệu hóa tài khoản của chính bạn.", 400, request, env);

  const target = await env.DB.prepare("select display_name from users where id=?").bind(targetUserId).first();
  await env.DB.prepare("update users set disabled=? where id=?").bind(disabled ? 1 : 0, targetUserId).run();
  await logAdminAction(env, admin.user, disabled ? "USER_DISABLED" : "USER_ENABLED", `${disabled ? "Vô hiệu hóa" : "Kích hoạt lại"} người dùng ${target?.display_name || targetUserId}`);
  return json({ ok: true, status: disabled ? "Disabled" : "Active" }, {}, request, env);
}
