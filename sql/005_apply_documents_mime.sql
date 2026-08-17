-- 005_apply_documents_mime.sql — record what a generated document actually is.
--
-- ADDITIVE ONLY, like every migration here. One nullable column; nothing reads
-- it yet that would break on NULL.
--
-- WHY
--
-- apply_documents was written when the engine only ever produced PDFs, so the
-- format was implicit and there was nothing to record. It isn't any more: the
-- CV path now tailors the user's own .docx and converts it to PDF only when the
-- local converter is running, so a generated document is a PDF *or* a Word
-- file depending on the machine it was made on.
--
-- upload.js sends `doc.mime` to the page when it builds the File for a
-- DataTransfer attach, and plenty of ATS widgets read `file.type` and reject
-- anything their `accept` attribute doesn't cover. Getting it wrong means a CV
-- silently refused by the upload control.
--
-- docgen.js had already started writing the column. Without it, PostgREST
-- answered every document write with
--
--   PGRST204: Could not find the 'mime' column of 'apply_documents'
--
-- and because that write happens before the job tab is even opened, the whole
-- application failed at the first step — on a job the engine had already paid
-- to tailor.
--
-- user_documents (migration 004) has carried the same column since it was
-- created; this brings the generated side in line with the uploaded side.

alter table public.apply_documents
  add column if not exists mime text;

comment on column public.apply_documents.mime is
  'MIME type of the generated file — application/pdf, or the Word type when the '
  'local PDF converter was unavailable. NULL on rows written before this '
  'migration, which are all PDFs.';

-- Backfill: every row that predates the docx path was rendered to PDF.
update public.apply_documents
   set mime = 'application/pdf'
 where mime is null;
