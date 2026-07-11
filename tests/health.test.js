import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
  });
});
