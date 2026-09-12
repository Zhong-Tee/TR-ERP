import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import packageJson from './package.json'

// https://vite.dev/config/
// โหมด https (npm run dev:mobile) เปิด self-signed HTTPS เพื่อให้มือถือใช้ GPS/กล้องได้
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  // รองรับ PORT จาก environment (เครื่องมือที่รันหลาย dev server พร้อมกัน) — ไม่ตั้งค่า = ใช้ 5173 ตามเดิม
  server: {
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
  },
}))
