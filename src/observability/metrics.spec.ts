import { httpLabels, Metrics } from './metrics.js';
import { startHarness, type Harness } from '../../test/harness.js';

describe('Metrics', () => {
  it('renders counters, histograms and gauges in Prometheus text format', () => {
    const m = new Metrics();
    m.inc('c_total', { a: 'x"y' });
    m.inc('c_total', { a: 'x"y' }, 2);
    m.observe('d_seconds', { r: '/p' }, 0.07);
    const t = m.render({ g: 4 });
    expect(t).toContain('c_total{a="x\\"y"} 3');
    expect(t).toContain('d_seconds_bucket{r="/p",le="0.05"} 0');
    expect(t).toContain('d_seconds_bucket{r="/p",le="0.1"} 1');
    expect(t).toContain('d_seconds_count{r="/p"} 1');
    expect(t).toContain('g 4');
  });
});

describe('GET /v1/metrics', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ METRICS_TOKEN: 'm'.repeat(20) }); });
  afterAll(async () => { await h.close(); });
  it('requires the token, and counts requests by route pattern', async () => {
    await h.http().get('/v1/health');
    await h.http().get('/v1/offers/abc');
    expect((await h.http().get('/v1/metrics')).status).toBe(401);
    const r = await h.http().get('/v1/metrics').set('Authorization', `Bearer ${'m'.repeat(20)}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('http_requests_total{method="GET",route="/v1/health"');
    expect(r.text).toContain('route="/v1/offers/:id"');
    expect(r.text).not.toContain('/offers/abc');
    expect(r.text).toContain('sp_notifications_pending 0');
  });
});

// #146: label sets for parameterised routes carry the template and status class, never raw ids.
describe('http_request_duration_seconds labels', () => {
  it.each([
    ['GET', '/v1/offers/:id', 200, { method: 'GET', route: '/v1/offers/:id', status_class: '2xx' }],
    ['POST', '/v1/pools/:id/commit', 422, { method: 'POST', route: '/v1/pools/:id/commit', status_class: '4xx' }],
    ['GET', '/v1/admin/disputes/:id', 503, { method: 'GET', route: '/v1/admin/disputes/:id', status_class: '5xx' }],
    ['GET', undefined, 404, { method: 'GET', route: 'unmatched', status_class: '4xx' }],
  ])('%s %s -> %s', (method, route, status, labels) => {
    expect(httpLabels(method, route, status)).toEqual(labels);
  });

  describe('over HTTP', () => {
    let h: Harness;
    beforeAll(async () => { h = await startHarness({ METRICS_TOKEN: 'n'.repeat(20) }); });
    afterAll(async () => { await h.close(); });
    it('records the route template and status class for a parameterised route', async () => {
      await h.http().get('/v1/offers/does-not-exist-123');
      const r = await h.http().get('/v1/metrics').set('Authorization', `Bearer ${'n'.repeat(20)}`);
      expect(r.text).toContain('http_request_duration_seconds_count{method="GET",route="/v1/offers/:id",status_class="4xx"} 1');
      expect(r.text).not.toContain('does-not-exist-123');
    });
  });
});
