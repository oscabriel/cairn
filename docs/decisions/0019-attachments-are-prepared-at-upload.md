---
status: proposed
gate: judges/paste.ts
---

# Attachments are prepared at upload and reach the model as content

A file reaches the brain through a signed one-shot upload URL (t3code's protocol): the client asks `attachments.createUploadUrl`, posts the raw bytes, and gets back an `AttachmentRef`. The brain sniffs the bytes and prepares the file at upload, never at send: images are fitted to 1,568 px on the long edge (the client fits them first too), PDF text comes from `unpdf` and DOCX text from `mammoth` in a worker with time, memory and size caps, and plain text is kept as it is. HEIC is refused, since iOS already converts photos to JPEG. At send, images become image content and documents one `attachmentText` block with the first 40,000 characters inline and the path of the full text, so the model can read the rest with its tools, and the user entry records the references so the transcript shows chips. Limits are 20 attachments a turn, 10 MiB an image, 50 MiB a file and 120,000 inline characters a turn.

Gate: `judges/paste.ts`, its image and document variants, from paste on the phone to content the model answers about.
