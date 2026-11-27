#!/usr/bin/env bash
# Point every site scripts/check-release-version.sh reads at one version.
# workspace:* dependencies are left unchanged. npm is not called.
# If a write does not match what was planned, the previous bytes are restored.
# Usage: bump-version.sh [--dry-run] <version>
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 [--dry-run] <version>" >&2
  exit 2
fi

dry=0
version=""
for arg in "$@"; do
  case "${arg}" in
    --dry-run) dry=1 ;;
    --) ;;
    -*)
      echo "bump-version: unknown option ${arg}" >&2
      exit 2
      ;;
    *)
      if [[ -n "${version}" ]]; then
        echo "bump-version: unexpected argument ${arg}" >&2
        exit 2
      fi
      version="${arg}"
      ;;
  esac
done

if [[ -z "${version}" ]]; then
  echo "bump-version: missing version" >&2
  exit 2
fi

source_path="${BASH_SOURCE[0]}"
while [[ -L "${source_path}" ]]; do
  link_dir="$(CDPATH='' cd -- "$(dirname -- "${source_path}")" && pwd -P)"
  source_path="$(readlink -- "${source_path}")"
  if [[ "${source_path}" != /* ]]; then
    source_path="${link_dir}/${source_path}"
  fi
done
script_dir="$(CDPATH='' cd -- "$(dirname -- "${source_path}")" && pwd -P)"
root="$(CDPATH='' cd -- "${script_dir}/.." && pwd -P)"

export BUMP_ROOT="${root}"
export BUMP_VERSION="${version}"
export BUMP_DRY="${dry}"

python3 - <<'PY'
import json, os, re, sys
from pathlib import Path

root = Path(os.environ["BUMP_ROOT"])
new = os.environ["BUMP_VERSION"]
dry = os.environ["BUMP_DRY"] == "1"

if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.]+)?", new) is None:
    sys.exit("bump-version: version must be semver")

version_files = [
    "package.json",
    "packages/runtime/package.json",
    "packages/codegen/package.json",
    "packages/rpc/package.json",
    "examples/pi-admit-harness/package.json",
]
dep_files = [
    "packages/codegen/package.json",
    "packages/rpc/package.json",
]
lock_file = "bun.lock"
workspace_dep = '"@haozeke/capnp": "workspace:*"'

def fail(msg):
    sys.exit(f"bump-version: {msg}")

def read_text(rel):
    path = root / rel
    if not path.is_file():
        fail(f"missing {rel}")
    return path.read_text(encoding="utf-8")

def replace_exact(text, old, new_text, expect, label):
    count = text.count(old)
    if count != expect:
        fail(f"{label}: found {count} of {old}, expected {expect}")
    return text.replace(old, new_text)

runtime = json.loads(read_text("packages/runtime/package.json"))
old = runtime.get("version")
if not isinstance(old, str) or old == "":
    fail("packages/runtime/package.json has no version")

planned = {}

for rel in version_files:
    text = read_text(rel)
    token = f'"version": "{old}"'
    planned[rel] = replace_exact(text, token, f'"version": "{new}"', 1, rel)

for rel in dep_files:
    token = f'"@haozeke/capnp": "^{old}"'
    planned[rel] = replace_exact(
        planned[rel], token, f'"@haozeke/capnp": "^{new}"', 1, f"{rel} dependency"
    )

lock = read_text(lock_file)
if lock.count(workspace_dep) < 1:
    fail(f"{lock_file} has no workspace:* dependency on @haozeke/capnp")
lock = replace_exact(
    lock, f'"version": "{old}"', f'"version": "{new}"', 4, f"{lock_file} version"
)
lock = replace_exact(
    lock,
    f'"@haozeke/capnp": "^{old}"',
    f'"@haozeke/capnp": "^{new}"',
    2,
    f"{lock_file} dependency",
)
if lock.count(workspace_dep) < 1:
    fail(f"{lock_file} lost workspace:*")
planned[lock_file] = lock

example = "examples/pi-admit-harness/package.json"
if planned[example].count(workspace_dep) < 1:
    fail(f"{example} lost workspace:*")

def replace_line(text, pattern, repl, label):
    updated, count = pattern.subn(repl, text)
    if count != 1:
        fail(f"{label}: found {count} matches, expected 1")
    return updated

pixi = "pixi.toml"
planned[pixi] = replace_line(
    read_text(pixi),
    re.compile(r'^version = "' + re.escape(old) + r'"$', re.M),
    f'version = "{new}"',
    pixi,
)

conf = "docs/source/conf.py"
planned[conf] = replace_line(
    read_text(conf),
    re.compile(r'^release = "' + re.escape(old) + r'"$', re.M),
    f'release = "{new}"',
    conf,
)

cli = "packages/runtime/src/cli.ts"
cli_old = "capnp-ts " + old + "\\n"
cli_new = "capnp-ts " + new + "\\n"
planned[cli] = replace_exact(read_text(cli), cli_old, cli_new, 1, cli)

readme = "README.md"
readme_text = read_text(readme)
tarball = re.compile(
    r"haozeke-(?:capnpc-ts|capnp-rpc|capnp)-" + re.escape(old) + r"\.tgz"
)
if not tarball.search(readme_text):
    fail(f"{readme}: no haozeke tarball name at {old}")

def tarball_repl(match):
    return match.group(0).replace(old, new, 1)

planned[readme] = tarball.sub(tarball_repl, readme_text)

def check_package(rel, text):
    data = json.loads(text)
    if data.get("version") != new:
        fail(f"{rel}: version would be {data.get('version')}")
    dep = data.get("dependencies", {}).get("@haozeke/capnp")
    if rel in dep_files and dep != f"^{new}":
        fail(f"{rel}: @haozeke/capnp would be {dep}")
    if rel == example and dep != "workspace:*":
        fail(f"{rel}: @haozeke/capnp would be {dep}")

for rel in version_files:
    check_package(rel, planned[rel])

if dry or new == old:
    action = "dry-run" if dry else "already"
    print(f"bump-version: {action} {old} -> {new}")
    raise SystemExit(0)

backups = {rel: (root / rel).read_bytes() for rel in planned}

def restore():
    for rel, blob in backups.items():
        (root / rel).write_bytes(blob)

try:
    for rel, text in planned.items():
        (root / rel).write_text(text, encoding="utf-8", newline="\n")
    for rel, text in planned.items():
        got = (root / rel).read_text(encoding="utf-8")
        if got != text:
            fail(f"{rel}: write did not land")
    for rel in version_files:
        check_package(rel, (root / rel).read_text(encoding="utf-8"))
except SystemExit:
    restore()
    raise
except Exception as exc:
    restore()
    fail(str(exc))

print(f"bump-version: {old} -> {new}")
PY
