import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` runs the API with wrangler on 8787; the web app proxies to it.
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", sourcemap: true },
});
