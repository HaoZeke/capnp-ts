/**
 * Standalone Cap'n admit (prepare) harness for pure ESM hosts (Bun / Node ≥ 18).
 *
 * Demonstrates how an OMP/Pi extension would call @haozeke/capnp without a
 * native addon. This file is intentionally not a full OMP extension: it has
 * no dependency on @oh-my-pi. When wiring into OMP, wrap admitFromBytes with
 * ExtensionAPI roughly as:
 *
 *   // import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"; // host-only
 *   // import { Message } from "@haozeke/capnp";
 *   // export default function (pi: ExtensionAPI) {
 *   //   pi.registerTool({
 *   //     name: "capnp_admit",
 *   //     async execute(_id, params: { path: string }) {
 *   //       const { readFile } = await import("node:fs/promises");
 *   //       const bytes = new Uint8Array(await readFile(params.path));
 *   //       const view = admitFromBytes(bytes);
 *   //       return { content: [{ type: "text", text: formatAdmitReport(view) }] };
 *   //     },
 *   //   });
 *   // }
 *
 * Decode path: Message.fromFlat → gen/addressbook.ts getters (capnpc-ts emit).
 * Default fixture: packages/runtime/test/golden/addressbook.bin (Alice / Bob).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElemSize,
  Message,
  MessageBuilder,
  PtrKind,
  type Ptr,
} from "@haozeke/capnp";
import {
  ADDRESS_BOOK_DWORDS,
  ADDRESS_BOOK_PWORDS,
  AddressBook_getPeople,
  AddressBook_getPeopleAt,
  AddressBook_getPeopleLen,
  PERSON_DWORDS,
  PERSON_PWORDS,
  PERSON_PHONE_NUMBER_DWORDS,
  PERSON_PHONE_NUMBER_PWORDS,
  Person_PhoneNumber_Type,
  Person_PhoneNumber_getNumber,
  Person_PhoneNumber_getType,
  Person_employment,
  Person_employment_getEmployer,
  Person_employment_getSchool,
  Person_employment_which,
  Person_getEmail,
  Person_getId,
  Person_getName,
  Person_getPhonesAt,
  Person_getPhonesLen,
} from "./gen/addressbook.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DEFAULT_GOLDEN = join(
  REPO_ROOT,
  "packages/runtime/test/golden/addressbook.bin",
);

/** Re-export enum maps for OMP wrappers (schema tags without hand offsets). */
export const EmploymentWhich = Person_employment;
export const PhoneNumberType = Person_PhoneNumber_Type;

export type AdmittedPerson = {
  id: number;
  name: string;
  email: string;
  employment:
    | { which: "unemployed" }
    | { which: "employer"; employer: string }
    | { which: "school"; school: string }
    | { which: "selfEmployed" };
  phones: Array<{ number: string; type: number }>;
};

/** Zero-copy-ish view of an admitted stream-framed Cap'n message. */
export type AdmitView = {
  source: string;
  segmentCount: number;
  segmentWordCounts: number[];
  /** Live Message reader (fromFlat / viewFlat). */
  message: Message;
  /**
   * Schema-shaped AddressBook people when root looks like AddressBook
   * (people @0 is a composite list of Person-sized structs).
   */
  addressBook?: { people: AdmittedPerson[] };
  /** Root text when CAPNP_ADMIT_TINY built a single-Text root. */
  rootText?: string;
};

function employmentFromPtr(p: Ptr): AdmittedPerson["employment"] {
  const tag = Person_employment_which(p);
  if (tag === Person_employment.employer) {
    return { which: "employer", employer: Person_employment_getEmployer(p) };
  }
  if (tag === Person_employment.school) {
    return { which: "school", school: Person_employment_getSchool(p) };
  }
  if (tag === Person_employment.selfEmployed) {
    return { which: "selfEmployed" };
  }
  return { which: "unemployed" };
}

function decodePerson(p: Ptr): AdmittedPerson {
  const phones: AdmittedPerson["phones"] = [];
  const nPhones = Person_getPhonesLen(p);
  for (let i = 0; i < nPhones; i++) {
    const ph = Person_getPhonesAt(p, i);
    phones.push({
      number: Person_PhoneNumber_getNumber(ph),
      type: Person_PhoneNumber_getType(ph),
    });
  }
  return {
    id: Person_getId(p),
    name: Person_getName(p),
    email: Person_getEmail(p),
    employment: employmentFromPtr(p),
    phones,
  };
}

/**
 * Try AddressBook decode via Message root + generated AddressBook_* getters.
 * Returns undefined when the root is not that shape (e.g. tiny Text fixture).
 */
export function tryDecodeAddressBook(root: Ptr): AdmitView["addressBook"] {
  if (root.kind !== PtrKind.Struct) return undefined;
  const people = AddressBook_getPeople(root);
  // AddressBook.people is List(Person) — composite (not Text/byte list).
  if (
    people.kind !== PtrKind.List ||
    people.esize !== ElemSize.Composite ||
    AddressBook_getPeopleLen(root) === 0
  ) {
    return undefined;
  }
  const out: AdmittedPerson[] = [];
  const n = AddressBook_getPeopleLen(root);
  for (let i = 0; i < n; i++) {
    out.push(decodePerson(AddressBook_getPeopleAt(root, i)));
  }
  return { people: out };
}

/**
 * Build a tiny stream-framed message: root struct with one Text pointer.
 * Uses MessageBuilder (same public surface as encode in an OMP tool).
 */
export function buildTinyFramedText(text: string): Uint8Array {
  const b = new MessageBuilder({ firstWords: 16 });
  const root = b.initRoot(0, 1);
  root.setText(0, text);
  return b.toFlat();
}

/**
 * Build a minimal AddressBook (one person) via MessageBuilder — encode path
 * for dogfood when CAPNP_ADMIT_BUILD=1. Layout constants from gen/addressbook.ts.
 */
export function buildMiniAddressBook(): Uint8Array {
  const b = new MessageBuilder();
  const book = b.initRoot(ADDRESS_BOOK_DWORDS, ADDRESS_BOOK_PWORDS);
  const person = book.initList(0, 1, PERSON_DWORDS, PERSON_PWORDS);
  person.setU32(0, 1); // Person.id
  person.setU16(4, Person_employment.unemployed);
  person.setText(0, "Admit");
  person.setText(1, "admit@example.com");
  const phones = person.initList(
    2,
    1,
    PERSON_PHONE_NUMBER_DWORDS,
    PERSON_PHONE_NUMBER_PWORDS,
  );
  phones.setU16(0, PhoneNumberType.mobile);
  phones.setText(0, "555-0000");
  return b.toFlat();
}

/** Admit (prepare) a Cap'n stream-framed buffer via Message.fromFlat. */
export function admitFromBytes(
  buf: Uint8Array,
  source = "<buffer>",
): AdmitView {
  const message = Message.fromFlat(buf);
  const root = message.root();
  const addressBook = tryDecodeAddressBook(root);
  let rootText: string | undefined;
  if (!addressBook && root.kind === PtrKind.Struct && root.pwords >= 1) {
    try {
      const t = root.getText(0);
      if (t.length > 0) rootText = t;
    } catch {
      // not a Text root
    }
  }
  return {
    source,
    segmentCount: message.segmentCount,
    segmentWordCounts: message.segs.map((s) => s.words),
    message,
    addressBook,
    rootText,
  };
}

/** Zero-copy admit: buffer must outlive the returned view. */
export function admitViewFromBytes(
  buf: Uint8Array,
  source = "<buffer>",
): AdmitView {
  const message = Message.viewFlat(buf);
  const root = message.root();
  return {
    source,
    segmentCount: message.segmentCount,
    segmentWordCounts: message.segs.map((s) => s.words),
    message,
    addressBook: tryDecodeAddressBook(root),
  };
}

export function formatAdmitReport(view: AdmitView): string {
  const lines: string[] = [
    `admit source: ${view.source}`,
    `segments: ${view.segmentCount} (words: ${view.segmentWordCounts.join(", ")})`,
    `reader: Message.fromFlat (@haozeke/capnp) + gen/addressbook.ts`,
  ];
  if (view.addressBook) {
    lines.push(`addressBook.people (${view.addressBook.people.length}):`);
    for (const p of view.addressBook.people) {
      const emp =
        p.employment.which === "employer"
          ? `employer=${JSON.stringify(p.employment.employer)}`
          : p.employment.which === "school"
            ? `school=${JSON.stringify(p.employment.school)}`
            : p.employment.which;
      lines.push(
        `  person id=${p.id} name=${JSON.stringify(p.name)} email=${JSON.stringify(p.email)} employment=${emp}`,
      );
      for (const ph of p.phones) {
        lines.push(
          `    phone type=${ph.type} number=${JSON.stringify(ph.number)}`,
        );
      }
    }
  } else if (view.rootText !== undefined) {
    lines.push(`root text: ${JSON.stringify(view.rootText)}`);
  } else {
    lines.push("root: (no AddressBook / Text decode applied)");
  }
  lines.push(
    "note: pure ESM admit path; no native addon. Typed getters from capnpc-ts gen/addressbook.ts.",
  );
  return lines.join("\n");
}

function loadInput(): { buf: Uint8Array; source: string } {
  if (process.env.CAPNP_ADMIT_TINY === "1") {
    const buf = buildTinyFramedText("admit-ok");
    return { buf, source: "<tiny-framed admit-ok>" };
  }
  if (process.env.CAPNP_ADMIT_BUILD === "1") {
    const buf = buildMiniAddressBook();
    return { buf, source: "<MessageBuilder mini AddressBook>" };
  }
  const path = process.env.CAPNP_ADMIT_BIN ?? DEFAULT_GOLDEN;
  if (!existsSync(path)) {
    const buf = buildTinyFramedText("admit-ok");
    console.error(
      `admit-harness: golden not found at ${path}; using tiny framed message`,
    );
    return { buf, source: "<tiny-framed admit-ok>" };
  }
  const buf = new Uint8Array(readFileSync(path));
  return { buf, source: path };
}

function main(): void {
  const { buf, source } = loadInput();
  const view = admitFromBytes(buf, source);
  console.log(formatAdmitReport(view));
}

// Run when executed as a script (Bun / node --experimental-strip-types).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main();
}

// Layout / enum maps for OMP wrappers (from generated schema module).
export {
  PERSON_DWORDS,
  PERSON_PWORDS,
  ADDRESS_BOOK_DWORDS,
  ADDRESS_BOOK_PWORDS,
  Person_employment,
  Person_PhoneNumber_Type,
};
