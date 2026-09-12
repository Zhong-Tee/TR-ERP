// Script สำหรับแปลงรูปสลิปเป็น Base64
// วิธีใช้: เปิด Browser Console (F12) แล้ว copy-paste code นี้

// 1. ใส่ URL ของรูปสลิปที่อัพโหลดแล้ว
const slipUrl = 'YOUR_SLIP_IMAGE_URL_HERE'; // เปลี่ยนเป็น URL ของรูปสลิปจริง

// 2. แปลงรูปเป็น Base64
async function imageUrlToBase64(url) {
  console.log('📥 Downloading image from:', url);
  const response = await fetch(url);
  const blob = await response.blob();
  console.log('📦 Image size:', blob.size, 'bytes');
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1]; // ลบ data:image/...;base64, prefix
      console.log('✅ Base64 length:', base64.length, 'characters');
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 3. ทดสอบ verify-slip
async function testWithRealSlip() {
  try {
    const imageBase64 = await imageUrlToBase64(slipUrl);
    
    // ดึง session token
    const { data: { session } } = await supabase.auth.getSession();
    
    const headers = {
      'Content-Type': 'application/json',
      'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
    };
    
    if (session) {
      headers['Authorization'] = `Bearer ${session.access_token}`;
    }
    
    console.log('📤 Sending request to verify-slip...');
    const response = await fetch('https://zkzjbhvsltbwbtteihiy.supabase.co/functions/v1/verify-slip', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ imageBase64: imageBase64 })
    });
    
    console.log('📥 Status:', response.status);
    const data = await response.json();
    console.log('📥 Response:', data);
    
    if (response.ok && data.success) {
      console.log('✅ Success! Amount:', data.amount);
    } else {
      console.error('❌ Error:', data.error || data);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Request failed:', error);
    throw error;
  }
}

// 4. รัน test
testWithRealSlip();
