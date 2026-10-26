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

// Ops endpoints that aren't pages: the installer's short address sits beside /health.
describe('GET /install.sh', () => {
  it('redirects to the installer script in the repository', async () => {
    const res = await request(app).get('/install.sh');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://raw.githubusercontent.com/natewhi/postfalcon/main/install.sh');
  });
});
