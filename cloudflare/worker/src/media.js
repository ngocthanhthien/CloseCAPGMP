// Port of Storage bucket gmp-mediasave (backupMedia() in cloud.js). Original-quality
// evidence photos only — the app never reads these back for display (it always shows the
// compressed image embedded in the Finding/Action record), so this is write-only, same as
// the retired Supabase bucket ("No public access, overwrites, or deletion through the
// browser" — schema.sql comment).
//
// Design note vs. the migration plan doc: the plan sketched a presigned-URL upload (S3 SigV4
// direct-to-R2). That needs a separate R2 API token pair created by hand in the dashboard
// (wrangler can't provision it) and a SigV4 signer. Since evidence photos are already capped
// at 20 MiB and Workers happily proxy request bodies well past that, uploading straight
// through the Worker to the R2 binding is simpler and needs no extra credential — same
// security properties (private bucket, Worker-checked auth), one less moving part.
import { err, json } from "./util.js";
import { authenticate } from "./auth.js";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MiB, same limit as the retired bucket's file_size_limit

export async function handleMediaUpload(request, env, url) {
  const auth = await authenticate(request, env);
  if (auth.error) return err(auth.error.message, auth.error.status, request, env);

  const contentType = request.headers.get("Content-Type") || "";
  if (!ALLOWED_TYPES.has(contentType)) return err("Loại ảnh không được hỗ trợ.", 400, request, env);
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len && len > MAX_BYTES) return err("Ảnh gốc vượt quá 20 MiB.", 400, request, env);

  const rawName = url.searchParams.get("name") || "media";
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${auth.user.id}/${crypto.randomUUID()}_${safeName}`;

  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
  return json({ ok: true, key }, {}, request, env);
}
