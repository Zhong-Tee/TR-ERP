# แก้ไขปัญหา Tailwind CSS v4

## วิธีที่ 1: ใช้ @tailwindcss/postcss (ทำแล้ว)

✅ ติดตั้ง `@tailwindcss/postcss` แล้ว
✅ อัปเดต `postcss.config.js` แล้ว
✅ อัปเดต `src/index.css` แล้ว

ลองรัน `npm run dev` ดู

## วิธีที่ 2: Downgrade เป็น Tailwind CSS v3 (ถ้าวิธีที่ 1 ไม่ได้)

ถ้ายังมีปัญหา ให้ downgrade เป็น Tailwind CSS v3:

```bash
npm uninstall tailwindcss @tailwindcss/postcss
npm install -D tailwindcss@^3.4.0
```

แล้วแก้ไขไฟล์:

**postcss.config.js:**
```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

**src/index.css:**
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```
