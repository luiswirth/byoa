# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm types
    pnpm exec tsc -p relay
    pnpm exec tsc -p client
    pnpm exec tsc -p onboard
    just test

# The relay, locally, on port 8790.
dev:
    pnpm exec wrangler dev

# The relay, at byoa.senses.sh.
deploy: ci
    pnpm exec wrangler deploy --domain byoa.senses.sh

# The spec's examples, run with curl against a relay of its own.
test:
    #!/usr/bin/env bash
    set -euo pipefail
    node_modules/.bin/wrangler dev --port 8791 >/dev/null 2>&1 &
    trap 'kill $!' EXIT
    tests/transport.sh http://localhost:8791
    node tests/secrets.ts
