// Credentials: random tokens, kept by the service only as SHA-256 hashes.
//
// - Owner token: the room's host; manages invites, members and the room.
// - Member token: a participant's long-lived credential (the app keeps it
//   in the Keychain), used to get connection tickets.
// - Connection ticket: short-lived and single-use, for the WebSocket
//   upgrade (native WebSockets can't send an Authorization header, and a
//   long-lived token mustn't go in a URL).

export function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A credential: 256 random bits. */
export function newToken(): string {
  return base64url(randomBytes(32));
}

/** An opaque identifier: 128 random bits, URL-safe. */
export function newId(): string {
  return base64url(randomBytes(16));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two hex digests without stopping at the first difference. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** The bearer token from an Authorization header, if there is one. */
export function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
