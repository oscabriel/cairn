---
status: accepted
gate: judges/paste.ts
---

# Attachments are prepared at upload and reach the model as content

A file reaches the brain through a signed one-shot upload URL (t3code's protocol): the client asks `attachments.createUploadUrl`, posts the raw bytes, and gets back an `AttachmentRef`. The brain sniffs the bytes and prepares the file at upload, never at send: images are fitted to 1,568 px on the long edge (the client fits them first too), PDF text comes from `unpdf` and DOCX text from `mammoth` in a worker with time, memory and size caps, and plain text is kept as it is. HEIC is refused, since iOS already converts photos to JPEG. At send, images become image content and documents one `attachmentText` block with the first 40,000 characters inline and the path of the full text, so the model can read the rest with its tools, and the user entry records the references so the transcript shows chips. Limits are 20 attachments a turn, 10 MiB an image, 50 MiB a file and 120,000 inline characters a turn.

Gate: `judges/paste.ts`, its image and document variants, from paste on the phone to content the model answers about.

Accepted at the wave 4 integration (2026-10-22): `judges/paste.ts` automated tier passes. Paste to chip p50 70 / p95 76 ms on lan and 169 / 172 ms throttled (10 Mbps, 60 ms); send to `turn.submitted` at most 8 ms; sha256 of the prepared image matched 20/20 in each profile; paste and send at once at most 65 ms; a 51 MiB PDF refused. Real models answered the image nonce through `claude-bridge` and `opencode-go` (both `claude-haiku-5-5`), all three PDF page nonces, the scanned PDF's 'no text layer' note and the DOCX nonce. The phone half stays a wizard stage.
