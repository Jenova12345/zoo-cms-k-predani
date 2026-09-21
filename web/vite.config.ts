import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// V dev módu běží Vite na 5173 a proxy posílá /api a /data na Fastify (3000).
// V produkci servíruje buildnutý web přímo Fastify, takže proxy se nepoužije.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/data": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
