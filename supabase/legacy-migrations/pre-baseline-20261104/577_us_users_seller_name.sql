-- Optional seller display name used on QT/PC documents.
ALTER TABLE public.us_users
  ADD COLUMN IF NOT EXISTS seller_name TEXT;

COMMENT ON COLUMN public.us_users.seller_name IS
  'ชื่อผู้ขายที่แสดงบนใบเสนอราคาและใบยืนยันรายละเอียดการผลิต';
