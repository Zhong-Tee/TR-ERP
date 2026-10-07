import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import packageJson from './package.json'
import { randomUUID } from 'node:crypto'

// https://vite.dev/config/
// โหมด https (npm run dev:mobile) เปิด self-signed HTTPS เพื่อให้มือถือใช้ GPS/กล้องได้
export default defineConfig(({ mode, command }) => ({
  // Use a fresh dependency URL as well as a fresh disk cache. Chrome may retain
  // invalid optimized modules from the cache that was interrupted by shutdown.
  cacheDir: 'node_modules/.vite-tr-erp',
  // Sudden power loss has left optimized React modules filled with NUL bytes.
  // A new optimizer hash on each dev startup rebuilds disk dependencies and
  // gives browsers fresh versioned URLs without accumulating cache folders.
  ...(command === 'serve' ? {
    optimizeDeps: {
      esbuildOptions: {
        define: { __TR_ERP_DEV_CACHE_SESSION__: JSON.stringify(randomUUID()) },
      },
    },
  } : {}),
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  // รองรับ PORT จาก environment (เครื่องมือที่รันหลาย dev server พร้อมกัน) — ไม่ตั้งค่า = ใช้ 5173 ตามเดิม
  server: {
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
  },
}))
