// The sign image's health check (SH-287): healthy while the service is ready (200) or deliberately off until its
// records are placed (503, state "waiting-for-records"); UNHEALTHY when the service refused to start (503, state
// "refused": a wrong configuration, for example taxRules on before the rules records exist) or does not answer.
// usage (the Dockerfile's HEALTHCHECK): node /app/hackathon-sign/health.js   (SIGN_HEALTH_URL overrides the address)
"use strict";

const url = process.env.SIGN_HEALTH_URL || "http://127.0.0.1:8080/launches/api/four/health";

fetch(url, { signal: AbortSignal.timeout(4000) })
  .then(async (r) => {
    const body = await r.json().catch(() => ({}));
    process.exit(r.status === 200 || (r.status === 503 && body.state === "waiting-for-records") ? 0 : 1);
  })
  .catch(() => process.exit(1));
