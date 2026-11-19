/* global __ENV, __VU, __ITER */
// k6 commit load test (#155): brief 11.5's 100 commits in five minutes, against POST /v1/pools/:id/commit/prepare.
//   k6 run -e BASE_URL=https://staging.example.com -e POOL_ID=<open pool id> -e TOKENS=<token1,token2,...> test/load/commits.js
// TOKENS are access tokens of members that already have a wallet bound. See docs/runbooks/load-testing.md.
import http from 'k6/http';
import { check } from 'k6';

const BASE = `${(__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')}/v1`;
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
const WINDOW = __ENV.WINDOW || '5m';

export const options = {
  scenarios: {
    commits: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.COMMITS || 100),
      timeUnit: WINDOW,
      duration: WINDOW,
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{step:prepare}': [`p(95)<${__ENV.P95_PREPARE_MS || 2000}`],
  },
};

export function setup() {
  if (!__ENV.POOL_ID || TOKENS.length === 0) {
    throw new Error('set -e POOL_ID=<open pool id> -e TOKENS=<comma-separated member access tokens>');
  }
}

export default function () {
  const token = TOKENS[(__VU + __ITER) % TOKENS.length];
  const res = http.post(
    `${BASE}/pools/${__ENV.POOL_ID}/commit/prepare`,
    JSON.stringify({ units: Number(__ENV.UNITS || 1) }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, tags: { step: 'prepare' } },
  );
  check(res, {
    'prepare is 2xx': (r) => r.status >= 200 && r.status < 300,
    'prepare returns a transaction': (r) => String(r.body).includes('txXdr'),
  });
}
