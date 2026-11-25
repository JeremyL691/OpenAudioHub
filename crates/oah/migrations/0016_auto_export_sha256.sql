-- SHA-256 fingerprint of the file written by desktop automatic export, so split and daily
-- consolidation can verify transcoded exports (such as .ogg exported as .mp3) byte-for-byte
-- before replacing or removing them.
ALTER TABLE recordings ADD COLUMN auto_export_sha256 TEXT;
