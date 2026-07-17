import { claimTypeLabel } from '../../lib/claimTypeLabels'
import type { ClaimCompareDetail, OrderItemRow, RefOrderDetail } from './claimCompareShared'
import {
  channelLabel,
  customerFromProposedOrder,
  externalUrlOrNull,
  fmtMoney,
  lineTotal,
  submitterDisplayClaim,
} from './claimCompareShared'

const cellOrDash = (v: string | null | undefined) => (v && String(v).trim() ? String(v).trim() : '–')

/** ตารางรายการสินค้าพร้อมข้อมูลผลิตครบ — ใช้ทั้งบิลเก่าและบิลเคลมใหม่ */
function FullItemsTable({ items }: { items: OrderItemRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[1020px]">
        <thead>
          <tr className="text-left text-gray-600 border-b bg-gray-50">
            <th className="py-1.5 px-2 min-w-[140px]">สินค้า</th>
            <th className="py-1.5 px-2">สีหมึก</th>
            <th className="py-1.5 px-2">ลาย</th>
            <th className="py-1.5 px-2">เส้น</th>
            <th className="py-1.5 px-2">ฟอนต์</th>
            <th className="py-1.5 px-2">บรรทัด 1</th>
            <th className="py-1.5 px-2">บรรทัด 2</th>
            <th className="py-1.5 px-2">บรรทัด 3</th>
            <th className="py-1.5 px-2 text-right">จำนวน</th>
            <th className="py-1.5 px-2 text-right">ราคา/หน่วย</th>
            <th className="py-1.5 px-2 text-right">รวม</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i} className="border-b border-gray-50">
              <td className="py-1.5 px-2">{cellOrDash(it.product_name)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.ink_color)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.cartoon_pattern)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.line_pattern)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.font)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.line_1)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.line_2)}</td>
              <td className="py-1.5 px-2">{cellOrDash(it.line_3)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{it.quantity ?? '–'}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{fmtMoney(Number(it.unit_price) || 0)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{fmtMoney(lineTotal(it))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Props = {
  detail: ClaimCompareDetail
  refOrder: RefOrderDetail | null
  refLoading: boolean
  channelLabels: Record<string, string>
  claimLabels: Record<string, string>
  /** REQ ที่อนุมัติแล้วก่อนคำขอนี้ (เคลมซ้ำ) — จากแมปหรือจากโหลด */
  latestPriorReqBillNo?: string | null
  /** เมื่อคำขอนี้อนุมัติแล้ว: เลขบิล REQ ที่สร้างจากคำขอนี้ */
  approvedResultBillNo?: string | null
}

export default function ClaimRequestComparePanel({
  detail,
  refOrder,
  refLoading,
  channelLabels,
  claimLabels,
  latestPriorReqBillNo,
  approvedResultBillNo,
}: Props) {
  const proposedItems = (detail.proposed_snapshot?.items || []) as OrderItemRow[]
  const proposedOrder = detail.proposed_snapshot?.order || {}
  const propPrice = Number(proposedOrder.price) || 0
  const propShipping = Number(proposedOrder.shipping_cost) || 0
  const propDiscount = Number(proposedOrder.discount) || 0
  const propTotal = Number(proposedOrder.total_amount) || 0
  const proposedClaimDetailsLegacy =
    typeof proposedOrder.claim_details === 'string' ? proposedOrder.claim_details.trim() : ''
  const displayClaimDescription =
    (detail.claim_description?.trim() || proposedClaimDetailsLegacy || '').trim() || null
  const displaySupportingUrl = externalUrlOrNull(detail.supporting_url ?? undefined)

  const proposedCustomerFallback = customerFromProposedOrder(proposedOrder as Record<string, unknown>)

  const modalCustomer = refOrder
    ? {
        customer_name: refOrder.customer_name,
        customer_address: refOrder.customer_address,
        mobile_phone: refOrder.mobile_phone,
        channel_code: refOrder.channel_code,
        admin_user: refOrder.admin_user,
      }
    : detail.ref_order
      ? {
          customer_name: detail.ref_order.customer_name,
          customer_address: detail.ref_order.customer_address,
          mobile_phone: detail.ref_order.mobile_phone,
          channel_code: detail.ref_order.channel_code,
          admin_user: detail.ref_order.admin_user,
        }
      : proposedCustomerFallback

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto pr-1">
      <h3 className="text-lg font-bold text-gray-900 mb-1">เปรียบเทียบบิลเคลม</h3>
      <p className="text-sm text-gray-600 mb-1 flex flex-wrap gap-x-1 gap-y-0.5 items-baseline">
        <span>
          บิลจัดส่งต้น:{' '}
          <strong className="font-mono">{refOrder?.bill_no || detail.ref_snapshot?.bill_no || '–'}</strong>
        </span>
        {latestPriorReqBillNo ? (
          <span>
            <span className="text-gray-400">·</span> REQ ล่าสุด (ก่อนคำขอนี้):{' '}
            <strong className="font-mono">{latestPriorReqBillNo}</strong>
          </span>
        ) : null}
        {approvedResultBillNo ? (
          <span>
            <span className="text-gray-400">·</span> บิล REQ จากคำขอนี้:{' '}
            <strong className="font-mono">{approvedResultBillNo}</strong>
          </span>
        ) : null}
        <span>
          <span className="text-gray-400">·</span> หัวข้อ:{' '}
          <strong>{claimTypeLabel(claimLabels, detail.claim_type)}</strong>
        </span>
      </p>
      <p className="text-sm text-gray-600 mb-3">
        ผู้ส่งคำขอเคลม: <strong>{submitterDisplayClaim(detail)}</strong>
      </p>

      {detail.status === 'rejected' && (detail.rejected_reason || '').trim() ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm text-rose-900 mb-3">
          <div className="font-semibold text-rose-950 mb-1">เหตุผลปฏิเสธ (บัญชี)</div>
          <p className="whitespace-pre-wrap break-words">{detail.rejected_reason!.trim()}</p>
        </div>
      ) : null}

      {displaySupportingUrl ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => window.open(displaySupportingUrl, '_blank', 'noopener,noreferrer')}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700"
          >
            เปิดลิงก์หลักฐาน
          </button>
        </div>
      ) : null}

      {displayClaimDescription ? (
        <div className="text-sm text-gray-700 mb-3 rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2.5">
          <span className="text-gray-600 font-medium block mb-1">คำอธิบายการเคลม</span>
          <p className="whitespace-pre-wrap break-words text-gray-900 leading-relaxed">{displayClaimDescription}</p>
        </div>
      ) : null}

      {refLoading && !modalCustomer ? (
        <p className="text-sm text-gray-500 mb-3">กำลังโหลดข้อมูลลูกค้า...</p>
      ) : modalCustomer ? (
        <div className="rounded-lg border border-gray-200 bg-slate-50/90 px-4 py-3 text-sm mb-4 space-y-2">
          <div className="font-semibold text-slate-800">ข้อมูลลูกค้า (บิลอ้างอิง / จัดส่งเดิม)</div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-gray-800">
            <div className="sm:col-span-2">
              <dt className="text-gray-500 text-xs font-medium">ชื่อลูกค้า</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words">{modalCustomer.customer_name?.trim() || '–'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500 text-xs font-medium">ที่อยู่จัดส่ง</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words">
                {modalCustomer.customer_address?.trim() || '–'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 text-xs font-medium">เบอร์โทร</dt>
              <dd className="mt-0.5">{modalCustomer.mobile_phone?.trim() || '–'}</dd>
            </div>
            <div>
              <dt className="text-gray-500 text-xs font-medium">ช่องทาง</dt>
              <dd className="mt-0.5">{channelLabel(channelLabels, modalCustomer.channel_code)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500 text-xs font-medium">ผู้เปิดบิล</dt>
              <dd className="mt-0.5">{modalCustomer.admin_user?.trim() || '–'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-gray-500 text-xs font-medium mb-1">วิดีโอ (แพคสินค้า)</dt>
              <dd>
                <button
                  type="button"
                  disabled={!detail.packing_video_url}
                  title={detail.packing_video_url ? 'เปิดวิดีโอแพคในแท็บใหม่' : 'ยังไม่พบวิดีโอของบิลนี้'}
                  onClick={() =>
                    detail.packing_video_url &&
                    window.open(detail.packing_video_url, '_blank', 'noopener,noreferrer')
                  }
                  className="px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  วิดีโอ (แพค)
                </button>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="border rounded-lg overflow-hidden shrink-0">
        <div className="bg-slate-100 px-3 py-2 font-semibold text-slate-800 text-sm">บิลเก่า (จัดส่งแล้ว)</div>
        {refLoading ? (
          <p className="p-3 text-sm text-gray-500">กำลังโหลด...</p>
        ) : refOrder ? (
          <>
            <p className="px-3 py-2 text-sm space-x-2 border-b border-gray-100">
              <span>ยอดรายการ: {fmtMoney(refOrder.price)}</span>
              <span className="text-gray-500">|</span>
              <span>ค่าขนส่ง: {fmtMoney(refOrder.shipping_cost)}</span>
              {refOrder.discount > 0 && (
                <>
                  <span className="text-gray-500">|</span>
                  <span>ส่วนลด: {fmtMoney(refOrder.discount)}</span>
                </>
              )}
              <span className="text-gray-500">|</span>
              <span>
                ยอดรวม: <strong>{fmtMoney(refOrder.total_amount)}</strong>
              </span>
            </p>
            <FullItemsTable items={refOrder.order_items || []} />
          </>
        ) : (
          <p className="p-3 text-sm text-gray-500">ไม่พบข้อมูลบิลอ้างอิง</p>
        )}
      </div>

      <div className="mt-4 border border-amber-200 rounded-lg overflow-hidden shrink-0">
        <div className="bg-amber-50 px-3 py-2 font-semibold text-amber-900 text-sm">
          รายละเอียดบิลเคลมใหม่ (เสนอเคลม)
        </div>
        <p className="px-3 py-2 text-sm space-x-2 border-b border-amber-100">
          <span>ยอดรายการ: {fmtMoney(propPrice)}</span>
          <span className="text-gray-500">|</span>
          <span>ค่าขนส่ง: {fmtMoney(propShipping)}</span>
          {propDiscount > 0 && (
            <>
              <span className="text-gray-500">|</span>
              <span>ส่วนลด: {fmtMoney(propDiscount)}</span>
            </>
          )}
          <span className="text-gray-500">|</span>
          <span>
            ยอดรวมเสนอ: <strong>{fmtMoney(propTotal)}</strong>
          </span>
          {refOrder && (
            <span
              className={
                propTotal - refOrder.total_amount > 0.005
                  ? 'text-red-600'
                  : propTotal - refOrder.total_amount < -0.005
                    ? 'text-emerald-700'
                    : 'text-gray-600'
              }
            >
              {' '}
              (ส่วนต่าง {fmtMoney(propTotal - refOrder.total_amount)})
            </span>
          )}
        </p>
        <FullItemsTable items={proposedItems} />
      </div>
    </div>
  )
}
