// วิธีทดสอบด้วย URL จาก Console
// Copy-paste code นี้ใน Browser Console (F12) หลังจาก login แล้ว

// 1. ตั้งค่า anon key (รันบรรทัดนี้ก่อน 1 ครั้ง)
if (!window.__SUPABASE_ANON_KEY__) {
  window.__SUPABASE_ANON_KEY__ = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprempiaHZzbHRid2J0dGVpaGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5Njc5MDQsImV4cCI6MjA4NDU0MzkwNH0.Z3sTjdW1gtqtfVfybHm02wqOUGllhmMLu1rNVwD4jtU';
  console.log('✅ Anon key set!');
}

// 2. ใส่ URL ของรูปสลิป
const slipUrl = 'https://zkzjbhvsltbwbtteihiy.supabase.co/storage/v1/object/public/slip-images/slipFBTR26010007/slipFBTR26010007-01.jpg';

// 2. แปลงรูปเป็น Base64 และทดสอบ
async function testWithSlipUrl() {
  try {
    console.log('📥 Downloading image from:', slipUrl);
    
    // แปลงรูปเป็น Base64
    const response = await fetch(slipUrl);
    const blob = await response.blob();
    console.log('📦 Image size:', blob.size, 'bytes');
    
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        console.log('✅ Base64 length:', base64.length, 'characters');
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    
    // ดึง session และ anon key
    const { data: { session } } = await supabase.auth.getSession();
    
    // ดึง URL และ key
    const supabaseUrl = 'https://zkzjbhvsltbwbtteihiy.supabase.co';
    const anonKey = window.__SUPABASE_ANON_KEY__;
    
    if (!anonKey) {
      console.error('❌ Anon key not found!');
      console.log('💡 Please run the anon key setup at the top of this script first.');
      throw new Error('Missing anon key. Please set window.__SUPABASE_ANON_KEY__ first.');
    }
    
    if (!session) {
      console.error('❌ No session - please login first');
      return;
    }
    
    console.log('📤 Sending request to verify-slip...');
    const response2 = await fetch(`${supabaseUrl}/functions/v1/verify-slip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({ imageBase64: imageBase64 })
    });
    
    console.log('📥 Response status:', response2.status);
    const data = await response2.json();
    console.log('📥 Response data:', data);
    
    if (response2.ok && data.success) {
      console.log('✅ Success! Amount:', data.amount);
      console.log('✅ Message:', data.message);
    } else {
      console.error('❌ Error:', data.error || data);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Request failed:', error);
    throw error;
  }
}

// 3. รัน test
testWithSlipUrl();
