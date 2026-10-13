import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: dashboardRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(dashboardRoot, ".."),
    },
  },
  build: {
    outDir: resolve(dashboardRoot, "dist"),
    emptyOutDir: true,
  },
});
