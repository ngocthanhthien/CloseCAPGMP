// One-time bootstrap: there is no public signup endpoint (by design — every account after
// the first is created by an existing Admin via /admin/users, which itself requires an
// Admin caller). This script computes a PBKDF2 hash in the exact format the Worker expects
// and prints the `wrangler d1 execute` command to seed the very first Admin account.
//
// Usage:
//   node create-first-admin.mjs <login_id> <password> "<Họ và tên>"
// Then copy/run the printed command from inside cloudflare/worker/.
//
// login_id can be a Username (no "@") or a real email — either works, this project's
// Cloudflare backend has no synthetic-email requirement (that was only a Supabase Auth
// constraint). Run this again with different values any time an additional Admin is needed
// without going through another Admin's account (e.g. recovery scenario).
const [loginId, password, displayName] = process.argv.slice(2);
if (!loginId || !password || !displayName) {
  console.error('Usage: node create-first-admin.mjs <login_id> <password> "<Họ và tên>"');
  process.exit(1);
}
if (password.length < 6) { console.error("Mật khẩu phải từ 6 ký tự trở lên."); process.exit(1); }

function b64(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ITERATIONS = 100000; // must match PBKDF2_ITERATIONS in src/util.js (Workers' Web Crypto hard cap)
const salt = crypto.getRandomValues(new Uint8Array(16));
const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, keyMaterial, 256);

const id = crypto.randomUUID();
const hash = b64(bits), saltB64 = b64(salt), now = new Date().toISOString();
const loginLower = loginId.toLowerCase();
const escapedName = displayName.replace(/'/g, "''");

const sql = `insert into users (id, login_id, login_id_lower, password_hash, password_salt, pbkdf2_iterations, display_name, role, disabled, created_at) values ('${id}','${loginId}','${loginLower}','${hash}','${saltB64}',${ITERATIONS},'${escapedName}','admin',0,'${now}');`;

console.log("\nChạy lệnh sau trong thư mục cloudflare/worker/ (một lần duy nhất):\n");
console.log(`npx wrangler d1 execute gmp-closegap-db --remote --command "${sql.replace(/"/g, '\\"')}"\n`);
