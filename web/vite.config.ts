import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the SPA and proxies /api to the local Worker (wrangler dev :8787).
// Build: outputs to dist/, which wrangler.toml [assets] serves from the Worker.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
