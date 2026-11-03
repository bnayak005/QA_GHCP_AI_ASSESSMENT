import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { Bank } from '../dist/server/domain.js';
import { createApp } from '../dist/server/app.js';

const bank = new Bank();
const credentials = bank.seed();
const origins = [];
const runtime = createApp(bank, { origins, log: () => {} });
const server = runtime.app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
origins.push(base);
let browser;
async function waitForCondition(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(predicate(), description);
}
try {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const executablePath = existsSync(chromium.executablePath())
    ? undefined
    : existsSync(edge)
      ? edge
      : undefined;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  let loginRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/login')) loginRequests++;
  });
  const login = async (username, target = page) => {
    const user = credentials.find((entry) => entry.username === username);
    assert(user);
    await target.getByLabel('Username', { exact: true }).fill(user.username);
    await target.getByLabel('Password', { exact: true }).fill(user.password);
    await target.getByRole('button', { name: 'Sign in', exact: true }).click();
    await target.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  };
  const signOut = async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Signed out.' }).waitFor();
    assert.equal(await page.locator('article').count(), 0);
  };
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  assert(
    await page
      .getByLabel('Username', { exact: true })
      .evaluate((input) => input.validity.valueMissing),
  );
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  assert(
    await page
      .getByLabel('Password', { exact: true })
      .evaluate((input) => input.validity.valueMissing),
  );
  assert.equal(loginRequests, 0, 'Required-field feedback must precede login submission');
  await page.getByLabel('Username', { exact: true }).focus();
  await page.keyboard.press('Tab');
  assert(
    await page
      .getByLabel('Password', { exact: true })
      .evaluate((input) => input === document.activeElement),
  );
  await page.keyboard.press('Tab');
  assert(
    await page
      .getByRole('button', { name: 'Sign in', exact: true })
      .evaluate((button) => button === document.activeElement),
  );
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Invalid username or password.' }).waitFor();
  await login('alice');
  await page.getByText('Current - verified mock balances', { exact: true }).waitFor();
  assert.equal(await page.locator('article').count(), 2);
  const savings = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Savings ...1042', exact: true }) });
  await savings.getByText('Demo-only account controls').click();
  await savings.getByLabel('Synthetic balance (USD)').fill('1234.56');
  const start = performance.now();
  await savings.getByRole('button', { name: 'Simulate balance change', exact: true }).click();
  await savings.getByText('USD 1,234.56', { exact: true }).waitFor();
  const updateMs = performance.now() - start;
  assert(updateMs <= 1000, `UI update exceeded 1 second: ${updateMs}`);
  await savings.getByRole('button', { name: 'Simulate account failure' }).click();
  await savings.getByText('Available balance (last known, not current)', { exact: true }).waitFor();
  const checking = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Checking ...2086', exact: true }) });
  assert.equal(await checking.getByText('Available balance', { exact: true }).count(), 1);
  await savings.getByRole('button', { name: 'Restore account source' }).click();
  await page.getByText('Current - verified mock balances', { exact: true }).waitFor();
  const outageStart = performance.now();
  await page.getByRole('button', { name: 'Simulate source outage', exact: true }).click();
  await page.getByText('Not current - do not rely on these amounts', { exact: true }).waitFor();
  assert(performance.now() - outageStart <= 5000);
  await page.getByRole('button', { name: 'Restore source', exact: true }).click();
  await page.getByText('Current - verified mock balances', { exact: true }).waitFor();
  await savings.getByLabel('Synthetic balance (USD)').fill('invalid');
  await savings.getByRole('button', { name: 'Simulate balance change', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Use an exact USD amount' }).waitFor();
  await page.waitForTimeout(2200);
  assert((await page.getByRole('alert').innerText()).includes('Use an exact USD amount'));
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  assert.equal(await page.getByRole('alert').count(), 0);
  await savings.getByRole('button', { name: 'Simulate balance change', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Use an exact USD amount' }).waitFor();
  await savings.getByLabel('Synthetic balance (USD)').fill('1234.56');
  await savings.getByRole('button', { name: 'Simulate balance change', exact: true }).click();
  assert.equal(await page.getByRole('alert').count(), 0);
  await signOut();
  await login('empty');
  await page.getByText('No eligible savings or checking accounts.', { exact: true }).waitFor();
  await signOut();

  // Delay an already authorized initial response beyond logout and a different login.
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  let captured;
  const ready = new Promise((resolve) => {
    captured = resolve;
  });
  let delivered;
  const delivery = new Promise((resolve) => {
    delivered = resolve;
  });
  await page.route(
    '**/api/balances',
    async (route) => {
      const response = await route.fetch();
      captured();
      await delayed;
      await route.fulfill({ response });
      delivered();
    },
    { times: 1 },
  );
  await login('alice');
  await ready;
  await signOut();
  await login('bob');
  await page.getByText('USD 500.00', { exact: true }).waitFor();
  release();
  await delivery;
  await page.waitForTimeout(300);
  assert.equal(await page.locator('article').count(), 1);
  assert.equal(await page.getByText('USD 1,234.56', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await page.locator('input[type="password"]').count(), 0);

  for (const payload of [
    { body: '{}', contentType: 'application/json', message: 'Invalid balance response.' },
    {
      body: '{"kind":"snapshot","accounts":null}',
      contentType: 'application/json',
      message: 'Invalid balance response.',
    },
    {
      body: '<html>Temporary failure</html>',
      contentType: 'text/html',
      message: 'Server returned an invalid response.',
    },
  ]) {
    const malformed = await browser.newPage();
    malformed.on('pageerror', (error) => errors.push(error.message));
    await malformed.route(
      '**/api/balances',
      (route) =>
        route.fulfill({ status: 200, body: payload.body, contentType: payload.contentType }),
      { times: 1 },
    );
    await malformed.goto(base);
    await login('alice', malformed);
    await malformed.getByRole('alert').filter({ hasText: payload.message }).waitFor();
    await malformed.getByText('Current - verified mock balances', { exact: true }).waitFor();
    assert.equal(await malformed.locator('article').count(), 2);
    await malformed.close();
  }
  await waitForCondition(
    () => bank.listeners.size === 1,
    'Malformed-response test streams must be cleaned up',
  );

  for (const status of [200, 401]) {
    let resumed, reached, complete;
    const resume = new Promise((resolve) => {
      resumed = resolve;
    });
    const reachedRequest = new Promise((resolve) => {
      reached = resolve;
    });
    const completedRequest = new Promise((resolve) => {
      complete = resolve;
    });
    await page.route(
      '**/api/session',
      async (route) => {
        const response = await route.fetch();
        reached();
        await resume;
        if (status === 200) await route.fulfill({ response });
        else
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: '{"error":"Obsolete request","correlationId":"test"}',
          });
        complete();
      },
      { times: 1 },
    );
    runtime.close();
    await reachedRequest;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('Current - verified mock balances', { exact: true }).waitFor();
    await waitForCondition(
      () => bank.listeners.size === 1,
      'A replacement stream must be established',
    );
    resumed();
    await completedRequest;
    await page.waitForTimeout(1000);
    assert.equal(
      bank.listeners.size,
      1,
      'Obsolete reconnect response must not create another stream',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Sign out', exact: true }).count(),
      1,
      'Obsolete reconnect failure must not clear the current session',
    );
  }
  await signOut();
  await waitForCondition(
    () => bank.listeners.size === 0,
    'Logout must remove every stream listener',
  );
  await login('alice');
  await page.getByText('Current - verified mock balances', { exact: true }).waitFor();
  await page.route(
    '**/api/logout',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Logout not confirmed by server","correlationId":"test"}',
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Logout not confirmed' }).waitFor();
  assert.equal(await page.locator('article').count(), 0);
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: /^Signed out\.$/ })
      .count(),
    0,
  );
  await waitForCondition(
    () => bank.listeners.size === 0,
    'Unconfirmed logout must still clear local streams',
  );
  assert.deepEqual(errors, []);
  console.log(
    `Browser smoke passed: required-field/keyboard checks, invalid/valid login, two accounts, UI update ${Math.round(updateMs)}ms, outages/recovery, logout/unconfirmed logout, empty accounts, delayed old-session response, mobile layout, persistent/dismissible action errors, malformed initial responses, reconnect/visibility races with late success/failure; no page errors or leaked listeners.`,
  );
} finally {
  await browser?.close();
  runtime.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
