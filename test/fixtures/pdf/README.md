# PDF test fixtures (ro-13-pdf-document-ingestion)

Real, checked-in binary PDF fixtures for `ingestDocument.test.ts`'s PDF-path
tests — never mocked exceptions, per the story's acceptance criteria.

- `wellformed-multipage.pdf` — a real, valid 3-page PDF (hand-built, minimal
  PDF 1.4 syntax, uncompressed Helvetica text streams). Page 1 contains the
  marker string `PAGE-ONE-MARKER`, page 2 `PAGE-TWO-MARKER`, page 3
  `PAGE-THREE-MARKER`, so tests can assert both extraction and per-page
  provenance without ambiguity.
- `encrypted.pdf` — the same 3-page content, encrypted with a real user
  password (`secret123`, AES-256) via `pypdf`. Opening it without a password
  raises `unpdf`/`pdf.js`'s real `PasswordException` (confirmed directly,
  not assumed).
- `corrupt.pdf` — `wellformed-multipage.pdf` truncated to 60% of its length
  with a byte-mangled region in the middle, guaranteeing a real, unrecoverable
  structural break. Opening it raises `unpdf`/`pdf.js`'s real
  `InvalidPDFException`.
- `large-text.pdf` — a real, valid 72-page PDF whose extracted text totals
  ~202KB (over `ingestDocument.ts`'s existing `MAX_INGEST_BYTES` = 200,000
  bytes) while its own raw file size (~267KB) stays far under
  `MAX_PDF_SOURCE_BYTES`. Proves the post-extraction `MAX_INGEST_BYTES`
  rejection (ro-10's existing, unchanged check) fires on PDF-derived text
  exactly as it already does for `.txt`/`.md` content — this fixture never
  trips the pre-parse `MAX_PDF_SOURCE_BYTES` gate itself.

All four were generated with a standalone script (not a project dependency —
generation happens once, offline; only the resulting bytes are checked in).
Each line of body text is wrapped conservatively short (well under a
612pt-wide US Letter page's real glyph budget for 12pt Helvetica) — pdf.js's
text extraction only returns glyphs that actually fall within the page's
visible bounds, so a wrap width that looks safe in raw character count can
still get silently clipped if it overruns the page edge. Regenerating any of
these fixtures should reverify (`unpdf`'s `extractText`) that no page's
returned text is shorter than what was written, before checking a new binary
in.
