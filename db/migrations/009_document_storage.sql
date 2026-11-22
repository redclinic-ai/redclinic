-- 009: document storage details. Originals are never changed or deleted by the app
-- (rc_app has SELECT and INSERT only on documents, unchanged).
ALTER TABLE documents
  ADD COLUMN sha256 text,                 -- fingerprint of the original file, to prove it was not altered
  ADD COLUMN storage_driver text;         -- which storage adapter holds the file (e.g. 'local', 's3')

-- A file record must point at stored bytes; a note may have no file.
ALTER TABLE documents ADD CONSTRAINT documents_file_or_note
  CHECK (doc_type = 'note' OR storage_path IS NOT NULL) NOT VALID;
