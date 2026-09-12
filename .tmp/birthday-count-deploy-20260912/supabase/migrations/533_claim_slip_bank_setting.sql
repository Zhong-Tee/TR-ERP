-- Select one dedicated receiver account for EasySlip verification of claim bills.
ALTER TABLE public.bank_settings
  ADD COLUMN IF NOT EXISTS use_for_claim_slips BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_settings_single_claim_slip_account
  ON public.bank_settings (use_for_claim_slips)
  WHERE use_for_claim_slips = TRUE;

COMMENT ON COLUMN public.bank_settings.use_for_claim_slips IS
  'True for the single receiver account used to verify claim-bill (REQ) payment slips.';
