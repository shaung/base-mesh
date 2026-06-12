// ---------------------------------------------------------------------------
// Text normalization utilities for Feishu Bitable field values.
//
// Feishu Multiline text fields store values as { text, type } objects.
// Person fields store [{ id, name, ... }] objects.
// These utilities normalize them to plain strings for internal use.
// ---------------------------------------------------------------------------

export function extractText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((e) => extractText(e)).join('');
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
  }
  return String(v ?? '');
}

/** Extract user open_ids from a Feishu Person field (type 11) or Lookup
 *  field wrapping a Person field.
 *
 *  Person field value:        [{ id: "ou_xxx", name: "...", ... }]
 *  Lookup wrapping Person:    { type: 11, value: [{ id: "ou_xxx", name: "...", ... }] }
 *
 *  Returns comma-separated open_ids, or empty string. */
export function extractUserIds(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.type === 11 && Array.isArray(obj.value)) {
      return extractUserIds(obj.value);
    }
    return '';
  }
  if (Array.isArray(v)) {
    return v
      .map((item: any) => (typeof item?.id === 'string' ? item.id : ''))
      .filter(Boolean)
      .join(',');
  }
  return '';
}
