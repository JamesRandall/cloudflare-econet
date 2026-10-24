// SPDX-License-Identifier: AGPL-3.0-only
// The page an invitation link opens: what the room is, and a way into it
// from either emulator (neither is assumed installed), or the link to copy.

import type { Preview } from "./rooms/RoomDurableObject";

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function landingPage(input: { origin: string; token: string; preview: Preview | null; serviceName: string }): Response {
  const { origin, token, preview } = input;
  const service = new URL(origin).host;
  const link = `${origin}/join/${token}`;
  const appLink = (scheme: string) => `${scheme}://join?service=${encodeURIComponent(origin)}&invite=${encodeURIComponent(token)}`;
  const stations = preview?.stations ?? [];
  const body = preview
    ? `
      <p class="eyebrow">You're invited to an Econet network</p>
      <h1>${escape(preview.room.name)}</h1>
      ${preview.room.description ? `<p class="description">${escape(preview.room.description)}</p>` : ""}
      <p class="meta">${preview.participants} ${preview.participants === 1 ? "person" : "people"} · ${stations.length} ${stations.length === 1 ? "machine" : "machines"} · on ${escape(service)}</p>
      ${stations.length ? `<ul class="stations">${stations.map((s) => `<li><span class="n">${s.station}</span> ${escape(s.label)} <span class="kind">${escape(s.kind)}</span></li>`).join("")}</ul>` : ""}
      <div class="buttons">
        <a class="button primary" href="${escape(appLink("macbeeb"))}">Open in MacBeeb</a>
        <a class="button" href="${escape(appLink("macarch"))}">Open in MacArch</a>
      </div>
      <p class="help">Don't have the app open? Start it, choose <b>File ▸ Join Econet Network…</b> and paste this link:</p>
      <div class="copy"><input readonly value="${escape(link)}" id="link"><button onclick="navigator.clipboard.writeText(document.getElementById('link').value);this.textContent='Copied'">Copy Link</button></div>
      <p class="fine">The invitation expires ${new Date(preview.inviteExpiresAt).toUTCString()}. Joining connects your emulated machines' Econet to this network: nothing else on your Mac is shared.</p>`
    : `
      <p class="eyebrow">Econet invitation</p>
      <h1>This invitation isn't valid</h1>
      <p class="description">It may have expired, been withdrawn, or the network may have closed. Ask whoever sent it for a new one.</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${preview ? escape(preview.room.name) + " · " : ""}Econet invitation</title>
<style>
  :root { color-scheme: dark; --bg: #0e1013; --card: #171a20; --text: #f2f2f2; --muted: #a3a8b3; --accent: #39c5cf; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
         background: radial-gradient(circle at 10% 0%, #3a1416 0, transparent 45%), radial-gradient(circle at 100% 20%, #0f3337 0, transparent 50%), var(--bg);
         color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  main { width: 100%; max-width: 560px; background: var(--card); border: 1px solid #2a2f38; border-radius: 18px; padding: 32px; }
  .eyebrow { margin: 0; color: var(--accent); font-weight: 600; font-size: 14px; }
  h1 { margin: 6px 0 8px; font-size: 32px; line-height: 1.15; }
  .description { color: var(--muted); margin: 0 0 8px; }
  .meta { color: var(--muted); font-size: 14px; }
  .stations { list-style: none; padding: 0; margin: 16px 0; display: grid; gap: 6px; }
  .stations li { background: #1f232b; border-radius: 8px; padding: 8px 12px; }
  .stations .n { display: inline-block; min-width: 2.2em; font-weight: 700; color: var(--accent); }
  .stations .kind { color: var(--muted); font-size: 14px; }
  .buttons { display: flex; gap: 10px; flex-wrap: wrap; margin: 22px 0 14px; }
  .button { flex: 1 1 180px; text-align: center; padding: 12px 16px; border-radius: 999px; text-decoration: none; font-weight: 600;
            color: var(--text); background: #262b34; }
  .button.primary { background: var(--accent); color: #062124; }
  .help, .fine { color: var(--muted); font-size: 14px; }
  .copy { display: flex; gap: 8px; }
  .copy input { flex: 1; min-width: 0; background: #0e1013; color: var(--text); border: 1px solid #2a2f38; border-radius: 8px; padding: 8px 10px; font: 13px ui-monospace, monospace; }
  .copy button { border: 0; border-radius: 8px; padding: 8px 14px; background: #262b34; color: var(--text); font-weight: 600; cursor: pointer; }
  .fine { margin-top: 18px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status: preview ? 200 : 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "X-Frame-Options": "DENY",
    },
  });
}
