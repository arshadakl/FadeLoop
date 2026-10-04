import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "frontend",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve("frontend/src") } },
  server: {
    proxy: Object.fromEntries(
      ["/api", "/session", "/auth"].map((path) => [
        path,
        "http://localhost:8787",
      ]),
    ),
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(
        ["index", "privacy", "terms", "data-deletion"].map((page) => [
          page,
          resolve(`frontend/${page}.html`),
        ]),
      ),
    },
  },
});
