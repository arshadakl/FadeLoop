// Small HTTP response helpers. Dashboard authentication lives in auth/session.ts.

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FadeLoop connection</title><script src="/theme.js"></script><link rel="stylesheet" href="/styles.css"></head><body><main class="doc connection-result">${body}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location, "referrer-policy": "no-referrer" } });
}
