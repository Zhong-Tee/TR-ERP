# TR-ERP

ระบบจัดการออเดอร์และ QC สำหรับ TR Kids

## เทคโนโลยีที่ใช้

- React 19 + TypeScript
- Vite
- Supabase (PostgreSQL + Auth + Storage)
- Tailwind CSS
- React Router

## การติดตั้ง

1. ติดตั้ง dependencies:
```bash
npm install
```

2. สร้างไฟล์ `.env` ใน root directory:
```
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

3. รัน development server:
```bash
npm run dev
```

## โครงสร้างโปรเจกต์

```
tr-erp/
├── src/
│   ├── components/     # React components
│   ├── lib/            # Utilities และ services
│   ├── hooks/          # Custom React hooks
│   ├── types/          # TypeScript types
│   └── App.tsx         # Main app component
├── supabase/
│   ├── functions/      # Edge Functions
│   └── migrations/     # Database migrations
└── package.json
```

## การ Setup Supabase

1. สร้าง Supabase project ใหม่
2. รัน migration:
```bash
supabase migration up
```
3. สร้าง Storage buckets:
   - `product-images`
   - `cartoon-patterns`
   - `slip-images`
4. ตั้งค่า Edge Function secrets:
   - `EASYSLIP_API_KEY`

## Features

- ✅ Authentication & Authorization
- ✅ Order Management
- ✅ Admin QC Review
- ✅ EasySlip Integration
- ✅ QC System
- ✅ Packing System
- ✅ Products Management
- ✅ Cartoon Patterns Management
- ✅ Sales Reports
- ✅ Settings & User Roles
