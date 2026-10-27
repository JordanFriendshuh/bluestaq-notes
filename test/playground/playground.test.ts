import request from 'supertest';
import { afterAll, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';

const { app, db } = createTestApp();
afterAll(() => db.destroy());

it('serves the playground page and its script with the usual security headers', async () => {
  const page = await request(app).get('/playground/');
  const script = await request(app).get('/playground/app.js');

  expect(page.status).toBe(200);
  expect(page.text).toContain('<script src="app.js" defer></script>');
  expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  expect(script.status).toBe(200);
  expect(script.headers['content-type']).toMatch(/javascript/);
});
