import type { OpenNextConfig } from "@opennextjs/cloudflare";

export default {
  default: {
    override: {
      tagCache: "dummy",
    },
  },
} satisfies OpenNextConfig;
