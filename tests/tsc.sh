#!/bin/sh
# NK-08: type-check the mod against the engine's API file, with a tsconfig kept outside the mod. `tsc -p <mod>` reads
# .claude-plugin/types, which the engine rewrites only when it loads the mod: a copy older than the engine reports
# errors that are not there. The types file is the one plugin-authoring names as it loads (claude-code.d.ts).
# Usage: sh tests/tsc.sh <path to claude-code.d.ts>   (exit: tsc's own; 2 when the file is missing or tsc is not found)
TYPES="$1"
MOD="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$TYPES" ] || { echo "usage: sh tests/tsc.sh <path to claude-code.d.ts>" >&2; exit 2; }
command -v tsc >/dev/null 2>&1 || { echo "tsc not found on PATH" >&2; exit 2; }
DIR="$(mktemp -d "${TMPDIR:-/tmp}/snagon-tsc.XXXXXX")" || exit 2
trap 'rm -rf "$DIR"' EXIT
cat > "$DIR/tsconfig.json" <<EOF
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "types": [], "module": "esnext", "moduleResolution": "bundler", "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true, "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" },
  "include": ["$TYPES", "$MOD/hooks", "$MOD/types", "$MOD/tests"] }
EOF
tsc -p "$DIR"
