#!/usr/bin/env bash
# Extract the release notes body for a version from CHANGELOG.md.
# Usage: extract-changelog.sh <version-or-tag> [changelog-path]
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <version-or-tag> [changelog-path]" >&2
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

version="${1#refs/tags/}"
version="${version#v}"
if [[ -z "${version}" ]]; then
  echo "extract-changelog: empty version argument" >&2
  exit 2
fi
changelog="${2:-${root}/CHANGELOG.md}"

if [[ ! -f "${changelog}" ]]; then
  echo "extract-changelog: file not found: ${changelog}" >&2
  exit 1
fi

notes="$(
  awk -v ver="${version}" '
    BEGIN { found = 0; in_section = 0; fence = "" }
    fence != "" {
      if ((fence == "```" && $0 ~ /^[[:space:]]*```/) || (fence == "~~~" && $0 ~ /^[[:space:]]*~~~/)) {
        fence = ""
      }
      if (in_section) {
        print
      }
      next
    }
    /^[[:space:]]*```/ {
      fence = "```"
      if (in_section) {
        print
      }
      next
    }
    /^[[:space:]]*~~~/ {
      fence = "~~~"
      if (in_section) {
        print
      }
      next
    }
    /^## \[/ {
      if (in_section) {
        in_section = 0
        next
      }
      prefix = "## [" ver "]"
      if (substr($0, 1, length(prefix)) == prefix) {
        rest = substr($0, length(prefix) + 1)
        if (rest == "" || rest ~ /^([[:space:]]|$)/) {
          found = 1
          in_section = 1
          next
        }
      }
    }
    in_section && /^\[[^]]+\]:[[:space:]]/ {
      in_section = 0
      next
    }
    in_section {
      print
    }
    END {
      if (!found) {
        exit 3
      }
    }
  ' "${changelog}"
)" || {
  rc=$?
  if [[ ${rc} -eq 3 ]]; then
    echo "extract-changelog: no '## [${version}]' section in ${changelog}" >&2
  fi
  exit 1
}

# Trim leading and trailing blank lines.
trimmed="$(
  printf '%s\n' "${notes}" | awk '
    { lines[NR] = $0 }
    END {
      start = 1
      while (start <= NR && lines[start] ~ /^[[:space:]]*$/) start++
      end = NR
      while (end >= start && lines[end] ~ /^[[:space:]]*$/) end--
      for (i = start; i <= end; i++) print lines[i]
    }
  '
)"

if [[ -z "${trimmed}" ]]; then
  echo "extract-changelog: section '## [${version}]' in ${changelog} is empty" >&2
  exit 1
fi

printf '%s\n' "${trimmed}"
