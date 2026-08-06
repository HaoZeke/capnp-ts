/**
 * Little-endian scalar load/store via DataView.
 *
 * All multi-byte wire access goes through these helpers so the library never
 * depends on host endianness or TypedArray multi-byte views over wire bytes.
 * Offsets are byte offsets into the given buffer.
 */

function viewOf(buf: ArrayBuffer | ArrayBufferView): DataView {
  if (buf instanceof ArrayBuffer) {
    return new DataView(buf);
  }
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

// --- unsigned ---

export function loadU8(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getUint8(offset);
}

export function storeU8(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setUint8(offset, value);
}

export function loadU16(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getUint16(offset, true);
}

export function storeU16(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setUint16(offset, value, true);
}

export function loadU32(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getUint32(offset, true);
}

export function storeU32(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setUint32(offset, value, true);
}

/** Unsigned 64-bit; returns bigint in the range 0n .. 2^64-1. */
export function loadU64(buf: ArrayBuffer | ArrayBufferView, offset: number): bigint {
  return viewOf(buf).getBigUint64(offset, true);
}

export function storeU64(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: bigint,
): void {
  viewOf(buf).setBigUint64(offset, value, true);
}

// --- signed ---

export function loadI8(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getInt8(offset);
}

export function storeI8(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setInt8(offset, value);
}

export function loadI16(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getInt16(offset, true);
}

export function storeI16(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setInt16(offset, value, true);
}

export function loadI32(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getInt32(offset, true);
}

export function storeI32(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setInt32(offset, value, true);
}

/** Signed 64-bit as bigint. */
export function loadI64(buf: ArrayBuffer | ArrayBufferView, offset: number): bigint {
  return viewOf(buf).getBigInt64(offset, true);
}

export function storeI64(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: bigint,
): void {
  viewOf(buf).setBigInt64(offset, value, true);
}

// --- floating point ---

export function loadF32(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getFloat32(offset, true);
}

export function storeF32(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setFloat32(offset, value, true);
}

export function loadF64(buf: ArrayBuffer | ArrayBufferView, offset: number): number {
  return viewOf(buf).getFloat64(offset, true);
}

export function storeF64(
  buf: ArrayBuffer | ArrayBufferView,
  offset: number,
  value: number,
): void {
  viewOf(buf).setFloat64(offset, value, true);
}
