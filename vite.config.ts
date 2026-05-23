import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const BRIDGE_TARGET = process.env.VITE_BRIDGE_PROXY || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/stud": { target: BRIDGE_TARGET, changeOrigin: true },
      "/auth": { target: BRIDGE_TARGET, changeOrigin: true },
      "/codex": { target: BRIDGE_TARGET, changeOrigin: true },
      "/api": { target: BRIDGE_TARGET, changeOrigin: true },
      "/health": { target: BRIDGE_TARGET, changeOrigin: true },
    },
  },
});
