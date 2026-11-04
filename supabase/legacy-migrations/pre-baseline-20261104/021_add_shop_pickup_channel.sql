-- ช่องทาง SHOP PICKUP (SHOPP): บล็อกที่อยู่ลูกค้า เปิดเลขพัสดุ
-- ช่องทาง SHOP (SHOP SHIPPING): แสดงที่อยู่+ชื่อช่องทาง ปิดเลขพัสดุ (logic อยู่ใน OrderForm)
INSERT INTO channels (channel_code, channel_name) VALUES
('SHOPP', 'SHOP PICKUP')
ON CONFLICT (channel_code) DO NOTHING;
