import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { S3ObjectStore, type S3Options } from '../../src/evidence/store.js';

/**
 * Opt-in integration suite (#156): skipped unless INTEGRATION=1, then run against real MinIO and Redis, for example the
 * services in docker-compose.yml (`docker compose up -d minio redis`, then `pnpm test:integration`). Endpoints and
 * credentials can be overridden by env; see docs/integration-tests.md.
 */
const enabled = process.env.INTEGRATION === '1';
const S3_ENDPOINT = process.env.INTEGRATION_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const S3_ACCESS_KEY = process.env.INTEGRATION_S3_ACCESS_KEY ?? 'minioadmin';
const S3_SECRET_KEY = process.env.INTEGRATION_S3_SECRET_KEY ?? 'minioadmin';
const REDIS_URL = process.env.INTEGRATION_REDIS_URL ?? 'redis://127.0.0.1:6379';

describe.skipIf(!enabled)('S3ObjectStore against MinIO', () => {
  const suffix = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const buckets = { public: `sp-int-public-${suffix}`, evidence: `sp-int-evidence-${suffix}` };
  const options: S3Options = { endpoint: S3_ENDPOINT, region: 'us-east-1', accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, buckets };
  let store: S3ObjectStore;

  beforeAll(async () => {
    const admin = new S3Client({
      endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
    for (const bucket of Object.values(buckets)) {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      await admin.send(new HeadBucketCommand({ Bucket: bucket }));
    }
    store = new S3ObjectStore(options);
  });

  it('uploads and downloads binary bytes unchanged', async () => {
    const bytes = randomBytes(256 * 1024);
    await store.put('evidence', 'claims/1/photo.jpg', bytes);
    const got = await store.get('evidence', 'claims/1/photo.jpg');
    expect(got).not.toBeNull();
    expect(Buffer.compare(got!, bytes)).toBe(0);
  });

  it('keeps the public and evidence buckets separate', async () => {
    await store.put('public', 'offers/only-public.txt', Buffer.from('public'));
    expect((await store.get('public', 'offers/only-public.txt'))?.toString()).toBe('public');
    expect(await store.get('evidence', 'offers/only-public.txt')).toBeNull();
  });

  it('returns the latest bytes after an overwrite', async () => {
    await store.put('public', 'offers/card.png', Buffer.from('v1'));
    await store.put('public', 'offers/card.png', Buffer.from('v2'));
    expect((await store.get('public', 'offers/card.png'))?.toString()).toBe('v2');
  });

  it('returns null for a key that was never written', async () => {
    expect(await store.get('evidence', `missing/${suffix}`)).toBeNull();
  });

  it('signs requests: a wrong secret is rejected by the server', async () => {
    const wrong = new S3ObjectStore({ ...options, secretAccessKey: 'not-the-real-secret' });
    await expect(wrong.put('public', 'offers/forged.txt', Buffer.from('x'))).rejects.toThrow();
    expect(await store.get('public', 'offers/forged.txt')).toBeNull();
  });

  it('rejects traversal keys before sending anything', async () => {
    await expect(store.put('evidence', '../escape', Buffer.from('x'))).rejects.toThrow('invalid object key');
  });
});

type Reply = string | number | null;

function encode(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
}

/** Parses `count` RESP replies from `buf`, or returns null when more bytes are still to come. */
function parseReplies(buf: string, count: number): Reply[] | null {
  const out: Reply[] = [];
  let i = 0;
  while (out.length < count) {
    const end = buf.indexOf('\r\n', i);
    if (end < 0) return null;
    const type = buf[i];
    const line = buf.slice(i + 1, end);
    if (type === '+') {
      out.push(line);
      i = end + 2;
    } else if (type === ':') {
      out.push(Number(line));
      i = end + 2;
    } else if (type === '-') {
      throw new Error(`redis error: ${line}`);
    } else if (type === '$') {
      const n = Number(line);
      if (n < 0) {
        out.push(null);
        i = end + 2;
      } else {
        if (buf.length < end + 2 + n + 2) return null;
        out.push(buf.slice(end + 2, end + 2 + n));
        i = end + 2 + n + 2;
      }
    } else {
      throw new Error(`unexpected redis reply type ${type}`);
    }
  }
  return out;
}

/** Sends commands over one connection and resolves with their replies (no client library needed). */
function redis(url: string, commands: string[][]): Promise<Reply[]> {
  const u = new URL(url);
  return new Promise<Reply[]>((resolve, reject) => {
    const socket = connect(Number(u.port || 6379), u.hostname);
    let buf = '';
    socket.on('connect', () => {
      const auth = u.password ? [encode(u.username ? ['AUTH', u.username, u.password] : ['AUTH', u.password])] : [];
      socket.write(auth.join('') + commands.map(encode).join(''));
    });
    socket.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      try {
        const replies = parseReplies(buf, commands.length + (u.password ? 1 : 0));
        if (replies) {
          socket.end();
          resolve(u.password ? replies.slice(1) : replies);
        }
      } catch (e) {
        socket.destroy();
        reject(e as Error);
      }
    });
    socket.on('error', reject);
  });
}

describe.skipIf(!enabled)('Redis at REDIS_URL', () => {
  const key = `sp-int:${Date.now().toString(36)}`;

  it('answers PING', async () => {
    expect(await redis(REDIS_URL, [['PING']])).toEqual(['PONG']);
  });

  it('stores a value and expires it after its TTL', async () => {
    expect(await redis(REDIS_URL, [['SET', key, 'v', 'PX', '300'], ['GET', key]])).toEqual(['OK', 'v']);
    await new Promise((r) => setTimeout(r, 600));
    expect(await redis(REDIS_URL, [['GET', key]])).toEqual([null]);
  });
});
