import { initializeTracing, instrumentRpcServer } from './tracing.js';

describe('OpenTelemetry tracing', () => {
  it('does not initialize a provider or wrap RPC clients when the endpoint is empty', async () => {
    expect(await initializeTracing('', 'api')).toBeUndefined();
    const server = { async getLatestLedger() { return { sequence: 42 }; } };
    expect(instrumentRpcServer(server)).toBe(server);
  });

  it('starts an active provider only when an OTLP endpoint is configured', async () => {
    const tracing = await initializeTracing('http://127.0.0.1:4318/v1/traces', 'worker');
    expect(tracing).toBeDefined();
    const span = tracing!.tracer.startSpan('test');
    expect(span.isRecording()).toBe(true);
    span.end();
    await tracing!.shutdown();
  });
});
