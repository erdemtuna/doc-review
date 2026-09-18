import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/ui", import.meta.url)) },
  },
  publicDir: false,
  build: {
    target: "es2023",
    outDir: "lib/ui",
    emptyOutDir: false,
    cssCodeSplit: false,
    cssMinify: false,
    license: { fileName: "THIRD_PARTY_NOTICES.md" },
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/ui/main.tsx", import.meta.url)),
      output: {
        entryFileNames: "chrome.js",
        assetFileNames: "chrome[extname]",
        codeSplitting: false,
      },
    },
  },
});
