-- Allow Accounting to view refund returns from the Orders menu.
-- Refund SELECT and slip storage access already include Accounting.
-- Sending confirmation remains restricted by mark_refund_slip_sent.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('account', 'orders-refund-return', 'โอนคืน', true)
ON CONFLICT (role, menu_key) DO UPDATE
SET has_access = EXCLUDED.has_access,
    menu_name = EXCLUDED.menu_name;
