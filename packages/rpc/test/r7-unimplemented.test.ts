/**
 * Unknown methods use capnp-C++ `UNIMPLEMENTED` text and type.
 */
import { describe, expect, test } from "bun:test";

import { toRpcError } from "../src/capability.ts";
import { EchoImpl } from "../../../interop/rpc_common.ts";
import { ECHO_INTERFACE_ID } from "../../../interop/interop.capnp.ts";

describe("unimplemented errors keep their type", () => {
  test("toRpcError keeps a named exception type", () => {
    const e = Object.assign(new Error("Method not implemented."), { type: "unimplemented" });
    const rpc = toRpcError(e);
    expect(rpc.type).toBe("unimplemented");
    expect(rpc.message).toBe("Method not implemented.");
  });

  test("Echo answers an unknown method as capnp-C++ does", () => {
    const echo = new EchoImpl();
    expect(() =>
      echo.dispatch(
        ECHO_INTERFACE_ID,
        77,
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    ).toThrow(
      `Method not implemented.; interfaceName = interop.capnp:Echo; typeId = ${ECHO_INTERFACE_ID}; methodId = 77`,
    );
  });
});
