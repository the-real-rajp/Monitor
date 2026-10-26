import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production build lands in internal/webui/dist so the Go binary can
// embed it (go build -tags embedweb). In development, API calls are proxied
// to a locally running monitor-server.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/healthz": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
    },
  },
});
