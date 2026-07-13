/** ข้อมูลธนาคารไทย + แอปพลิเคชันธนาคาร — ใช้ร่วมกันระหว่างหน้า อายุสลิป (เมนูบัญชี) และดรอปดาวน์ธนาคาร (บัญชีรับโอนคืน) */

export type BankApp = {
  name: string
  bank: string
  logo: string
  brandColor: string
}

/** URL โลโก้ธนาคาร (omise banks-logo) */
export function bankLogoUrl(logo: string): string {
  return `https://raw.githubusercontent.com/omise/banks-logo/master/th/${logo}.svg`
}

/** แอปธนาคารที่รองรับอายุสลิป 30 วัน */
export const SLIP_BANK_APPS_30D: BankApp[] = [
  { name: 'K PLUS', bank: 'ธนาคารกสิกรไทย', logo: 'kbank', brandColor: '#138f2d' },
  { name: 'MAKE by KBank', bank: 'ธนาคารกสิกรไทย', logo: 'kbank', brandColor: '#138f2d' },
  { name: 'Krungthai NEXT', bank: 'ธนาคารกรุงไทย', logo: 'ktb', brandColor: '#1ba5e1' },
  { name: 'Paotang', bank: 'ธนาคารกรุงไทย', logo: 'ktb', brandColor: '#1ba5e1' },
  { name: 'Bangkok Bank', bank: 'ธนาคารกรุงเทพ', logo: 'bbl', brandColor: '#1e4598' },
  { name: 'CIMB THAI', bank: 'ธนาคารซีไอเอ็มบี', logo: 'cimb', brandColor: '#7e2f36' },
  { name: 'UOB TMRW Thailand', bank: 'ธนาคารยูโอบี', logo: 'uob', brandColor: '#0b3979' },
]

/** แอปธนาคารที่รองรับอายุสลิป 7 วัน */
export const SLIP_BANK_APPS_7D: BankApp[] = [
  { name: 'SCB Easy', bank: 'ธนาคารไทยพาณิชย์', logo: 'scb', brandColor: '#4e2e7f' },
  { name: 'TTB Touch', bank: 'ธนาคารทหารไทยธนชาต', logo: 'ttb', brandColor: '#fc4f1f' },
  { name: 'MyMo by GSB', bank: 'ธนาคารออมสิน', logo: 'gsb', brandColor: '#eb198d' },
  { name: 'KMA-Krungsri', bank: 'ธนาคารกรุงศรีอยุธยา', logo: 'bay', brandColor: '#fec43b' },
  { name: 'Kept', bank: 'ธนาคารกรุงศรีอยุธยา', logo: 'bay', brandColor: '#fec43b' },
  { name: 'Dime!', bank: 'ธนาคารกรุงศรีอยุธยา', logo: 'bay', brandColor: '#fec43b' },
  { name: 'KKP MOBILE', bank: 'ธนาคารเกียรตินาคินภัทร', logo: 'kk', brandColor: '#199cc5' },
  { name: 'GHB ALL GEN', bank: 'ธนาคารอาคารสงเคราะห์', logo: 'ghb', brandColor: '#f57d23' },
  { name: 'TISCO My Wealth', bank: 'ธนาคารทิสโก้', logo: 'tisco', brandColor: '#12549f' },
  { name: 'LHB You', bank: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', logo: 'lhb', brandColor: '#6d6e71' },
]

export type ThaiBank = {
  bank: string
  logo: string
  brandColor: string
}

/** รายชื่อธนาคาร (ไม่ซ้ำ) จากรายการแอปทั้งหมด — ใช้กับดรอปดาวน์เลือกธนาคาร */
export const THAI_BANKS: ThaiBank[] = [...SLIP_BANK_APPS_30D, ...SLIP_BANK_APPS_7D].reduce<ThaiBank[]>(
  (list, app) => {
    if (!list.some((b) => b.bank === app.bank)) {
      list.push({ bank: app.bank, logo: app.logo, brandColor: app.brandColor })
    }
    return list
  },
  [],
)
