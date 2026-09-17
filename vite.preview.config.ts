import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/ui/preview", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/ui", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./.ui-preview", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
