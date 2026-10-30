import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.WORKBENCH_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": api,
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
});
