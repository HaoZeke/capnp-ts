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
 * Decode path: Message.fromFlat → root/list/struct accessors (no hand frame scan).
 * AddressBook layout matches schema/addressbook.capnp (hand constants until
 * capnpc-ts emit lands); Alice/Bob golden is the default fixture.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DEFAULT_GOLDEN = join(
  REPO_ROOT,
  "packages/runtime/test/golden/addressbook.bin",
);

/** Person layout (addressbook.capnp): 1 data word, 4 pointers. */
const PERSON_DWORDS = 1;
const PERSON_PWORDS = 4;
const PERSON_ID_OFF = 0;
const PERSON_NAME_PTR = 0;
const PERSON_EMAIL_PTR = 1;
const PERSON_PHONES_PTR = 2;
const PERSON_EMPLOYMENT_TAG_OFF = 4;
const PERSON_EMPLOYMENT_PTR = 3;

const EMP_UNEMPLOYED = 0;
const EMP_EMPLOYER = 1;
const EMP_SCHOOL = 2;
const EMP_SELF_EMPLOYED = 3;

const PHONE_DWORDS = 1;
const PHONE_PWORDS = 1;
const PHONE_TYPE_OFF = 0;
const PHONE_NUMBER_PTR = 0;

/** AddressBook: people @0 :List(Person). */
const ADDRESS_BOOK_PEOPLE_PTR = 0;

const EmploymentWhich = {
  unemployed: EMP_UNEMPLOYED,
  employer: EMP_EMPLOYER,
  school: EMP_SCHOOL,
  selfEmployed: EMP_SELF_EMPLOYED,
} as const;

const PhoneNumberType = {
  mobile: 0,
  home: 1,
  work: 2,
} as const;

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

function employmentLabel(tag: number): AdmittedPerson["employment"]["which"] {
  switch (tag) {
    case EMP_EMPLOYER:
      return "employer";
    case EMP_SCHOOL:
      return "school";
    case EMP_SELF_EMPLOYED:
      return "selfEmployed";
    default:
      return "unemployed";
  }
}

function decodePerson(p: Ptr): AdmittedPerson {
  const tag = p.getU16(PERSON_EMPLOYMENT_TAG_OFF);
  const which = employmentLabel(tag);
  let employment: AdmittedPerson["employment"];
  if (which === "employer") {
    employment = { which, employer: p.getText(PERSON_EMPLOYMENT_PTR) };
  } else if (which === "school") {
    employment = { which, school: p.getText(PERSON_EMPLOYMENT_PTR) };
  } else if (which === "selfEmployed") {
    employment = { which };
  } else {
    employment = { which: "unemployed" };
  }

  const phonesPtr = p.getP(PERSON_PHONES_PTR);
  const phones: AdmittedPerson["phones"] = [];
  if (phonesPtr.kind === PtrKind.List) {
    for (let i = 0; i < phonesPtr.listLen(); i++) {
      const ph = phonesPtr.listGetP(i);
      phones.push({
        number: ph.getText(PHONE_NUMBER_PTR),
        type: ph.getU16(PHONE_TYPE_OFF),
      });
    }
  }

  return {
    id: p.getU32(PERSON_ID_OFF),
    name: p.getText(PERSON_NAME_PTR),
    email: p.getText(PERSON_EMAIL_PTR),
    employment,
    phones,
  };
}

/**
 * Try AddressBook decode: root.people is composite List(Person).
 * Returns undefined when the root is not that shape (e.g. tiny Text fixture).
 */
export function tryDecodeAddressBook(root: Ptr): AdmitView["addressBook"] {
  if (root.kind !== PtrKind.Struct) return undefined;
  const people = root.getP(ADDRESS_BOOK_PEOPLE_PTR);
  // AddressBook.people is List(Person) — composite (not Text/byte list).
  if (
    people.kind !== PtrKind.List ||
    people.esize !== ElemSize.Composite ||
    people.listLen() === 0
  ) {
    return undefined;
  }
  const out: AdmittedPerson[] = [];
  for (let i = 0; i < people.listLen(); i++) {
    out.push(decodePerson(people.listGetP(i)));
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
 * for dogfood when CAPNP_ADMIT_BUILD=1.
 */
export function buildMiniAddressBook(): Uint8Array {
  const b = new MessageBuilder();
  const book = b.initRoot(0, 1);
  const people0 = book.initList(0, 1, PERSON_DWORDS, PERSON_PWORDS);
  people0.setU32(PERSON_ID_OFF, 1);
  people0.setU16(PERSON_EMPLOYMENT_TAG_OFF, EMP_UNEMPLOYED);
  people0.setText(PERSON_NAME_PTR, "Admit");
  people0.setText(PERSON_EMAIL_PTR, "admit@example.com");
  const phones = people0.initList(PERSON_PHONES_PTR, 1, PHONE_DWORDS, PHONE_PWORDS);
  phones.setU16(PHONE_TYPE_OFF, PhoneNumberType.mobile);
  phones.setText(PHONE_NUMBER_PTR, "555-0000");
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
    `reader: Message.fromFlat (@haozeke/capnp)`,
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
    "note: pure ESM admit path; no native addon. Layout constants match addressbook.capnp until capnpc-ts emit.",
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

// Re-export layout maps for OMP wrappers that want schema tags without codegen.
export {
  EmploymentWhich,
  PhoneNumberType,
  PERSON_DWORDS,
  PERSON_PWORDS,
  ADDRESS_BOOK_PEOPLE_PTR,
};
