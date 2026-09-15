import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: :5173 제공, /api(REST+SSE)는 실험 서버(:3848)로 프록시.
// 운영 서버(:3847)는 손대지 않는다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3848',
        changeOrigin: true,
      },
    },
  },
});
