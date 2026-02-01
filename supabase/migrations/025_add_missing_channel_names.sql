-- เพิ่มช่องทางที่ใช้ในระบบแต่ยังไม่มีในตาราง channels (ให้แสดงชื่อช่องทางแทนรหัส)
INSERT INTO channels (channel_code, channel_name) VALUES
('FBTR', 'Facebook TR'),
('PUMP', 'PUMP'),
('OATR', 'OATR'),
('PN', 'PN'),
('PGTR', 'PG TR'),
('WY', 'WY')
ON CONFLICT (channel_code) DO NOTHING;
