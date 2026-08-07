#!/usr/bin/env python3
"""Bidirectional Cap'n interop helpers: pycapnp encode/decode for fixtures."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import capnp

ROOT = Path(__file__).resolve().parents[1]
AB_SCHEMA = ROOT / "schema" / "addressbook.capnp"
CALC_SCHEMA = ROOT / "schema" / "calculator.capnp"
OUT = ROOT / "packages" / "runtime" / "test" / "golden" / "pycapnp"


def load_ab():
    return capnp.load(str(AB_SCHEMA))


def load_calc():
    return capnp.load(str(CALC_SCHEMA))


def write_addressbook(path: Path) -> None:
    ab = load_ab()
    msg = ab.AddressBook.new_message()
    people = msg.init("people", 2)
    a = people[0]
    a.id = 123
    a.name = "Alice"
    a.email = "alice@example.com"
    phones = a.init("phones", 1)
    phones[0].number = "555-1212"
    phones[0].type = "mobile"
    a.employment.school = "MIT"
    b = people[1]
    b.id = 456
    b.name = "Bob"
    b.email = "bob@example.com"
    phones = b.init("phones", 2)
    phones[0].number = "555-4567"
    phones[0].type = "home"
    phones[1].number = "555-7654"
    phones[1].type = "work"
    b.employment.unemployed = None
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        msg.write(f)
    print(f"wrote {path} ({path.stat().st_size} B)")


def write_calculator_add(path: Path) -> None:
    c = load_calc()
    msg = c.EvaluateRequest.new_message()
    expr = msg.expression
    expr.init("call")
    call = expr.call
    call.op = "add"
    params = call.init("params", 2)
    params[0].literal = 2.0
    params[1].literal = 3.0
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        msg.write(f)
    print(f"wrote {path} ({path.stat().st_size} B)")


def write_calculator_mul_add(path: Path) -> None:
    c = load_calc()
    msg = c.EvaluateRequest.new_message()
    outer = msg.expression
    outer.init("call")
    outer.call.op = "multiply"
    params = outer.call.init("params", 2)
    params[0].init("call")
    params[0].call.op = "add"
    ip = params[0].call.init("params", 2)
    ip[0].literal = 2.0
    ip[1].literal = 3.0
    params[1].literal = 4.0
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        msg.write(f)
    print(f"wrote {path} ({path.stat().st_size} B)")


def write_calculator_value(path: Path) -> None:
    c = load_calc()
    msg = c.EvaluateResponse.new_message()
    msg.value = 5.0
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        msg.write(f)
    print(f"wrote {path} ({path.stat().st_size} B)")


def read_addressbook(path: Path) -> dict:
    ab = load_ab()
    with open(path, "rb") as f:
        msg = ab.AddressBook.read(f)
    people = []
    for p in msg.people:
        emp = p.employment.which()
        people.append(
            {
                "id": int(p.id),
                "name": p.name,
                "email": p.email,
                "employment": emp,
                "school": p.employment.school if emp == "school" else None,
                "phones": [
                    {"number": ph.number, "type": str(ph.type)} for ph in p.phones
                ],
            }
        )
    return {"people": people}


def read_evaluate_request(path: Path) -> dict:
    c = load_calc()
    with open(path, "rb") as f:
        msg = c.EvaluateRequest.read(f)

    def walk(expr):
        w = expr.which()
        if w == "literal":
            return {"literal": float(expr.literal)}
        if w == "parameter":
            return {"parameter": int(expr.parameter)}
        if w == "call":
            return {
                "call": {
                    "op": str(expr.call.op),
                    "params": [walk(p) for p in expr.call.params],
                }
            }
        return {"which": w}

    return {"expression": walk(msg.expression)}


def read_evaluate_response(path: Path) -> dict:
    c = load_calc()
    with open(path, "rb") as f:
        msg = c.EvaluateResponse.read(f)
    return {"value": float(msg.value)}


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write-all")
    w.add_argument("--out", type=Path, default=OUT)
    r = sub.add_parser("read-ab")
    r.add_argument("path", type=Path)
    rc = sub.add_parser("read-calc")
    rc.add_argument("path", type=Path)
    rr = sub.add_parser("read-resp")
    rr.add_argument("path", type=Path)
    args = ap.parse_args()
    if args.cmd == "write-all":
        out = args.out
        write_addressbook(out / "addressbook_pycapnp.bin")
        write_calculator_add(out / "calculator_add_2_3_pycapnp.bin")
        write_calculator_mul_add(out / "calculator_mul_add_pycapnp.bin")
        write_calculator_value(out / "calculator_value_5_pycapnp.bin")
        return 0
    if args.cmd == "read-ab":
        print(json.dumps(read_addressbook(args.path), indent=2))
        return 0
    if args.cmd == "read-calc":
        print(json.dumps(read_evaluate_request(args.path), indent=2))
        return 0
    if args.cmd == "read-resp":
        print(json.dumps(read_evaluate_response(args.path), indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
