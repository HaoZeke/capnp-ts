/**
 * Walk framed CodeGeneratorRequest (schema.capnp).
 * Offsets match capnp-fortran capnp_schema.f90 / capnp compile -ocapnp schema.capnp.
 *
 * CodeGeneratorRequest: 0 data words, 4 pointers
 *   ptr0 nodes : List(Node)
 *   ptr1 requestedFiles : List(RequestedFile)
 *   ptr2 capnpVersion
 *   ptr3 sourceInfo
 *
 * RequestedFile: 1 data word (id u64), 2+ pointers
 *   ptr0 filename : Text
 */

// Concrete module paths so the plugin survives package-index churn.
import { Message } from "../../runtime/src/message.ts";
import {
  PtrKind,
  ElemSize,
  WireKind,
  WORD_BYTES,
} from "../../runtime/src/kinds.ts";
import { loadU32, loadU64 } from "../../runtime/src/endian.ts";
import {
  wpKind,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
  wpListEsize,
  wpListCount,
} from "../../runtime/src/pointer.ts";

export type CgrSummary = {
  nodeCount: number;
  requestedFileCount: number;
  /** Paths from requestedFiles[i].filename (may be empty if unreadable). */
  requestedFilenames: string[];
};

/** Prefer Message.fromFlat when the wire reader is present. */
export function summarizeCgr(bytes: Uint8Array): CgrSummary {
  try {
    return summarizeViaMessage(bytes);
  } catch (primary) {
    try {
      return summarizeViaHandWalk(bytes);
    } catch {
      throw primary;
    }
  }
}

function summarizeViaMessage(bytes: Uint8Array): CgrSummary {
  const msg = Message.fromFlat(bytes);
  // Schema graphs are deep; raise traversal budget after open.
  msg.traversalLeft = 1_073_741_824;
  msg.depthLimit = 256;

  const root = msg.root();
  if (root.kind !== PtrKind.Struct) {
    throw new Error("CGR: root is not a struct");
  }

  const nodes = root.getp(0);
  const reqFiles = root.getp(1);
  const nodeCount = nodes.kind === PtrKind.List ? nodes.listLen() : 0;
  const requestedFileCount =
    reqFiles.kind === PtrKind.List ? reqFiles.listLen() : 0;

  const requestedFilenames: string[] = [];
  if (reqFiles.kind === PtrKind.List) {
    for (let i = 0; i < requestedFileCount; i++) {
      const rf = reqFiles.listGetp(i);
      requestedFilenames.push(rf.kind === PtrKind.Struct ? rf.getText(0) : "");
    }
  }

  return { nodeCount, requestedFileCount, requestedFilenames };
}

// --- Hand-offset fallback (no Message API / parse failure) ---------------

/** Parse stream framing; return segment byte slices (views into `bytes`). */
export function parseFramedSegments(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length < 8) {
    throw new Error("CGR framing: buffer too short for segment table");
  }
  const segCount = loadU32(bytes, 0) + 1;
  if (segCount < 1 || segCount > 512) {
    throw new Error(`CGR framing: absurd segment count ${segCount}`);
  }
  const tableBytes = 4 + 4 * segCount;
  const headerBytes = (tableBytes + 7) & ~7;
  if (bytes.length < headerBytes) {
    throw new Error("CGR framing: truncated segment table");
  }
  const segs: Uint8Array[] = [];
  let pos = headerBytes;
  for (let i = 0; i < segCount; i++) {
    const words = loadU32(bytes, 4 + 4 * i);
    const nbytes = words * WORD_BYTES;
    if (pos + nbytes > bytes.length) {
      throw new Error(`CGR framing: segment ${i} overruns buffer`);
    }
    segs.push(bytes.subarray(pos, pos + nbytes));
    pos += nbytes;
  }
  return segs;
}

function readWord(seg: Uint8Array, byteOff: number): bigint {
  if (byteOff < 0 || byteOff + 8 > seg.length) {
    throw new Error(`CGR walk: word read OOB at ${byteOff}`);
  }
  return loadU64(seg, byteOff);
}

function nearBody(seg: Uint8Array, ptrByteOff: number, word: bigint): number {
  const kind = wpKind(word);
  if (kind === WireKind.Far || kind === WireKind.Cap) {
    throw new Error(`CGR walk: unsupported pointer kind ${kind} (far/cap)`);
  }
  if (word === 0n) {
    throw new Error("CGR walk: null pointer");
  }
  const off = wpOffset(word);
  return ptrByteOff + WORD_BYTES + off * WORD_BYTES;
}

function listLenHand(seg: Uint8Array, ptrByteOff: number, word: bigint): number {
  if (wpKind(word) !== WireKind.List) {
    throw new Error(`CGR walk: expected list pointer, got kind ${wpKind(word)}`);
  }
  const esize = wpListEsize(word);
  if (esize === ElemSize.Composite) {
    const body = nearBody(seg, ptrByteOff, word);
    const tag = readWord(seg, body);
    return Number((tag >> 2n) & 0x3fffffffn);
  }
  return wpListCount(word);
}

function readTextHand(seg: Uint8Array, ptrByteOff: number, word: bigint): string {
  if (word === 0n) return "";
  if (wpKind(word) !== WireKind.List) {
    throw new Error("CGR walk: Text is not a list pointer");
  }
  if (wpListEsize(word) !== ElemSize.Byte) {
    throw new Error("CGR walk: Text esize != byte");
  }
  const count = wpListCount(word);
  const body = nearBody(seg, ptrByteOff, word);
  const n = Math.max(0, count - 1);
  if (body + n > seg.length) {
    throw new Error("CGR walk: Text overruns segment");
  }
  return new TextDecoder().decode(seg.subarray(body, body + n));
}

/** Single-segment near-pointer hand walk of CGR (same offsets as Message path). */
export function summarizeViaHandWalk(bytes: Uint8Array): CgrSummary {
  const segs = parseFramedSegments(bytes);
  const seg0 = segs[0];
  if (!seg0 || seg0.length < WORD_BYTES) {
    throw new Error("CGR walk: empty segment 0");
  }

  const rootWord = readWord(seg0, 0);
  if (wpKind(rootWord) !== WireKind.Struct) {
    throw new Error(`CGR walk: root is not a struct (kind ${wpKind(rootWord)})`);
  }
  const rootBody = nearBody(seg0, 0, rootWord);
  const dwords = wpStructDwords(rootWord);
  const pwords = wpStructPwords(rootWord);
  if (pwords < 2) {
    throw new Error(`CGR walk: root has only ${pwords} pointers`);
  }
  const ptrBase = rootBody + dwords * WORD_BYTES;

  const nodesWord = readWord(seg0, ptrBase + 0 * WORD_BYTES);
  const reqWord = readWord(seg0, ptrBase + 1 * WORD_BYTES);

  const nodeCount =
    nodesWord === 0n ? 0 : listLenHand(seg0, ptrBase + 0 * WORD_BYTES, nodesWord);
  const requestedFileCount =
    reqWord === 0n ? 0 : listLenHand(seg0, ptrBase + 1 * WORD_BYTES, reqWord);

  const requestedFilenames: string[] = [];
  if (reqWord !== 0n && requestedFileCount > 0) {
    const listBody = nearBody(seg0, ptrBase + 1 * WORD_BYTES, reqWord);
    const tag = readWord(seg0, listBody);
    const elemDw = wpStructDwords(tag);
    const elemPw = wpStructPwords(tag);
    const elemBytes = (elemDw + elemPw) * WORD_BYTES;
    const firstElem = listBody + WORD_BYTES;
    for (let i = 0; i < requestedFileCount; i++) {
      const elemOff = firstElem + i * elemBytes;
      const fnamePtrOff = elemOff + elemDw * WORD_BYTES;
      try {
        const fw = readWord(seg0, fnamePtrOff);
        requestedFilenames.push(readTextHand(seg0, fnamePtrOff, fw));
      } catch {
        requestedFilenames.push("");
      }
    }
  }

  return { nodeCount, requestedFileCount, requestedFilenames };
}
