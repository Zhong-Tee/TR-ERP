-- ============================================
-- MIGRATE PACKING VIDEOS TO GOOGLE DRIVE
-- ============================================
-- Add columns to store Google Drive file references
-- while keeping storage_path for backward compatibility

ALTER TABLE pk_packing_videos
ADD COLUMN IF NOT EXISTS gdrive_file_id TEXT,
ADD COLUMN IF NOT EXISTS gdrive_url TEXT;

COMMENT ON COLUMN pk_packing_videos.gdrive_file_id IS 'Google Drive file ID returned after upload';
COMMENT ON COLUMN pk_packing_videos.gdrive_url IS 'Google Drive viewable URL: https://drive.google.com/file/d/{id}/view';
