/**
 * Named exports for the deprecated `Bootstrap.deprecatedObjectId`, as
 * capnp-C++ `EzRpcServer::exportCap` and its `restore`.
 */
import { decodeWireText, type Ptr, PtrKind } from "@haozeke/capnp";

import { Client, RpcError } from "./capability.ts";

/** Resolves a Bootstrap's object id; a null id asks for the main interface. */
export type Restorer = (objectId: Ptr) => Client;

export class ExportMap {
  private readonly exports = new Map<string, Client>();
  private readonly main?: Client;

  constructor(main?: Client) {
    this.main = main?.dup();
  }

  exportCap(name: string, cap: Client): void {
    this.exports.set(name, cap.dup());
  }

  readonly restore: Restorer = (objectId) => {
    if (objectId.kind === PtrKind.Null) {
      if (this.main === undefined) {
        throw new RpcError("This vat does not expose any public/bootstrap interfaces.");
      }
      return this.main;
    }
    const name = decodeWireText(objectId);
    const cap = this.exports.get(name);
    if (cap === undefined) throw new RpcError(`Server exports no such capability.; name = ${name}`);
    return cap;
  };
}
