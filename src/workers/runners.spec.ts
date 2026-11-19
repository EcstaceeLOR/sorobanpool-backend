import { every, rpcPort } from './runners.js';

describe('rpcPort', () => {
  it('asks the RPC for endLedger + 1 because the RPC treats endLedger as exclusive', async () => {
    const seen: Record<string, unknown>[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async (req: Record<string, unknown>) => {
        seen.push(req);
        return { events: [], cursor: '' };
      },
    } as never;
    await rpcPort(server).getEvents(10, 20, ['C1']);
    expect(seen[0]).toMatchObject({ startLedger: 10, endLedger: 21 });
  });

  it('splits more than five contracts into separate filters (an RPC limit)', async () => {
    const seen: { filters: { contractIds: string[] }[] }[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 1 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async (req: { filters: { contractIds: string[] }[] }) => {
        seen.push(req);
        return { events: [], cursor: '' };
      },
    } as never;
    await rpcPort(server).getEvents(1, 2, ['A', 'B', 'C', 'D', 'E', 'F']);
    expect(seen[0]!.filters.map((f) => f.contractIds.length)).toEqual([5, 1]);
  });
});

// #145: a stop signal mid tick lets the running tick finish, and no new tick starts.
describe('runner stop (graceful shutdown)', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('waits for the tick in progress and never starts another', async () => {
    let ticks = 0;
    let finished = false;
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((r) => { markStarted = r; });
    const runner = every('test', 5, async () => {
      ticks++;
      markStarted();
      await new Promise<void>((r) => { release = r; });
      finished = true;
    });
    await started;
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await sleep(30);
    expect(stopped).toBe(false);
    expect(ticks).toBe(1);
    release();
    await stopping;
    expect(finished).toBe(true);
    await sleep(30);
    expect(ticks).toBe(1);
  });

  it('resolves at once when no tick is running', async () => {
    let ticks = 0;
    const runner = every('idle', 60_000, async () => { ticks++; });
    await runner.stop();
    expect(ticks).toBe(0);
  });
});
