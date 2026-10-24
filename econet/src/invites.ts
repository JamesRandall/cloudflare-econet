// Invitations: a short code to read aloud or type, and a long link. Both
// stand for the same invite, held (hashed) by its room, which decides
// whether it's still good.
//
// Code: "ACRN-" then 12 Crockford base32 characters in groups of four:
// eleven random (55 bits) and a check character. Case doesn't matter, and
// spaces, hyphens and the prefix are optional when typed; I and L read as
// 1, O as 0.
//
// Link token: the room's id and a 128-bit secret, so a link finds its
// room without a lookup.

import { base64url, randomBytes } from "./auth";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_CHARACTERS = 11;

export function newCode(): string {
  const bytes = randomBytes(RANDOM_CHARACTERS);
  const characters = [...bytes].map((b) => ALPHABET[b & 31]);
  characters.push(ALPHABET[checksum(characters.join(""))]);
  const body = characters.join("");
  return `ACRN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

function checksum(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum = (sum * 7 + ALPHABET.indexOf(body[i]) * (i + 1)) % 32;
  return sum;
}

/** The code as typed, made canonical ("ACRN-XXXX-XXXX-XXXX"), or null if
 *  it can't be one (wrong length, characters, or check). */
export function normaliseCode(typed: string): string | null {
  let s = typed.toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.startsWith("ACRN")) s = s.slice(4);
  s = s.replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== RANDOM_CHARACTERS + 1) return null;
  if ([...s].some((c) => !ALPHABET.includes(c))) return null;
  const body = s.slice(0, RANDOM_CHARACTERS);
  if (ALPHABET[checksum(body)] !== s[RANDOM_CHARACTERS]) return null;
  return `ACRN-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** A link's token: the room id, a dot, the secret. */
export function newLinkToken(roomId: string): { token: string; secret: string } {
  const secret = base64url(randomBytes(16));
  return { token: `${roomId}.${secret}`, secret };
}

export function parseLinkToken(token: string): { roomId: string; secret: string } | null {
  const match = /^([A-Za-z0-9_-]{16,32})\.([A-Za-z0-9_-]{16,32})$/.exec(token);
  return match ? { roomId: match[1], secret: match[2] } : null;
}
