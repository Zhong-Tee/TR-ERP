// Shared contract with TR-ERP/src/lib/webOrderImport.ts. Money in this file is baht.
export const WEB_ORDER_VERSION = "TRKIDS-WEB-1";
export const WEB_ORDER_HEADERS = [
  "ช่องทาง",
  "ชื่อลูกค้า",
  "ที่อยู่ลูกค้า",
  "ราคา/หน่วย",
  "ค่าส่ง",
  "ส่วนลด",
  "วิธีการชำระ",
  "ชื่อโปรโมชั่น",
  "วันที่ชำระ",
  "เวลาที่ชำระ",
  "ชื่อสินค้า",
  "สีหมึก",
  "ชั้นที่",
  "ลายการ์ตูน",
  "ลายเส้น",
  "ฟอนต์",
  "บรรทัด 1",
  "บรรทัด 2",
  "บรรทัด 3",
  "จำนวน",
  "หมายเหตุ",
  "ไฟล์แนบ",
  "schema_version",
  "web_order_no",
  "web_item_id",
  "erp_product_code",
  "is_free",
  "standard_shipping",
  "charged_shipping",
  "special_area_surcharge",
  "subtotal",
  "total",
  "payment_reference",
  "batch_id",
  "recipient_name",
  "phone",
  "email",
  "address_line",
  "province",
  "district",
  "sub_district",
  "postal_code",
] as const;
export type WebRow = Record<string, string | number | boolean>;
export type WebImportedItem = {
  web_item_id: string;
  source_product_code: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  is_free: boolean;
  ink_color: string;
  product_type: string;
  cartoon_pattern: string;
  line_pattern: string;
  font: string;
  line_1: string;
  line_2: string;
  line_3: string;
  notes: string;
  file_attachment: string;
};
export type WebImportedOrder = {
  channel_code: string;
  channel_order_no: string;
  customer_name: string;
  recipient_name: string;
  customer_address: string;
  price: number;
  shipping_cost: number;
  discount: number;
  total_amount: number;
  payment_method: string;
  promotion: string;
  payment_date: string;
  payment_time: string;
  payment_reference: string;
  standard_shipping: number;
  charged_shipping: number;
  special_area_surcharge: number;
  billing_details: Record<string, string>;
  items: WebImportedItem[];
};
function text(row: WebRow, key: string) {
  return String(row[key] ?? "").trim();
}
function required(row: WebRow, key: string) {
  const value = text(row, key);
  if (!value) throw new Error(`ขาด ${key}`);
  return value;
}
function amount(row: WebRow, key: string) {
  const raw = row[key];
  if (raw === "" || raw == null) throw new Error(`ขาด ${key}`);
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(Math.round(value * 100)) ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.00001
  )
    throw new Error(`${key} ต้องเป็นจำนวนเงินไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง`);
  return value;
}
const cents = (v: number) => Math.round(v * 100);
export function parseWebOrderRows(rows: WebRow[]): WebImportedOrder[] {
  if (!rows.length || rows.length > 10000)
    throw new Error("ไฟล์ว่างหรือเกิน 10,000 รายการ");
  const groups = new Map<string, WebImportedOrder>();
  const fingerprints = new Map<string, string>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.schema_version !== WEB_ORDER_VERSION)
      throw new Error("รุ่นไฟล์เว็บไม่รองรับ");
    const channel = required(row, "ช่องทาง"),
      number = required(row, "web_order_no"),
      itemId = required(row, "web_item_id");
    if (
      !/^[A-Z0-9_-]{1,32}$/.test(channel) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(number)
    )
      throw new Error("ช่องทางหรือเลขออเดอร์ไม่ถูกต้อง");
    const key = channel + ":" + number;
    if (ids.has(itemId)) throw new Error("รหัสรายการเว็บซ้ำในไฟล์");
    ids.add(itemId);
    const rawFree = text(row, "is_free").toLowerCase();
    if (!["true", "false", "1", "0"].includes(rawFree))
      throw new Error("สถานะของแถมไม่ถูกต้อง");
    const isFree = ["true", "1"].includes(rawFree),
      unit = amount(row, "ราคา/หน่วย"),
      qty = Number(row["จำนวน"]);
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 10000)
      throw new Error("จำนวนสินค้าไม่ถูกต้อง");
    if (isFree && unit !== 0) throw new Error("ของแถมต้องมีราคา 0");
    const order: WebImportedOrder = {
      channel_code: channel,
      channel_order_no: number,
      customer_name: required(row, "ชื่อลูกค้า"),
      recipient_name: required(row, "recipient_name"),
      customer_address: required(row, "ที่อยู่ลูกค้า"),
      price: amount(row, "subtotal"),
      shipping_cost: amount(row, "ค่าส่ง"),
      discount: amount(row, "ส่วนลด"),
      total_amount: amount(row, "total"),
      payment_method: required(row, "วิธีการชำระ"),
      promotion: text(row, "ชื่อโปรโมชั่น"),
      payment_date: required(row, "วันที่ชำระ"),
      payment_time: required(row, "เวลาที่ชำระ"),
      payment_reference: required(row, "payment_reference"),
      standard_shipping: amount(row, "standard_shipping"),
      charged_shipping: amount(row, "charged_shipping"),
      special_area_surcharge: amount(row, "special_area_surcharge"),
      billing_details: {
        address_line: required(row, "address_line"),
        province: required(row, "province"),
        district: required(row, "district"),
        sub_district: required(row, "sub_district"),
        postal_code: required(row, "postal_code"),
        mobile_phone: required(row, "phone"),
        email: required(row, "email"),
      },
      items: [],
    };
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(order.payment_date) ||
      !/^\d{2}:\d{2}(:\d{2})?$/.test(order.payment_time)
    )
      throw new Error("วันที่/เวลาชำระไม่ถูกต้อง");
    const fingerprint = JSON.stringify(order);
    if (fingerprints.has(key) && fingerprints.get(key) !== fingerprint)
      throw new Error(`ข้อมูลหัวบิล ${number} ไม่ตรงกันระหว่างแถว`);
    fingerprints.set(key, fingerprint);
    if (!groups.has(key)) groups.set(key, order);
    groups.get(key)!.items.push({
      web_item_id: itemId,
      source_product_code: required(row, "erp_product_code"),
      product_name: required(row, "ชื่อสินค้า"),
      unit_price: unit,
      quantity: qty,
      is_free: isFree,
      ink_color: text(row, "สีหมึก"),
      product_type: text(row, "ชั้นที่"),
      cartoon_pattern: text(row, "ลายการ์ตูน"),
      line_pattern: text(row, "ลายเส้น"),
      font: text(row, "ฟอนต์"),
      line_1: text(row, "บรรทัด 1"),
      line_2: text(row, "บรรทัด 2"),
      line_3: text(row, "บรรทัด 3"),
      notes: text(row, "หมายเหตุ"),
      file_attachment: text(row, "ไฟล์แนบ"),
    });
  }
  for (const order of groups.values()) {
    const subtotal = order.items.reduce(
      (sum, i) => sum + cents(i.unit_price) * i.quantity,
      0,
    );
    if (
      subtotal !== cents(order.price) ||
      cents(order.shipping_cost) !==
        cents(order.charged_shipping) + cents(order.special_area_surcharge) ||
      subtotal + cents(order.shipping_cost) - cents(order.discount) !==
        cents(order.total_amount) ||
      cents(order.discount) > subtotal
    )
      throw new Error(`ยอดบิล ${order.channel_order_no} ไม่ตรงกับรายการ`);
  }
  return [...groups.values()];
}
