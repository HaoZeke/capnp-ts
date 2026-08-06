# Security Policy

## Supported versions

Security fixes land on `main` first and ship through normal semantic-version
tags once releases exist.

| Version | Supported |
| ------- | --------- |
| 0.1.x-dev / `main` | yes (fixes land here first) |

## Reporting a vulnerability

Do **not** open a public GitHub issue for unfixed wire-parser crashes,
traversal-limit bypasses, or other security bugs.

1. Email the maintainer privately: **rgoswami@ieee.org**, **or**
2. Use GitHub **Security Advisories** / private vulnerability reporting if
   enabled for this repository.

Include: affected commit or tag, runtime (Node/Bun version), a minimal
reproducer when one is available, and impact assessment.

We aim to acknowledge reports promptly and coordinate disclosure once a fix
is tagged.

## Scope

**In scope:** decoding of Cap'n Proto messages (stream framing, pointer
graphs, packed and canonical codecs), and any future RPC package that this
repo ships.

**Out of scope (unless trivially fixed):** issues only in unreleased
experimental branches; misconfiguration of peer applications; third-party
schema plugins unrelated to `capnpc-ts`.

## Security boundary

This library parses Cap'n Proto messages. Treat every network or IPC buffer
as hostile. A crafted message can attempt large allocations, deep pointer
graphs, or (once RPC exists) method invocations exposed by the application.

Defensive defaults match Cap'n C++ readers, not a trust-the-peer model:

- Traversal limit: 8 Mi words (`DEFAULT_TRAVERSAL_WORDS`)
- Nesting depth limit: 64 (`DEFAULT_DEPTH_LIMIT`)
- Segment count cap (`MAX_SEGMENTS`)
- Bounds, kind, depth, framing, and pack failures surface as `CapnpError`

Do not raise limits without a concrete need. Zero-copy views
(`Message.viewFlat`) require the caller buffer to outlive the message view.
Do not feed untrusted Cap'n streams into production without keeping those
limits in place.

Generated code from `capnpc-ts` (when shipped) will rely on the same runtime
checks; untrusted input is still untrusted after codegen.
