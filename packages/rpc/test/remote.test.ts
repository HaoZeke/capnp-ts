import { expect, test } from "bun:test";

import { Client, Settle, type ClientHook } from "../src/capability.ts";
import { PromiseClient, type RemoteHost, type RpcClientHook } from "../src/remote.ts";

test("disposing an unresolved PromiseClient settles whenMoreResolved", async () => {
  const initial = Client.local({ dispatch() {} }).hook as unknown as RpcClientHook;
  const eventual = new Settle<ClientHook>();
  const client = new PromiseClient({} as RemoteHost, initial, eventual, undefined);
  const more = client.whenMoreResolved();

  client.release();

  const outcome = await Promise.race([
    more.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
  expect(outcome).toBe("rejected");
});
