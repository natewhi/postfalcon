import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app.js';

function upstreamResponse(body, { status = 200, contentType = 'application/javascript' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => Buffer.from(body),
  };
}

describe('analytics proxy — UMAMI_HOST unset', () => {
  it('404s any /stats path', async () => {
    const res = await request(app).get('/stats/script.js');
    expect(res.status).toBe(404);
  });
});

describe('analytics proxy — UMAMI_HOST set', () => {
  beforeAll(() => {
    process.env.UMAMI_HOST = 'http://umami.internal:3002';
  });

  afterAll(() => {
    delete process.env.UMAMI_HOST;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('proxies the tracking script from the configured host', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(String(url)).toBe('http://umami.internal:3002/script.js');
      return upstreamResponse('console.log("umami");');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app).get('/stats/script.js');
    expect(res.status).toBe(200);
    expect(res.type).toBe('application/javascript');
    expect(res.text).toBe('console.log("umami");');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards a POST body and the real client headers to the collector endpoint', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe('http://umami.internal:3002/api/send');
      expect(init.method).toBe('POST');
      expect(init.headers['User-Agent']).toContain('analytics-test-agent');
      expect(Buffer.isBuffer(init.body)).toBe(true);
      expect(JSON.parse(init.body.toString())).toEqual({ type: 'event', payload: { url: '/pricing' } });
      return upstreamResponse(JSON.stringify({ ok: true }), { contentType: 'application/json' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app)
      .post('/stats/api/send')
      .set('User-Agent', 'analytics-test-agent')
      .send({ type: 'event', payload: { url: '/pricing' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 502 if the upstream Umami instance is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );

    const res = await request(app).get('/stats/script.js');
    expect(res.status).toBe(502);
  });
});
