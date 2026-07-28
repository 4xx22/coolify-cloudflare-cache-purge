import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          CLOUDFLARE_API_TOKEN: "test-cloudflare-api-token",
          WEBHOOK_SECRET: "test-webhook-secret",
        },
      },
    }),
  ],
});
