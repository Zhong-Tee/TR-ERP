## UAT Checklist: Work Order UUID Cutover

### ก่อนเริ่ม
- รัน migrations: `189`, `190`, `191`, `192`, `193`
- รีสตาร์ท frontend หลัง deploy

### SQL ตรวจความครบถ้วน (ต้องได้ 0)

```sql
-- or_orders: มีชื่อใบงาน แต่ไม่มี work_order_id (ไม่ควรมีหลัง cutover)
select count(*) as missing
from or_orders
where work_order_name is not null and trim(work_order_name) <> ''
  and work_order_id is null;

-- wms_orders: มี order_id แต่ไม่มี work_order_id (ไม่ควรมี)
select count(*) as missing
from wms_orders
where order_id is not null and trim(order_id) <> ''
  and work_order_id is null;

-- plan_jobs: มี name แต่ไม่มี work_order_id (ไม่ควรมี)
select count(*) as missing
from plan_jobs
where name is not null and trim(name) <> ''
  and work_order_id is null;
```

### Flow 1: สร้างใบงาน (Plan → ใบสั่งงาน)
- เลือกบิล 2–3 ใบ (ต่าง channel ได้)
- กดสร้างใบงาน
- ตรวจ:
  - `or_work_orders` มีแถวใหม่ (`work_order_name` ถูกต้อง, `order_count` ถูกต้อง)
  - `or_orders` ของบิลที่เลือกมี `work_order_id` และ `work_order_name` ถูก set
  - `plan_jobs` มีแถวใหม่ และ `work_order_id` ตรงกับ `or_work_orders.id`

SQL quick check:

```sql
select o.id, o.bill_no, o.work_order_id, o.work_order_name
from or_orders o
where o.work_order_id is not null
order by o.updated_at desc
limit 20;
```

### Flow 2: Assign WMS (จัดสินค้า → ใบงานใหม่)
- เลือกใบงานใหม่ → assign picker
- ตรวจ:
  - เรียก `rpc_assign_wms_for_work_order_v2` ผ่าน
  - `wms_orders.work_order_id` ถูก set
  - `wms_orders.order_id` ยังเป็นชื่อใบงานเพื่อแสดงผล (แต่ไม่ใช้เป็นตัวตน)

SQL:

```sql
select work_order_id, order_id, count(*) as lines
from wms_orders
group by work_order_id, order_id
order by max(created_at) desc
limit 20;
```

### Flow 3: Picker (mobile)
- picker เห็นรายการใบงาน (แสดงชื่อ) และสามารถเลือกเข้าไปได้
- รายการสินค้าโหลดได้ (query ด้วย `work_order_id`)
- กรณี “บิลถูกย้ายออก”: ปุ่มหลักเป็น “ข้ามรายการ” และบันทึกเป็น `cancelled`

### Flow 4: Review (จัดสินค้า → ตรวจสินค้า)
- dropdown ใบงาน: value เป็น `work_order_id`, label เป็น `work_order_name`
- ตรวจสินค้า:
  - ปกติยังมี 3 ปุ่ม (ไม่เจอ/หยิบผิด/หยิบถูก)
  - รายการที่ถูกย้ายออกมีปุ่มเดียว “คืนเข้าคลัง” → status `returned` และ stock reverse ทำงาน

### Flow 5: ย้ายบิลไปใบสั่งงาน (Plan → จัดการใบงาน)
- เลือกบิลบางใบในใบงาน → กด “ย้ายไปใบสั่งงาน”
- ตรวจ:
  - RPC ที่ใช้: `rpc_plan_release_orders_to_workqueue_v2`
  - บิลกลับไป status `ใบสั่งงาน`, `work_order_id`/`work_order_name` เป็น NULL
  - set `plan_released_from_work_order_id` และ `plan_released_from_work_order`
  - `wms_orders.plan_line_released` ถูก set สำหรับแถวที่หยิบ/ตรวจแล้ว

SQL:

```sql
select id, bill_no, status, plan_released_from_work_order_id, plan_released_from_work_order
from or_orders
where plan_released_from_work_order_id is not null
order by plan_released_at desc
limit 20;
```

### Flow 6: Dashboard (Master Plan)
- ป้าย “แก้ไข/ยกเลิก” ต้องอิง `work_order_id` ไม่ชนกรณีชื่อซ้ำ
- คลิกป้าย “แก้ไข” ต้องเห็นรายการบิลที่ย้ายออก และดูรายการสินค้าได้

