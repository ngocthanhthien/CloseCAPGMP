// Shared helpers used across every route module.

export function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
    "Vary": "Origin",
  };
  // Only echo back Access-Control-Allow-Origin when it actually matches — the real access
  // control is the Bearer JWT check (CORS is browser-enforced only and doesn't gate non-
  // browser clients like curl), but returning a mismatched origin value here is confusing to
  // debug and gives a false impression that an unlisted origin was granted anything.
  if (allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(data, init, request, env) {
  const headers = { "Content-Type": "application/json", ...(request ? corsHeaders(request, env) : {}) };
  return new Response(JSON.stringify(data), { status: (init && init.status) || 200, headers });
}

export function err(message, status, request, env) {
  return json({ error: message }, { status: status || 400 }, request, env);
}

export function uuid() {
  return crypto.randomUUID();
}

export function nowISO() {
  return new Date().toISOString();
}

export function todayISO() {
  return nowISO().slice(0, 10);
}

const ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;
export function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/;
export function validEmbeddedImage(s) {
  return !s || IMG_RE.test(s);
}

export function bytesOf(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

function b64urlEncode(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
export const b64 = {
  encode: b64urlEncode,
  decodeToBytes: b64urlDecodeToBytes,
  decodeToString: (str) => new TextDecoder().decode(b64urlDecodeToBytes(str)),
};

// --- Password hashing: PBKDF2-SHA256 via Web Crypto (Workers has no native bcrypt). ---
// 100,000 is the MAXIMUM Cloudflare Workers' Web Crypto implementation allows for PBKDF2
// (confirmed by a live 500 error when 210,000 was tried — undocumented in Cloudflare's own
// docs as of writing). This is below the current OWASP-recommended 600,000 for PBKDF2-
// SHA256, but it's the ceiling this runtime permits; iterations are stored per-account so a
// future higher cap (or a switch to Argon2id via WASM) can be adopted without invalidating
// existing hashes.
export const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  return b64.encode(bits);
}

export async function makePasswordHash(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, saltBytes, PBKDF2_ITERATIONS);
  return { hash, salt: b64.encode(saltBytes), iterations: PBKDF2_ITERATIONS };
}

export async function verifyPassword(password, saltB64, iterations, expectedHashB64) {
  const saltBytes = b64.decodeToBytes(saltB64);
  const computed = await hashPassword(password, saltBytes, iterations);
  // Constant-time compare to avoid leaking hash-prefix-match timing.
  const a = b64.decodeToBytes(computed), b = b64.decodeToBytes(expectedHashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- JWT (HS256), signed/verified via Web Crypto. No external library needed. ---
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJWT(payload, secret, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encHeader = b64.encode(new TextEncoder().encode(JSON.stringify(header)));
  const encBody = b64.encode(new TextEncoder().encode(JSON.stringify(body)));
  const toSign = `${encHeader}.${encBody}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  return `${toSign}.${b64.encode(sig)}`;
}

export async function verifyJWT(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encBody, encSig] = parts;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64.decodeToBytes(encSig), new TextEncoder().encode(`${encHeader}.${encBody}`));
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64.decodeToString(encBody)); } catch { return null; }
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

export function bearerToken(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer (.+)$/.exec(h);
  return m ? m[1] : null;
}
