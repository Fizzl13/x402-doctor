// One-off: fresh public clone of x402-examples, install, tests, dry run (pays nothing).
import { execSync } from 'child_process';
execSync('git clone -q --depth 1 https://github.com/Fizzl13/x402-examples /tmp/ex && cd /tmp/ex/crowding-check && npm ci --silent && npm test 2>&1 | grep -E "^# (pass|fail)" && node crowding-check.mjs BTC --dry-run && node crowding-check.mjs ETH --dry-run && node crowding-check.mjs BTC; echo "exit (no key, expected message above): $?"', { stdio: 'inherit', shell: '/bin/bash' });
