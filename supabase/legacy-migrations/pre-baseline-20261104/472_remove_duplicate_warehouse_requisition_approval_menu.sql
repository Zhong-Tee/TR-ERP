-- Desktop approval now lives in WMS > Requisitions. The mobile manager flow
-- continues to use ManagerLayout/ApprovalList and is intentionally untouched.
DELETE FROM public.st_user_menus
WHERE menu_key = 'warehouse-requisition-approval';
