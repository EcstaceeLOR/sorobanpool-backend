import { installShutdown, shutdown } from './shutdown.js';
import { every } from '../workers/runners.js';

// #145: SIGTERM stops intake, drains schedulers, then disconnects Prisma, within a bounded time.
describe('graceful shutdown', () => {
  it('closes HTTP, then stops runners, then disconnects the database', async () => {
    const order: string[] = [];
    await shutdown({
      closeHttp: async () => { order.push('http'); },
      runners: [{ stop: async () => { order.push('runner'); } }],
      disconnect: async () => { order.push('prisma'); },
    });
    expect(order).toEqual(['http', 'runner', 'prisma']);
  });

  it('lets a runner caught mid tick finish before Prisma disconnects', async () => {
    const order: string[] = [];
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => { markStarted = r; });
    const runner = every('mid-tick', 5, async () => {
      markStarted();
      await new Promise((r) => setTimeout(r, 40));
      order.push('tick done');
    });
    await started;
    const exits: number[] = [];
    await installShutdown({ runners: [runner], disconnect: async () => { order.push('prisma'); } }, { exit: (c) => exits.push(c), signals: [] })('SIGTERM');
    expect(order).toEqual(['tick done', 'prisma']);
    expect(exits).toEqual([0]);
  });

  it('runs once even if the signal arrives twice', async () => {
    let closes = 0;
    const exits: number[] = [];
    const handle = installShutdown({ closeHttp: async () => { closes++; }, runners: [], disconnect: async () => {} }, { exit: (c) => exits.push(c), signals: [] });
    await Promise.all([handle('SIGTERM'), handle('SIGINT')]);
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('exits 1 when draining exceeds the timeout', async () => {
    const exits: number[] = [];
    const handle = installShutdown({ closeHttp: () => new Promise(() => {}), runners: [], disconnect: async () => {} }, { exit: (c) => exits.push(c), signals: [], timeoutMs: 20 });
    await handle('SIGTERM');
    expect(exits).toEqual([1]);
  });

  it('exits 1 when a step fails', async () => {
    const exits: number[] = [];
    const handle = installShutdown({ runners: [], disconnect: async () => { throw new Error('pool busy'); } }, { exit: (c) => exits.push(c), signals: [] });
    await handle('SIGTERM');
    expect(exits).toEqual([1]);
  });
});
