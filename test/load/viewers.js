/* global __ENV */
// k6 viewer load test for the public pool pages (#155): brief 11.5's 1,000 concurrent viewers.
//   k6 run -e BASE_URL=https://staging.example.com -e SLUG=<share slug> -e POOL_ID=<pool id> test/load/viewers.js
// Reduced local run: add -e VUS=50 -e HOLD=1m. See docs/runbooks/load-testing.md.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = `${(__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')}/v1`;
const VUS = Number(__ENV.VUS || 1000);

export const options = {
  scenarios: {
    viewers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '1m', target: VUS },
        { duration: __ENV.HOLD || '5m', target: VUS },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{page:preview}': [`p(95)<${__ENV.P95_PREVIEW_MS || 500}`],
    'http_req_duration{page:sharecard}': [`p(95)<${__ENV.P95_SHARECARD_MS || 1000}`],
  },
};

export function setup() {
  if (!__ENV.SLUG) throw new Error('set -e SLUG=<share slug of an existing pool>');
}

export default function () {
  const preview = http.get(`${BASE}/p/${__ENV.SLUG}`, { tags: { page: 'preview' } });
  check(preview, { 'preview is 200': (r) => r.status === 200 });
  if (__ENV.POOL_ID) {
    const card = http.get(`${BASE}/pools/${__ENV.POOL_ID}/sharecard.png`, { tags: { page: 'sharecard' } });
    check(card, { 'share card is 200': (r) => r.status === 200 });
  }
  // A viewer reads the page for a moment before the next request.
  sleep(1 + Math.random() * 2);
}
