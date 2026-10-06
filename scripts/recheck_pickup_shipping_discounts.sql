-- Read-only recheck of the 15 bills reported by the user.
-- discount is stored in baht. A numeric offset does not identify a discount's intent.
SELECT bill_no,status,fulfillment_method,price,shipping_cost,discount,total_amount,
       price+shipping_cost-discount AS expected_total,
       total_amount-(price+shipping_cost-discount) AS total_difference,
       CASE WHEN discount>=shipping_cost AND shipping_cost>0
                   AND abs(total_amount-(price+shipping_cost-discount))<0.01
            THEN 'ส่วนลดครอบคลุมค่าส่ง ยอดสุทธิตรงสูตร'
            ELSE 'ต้องตรวจเพิ่มเติม' END AS audit_result
FROM public.or_orders
WHERE id IN (
  'bc2698ec-abd2-4cd2-8f82-26281dd68f8b'::uuid,
  '8e707f83-36fa-4762-a234-6d3efbcc3c4a'::uuid,
  '13686f4a-ff37-4aa9-b34f-1bedfcd2f3a1'::uuid,
  '6c770b5f-69a2-4c47-b911-1012d1348ad0'::uuid,
  'a3817ebd-3f2b-4891-a27a-ee73e834b8aa'::uuid,
  'eecd7706-1250-4ede-ac3d-cad2933fa48c'::uuid,
  'a5dbe6cd-8031-4112-adc6-bf9b5260ea40'::uuid,
  '5cd3bd1d-ce5b-4046-9516-0c5e26005f52'::uuid,
  '53941309-69a7-4542-b51c-7b2124d74466'::uuid,
  'e85e7180-f03b-4ada-87c1-71600ef41151'::uuid,
  'c5dc23c4-7582-4266-924e-fee9152a4d3d'::uuid,
  'fc016ccf-f7c0-4881-8d76-5de858d839ac'::uuid,
  'bdbac918-ffae-4e9b-b5ce-55fa82282b2f'::uuid,
  '9bbfb0cc-6583-4f32-b1fb-954210ad6fbf'::uuid,
  '0599b759-237d-42af-a4db-4249e70fe4b1'::uuid
)
ORDER BY bill_no;
