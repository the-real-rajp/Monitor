import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production output goes straight into the PHP document root. emptyOutDir is
// off so index.php and .htaccess survive; the prebuild script clears assets/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../web/public",
    emptyOutDir: false,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000", "/install.sh": "http://127.0.0.1:8000" },
  },
});
