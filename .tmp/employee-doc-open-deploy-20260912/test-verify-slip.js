// Script สำหรับทดสอบ verify-slip Edge Function
// วิธีใช้: เปิด Browser Console (F12) แล้ว copy-paste code นี้

// 1. เตรียม Base64 image (ตัวอย่าง - รูป 1x1 pixel สีดำ)
const testImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// 2. ตั้งค่า
const SUPABASE_URL = "https://zkzjbhvsltbwbtteihiy.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY_HERE"; // ใส่ anon key จาก .env

// 3. ดึง session token (ถ้ามี)
async function testVerifySlip() {
  try {
    // ดึง session จาก Supabase client (ถ้ามี)
    const { data: { session } } = await supabase.auth.getSession();
    
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    };
    
    // เพิ่ม Authorization header ถ้ามี session
    if (session) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
      console.log('✅ Using authenticated session');
    } else {
      console.log('⚠️ No session - using anonymous access');
    }
    
    // 4. ส่ง request
    console.log('📤 Sending request to verify-slip...');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/verify-slip`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        imageBase64: testImageBase64
      })
    });
    
    console.log('📥 Response status:', response.status);
    console.log('📥 Response headers:', Object.fromEntries(response.headers.entries()));
    
    const data = await response.json();
    console.log('📥 Response data:', data);
    
    if (response.ok) {
      console.log('✅ Success!', data);
    } else {
      console.error('❌ Error:', data);
    }
    
    return { response, data };
  } catch (error) {
    console.error('❌ Request failed:', error);
    throw error;
  }
}

// 5. รัน test
testVerifySlip();
