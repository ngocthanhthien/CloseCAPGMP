// Public browser configuration for the Cloudflare-backed bridge (cloud.js).
// No secret belongs here — this is a plain API base URL, publicly visible; all real access
// control happens server-side in the Worker (JWT + per-request D1 checks).
window.GMP_CONFIG = Object.freeze({
  apiBaseUrl: "https://gmp-closegap-api.dangthanhbinh53.workers.dev"
});
