import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      AGENTGATE_DEV_MODE: "true"
    }
  }
});
