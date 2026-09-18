import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/ui", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["test/ui/setup.ts"],
    include: ["test/ui/**/*.test.{ts,tsx}", "src/ui/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
