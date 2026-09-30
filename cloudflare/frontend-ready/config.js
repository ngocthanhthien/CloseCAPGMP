// Public browser configuration for the Cloudflare-backed bridge (cloudflare/frontend-ready/cloud.js).
// NOT YET LIVE. No secret belongs here — this is a plain API base URL, publicly visible;
// all real access control happens server-side in the Worker (JWT + per-request D1 checks).
window.GMP_CONFIG = Object.freeze({
  apiBaseUrl: "https://gmp-closegap-api.dangthanhbinh53.workers.dev"
});
