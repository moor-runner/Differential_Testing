export const MAX_PREVIEW = 1024 * 1024;

export function bounded(value: string | null | undefined) {
  const text = value || '';
  if (text.length < MAX_PREVIEW / 3) return { text, truncated: false };
  const bytes = new TextEncoder().encode(text);
  return bytes.length > MAX_PREVIEW
    ? { text: new TextDecoder().decode(bytes.subarray(0, MAX_PREVIEW)), truncated: true }
    : { text, truncated: false };
}

/** Match Java Character.isWhitespace, used by the judging engine. */
export function normalize(value: string) {
  const trailingWhitespace = /[\u0009-\u000D\u001C-\u001F\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]+$/u;
  const lines = value.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(trailingWhitespace, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join('\n');
}
