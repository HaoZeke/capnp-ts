/**
 * Raw-frame driver: writes hand-built rpc.capnp frames to an Echo server
 * and prints one line per frame the server sends back.
 *
 *   bun interop/raw_frames.ts <port> <scenario>
 *   bun interop/raw_frames.ts --list
 *
 * The same scenario run against the capnp-C++ peer (`rpc_peer serve`) and
 * the TypeScript server (`rpc_server.ts`) should print the same lines;
 * interop/run_raw_frames.sh runs every scenario against both and diffs.
 * Frames are built field by field so malformed and unusual messages can
 * be sent exactly as written.
 */
import { connect } from "node:net";

import {
  Message as CapnpMessage,
  MessageBuilder,
  Orphan,
  type Ptr,
  PtrKind,
  type StructBuilder,
} from "@haozeke/capnp";

import {
  CapDescriptor_which,
  Exception_getReason,
  Exception_getTrace,
  Exception_getType,
  Message,
  Message_which,
  Payload_getCapTable,
  Payload_getContent,
  Resolve_which,
  Return_which,
} from "../packages/rpc/src/rpc.capnp.ts";
import { ECHO_INTERFACE_ID } from "./interop.capnp.ts";

const ECHO = ECHO_INTERFACE_ID;
const M = {
  ping: 0,
  makePromise: 2,
  slow: 4,
  resolveLater: 3,
  echoCap: 8,
  brokenCap: 10,
  promiseOfHeld: 13,
  hold: 11,
  callHeld: 12,
  resolveHeld: 14,
} as const;

type Step = Uint8Array | { wait: number };

function frame(tag: number, fill?: (m: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, tag);
  fill?.(root);
  return b.toFlat();
}

/** A message whose body pointer is left null. */
function nullBody(tag: number): Uint8Array {
  return frame(tag);
}

function bootstrap(q: number): Uint8Array {
  return frame(Message.bootstrap, (m) => m.initStruct(0, 1, 1).setU32(0, q));
}

/** A promised-answer target; in `ops`, -1 is a `noop` and any other value a pointer field. */
function targetAnswer(t: StructBuilder, q: number, ops: number[] = []): void {
  t.setU16(4, 1);
  const pa = t.initStruct(0, 1, 1);
  pa.setU32(0, q);
  if (ops.length === 0) return;
  let op = pa.initCompositeList(0, ops.length, 1, 0);
  ops.forEach((f, i) => {
    if (i > 0) op = op.nextElement();
    if (f < 0) return;
    op.setU16(0, 1);
    op.setU16(2, f);
  });
}

function targetImport(t: StructBuilder, id: number): void {
  t.setU16(4, 0);
  t.setU32(0, id);
}

interface CallOpts {
  q: number;
  method: number;
  target: (t: StructBuilder) => void;
  params?: (p: StructBuilder) => void;
  dwords?: number;
  pwords?: number;
  noPromisePipelining?: boolean;
  onlyPromisePipeline?: boolean;
}

function call(o: CallOpts): Uint8Array {
  return frame(Message.call, (m) => {
    const c = m.initStruct(0, 3, 3);
    c.setU32(0, o.q >>> 0);
    c.setU64(8, ECHO);
    c.setU16(4, o.method);
    if (o.noPromisePipelining) c.setBool(129, true);
    if (o.onlyPromisePipeline) c.setBool(130, true);
    o.target(c.initStruct(0, 1, 1));
    const payload = c.initStruct(1, 0, 2);
    const content = payload.initStruct(0, o.dwords ?? 1, o.pwords ?? 0);
    o.params?.(content);
  });
}

/** `Echo.hold` with a capability the driver hosts as export `id`; `kind` 2 makes it a promise. */
function hold(q: number, id: number, kind = 1): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, Message.call);
  const c = root.initStruct(0, 3, 3);
  c.setU32(0, q);
  c.setU64(8, ECHO);
  c.setU16(4, M.hold);
  targetAnswer(c.initStruct(0, 1, 1), 0);
  const payload = c.initStruct(1, 0, 2);
  payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 0));
  const table = payload.initCompositeList(1, 1, 1, 1);
  table.setU16(0, kind);
  table.setU32(4, id);
  return b.toFlat();
}

function resolveException(promiseId: number, reason: string): Uint8Array {
  return frame(Message.resolve, (m) => {
    const r = m.initStruct(0, 1, 1);
    r.setU32(0, promiseId);
    r.setU16(4, 1);
    r.initStruct(0, 1, 2).setText(0, reason);
  });
}

function finish(q: number, releaseResultCaps = true): Uint8Array {
  return frame(Message.finish, (m) => {
    const f = m.initStruct(0, 1, 0);
    f.setU32(0, q);
    f.setBool(32, releaseResultCaps, true);
    f.setBool(33, false, true);
  });
}

function disembargoLoopback(target: (t: StructBuilder) => void, id: number): Uint8Array {
  return frame(Message.disembargo, (m) => {
    const d = m.initStruct(0, 1, 1);
    target(d.initStruct(0, 1, 1));
    d.setU16(4, 0);
    d.setU32(0, id);
  });
}

function provide(q: number): Uint8Array {
  return frame(Message.provide, (m) => {
    const p = m.initStruct(0, 1, 2);
    p.setU32(0, q);
    targetImport(p.initStruct(0, 1, 1), 0);
    p.initStruct(1, 1, 1).setU64(0, 7n);
  });
}

function accept(q: number): Uint8Array {
  return frame(Message.accept, (m) => {
    const a = m.initStruct(0, 1, 1);
    a.setU32(0, q);
    a.initStruct(0, 1, 1).setU64(0, 7n);
  });
}

function join(q: number): Uint8Array {
  return frame(Message.join, (m) => {
    const j = m.initStruct(0, 1, 2);
    j.setU32(0, q);
    targetImport(j.initStruct(0, 1, 1), 0);
    const k = j.initStruct(1, 1, 0);
    k.setU32(0, 1);
    k.setU16(4, 1);
    k.setU16(6, 0);
  });
}

function disembargoProvide(q: number): Uint8Array {
  return frame(Message.disembargo, (m) => {
    const d = m.initStruct(0, 1, 1);
    targetImport(d.initStruct(0, 1, 1), 0);
    d.setU16(4, 3);
    d.setU32(0, q);
  });
}

function disembargoOther(target: (t: StructBuilder) => void, which: number): Uint8Array {
  return frame(Message.disembargo, (m) => {
    const d = m.initStruct(0, 1, 1);
    target(d.initStruct(0, 1, 1));
    d.setU16(4, which);
  });
}

function abortWith(reason: string | null, trace?: string): Uint8Array {
  return frame(Message.abort, (m) => {
    if (reason === null) return;
    const e = m.initStruct(0, 1, 2);
    e.setText(0, reason);
    if (trace !== undefined) e.setText(1, trace);
  });
}

/** Re-frame a one-segment frame as `nsegs` segments, the rest empty. */
function manySegments(single: Uint8Array, nsegs: number): Uint8Array {
  const view = new DataView(single.buffer, single.byteOffset, single.byteLength);
  const words = view.getUint32(4, true);
  const body = single.subarray(8, 8 + words * 8);
  let table = 4 + 4 * nsegs;
  if (table % 8 !== 0) table += 4;
  const out = new Uint8Array(table + body.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, nsegs - 1, true);
  ov.setUint32(4, words, true);
  out.set(body, table);
  return out;
}

/** A segment table claiming one segment of `words` words, with no body. */
function header(words: number): Uint8Array {
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0, true);
  v.setUint32(4, words, true);
  return out;
}

const W = (ms: number): Step => ({ wait: ms });

const SCENARIOS: Record<string, Step[]> = {
  // Gap 1: a broken capability in results is a promise that resolves to an exception.
  "broken-cap-result": [
    bootstrap(0),
    call({ q: 1, method: M.brokenCap, target: (t) => targetAnswer(t, 0) }),
  ],
  // Gap 1: an exported promise that resolves to a null capability.
  "promise-to-null": [
    bootstrap(0),
    call({ q: 1, method: M.promiseOfHeld, target: (t) => targetAnswer(t, 0) }),
    W(100),
    call({ q: 2, method: M.resolveHeld, target: (t) => targetAnswer(t, 0) }),
  ],
  // Gap 5: a Call with a null body decodes as a default Call.
  "null-call": [nullBody(Message.call)],
  "null-call-after-bootstrap": [bootstrap(5), W(100), nullBody(Message.call)],
  // Gap 5: a Bootstrap with a null body answers question 0.
  "null-bootstrap": [nullBody(Message.bootstrap)],
  // Gap 6: level 3 and 4 messages on a two-party connection.
  provide: [bootstrap(0), W(100), provide(1)],
  accept: [accept(1)],
  join: [bootstrap(0), W(100), join(1)],
  // Gap 7: callHeld tail-calls the capability the driver handed over.
  "tail-call": [
    bootstrap(0),
    hold(1, 5),
    W(100),
    call({ q: 2, method: M.callHeld, target: (t) => targetAnswer(t, 0), params: (p) => p.setU32(0, 3) }),
  ],
  "tail-call-no-pipelining": [
    bootstrap(0),
    hold(1, 5),
    W(100),
    call({
      q: 2,
      method: M.callHeld,
      target: (t) => targetAnswer(t, 0),
      params: (p) => p.setU32(0, 3),
      noPromisePipelining: true,
    }),
  ],
  // A tail call back to the caller takes the `yourself` path even when
  // the call only pipelines (rpc.c++ directTailCall).
  "tail-call-only-pipeline": [
    bootstrap(0),
    hold(1, 5),
    W(100),
    call({
      q: 0x80000002,
      method: M.callHeld,
      target: (t) => targetAnswer(t, 0),
      params: (p) => p.setU32(0, 3),
      onlyPromisePipeline: true,
    }),
  ],
  // A received exception goes back out with one "remote exception: " prefix.
  "forward-remote-exception": [
    bootstrap(0),
    hold(1, 5, 2),
    W(100),
    resolveException(5, "gone"),
    W(100),
    call({ q: 2, method: M.callHeld, target: (t) => targetAnswer(t, 0), params: (p) => p.setU32(0, 3) }),
  ],
  "disembargo-provide": [bootstrap(0), W(100), disembargoProvide(1)],
  "disembargo-accept": [bootstrap(0), W(100), disembargoOther((t) => targetAnswer(t, 0, [0, 2]), 2)],
  "disembargo-unknown": [bootstrap(0), W(100), disembargoOther((t) => targetAnswer(t, 0), 9)],
  // Gap 10: a 512-segment frame.
  "segments-512": [manySegments(bootstrap(0), 512)],
  "segments-1000": [manySegments(bootstrap(0), 1000)],
  // Gap 3: a frame larger than the traversal limit.
  "oversize-frame": [header(8 * 1024 * 1024 + 1)],
  // Gap 10: a segment count that overflows.
  "segment-overflow": [new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0])],
  // Gap 11: a capability-free return.
  "no-finish-needed": [
    bootstrap(0),
    call({ q: 1, method: M.ping, target: (t) => targetAnswer(t, 0), params: (p) => p.setU32(0, 41) }),
  ],
  // Gap 11 and 13: once a capability-free answer is gone, a loopback at it fails.
  "loopback-after-no-finish": [
    bootstrap(0),
    call({ q: 1, method: M.echoCap, target: (t) => targetAnswer(t, 0), pwords: 1 }),
    W(100),
    disembargoLoopback((t) => targetAnswer(t, 1, [0]), 3),
  ],
  // Gap 13 companion: senderLoopback aimed at a broken capability.
  "loopback-broken": [
    bootstrap(0),
    call({ q: 1, method: M.brokenCap, target: (t) => targetAnswer(t, 0) }),
    W(100),
    disembargoLoopback((t) => targetAnswer(t, 1, [0]), 3),
  ],
  // senderLoopback aimed at an exported null capability, and at the promise
  // export that resolved to it. The C++ peer shares one Echo between
  // connections, so each first holds a null capability pointer.
  "loopback-null-export": [
    bootstrap(0),
    call({ q: 1, method: M.hold, target: (t) => targetAnswer(t, 0), dwords: 0, pwords: 1 }),
    call({ q: 2, method: M.promiseOfHeld, target: (t) => targetAnswer(t, 0) }),
    W(100),
    call({ q: 3, method: M.resolveHeld, target: (t) => targetAnswer(t, 0) }),
    W(100),
    disembargoLoopback((t) => targetImport(t, 2), 3),
  ],
  "loopback-null-promise": [
    bootstrap(0),
    call({ q: 1, method: M.hold, target: (t) => targetAnswer(t, 0), dwords: 0, pwords: 1 }),
    call({ q: 2, method: M.promiseOfHeld, target: (t) => targetAnswer(t, 0) }),
    W(100),
    call({ q: 3, method: M.resolveHeld, target: (t) => targetAnswer(t, 0) }),
    W(100),
    disembargoLoopback((t) => targetImport(t, 1), 3),
  ],
  // Gap 13: senderLoopback aimed at the peer's own local bootstrap.
  "loopback-local": [bootstrap(0), W(100), disembargoLoopback((t) => targetImport(t, 0), 3)],
  // Gap 14: Abort with a null exception and with a trace.
  "abort-null": [abortWith(null)],
  "abort-trace": [abortWith("bye", "trace text")],
  // Gap 8: onlyPromisePipeline on a high question id gets no Return.
  "only-promise-pipeline": [
    bootstrap(0),
    call({
      q: 0x80000001,
      method: M.ping,
      target: (t) => targetAnswer(t, 0),
      params: (p) => p.setU32(0, 1),
      onlyPromisePipeline: true,
    }),
    W(100),
    call({ q: 2, method: M.ping, target: (t) => targetAnswer(t, 0), params: (p) => p.setU32(0, 2) }),
  ],
  // Run with FLOW_LIMIT: a `slow` call of 16 segment words, then a ping that
  // is read only when the limit is at least 16.
  "flow-limit": [
    bootstrap(0),
    W(100),
    call({ q: 1, method: M.slow, target: (t) => targetAnswer(t, 0) }),
    W(100),
    call({ q: 2, method: M.ping, target: (t) => targetAnswer(t, 0), params: (p) => p.setU32(0, 1) }),
  ],
  // A Bootstrap pipeline is a `SingleCapPipeline`: even a lone noop is invalid.
  "bootstrap-noop-transform": [
    bootstrap(0),
    call({ q: 1, method: M.ping, target: (t) => targetAnswer(t, 0, [-1]), params: (p) => p.setU32(0, 1) }),
  ],
  // Gap 15 and 16: a deprecated named bootstrap.
  "named-bootstrap": [
    frame(Message.bootstrap, (m) => {
      const b = m.initStruct(0, 1, 1);
      b.setU32(0, 0);
      b.setText(0, "echo");
    }),
  ],
};

const RETURN_NAMES = ["results", "exception", "canceled", "resultsSentElsewhere", "takeFromOtherQuestion", "acceptFromThirdParty"];
const CAP_NAMES = ["none", "senderHosted", "senderPromise", "receiverHosted", "receiverAnswer", "thirdPartyHosted"];
const MSG_NAMES = Object.fromEntries(Object.entries(Message).map(([k, v]) => [v, k])) as Record<number, string>;
const TYPES = ["failed", "overloaded", "disconnected", "unimplemented"];

/**
 * A `KJ_REQUIRE` that compared two pointers prints their addresses in a
 * prefix no other process can reproduce, so the prefix is dropped.
 */
function reason(r: string): string {
  return r.replace(/^expected [^;\[]*\[[0-9a-f]+ == [0-9a-f]+\]; /, "");
}

function exc(e: Ptr): string {
  if (e.kind !== PtrKind.Struct) return "exc(null)";
  const trace = Exception_getTrace(e);
  return `${TYPES[Exception_getType(e)] ?? "?"} ${JSON.stringify(reason(Exception_getReason(e)))}${trace ? ` trace=${JSON.stringify(trace)}` : ""}`;
}

function caps(payload: Ptr): string {
  if (payload.kind !== PtrKind.Struct) return "[]";
  const table = Payload_getCapTable(payload);
  if (table.kind !== PtrKind.List) return "[]";
  const out: string[] = [];
  for (let i = 0; i < table.listLen(); i++) {
    const d = table.listGetP(i);
    out.push(`${CAP_NAMES[CapDescriptor_which(d)]}:${d.getU32(4)}`);
  }
  return `[${out.join(",")}]`;
}

function describe(f: Uint8Array): string {
  const root = CapnpMessage.fromFlat(f, { traversalWords: 1 << 26 }).root();
  const which = Message_which(root);
  const body = root.getP(0);
  const name = MSG_NAMES[which] ?? `tag${which}`;
  switch (which) {
    case Message.return: {
      const w = Return_which(body);
      const flags = [body.getBool(32, true) ? "" : "keepParams", body.getBool(33) ? "noFinishNeeded" : ""].filter(Boolean);
      let rest = "";
      if (w === 0) {
        const p = body.getP(0);
        const content = p.kind === PtrKind.Struct ? Payload_getContent(p) : p;
        const n = content.kind === PtrKind.Struct ? ` u32=${content.getU32(0)}` : "";
        rest = ` caps=${caps(p)}${n}`;
      } else if (w === 1) rest = ` ${exc(body.getP(0))}`;
      else if (w === 4) rest = ` other=${body.getU32(8)}`;
      return `return a=${body.getU32(0)} ${RETURN_NAMES[w]}${rest}${flags.length ? ` {${flags.join(",")}}` : ""}`;
    }
    case Message.call: {
      const t = body.getP(0);
      const target = t.getU16(4) === 0 ? `import:${t.getU32(0)}` : `answer:${t.getP(0).getU32(0)}`;
      const to = ["caller", "yourself", "thirdParty"][body.getU16(6)];
      return `call q=${body.getU32(0)} method=${body.getU16(4)} target=${target} sendResultsTo=${to}`;
    }
    case Message.abort:
      return `abort ${exc(body)}`;
    case Message.unimplemented: {
      const inner = body.kind === PtrKind.Struct ? MSG_NAMES[Message_which(body)] : "null";
      return `unimplemented ${inner}`;
    }
    case Message.resolve: {
      const w = Resolve_which(body);
      if (w === 0) {
        const d = body.getP(0);
        return `resolve p=${body.getU32(0)} cap ${CAP_NAMES[CapDescriptor_which(d)]}:${d.getU32(4)}`;
      }
      return `resolve p=${body.getU32(0)} exception ${exc(body.getP(0))}`;
    }
    case Message.disembargo:
      return `disembargo ctx=${body.getU16(4)}:${body.getU32(0)}`;
    case Message.finish:
      return `finish q=${body.getU32(0)}`;
    case Message.release:
      return `release id=${body.getU32(0)} n=${body.getU32(4)}`;
    default:
      return name;
  }
}

/** Bytes the frame at the head of `buf` needs, or 0 when the table is incomplete. */
function need(buf: Uint8Array): number {
  if (buf.length < 4) return 0;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = v.getUint32(0, true) + 1;
  let table = 4 + 4 * n;
  if (table % 8 !== 0) table += 4;
  if (buf.length < table) return 0;
  let words = 0;
  for (let i = 0; i < n; i++) words += v.getUint32(4 + 4 * i, true);
  return table + words * 8;
}

async function run(port: number, steps: Step[]): Promise<string[]> {
  const lines: string[] = [];
  const sock = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  let buf = new Uint8Array(0);
  let last = Date.now();
  let closed = false;
  sock.on("data", (chunk: Buffer) => {
    last = Date.now();
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    for (;;) {
      const n = need(buf);
      if (n === 0 || buf.length < n) break;
      lines.push(describe(buf.slice(0, n)));
      buf = buf.slice(n);
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    closed = true;
  });
  for (const s of steps) {
    if (s instanceof Uint8Array) {
      if (!closed) sock.write(s);
    } else await new Promise((r) => setTimeout(r, s.wait));
  }
  const start = Date.now();
  while (!closed && Date.now() - last < 400 && Date.now() - start < 4000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // A quiet but open socket is reported as such.
  lines.push(closed ? "EOF" : "open");
  sock.destroy();
  return lines;
}

if (process.argv[2] === "--list") {
  console.log(Object.keys(SCENARIOS).join("\n"));
} else {
  const port = Number(process.argv[2]);
  const name = process.argv[3] ?? "";
  const steps = SCENARIOS[name];
  if (steps === undefined) {
    console.error(`unknown scenario ${name}`);
    process.exit(2);
  }
  for (const l of await run(port, steps)) console.log(l);
}
