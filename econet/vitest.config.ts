import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A low room-wide limit, to reach it; the admin endpoints' secret.
      miniflare: { bindings: { ROOM_MESSAGES_PER_SECOND: "30", ADMIN_TOKEN: "test-admin-token" } },
    }),
  ],
});
