/**
 * นับความยาวข้อความสำหรับลิมิตบนบิล: นับช่องว่างและตัวอักษรที่ “เห็นเป็นพื้นฐาน”
 * ไม่นับวรรณยุกต์/สระลอยเหนือ–ใต้แนวพยัญชนะ (เช่น ่ ้ ๊ ๋ ิ ี ึ ื ็ ์ ุ ู ั ํ และพินทุ)
 * สระหน้า (เ แ โ ใ ไ) และ ำ (U+0E33) นับตามปกติ
 */
const THAI_COMBINING_MARKS_NOT_COUNTED = new Set<string>([
  '\u0E31', // sara mai han akat ั
  '\u0E34', // sara i ิ
  '\u0E35', // sara ii ี
  '\u0E36', // sara ue ึ
  '\u0E37', // sara uee ื
  '\u0E38', // sara u ุ
  '\u0E39', // sara uu ู
  '\u0E3A', // phinthu
  '\u0E47', // maitaikhu ็
  '\u0E48', // mai ek ่
  '\u0E49', // mai tho ้
  '\u0E4A', // mai tri ๊
  '\u0E4B', // mai chattawa ๋
  '\u0E4C', // thanthakhat ์
  '\u0E4D', // nikhahit ํ
])

export function countThaiBillChars(input: string): number {
  if (!input) return 0
  let n = 0
  for (const ch of input) {
    if (!THAI_COMBINING_MARKS_NOT_COUNTED.has(ch)) n += 1
  }
  return n
}
