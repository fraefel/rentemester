/** Copy byte views into an owned ArrayBuffer accepted by Fetch `Response`. */
export function responseBodyFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
