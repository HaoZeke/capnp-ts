/**
 * Raw-frame server: answers one RPC client with hand-built frames and
 * prints one line per frame the client sends.
 *
 *   bun interop/raw_server.ts <port> <scenario>
 *
 * A call on the bootstrap capability is answered with the scenario's
 * results, and a call pipelined on those results with an exception. interop/run_raw_server.sh
 * dials it from the capnp-C++ client and the TypeScript client and
 * compares what each sent and saw.
 */
import { createServer } from "node:net";

import { Message as CapnpMessage, MessageBuilder, Orphan, type Ptr, type StructBuilder } from "@haozeke/capnp";

import {
  Message,
  Message_which,
  Payload_getCapTableAt,
} from "../packages/rpc/src/rpc.capnp.ts";
import { describe, need } from "./raw_frames.ts";

/** Fills the results Payload of the scenario's Return. */
type Results = (b: MessageBuilder, payload: StructBuilder) => void;

const RESULTS: Record<string, Results> = {
  // Results pointer 0 names cap table entry 0, a `none`.
  "return-none": (b, payload) => {
    payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 0));
    payload.initCompositeList(1, 1, 1, 1).setU16(0, 0);
  },
  // Results pointer 0 names an entry past the end of the cap table.
  "return-out-of-range": (b, payload) => {
    payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 1));
    payload.initCompositeList(1, 1, 1, 1).setU16(0, 0);
  },
  // Results pointer 0 is a struct where a capability is expected.
  "return-non-cap": (_b, payload) => {
    payload.initStruct(0, 0, 1).initStruct(0, 1, 0).setU32(0, 7);
  },
  "return-echo-param": () => {},
};

type Reply = (f: Uint8Array) => void;

/** Answers a call on the bootstrap capability. False leaves it to the default. */
const CALLS: Record<string, (body: Ptr, reply: Reply) => boolean> = {
  // `echoCap` names the param cap as `receiverHosted`, with
  // `releaseParamCaps` left at true.
  "return-echo-param": (body, reply) => {
    if (body.getU16(4) !== 8) return false;
    const id = Payload_getCapTableAt(body.getP(1), 0).getU32(4);
    reply(
      returnResults(body.getU32(0), (b, payload) => {
        payload.initStruct(0, 0, 1).adopt(0, Orphan.cap(b, 0));
        const entry = payload.initCompositeList(1, 1, 1, 1);
        entry.setU16(0, 3);
        entry.setU32(4, id);
      }),
    );
    return true;
  },
};

function frame(fill: (m: StructBuilder, b: MessageBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(1, 1);
  root.setU16(0, Message.return);
  fill(root, b);
  return b.toFlat();
}

function returnResults(q: number, results: Results): Uint8Array {
  return frame((m, b) => {
    const ret = m.initStruct(0, 2, 1);
    ret.setU32(0, q);
    results(b, ret.initStruct(0, 0, 2));
  });
}

function returnException(q: number, reason: string): Uint8Array {
  return frame((m) => {
    const ret = m.initStruct(0, 2, 1);
    ret.setU32(0, q);
    ret.setU16(6, 1);
    ret.initStruct(0, 1, 2).setText(0, reason);
  });
}

const bootstrapCap: Results = (b, payload) => {
  payload.adopt(0, Orphan.cap(b, 0));
  payload.initCompositeList(1, 1, 1, 1).setU16(0, 1);
};

const port = Number(process.argv[2]);
const name = process.argv[3] ?? "";
const results = RESULTS[name];
if (results === undefined) {
  console.error(`unknown scenario ${name}`);
  process.exit(2);
}

const started = Date.now();
const lines: string[] = [];
const bootstraps = new Set<number>();
const server = createServer((sock) => {
  sock.setNoDelay(true);
  let buf = new Uint8Array(0);
  sock.on("data", (chunk: Buffer) => {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    for (;;) {
      const n = need(buf);
      if (n === 0 || buf.length < n) break;
      const f = buf.slice(0, n);
      buf = buf.slice(n);
      lines.push(process.env.RAW_TIMES ? `${Date.now() - started}ms ${describe(f)}` : describe(f));
      const root = CapnpMessage.fromFlat(f).root();
      const body = root.getP(0);
      switch (Message_which(root)) {
        case Message.bootstrap:
          bootstraps.add(body.getU32(0));
          sock.write(returnResults(body.getU32(0), bootstrapCap));
          break;
        case Message.call: {
          const t = body.getP(0);
          const onBootstrap = t.getU16(4) === 0 ? t.getU32(0) === 0 : bootstraps.has(t.getP(0).getU32(0));
          if (onBootstrap && CALLS[name]?.(body, (r) => sock.write(r))) break;
          if (onBootstrap) sock.write(returnResults(body.getU32(0), results));
          else sock.write(returnException(body.getU32(0), "pipelined call reached the server"));
          break;
        }
      }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    for (const l of lines) console.log(l);
    server.close();
  });
});
server.listen(port, "127.0.0.1", () => console.error(`listening ${port}`));
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 15000).unref();
