/**
 * Interim hand-rolled AddressBook helpers (schema/addressbook.capnp).
 * Layout from `capnp compile -ocapnp` (Person: 1 data word, 4 ptrs).
 *
 * Replace with output of `@haozeke/capnpc-ts` once full emit lands.
 * Schema id: @0x9eb32e19f86ee174
 */

/** Person: id @0 :UInt32; name/email/phones + employment union. */
export const PERSON_DWORDS = 1;
export const PERSON_PWORDS = 4;
/** Data byte offset of `id` (UInt32). */
export const PERSON_ID_OFF = 0;
/** Pointer slots. */
export const PERSON_NAME_PTR = 0;
export const PERSON_EMAIL_PTR = 1;
export const PERSON_PHONES_PTR = 2;
/** employment union tag: u16 at data byte 4 (second half of data word 0). */
export const PERSON_EMPLOYMENT_TAG_OFF = 4;
export const PERSON_EMPLOYMENT_UNEMPLOYED = 0;
export const PERSON_EMPLOYMENT_EMPLOYER = 1;
export const PERSON_EMPLOYMENT_SCHOOL = 2;
export const PERSON_EMPLOYMENT_SELF_EMPLOYED = 3;
/** employer/school text shares pointer slot 3 when that union arm is active. */
export const PERSON_EMPLOYMENT_PTR = 3;

/** Person.PhoneNumber: number @0 :Text; type @1 :Type. */
export const PHONE_NUMBER_DWORDS = 1;
export const PHONE_NUMBER_PWORDS = 1;
export const PHONE_NUMBER_TYPE_OFF = 0; // UInt16 enum
export const PHONE_NUMBER_NUMBER_PTR = 0;

/** Person.PhoneNumber.Type - const map (Bun strip-safe; no TS enum). */
export const PhoneNumberType = {
  mobile: 0,
  home: 1,
  work: 2,
} as const;
export type PhoneNumberType =
  (typeof PhoneNumberType)[keyof typeof PhoneNumberType];

/** AddressBook: people @0 :List(Person). */
export const ADDRESS_BOOK_DWORDS = 0;
export const ADDRESS_BOOK_PWORDS = 1;
export const ADDRESS_BOOK_PEOPLE_PTR = 0;

/**
 * Placeholder root handle. Full getters/setters need Message/Struct from
 * `@haozeke/capnp` (wire reader milestone). Call sites should treat this as
 * documentation of layout until then.
 */
export type AddressBookHandle = { readonly __brand: "AddressBook" };
export type PersonHandle = { readonly __brand: "Person" };
export type PhoneNumberHandle = { readonly __brand: "PhoneNumber" };

// TODO: personIdGet / personNameGet / addressBookPeopleGet, etc.
