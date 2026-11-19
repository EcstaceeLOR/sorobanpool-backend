import { currentRequestId, requestHeaders, withRequestContext } from './request-context.js';

describe('request context', () => {
  it('adds the active request id to outbound provider headers without replacing an explicit id', () => {
    withRequestContext('req-safe_1', () => {
      expect(requestHeaders({ accept: 'application/json' }).get('X-Request-Id')).toBe('req-safe_1');
      expect(requestHeaders({ 'X-Request-Id': 'explicit' }).get('X-Request-Id')).toBe('explicit');
    });
    expect(currentRequestId()).toBeUndefined();
  });
});
