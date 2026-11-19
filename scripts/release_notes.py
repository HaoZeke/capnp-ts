#!/usr/bin/env python3
"""Print the CHANGELOG.md section for one version, fail if it is missing."""
import argparse, re, sys

p = argparse.ArgumentParser()
p.add_argument("version")
p.add_argument("-o", "--output")
a = p.parse_args()
text = open("CHANGELOG.md", encoding="utf-8").read()
m = re.search(r"^## \[" + re.escape(a.version) + r"\] - .*?$", text, re.M)
if not m:
    sys.exit(f"CHANGELOG.md has no section for {a.version}")
rest = text[m.end():]
nxt = re.search(r"^## \[", rest, re.M)
body = rest[: nxt.start()] if nxt else rest
body = "\n".join(l for l in body.strip().splitlines() if not re.match(r"^\[[^\]]+\]: https?://", l)).strip() + "\n"
if a.output:
    open(a.output, "w", encoding="utf-8").write(body)
else:
    sys.stdout.write(body)
