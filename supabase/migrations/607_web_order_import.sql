-- Apply to TR-ERP, not to the ecommerce database.
alter table public.or_orders add column if not exists web_order_no text;
alter table public.or_orders add column if not exists web_import_snapshot jsonb;
alter table public.or_order_items add column if not exists web_item_id text;
create unique index if not exists or_orders_web_source_unique on public.or_orders(channel_code,web_order_no) where web_order_no is not null;
create unique index if not exists or_order_items_web_item_unique on public.or_order_items(order_id,web_item_id) where web_item_id is not null;

create or replace function public.import_web_order(payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare existing public.or_orders; new_id uuid; item jsonb; p public.pr_products; actor text;
 channel text:=payload->>'channel_code'; external_no text:=payload->>'channel_order_no';
 subtotal numeric:=0; qty integer; unit numeric; bill text; prefix text; seq integer;
begin
 if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
 -- SECURITY INVOKER preserves the ERP's current order/product RLS permissions.
 select coalesce(username,email) into actor from public.us_users where id=auth.uid();
 if actor is null then raise exception 'FORBIDDEN'; end if;
 if channel is null or channel !~ '^[A-Z0-9_-]{1,32}$' or external_no is null or external_no !~ '^[A-Za-z0-9_-]{1,80}$' then raise exception 'INVALID_SOURCE'; end if;
 if coalesce(jsonb_typeof(payload->'items'),'')<>'array' then raise exception 'INVALID_ITEMS'; end if;
 if jsonb_array_length(payload->'items') not between 1 and 1000 then raise exception 'INVALID_ITEMS'; end if;
 if nullif(payload->>'payment_reference','') is null or nullif(payload->>'customer_name','') is null or nullif(payload->>'customer_address','') is null then raise exception 'MISSING_ORDER_DATA'; end if;
 perform pg_advisory_xact_lock(hashtextextended('web-import:'||channel||':'||external_no,0));
 select * into existing from public.or_orders where channel_code=channel and web_order_no=external_no;
 if found then return jsonb_build_object('status','exists','id',existing.id,'bill_no',existing.bill_no); end if;
 if exists(select 1 from jsonb_array_elements(payload->'items') x group by x->>'web_item_id' having count(*)>1) then raise exception 'DUPLICATE_ITEM'; end if;
 for item in select * from jsonb_array_elements(payload->'items') loop
   qty:=(item->>'quantity')::integer; unit:=(item->>'unit_price')::numeric;
   if qty is null or qty<=0 or unit is null or unit<0 or unit<>round(unit,2) or nullif(item->>'web_item_id','') is null then raise exception 'INVALID_ITEM'; end if;
   if (item->>'is_free')::boolean and unit<>0 then raise exception 'INVALID_GIFT'; end if;
   select * into p from public.pr_products where product_code=item->>'source_product_code';
   if not found then raise exception 'UNKNOWN_SKU: %',item->>'source_product_code'; end if;
   subtotal:=subtotal+qty*unit;
 end loop;
 if (payload->>'price') is null or (payload->>'shipping_cost') is null or (payload->>'discount') is null or (payload->>'total_amount') is null or (payload->>'charged_shipping') is null or (payload->>'special_area_surcharge') is null or
 (payload->>'charged_shipping')::numeric<0 or (payload->>'special_area_surcharge')::numeric<0 or
 subtotal<>(payload->>'price')::numeric or (payload->>'shipping_cost')::numeric<0 or (payload->>'discount')::numeric not between 0 and subtotal or
 subtotal+(payload->>'shipping_cost')::numeric-(payload->>'discount')::numeric<>(payload->>'total_amount')::numeric or
 (payload->>'shipping_cost')::numeric<>(payload->>'charged_shipping')::numeric+(payload->>'special_area_surcharge')::numeric then raise exception 'TOTAL_MISMATCH'; end if;
 prefix:=channel||to_char(now() at time zone 'Asia/Bangkok','YYMM');
 perform pg_advisory_xact_lock(hashtextextended('bill:'||prefix,0));
 select coalesce(max(right(bill_no,4)::integer),0)+1 into seq from public.or_orders where bill_no ~ ('^'||prefix||'[0-9]{4}$');
 if seq>9999 then raise exception 'BILL_SEQUENCE_EXHAUSTED'; end if;
 bill:=prefix||lpad(seq::text,4,'0');
 insert into public.or_orders(channel_code,bill_no,channel_order_no,web_order_no,web_import_snapshot,customer_name,recipient_name,customer_address,price,shipping_cost,discount,total_amount,payment_method,promotion,payment_date,payment_time,status,requires_confirm_design,admin_user,entry_date,billing_details)
 values(channel,bill,external_no,external_no,payload,payload->>'customer_name',payload->>'recipient_name',payload->>'customer_address',subtotal,(payload->>'shipping_cost')::numeric,(payload->>'discount')::numeric,(payload->>'total_amount')::numeric,payload->>'payment_method',payload->>'promotion',(payload->>'payment_date')::date,(payload->>'payment_time')::time,'รอลงข้อมูล',false,actor,(now() at time zone 'Asia/Bangkok')::date,payload->'billing_details') returning id into new_id;
 for item in select * from jsonb_array_elements(payload->'items') loop
   select * into p from public.pr_products where product_code=item->>'source_product_code';
   insert into public.or_order_items(order_id,item_uid,web_item_id,product_id,product_name,quantity,unit_price,is_free,ink_color,product_type,cartoon_pattern,line_pattern,font,line_1,line_2,line_3,notes,file_attachment)
   values(new_id,bill||'-'||(item->>'web_item_id'),item->>'web_item_id',p.id,item->>'product_name',(item->>'quantity')::integer,(item->>'unit_price')::numeric,(item->>'is_free')::boolean,item->>'ink_color',item->>'product_type',item->>'cartoon_pattern',item->>'line_pattern',item->>'font',item->>'line_1',item->>'line_2',item->>'line_3',item->>'notes',nullif(item->>'file_attachment',''));
 end loop;
 return jsonb_build_object('status','created','id',new_id,'bill_no',bill);
end $$;
revoke all on function public.import_web_order(jsonb) from public,anon;
grant execute on function public.import_web_order(jsonb) to authenticated;
notify pgrst,'reload schema';
