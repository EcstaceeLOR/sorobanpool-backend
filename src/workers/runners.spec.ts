import { xdr } from '@stellar/stellar-sdk';
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

  it('uses the configured page size and refuses to skip an undrained range (#87)', async () => {
    const requests: Record<string, unknown>[] = [];
    const full = {
      id: 'e1', ledger: 1, ledgerClosedAt: new Date(0).toISOString(), contractId: 'C1',
      topic: [xdr.ScVal.scvSymbol('group_buy')], value: xdr.ScVal.scvVoid(),
    };
    const server = {
      getLatestLedger: async () => ({ sequence: 1 }),
      getHealth: async () => ({ oldestLedger: 1 }),
      getEvents: async (req: Record<string, unknown>) => {
        requests.push(req);
        return { events: Array.from({ length: 25 }, (_, i) => ({ ...full, id: `e${i}` })), cursor: 'next' };
      },
    } as never;
    await expect(rpcPort(server, 25, 2).getEvents(10, 20, ['C1'])).rejects.toThrow(/page limit 2x25/);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ limit: 25, startLedger: 10, endLedger: 21 });
    expect(requests[1]).toMatchObject({ limit: 25, cursor: 'next' });
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
