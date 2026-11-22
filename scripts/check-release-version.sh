#!/usr/bin/env bash
# Verify that every package, workspace, lockfile, docs, README, and CLI version
# agrees and matches any release tag.
# Accepts both annotated tags and lightweight tags fetched by actions/checkout.
# Usage: check-release-version.sh [tag]
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [tag]" >&2
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

if command -v bun >/dev/null 2>&1; then
  js_runner=(bun -e)
elif command -v node >/dev/null 2>&1; then
  js_runner=(node -e)
else
  echo "check-release-version: need bun or node on PATH" >&2
  exit 1
fi

read_json_field() {
  local file="$1"
  shift
  "${js_runner[@]}" '
    const fs = require("node:fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const cleaned = raw.replace(/,(\s*[}\]])/g, (_, tail) => tail);
    const data = JSON.parse(cleaned);
    let cur = data;
    for (const key of process.argv.slice(2)) {
      if (cur == null || typeof cur !== "object") process.exit(2);
      cur = cur[key];
    }
    if (typeof cur !== "string") process.exit(2);
    process.stdout.write(cur);
  ' "${file}" "$@"
}

errors=0
fail() {
  echo "check-release-version: $*" >&2
  errors=$((errors + 1))
}

expected="$(read_json_field "${root}/packages/runtime/package.json" version)" || {
  echo "check-release-version: missing version in packages/runtime/package.json" >&2
  exit 1
}

check_json_version() {
  local rel="$1"
  local actual=""
  if ! actual="$(read_json_field "${root}/${rel}" version)"; then
    fail "${rel}: missing string version"
    return
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    fail "${rel}: version '${actual}' disagrees with packages/runtime/package.json ('${expected}')"
  fi
}

check_runtime_dep() {
  local rel="$1"
  local actual=""
  if ! actual="$(read_json_field "${root}/${rel}" dependencies "@haozeke/capnp")"; then
    fail "${rel}: missing dependencies[\"@haozeke/capnp\"]"
    return
  fi
  if [[ "${actual}" != "^${expected}" && "${actual}" != "${expected}" ]]; then
    fail "${rel}: @haozeke/capnp dependency '${actual}' disagrees with '${expected}'"
  fi
}

check_lock_workspace() {
  local ws="$1"
  local actual=""
  if ! actual="$(read_json_field "${root}/bun.lock" workspaces "${ws}" version)"; then
    fail "bun.lock: workspaces['${ws}'] missing string version"
    return
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    fail "bun.lock: workspaces['${ws}'].version '${actual}' disagrees with '${expected}'"
  fi
}

check_lock_runtime_dep() {
  local ws="$1"
  local actual=""
  if ! actual="$(read_json_field "${root}/bun.lock" workspaces "${ws}" dependencies "@haozeke/capnp")"; then
    fail "bun.lock: workspaces['${ws}'] missing dependencies['@haozeke/capnp']"
    return
  fi
  if [[ "${actual}" != "^${expected}" && "${actual}" != "${expected}" ]]; then
    fail "bun.lock: workspaces['${ws}'] @haozeke/capnp dependency '${actual}' disagrees with '${expected}'"
  fi
}

check_json_version "package.json"
check_json_version "packages/codegen/package.json"
check_json_version "packages/rpc/package.json"
check_json_version "examples/pi-admit-harness/package.json"

check_runtime_dep "packages/codegen/package.json"
check_runtime_dep "packages/rpc/package.json"

check_lock_workspace "packages/runtime"
check_lock_workspace "packages/codegen"
check_lock_workspace "packages/rpc"
check_lock_workspace "examples/pi-admit-harness"

check_lock_runtime_dep "packages/codegen"
check_lock_runtime_dep "packages/rpc"

pixi_ver="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "${root}/pixi.toml" | head -n 1)"
if [[ -z "${pixi_ver}" ]]; then
  fail "pixi.toml: missing version"
elif [[ "${pixi_ver}" != "${expected}" ]]; then
  fail "pixi.toml: version '${pixi_ver}' disagrees with '${expected}'"
fi

conf_ver="$(sed -n 's/^release = "\([^"]*\)"$/\1/p' "${root}/docs/source/conf.py" | head -n 1)"
if [[ -z "${conf_ver}" ]]; then
  fail "docs/source/conf.py: missing release"
elif [[ "${conf_ver}" != "${expected}" ]]; then
  fail "docs/source/conf.py: release '${conf_ver}' disagrees with '${expected}'"
fi

cli_ver="$(sed -n 's/.*capnp-ts \([^"\\]*\)\\n.*/\1/p' "${root}/packages/runtime/src/cli.ts" | head -n 1)"
if [[ -z "${cli_ver}" ]]; then
  fail "packages/runtime/src/cli.ts: missing capnp-ts version string"
elif [[ "${cli_ver}" != "${expected}" ]]; then
  fail "packages/runtime/src/cli.ts: version '${cli_ver}' disagrees with '${expected}'"
fi

readme_tarballs="$(grep -oE 'haozeke-(capnp|capnpc-ts|capnp-rpc)-[^[:space:]`'\''"/]+\.tgz' "${root}/README.md" || true)"
if [[ -z "${readme_tarballs}" ]]; then
  fail "README.md: missing haozeke-capnp-<version>.tgz reference"
else
  while IFS= read -r tgz; do
    tgz_ver="${tgz#haozeke-capnpc-ts-}"
    tgz_ver="${tgz_ver#haozeke-capnp-rpc-}"
    tgz_ver="${tgz_ver#haozeke-capnp-}"
    tgz_ver="${tgz_ver%.tgz}"
    if [[ "${tgz_ver}" != "${expected}" ]]; then
      fail "README.md: tarball '${tgz}' version '${tgz_ver}' disagrees with '${expected}'"
    fi
  done <<< "${readme_tarballs}"
fi

tag=""
if [[ $# -ge 1 ]]; then
  tag="${1#refs/tags/}"
  if [[ -z "${tag}" ]]; then
    fail "empty tag argument"
  fi
elif [[ "${GITHUB_REF_TYPE:-}" == "tag" && -n "${GITHUB_REF_NAME:-}" ]]; then
  tag="${GITHUB_REF_NAME#refs/tags/}"
elif [[ "${GITHUB_REF:-}" == refs/tags/* ]]; then
  tag="${GITHUB_REF#refs/tags/}"
  if [[ -z "${tag}" ]]; then
    fail "empty tag in GITHUB_REF"
  fi
fi

if [[ -n "${tag}" ]]; then
  if [[ "${tag}" != v* ]]; then
    fail "tag '${tag}' must start with 'v'"
  else
    tag_version="${tag#v}"
    if [[ "${tag_version}" != "${expected}" ]]; then
      fail "tag '${tag}' (${tag_version}) disagrees with package version '${expected}'"
    fi
  fi

  if git -C "${root}" show-ref --verify --quiet "refs/tags/${tag}"; then
    # Peel to commit so both annotated tags and lightweight tags from
    # actions/checkout are accepted.
    tag_commit="$(git -C "${root}" rev-parse --verify "refs/tags/${tag}^{commit}")"
    head_commit="$(git -C "${root}" rev-parse --verify HEAD)"
    if [[ "${tag_commit}" != "${head_commit}" ]]; then
      fail "tag '${tag}' resolves to ${tag_commit}, expected HEAD ${head_commit}"
    fi
  else
    fail "tag '${tag}' does not exist in refs/tags/${tag}"
  fi
fi

if [[ -n "${tag}" || "${expected}" != *-dev ]]; then
  if ! bash "${script_dir}/extract-changelog.sh" "${expected}" >/dev/null 2>&1; then
    fail "CHANGELOG.md: missing non-empty '## [${expected}]' section"
  fi
fi

if [[ ${errors} -gt 0 ]]; then
  exit 1
fi

if [[ -n "${tag}" ]]; then
  echo "release-version ok: ${expected} (tag ${tag})"
else
  echo "release-version ok: ${expected}"
fi
