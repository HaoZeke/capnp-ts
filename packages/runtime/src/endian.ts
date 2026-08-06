/** Little-endian scalar load/store via DataView (wire is always LE). */

const TE = true; // littleEndian

export function loadU8(buf: Uint8Array, byteOff: number): number {
  return buf[byteOff]!;
}

export function loadU16(buf: Uint8Array, byteOff: number): number {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 2).getUint16(0, TE);
}

export function loadU32(buf: Uint8Array, byteOff: number): number {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 4).getUint32(0, TE);
}

export function loadI32(buf: Uint8Array, byteOff: number): number {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 4).getInt32(0, TE);
}

export function loadU64(buf: Uint8Array, byteOff: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 8).getBigUint64(0, TE);
}

export function loadI64(buf: Uint8Array, byteOff: number): bigint {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 8).getBigInt64(0, TE);
}

export function loadF32(buf: Uint8Array, byteOff: number): number {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 4).getFloat32(0, TE);
}

export function loadF64(buf: Uint8Array, byteOff: number): number {
  return new DataView(buf.buffer, buf.byteOffset + byteOff, 8).getFloat64(0, TE);
}

export function storeU8(buf: Uint8Array, byteOff: number, v: number): void {
  buf[byteOff] = v & 0xff;
}

export function storeU16(buf: Uint8Array, byteOff: number, v: number): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 2).setUint16(0, v, TE);
}

export function storeU32(buf: Uint8Array, byteOff: number, v: number): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 4).setUint32(0, v >>> 0, TE);
}

export function storeI32(buf: Uint8Array, byteOff: number, v: number): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 4).setInt32(0, v | 0, TE);
}

export function storeU64(buf: Uint8Array, byteOff: number, v: bigint): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 8).setBigUint64(0, v, TE);
}

export function storeI64(buf: Uint8Array, byteOff: number, v: bigint): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 8).setBigInt64(0, v, TE);
}

export function storeF32(buf: Uint8Array, byteOff: number, v: number): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 4).setFloat32(0, v, TE);
}

export function storeF64(buf: Uint8Array, byteOff: number, v: number): void {
  new DataView(buf.buffer, buf.byteOffset + byteOff, 8).setFloat64(0, v, TE);
}
