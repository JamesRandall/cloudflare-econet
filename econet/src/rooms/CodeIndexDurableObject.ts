// Which room a join code belongs to. Each code has its own tiny Durable
// Object, named by the code's hash, so a lookup goes straight there: no
// global table, and nothing to enumerate. The room itself decides whether
// the invite is still good; this only points the way, until it expires.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../service-info";

interface Entry {
  roomId: string;
  inviteId: string;
  expiresAt: number;
}

export class CodeIndexDurableObject extends DurableObject<Env> {
  async register(entry: Entry): Promise<void> {
    await this.ctx.storage.put("entry", entry);
    await this.ctx.storage.setAlarm(entry.expiresAt);
  }

  async lookup(): Promise<Entry | null> {
    const entry = await this.ctx.storage.get<Entry>("entry");
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  async remove(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
