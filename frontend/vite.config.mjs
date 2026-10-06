import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, strictPort: true,
    proxy: { '/api': { target: process.env.DUIPAI_BACKEND_URL || 'http://127.0.0.1:8080', changeOrigin: false, headers: process.env.DUIPAI_TOKEN ? { 'X-Duipai-Token': process.env.DUIPAI_TOKEN } : {} } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
});
