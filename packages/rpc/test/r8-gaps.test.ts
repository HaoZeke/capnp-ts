/**
 * Regressions found on the r7b tree: a closed transport must abort
 * `senderLoopback`, unclaimed fds must be closed, `adoptFd` must own
 * the first descriptor, a membrane must hide fds, and 253 is the limit.
 */
import { describe, expect, test } from "bun:test";
import { openSync, closeSync, readFileSync } from "node:fs";
import { MessageBuilder, type StructBuilder } from "@haozeke/capnp";

import { Client, RpcError, type RpcServer } from "../src/index.ts";
import { WindowFlowController } from "../src/flow.ts";
import { membrane, MembranePolicy } from "../src/membrane.ts";
import { ImportClient, type RemoteHost } from "../src/remote.ts";
import { Message, MESSAGE_DWORDS, MESSAGE_PWORDS } from "../src/rpc.capnp.ts";
import { MemoryTransportPair, type Transport } from "../src/transport.ts";
import { RpcConnection } from "../src/vat.ts";
import { IFACE, link } from "./support.ts";

describe("senderLoopback after the transport closes", () => {
  test("the echo aborts the connection and does not reject", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const local: RpcServer = { dispatch() {} };
      let resolveP!: (c: Client) => void;
      let held!: Client;
      const server: RpcServer = {
        dispatch(_i, m, params, _r, ctx) {
          if (m === 0) {
            held = new Client(ctx.getCap(params.getP(0)));
            return;
          }
          const promise = Client.fromPromise(new Promise<Client>((r) => (resolveP = r)));
          ctx.setResultCap(ctx.initResults(0, 1), 0, promise.hook);
        },
      };
      const { a, b, tb } = link(undefined, server);
      const boot = a.bootstrap();
      boot.call(IFACE, 0, (p, cb) => cb.setCap(p, 0, Client.local(local).hook), 0, 1);
      const reply = boot.call(IFACE, 1);
      for (let i = 0; i < 8; i++) {
        a.pump();
        b.pump();
        await new Promise((r) => setImmediate(r));
      }
      const results = await reply;
      const promise = new Client(results.getCap(results.content.getP(0)));
      (a as unknown as { startEmbargo(t: unknown): void }).startEmbargo({
        writeTarget(t: StructBuilder) {
          t.setU16(4, 0);
          t.setU32(0, 1);
        },
      });
      b.pump();
      expect(b.disconnected).toBeUndefined();
      resolveP(held);
      // The Resolve goes out in a microtask. The echo waits one more turn.
      await new Promise((r) => setImmediate(r));
      expect(b.disconnected).toBeUndefined();
      tb.close();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      expect(b.disconnected?.message).toContain("transport is closed");
      promise.release();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

function frame(which: number): Uint8Array {
  const b = new MessageBuilder();
  const root = b.initRoot(MESSAGE_DWORDS, MESSAGE_PWORDS);
  root.setU16(0, which);
  return b.toFlat();
}

describe("unclaimed received fds", () => {
  test("a message that names none of them is closed after dispatch", () => {
    const closed: number[] = [];
    const fd = 80;
    const inbox = [frame(Message.bootstrap)];
    const queued = [[fd]];
    let last: readonly number[] = [];
    let shut = false;
    const transport: Transport = {
      send() {},
      receive() {
        last = queued.shift() ?? [];
        return inbox.shift() ?? null;
      },
      receivedFds: () => last,
      ownsReceivedFds: () => true,
      get pending() {
        return inbox.length;
      },
      close() {
        shut = true;
      },
      get closed() {
        return shut;
      },
      closeFd(n: number) {
        closed.push(n);
      },
    };
    const vat = new RpcConnection(transport);
    expect(vat.pumpOnce()).toBe(true);
    expect(closed).toEqual([fd]);
  });

  test("an adopted fd stays open until the import is released", () => {
    const real = openSync("/dev/null", "r");
    const closed: number[] = [];
    const pair = new MemoryTransportPair();
    const server: RpcServer = {
      getFd: () => real,
      dispatch() {},
    };
    const a = new RpcConnection(pair.a, server);
    const inner = pair.b;
    const wrapped: Transport = {
      send(f, fds) {
        inner.send(f, fds);
      },
      receive: () => inner.receive(),
      receivedFds: () => inner.receivedFds?.() ?? [],
      ownsReceivedFds: () => true,
      get pending() {
        return inner.pending;
      },
      close: () => inner.close(),
      get closed() {
        return inner.closed;
      },
      closeFd(n: number) {
        closed.push(n);
      },
    };
    const b = new RpcConnection(wrapped);
    const cap = b.bootstrap();
    for (let i = 0; i < 4; i++) {
      a.pump();
      b.pump();
    }
    expect(cap.getFd()).toBe(real);
    expect(closed).toEqual([]);
    cap.release();
    expect(closed).toEqual([real]);
    try {
      closeSync(real);
    } catch {
      // release already closed it through the spy, or the spy only recorded it
    }
  });
});

describe("ImportClient.adoptFd", () => {
  test("the first fd is owned and a second one is closed", () => {
    const closed: number[] = [];
    const host: RemoteHost = {
      disconnected: undefined,
      streamWindow: 65536,
      createFlowController: () => new WindowFlowController(() => 65536),
      sendCallTo: () => {
        throw new Error("unused");
      },
      importDropped() {},
      promiseDropped() {},
      startEmbargo: () => {
        throw new Error("unused");
      },
      closeFd(fd: number) {
        closed.push(fd);
      },
    };
    const imp = new ImportClient(host, 1);
    imp.adoptFd(10);
    expect(imp.getFd()).toBe(10);
    imp.adoptFd(11);
    expect(imp.getFd()).toBe(10);
    expect(closed).toEqual([11]);
    imp.release();
    expect(closed).toEqual([11, 10]);
  });
});

class FdPolicy extends MembranePolicy {
  constructor(private readonly allow: boolean) {
    super();
  }
  inboundCall(): undefined {
    return undefined;
  }
  outboundCall(): undefined {
    return undefined;
  }
  override allowFdPassthrough(): boolean {
    return this.allow;
  }
}

describe("membrane fd passthrough", () => {
  test("getFd is hidden unless the policy opts in", () => {
    const server: RpcServer = {
      getFd: () => 9,
      dispatch() {},
    };
    const hidden = membrane(Client.local(server), new FdPolicy(false));
    expect(hidden.getFd()).toBeUndefined();
    const shown = membrane(Client.local(server), new FdPolicy(true));
    expect(shown.getFd()).toBe(9);
    hidden.release();
    shown.release();
  });
});

function fdClient(n: number): Client {
  return Client.local({
    getFd: () => n,
    dispatch() {},
  });
}

describe("attached fd limit", () => {
  test("253 descriptors are sent and a 254th is refused before encoding", () => {
    const pair = new MemoryTransportPair();
    const a = new RpcConnection(pair.a);
    const boot = a.bootstrap();
    boot.call(
      0n,
      0,
      (p, caps) => {
        for (let i = 0; i < 253; i++) caps.setCap(p, i, fdClient(1000 + i).hook);
      },
      0,
      253,
    );
    expect(pair.b.receive()).not.toBeNull();
    const call = pair.b.receive();
    expect(call).not.toBeNull();
    expect(pair.b.receivedFds?.()?.length).toBe(253);

    const pair2 = new MemoryTransportPair();
    const c = new RpcConnection(pair2.a);
    const boot2 = c.bootstrap();
    expect(() =>
      boot2.call(
        0n,
        0,
        (p, caps) => {
          for (let i = 0; i < 254; i++) caps.setCap(p, i, fdClient(2000 + i).hook);
        },
        0,
        254,
      ),
    ).toThrow(/too many attached file descriptors/);
    expect(pair2.b.pending).toBe(1);
    c.disconnect(new RpcError("done", "disconnected"));
    a.disconnect(new RpcError("done", "disconnected"));
  });
});

describe("portable core", () => {
  test("vat.ts and remote.ts do not import node:fs", () => {
    const vat = readFileSync(new URL("../src/vat.ts", import.meta.url), "utf8");
    const remote = readFileSync(new URL("../src/remote.ts", import.meta.url), "utf8");
    expect(vat.includes("node:fs")).toBe(false);
    expect(remote.includes("node:fs")).toBe(false);
    expect(readFileSync(new URL("../src/unix.ts", import.meta.url), "utf8").includes("node:fs")).toBe(
      true,
    );
  });
});
