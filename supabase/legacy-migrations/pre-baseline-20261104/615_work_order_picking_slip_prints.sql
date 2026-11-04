-- Records the first opening of the browser print dialog, not physical print success.
CREATE TABLE IF NOT EXISTS public.or_work_order_picking_slip_prints (
  work_order_id UUID PRIMARY KEY REFERENCES public.or_work_orders(id) ON DELETE CASCADE,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_by UUID NOT NULL DEFAULT auth.uid()
);

ALTER TABLE public.or_work_order_picking_slip_prints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read picking print state for accessible work orders"
  ON public.or_work_order_picking_slip_prints FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.or_work_orders w WHERE w.id = work_order_id));

CREATE POLICY "Record own picking print for accessible work orders"
  ON public.or_work_order_picking_slip_prints FOR INSERT TO authenticated
  WITH CHECK (printed_by = auth.uid() AND EXISTS (
    SELECT 1 FROM public.or_work_orders w WHERE w.id = work_order_id
  ));

GRANT SELECT, INSERT ON public.or_work_order_picking_slip_prints TO authenticated;
COMMENT ON TABLE public.or_work_order_picking_slip_prints IS
  'First browser print-dialog opening for each work order; does not confirm physical printing.';
