import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The manager (src/server.ts) serves ../public as static files; the build lands there.
// `npm run dev:web` runs Vite on :5173 and forwards the API and websocket to a running manager.
const target = process.env.SIM_MANAGER_URL || 'http://localhost:3100';

export default defineConfig({
    root: __dirname,
    plugins: [react()],
    build: {
        outDir: '../public',
        emptyOutDir: true,
        chunkSizeWarningLimit: 900,
    },
    server: {
        proxy: {
            '/api': target,
            '/ws': { target, ws: true },
        },
    },
});
