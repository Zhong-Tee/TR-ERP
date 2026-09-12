// วิธีทดสอบแบบง่าย - พิมพ์ทีละส่วนใน Console

// ส่วนที่ 1: ตั้งค่า anon key
window.__SUPABASE_ANON_KEY__ = window.__SUPABASE_ANON_KEY__ || 'PASTE_ANON_KEY_HERE';

// ส่วนที่ 2: ตั้งค่า URL
const slipUrl = 'https://zkzjbhvsltbwbtteihiy.supabase.co/storage/v1/object/public/slip-images/slipFBTR26010007/slipFBTR26010007-01.jpg';

// ส่วนที่ 3: ฟังก์ชันทดสอบ (copy ส่วนนี้ทั้งหมด)
(async () => {
  try {
    console.log('📥 Downloading image...');
    const response = await fetch(slipUrl);
    const blob = await response.blob();
    console.log('📦 Image size:', blob.size, 'bytes');
    
    const imageBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    console.log('✅ Base64 length:', imageBase64.length);
    
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      console.error('❌ No session - please login first');
      return;
    }
    
    console.log('📤 Sending request...');
    const res = await fetch('https://zkzjbhvsltbwbtteihiy.supabase.co/functions/v1/verify-slip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': window.__SUPABASE_ANON_KEY__,
      },
      body: JSON.stringify({ imageBase64 })
    });
    
    const data = await res.json();
    console.log('📥 Status:', res.status);
    console.log('📥 Response:', data);
    
    if (res.ok && data.success) {
      console.log('✅ Success! Amount:', data.amount);
    } else {
      console.error('❌ Error:', data.error || data);
    }
  } catch (error) {
    console.error('❌ Failed:', error);
  }
})();
