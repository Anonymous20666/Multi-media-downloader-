/**
 * Multipart uploads for the sender (§G6/X5 delivery).
 * Convention: a param value shaped { __upload: { buffer, filename, contentType } }
 * switches THAT call to multipart/form-data. Everything else stays JSON.
 */
export interface UploadValue {
  __upload: { buffer: Buffer; filename: string; contentType: string };
}

export function uploadFile(buffer: Buffer, filename: string, contentType = "application/octet-stream"): UploadValue {
  return { __upload: { buffer, filename, contentType } };
}

export function isUpload(v: unknown): v is UploadValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "__upload" in v &&
    Buffer.isBuffer((v as UploadValue).__upload?.buffer) &&
    typeof (v as UploadValue).__upload?.filename === "string"
  );
}

/** Split params into JSON body or multipart FormData. Returns headers to merge. */
export function encodeParams(params: Record<string, unknown>): { multipart: boolean; body: string | FormData } {
  const hasFile = Object.values(params).some(isUpload);
  if (!hasFile) return { multipart: false, body: JSON.stringify(params) };
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) {
    if (isUpload(v)) {
      const blob = new Blob([new Uint8Array(v.__upload.buffer)], { type: v.__upload.contentType });
      form.append(k, blob, v.__upload.filename);
    } else if (v !== undefined && v !== null) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  return { multipart: true, body: form };
}
