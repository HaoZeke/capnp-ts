/**
 * @haozeke/capnp-rpc — Cap'n Proto RPC for the TypeScript runtime.
 *
 * Levels 1 and 4 over a two-party transport. Level 3 needs a network
 * layer that can name a third vat, which two-party cannot.
 */
export { MemoryTransportPair, type Transport } from "./transport.ts";
export { frameLength, StreamTransport } from "./socket.ts";
export { RpcStream, StreamError } from "./stream.ts";
export { RpcConnection, type RpcServer } from "./vat.ts";
