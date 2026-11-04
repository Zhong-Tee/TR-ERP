-- Allow percentage discounts on qualifying product quantities.
ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_rule_type_check;
ALTER TABLE promotion ADD CONSTRAINT promotion_rule_type_check CHECK (
  rule_type IN (
    'legacy', 'bundle_fixed_price', 'spend_percent', 'spend_fixed',
    'buy_get', 'spend_get', 'quantity_get', 'quantity_fixed', 'quantity_percent'
  )
);

NOTIFY pgrst, 'reload schema';
