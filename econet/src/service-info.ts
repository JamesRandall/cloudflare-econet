import { LIMITS, MINIMUM_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./protocol";

/** The bindings, as wrangler.jsonc declares them (src/worker-configuration.d.ts,
 *  from `npm run types`). */
export type Env = Cloudflare.Env;

/** A numeric operator setting (a var in the Wrangler configuration), or
 *  its default when it's unset or not a number. */
export function setting(env: Env, name: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** GET /.well-known/acorn-econet: what this deployment is and does, so a
 *  client can check it's compatible before sending it anything. */
export function serviceInfo(env: Env, origin: string) {
  return {
    service: "acorn-internet-econet",
    name: env.SERVICE_NAME || "Acorn Internet Econet",
    origin,
    apiVersion: 1,
    protocolVersions: [PROTOCOL_VERSION],
    minimumProtocolVersion: MINIMUM_PROTOCOL_VERSION,
    features: {
      privateRooms: true,
      joinCodes: true,
      inviteLinks: true,
      publicDirectory: false,
      joinApproval: false,
      screenSharing: true,
    },
    limits: LIMITS,
  };
}

/** The origin links and the landing page use. */
export function publicOrigin(env: Env, request: Request): string {
  return env.PUBLIC_ORIGIN || new URL(request.url).origin;
}
