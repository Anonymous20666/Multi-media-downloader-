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
  if (typeof params.rich_message === "string") {
    try {
      params = { ...params, rich_message: JSON.parse(params.rich_message as string) };
    } catch {
      params = { ...params, rich_message: { html: params.rich_message } };
    }
  }
  // Nested uploads (media-group arrays) become attach:// references; top-level
  // uploads keep the original convention (file under its own param key).
  const nested: Array<{ field: string; value: UploadValue }> = [];
  let n = 0;
  const deepReplace = (v: unknown): unknown => {
    if (isUpload(v)) {
      const field = `file${n++}`;
      nested.push({ field, value: v });
      return `attach://${field}`;
    }
    if (Buffer.isBuffer(v)) return v;
    if (Array.isArray(v)) return v.map(deepReplace);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = deepReplace(x);
      return o;
    }
    return v;
  };
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) mapped[k] = isUpload(v) ? v : deepReplace(v);

  const hasTop = Object.values(mapped).some(isUpload);
  if (!hasTop && !nested.length) return { multipart: false, body: JSON.stringify(params) };
  const form = new FormData();
  for (const [k, v] of Object.entries(mapped)) {
    if (isUpload(v)) {
      form.append(k, toBlob(v), v.__upload.filename);
    } else if (v !== undefined && v !== null) {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  for (const { field, value } of nested) form.append(field, toBlob(value), value.__upload.filename);
  return { multipart: true, body: form };
}

function toBlob(v: UploadValue): Blob {
  return new Blob([new Uint8Array(v.__upload.buffer)], { type: v.__upload.contentType });
}
