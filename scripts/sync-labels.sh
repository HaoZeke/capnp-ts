#!/usr/bin/env bash
# Create or update the labels in .github/labels.yml. Needs gh and python3 with PyYAML.
set -euo pipefail
python3 - <<'PY' | while IFS=$'\t' read -r n c d; do gh label create "$n" --color "$c" --description "$d" --force; done
import yaml
for l in yaml.safe_load(open(".github/labels.yml")):
    print(f"{l['name']}\t{l['color']}\t{l['description']}")
PY
