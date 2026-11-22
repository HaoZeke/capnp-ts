#!/usr/bin/env bash
# Install the Cap'n Proto 1.4.0 release the test suite targets.
# Usage: install-capnproto.sh [prefix]
# A prefix that already contains bin/capnp is left in place, so a
# version-keyed CI cache can skip the build.
set -euo pipefail

version=1.4.0
# Published SHA-256 of https://capnproto.org/capnproto-c++-1.4.0.tar.gz
# (Debian orig tarball and the upstream release are the same bytes).
sha256=fa02378ad522b318916b9ad928d1372fc9abd43dd1f4f0392e50450f5c87828f
prefix=${1:-"${HOME}/.local/capnproto-${version}"}
url="https://capnproto.org/capnproto-c++-${version}.tar.gz"

mkdir -p -- "${prefix}"
prefix="$(CDPATH='' cd -- "${prefix}" && pwd)"

if [[ -x "${prefix}/bin/capnp" ]]; then
  echo "Cap'n Proto ${version} already installed at ${prefix}"
  "${prefix}/bin/capnp" --version
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "${tmpdir}"' EXIT
tarball="${tmpdir}/capnproto-c++-${version}.tar.gz"

curl -fsSL -o "${tarball}" "${url}"
echo "${sha256}  ${tarball}" | sha256sum -c -

tar -C "${tmpdir}" -xzf "${tarball}"
(
  cd "${tmpdir}/capnproto-c++-${version}"
  ./configure --prefix="${prefix}"
  make -j"$(nproc)"
  make install
)

"${prefix}/bin/capnp" --version
