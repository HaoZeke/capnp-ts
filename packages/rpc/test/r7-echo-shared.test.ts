/**
 * The server keeps one Echo, as `EzRpcServer` keeps its main capability.
 */
import { describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { attach, EchoImpl } from "../../../interop/rpc_common.ts";
import { ECHO_INTERFACE_ID, Echo_methods } from "../../../interop/interop.capnp.ts";
import { listenEcho } from "../../../interop/rpc_server.ts";

describe("one Echo serves every connection", () => {
  test("a later connection sees a cancel counted by an earlier one", async () => {
    const server = listenEcho(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const open = async () => {
      const sock = connect(port, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", () => resolve());
        sock.once("error", reject);
      });
      const conn = attach(sock, new EchoImpl());
      return { sock, echo: conn.bootstrap() };
    };

    const first = await open();
    const pending = first.echo.call(ECHO_INTERFACE_ID, Echo_methods.slow.ordinal, undefined, 0, 0);
    await first.echo.call(ECHO_INTERFACE_ID, Echo_methods.ping.ordinal, (p) => p.setU32(0, 0), 1, 0);
    pending.release();
    let seen = 0;
    for (let i = 0; i < 50 && seen === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const stats = await first.echo.call(
        ECHO_INTERFACE_ID,
        Echo_methods.stats.ordinal,
        undefined,
        0,
        0,
      );
      seen = stats.content.getU32(0);
    }
    expect(seen).toBe(1);
    first.sock.destroy();

    const second = await open();
    const again = await second.echo.call(
      ECHO_INTERFACE_ID,
      Echo_methods.stats.ordinal,
      undefined,
      0,
      0,
    );
    expect(again.content.getU32(0)).toBe(1);
    second.sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
