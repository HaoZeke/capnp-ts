/**
 * Declarations the compiler must keep: const expressions `tsc` accepts,
 * interface superclasses, streaming methods, applied annotations, and
 * generic parameters inherited by groups and method structs.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

/** Include dir next to the `capnp` on PATH, the same place packed tests use. */
function capnpInclude(): string {
  const which = spawnSync("which", ["capnp"], { encoding: "utf8" });
  const bin = which.status === 0 ? which.stdout.trim() : "";
  return join(dirname(dirname(bin)), "include");
}

const SCHEMA = `
@0x8123456789abcdef;

annotation myTag(file, struct, field, interface, method, const, enum, enumerant) :Text;

$myTag("file-tag");

const negInf :Float64 = -inf;
const missing :Void = void;

struct Box(T) {
  inner :group {
    val @0 :T;
  }
}

struct Choice {
  union {
    num @0 :UInt32;
    label @1 :Text;
    ug :group {
      a @2 :Int32 = 11;
      b @3 :Text = "ug";
      nested :union {
        u0 @4 :Int32 = 5;
        u1 @5 :Int32;
      }
    }
  }
}

interface Base {
  ping @0 () -> ();
}

interface Child extends(Base) {
  pong @0 () -> ();
}

interface GrandChild extends(Child) {}

interface Extra {
  zap @0 () -> ();
}

interface Multi extends(Child, Extra) {}

interface Writer {
  write @0 (bytes :Data) -> stream;
}

interface GenericRepo(T) {
  transform @0 [U] (item :T) -> (out :U);
}

struct Tagged $myTag("hi") {
  name @0 :Text $myTag("n");
}

enum Hue $myTag("color") {
  red @0 $myTag("r");
  blue @1;
}
`;

describe.skipIf(!hasCapnp())("audit emit", () => {
  test("superclasses, streams, annotations, generics, and consts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-audit-emit-"));
    const schema = join(dir, "audit.capnp");
    writeFileSync(schema, SCHEMA);
    const include = capnpInclude();
    expect(existsSync(join(include, "capnp/schema.capnp"))).toBe(true);
    const cgr = spawnSync("capnp", ["compile", "-o-", "-I", include, "-I", dir, schema]);
    expect(cgr.status).toBe(0);
    const ast = await walkCgr(new Uint8Array(cgr.stdout as Uint8Array));
    const file = ast.requestedFiles[0]!;
    const src = emitModuleSource(ast, file.filename, file.id);

    expect(src).toContain("export const negInf = -Infinity;");
    expect(src).not.toContain("-Infinity as const");
    expect(src).toContain("export const missing = undefined;");
    expect(src).not.toContain("undefined as const");

    expect(src).toContain("export type Box_inner_Ptr<T extends CapnpAnyPointer = CapnpAnyPointer>");
    expect(src).toContain("GenericRepo_transform_Params_Ptr<T extends CapnpAnyPointer = CapnpAnyPointer, U extends CapnpAnyPointer = CapnpAnyPointer>");

    expect(src).toContain("export abstract class ChildServer extends BaseServer");
    expect(src).toContain("streaming: true");
    expect(src).toContain("ptr.clearPointer(");
    expect(src).toContain("ptr.setU32(");

    expect(src).toMatch(/TAGGED_APPLIED_ANNOTATIONS = \[\{ id: 0x[0-9a-f]+n, value: "hi" \}\]/);
    expect(src).toMatch(/HUE_RED_APPLIED_ANNOTATIONS = \[\{ id: 0x[0-9a-f]+n, value: "r" \}\]/);
    expect(src).toMatch(/FILE_APPLIED_ANNOTATIONS = \[\{ id: 0x[0-9a-f]+n, value: "file-tag" \}\]/);
    expect(src).toContain("export class GrandChildClient");
    expect(src).toContain("export class MultiClient");
    const grandStart = src.indexOf("export class GrandChildClient");
    const grandEnd = src.indexOf("export abstract class GrandChildServer");
    const grand = src.slice(grandStart, grandEnd);
    expect(grand).toContain("BASE_INTERFACE_ID");
    expect(grand).toContain("CHILD_INTERFACE_ID");
    const multiStart = src.indexOf("export abstract class MultiServer");
    const multiEnd = src.indexOf("export abstract class", multiStart + 10);
    const multi = src.slice(multiStart, multiEnd > multiStart ? multiEnd : src.length);
    expect(multi).toContain("BASE_INTERFACE_ID");
    expect(multi).toContain("EXTRA_INTERFACE_ID");
    expect(src).toContain("ptr.setU16(");

    const out = join(dir, "audit.ts");
    writeFileSync(out, src);
    const mod = await import(out);
    const { Message, MessageBuilder } = await import("@haozeke/capnp");
    const b = new MessageBuilder();
    const root = b.initRoot(mod.Choice_dataWordCount, mod.Choice_pointerCount);
    root.setU16(mod.Choice_ug_nested_discriminantOffset, 1);
    mod.Choice_initUg(root);
    const read = Message.fromFlat(b.toFlat()).root();
    expect(mod.Choice_ug_nested_which(read)).toBe(0);
  });
});
