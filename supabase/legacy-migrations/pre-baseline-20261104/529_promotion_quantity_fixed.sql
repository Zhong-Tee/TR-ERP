-- Add "buy X selected products, get a fixed discount" promotion type.

ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_rule_type_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_rule_type_check CHECK (
  rule_type IN (
    'legacy', 'bundle_fixed_price', 'spend_percent', 'spend_fixed',
    'buy_get', 'spend_get', 'quantity_get', 'quantity_fixed'
  )
);

NOTIFY pgrst, 'reload schema';
