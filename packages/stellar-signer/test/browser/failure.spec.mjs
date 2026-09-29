import { randomBytes, randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { Networks, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { buildPaymentXdr } from '../../dist/index.js';
import { accountCounts, configureProject, createAccount, createProject, login, mockStellarBalance, registerUser, signPayment, verifyEnvelope } from './helpers.mjs';

const test = base.extend({
  session: async ({ browser, request }, use) => {
    const suffix = randomUUID().slice(0, 8);
    const credentials = { username: `stellar_${suffix}`, email: `stellar-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
    const project = await createProject(request, `stellar-failure-${suffix}`);
    const context = await browser.newContext();
    try {
      await mockStellarBalance(context);
      const page = await context.newPage();
      await page.goto('http://localhost:7051');
      await configureProject(page, project);
      await registerUser(page, credentials);
      await login(page, credentials);
      const account = await createAccount(page);
      const xdr = buildPaymentXdr({ publicKey: account.publicKey, destination: account.publicKey, amount: '1', sequence: '1' });
      await use({ page, context, account, xdr });
    } finally { await context.close(); }
  },
});

test.skip(process.env.STELLAR_TESTNET_SMOKE === '1', 'failure injection is independent of the Stellar network');

test('a lost submission response triggers a status lookup without another submission', async ({ session }) => {
  test.setTimeout(45000);
  const { page, context, account, xdr } = session;
  const hash = Buffer.from(TransactionBuilder.fromXdr(xdr, Networks.TESTNET).hash()).toString('hex');
  let submissions = 0;
  let lookups = 0;
  const lookupHashes = [];
  let heldResponse;
  await context.route('https://horizon-testnet.stellar.org/transactions', route => { submissions++; heldResponse = route; });
  await context.route('https://horizon-testnet.stellar.org/transactions/*', route => {
    lookups++;
    lookupHashes.push(route.request().url().split('/').at(-1));
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { hash, successful: true } });
  });
  verifyEnvelope(xdr, await signPayment(page, xdr), account.publicKey);
  await page.click('#stellarSubmit');
  await expect.poll(() => submissions).toBe(1);
  await page.fill('#stellarUnsignedXdr', 'changed after submission');
  await expect(page.locator('#stellarStatus')).toHaveText(`Confirmed transaction: ${hash}`, { timeout: 35000 });
  await heldResponse.abort().catch(() => {});
  expect({ submissions, lookups }).toEqual({ submissions: 1, lookups: 1 });
  expect(lookupHashes).toEqual([hash]);
  await expect(page.locator('#stellarSubmit')).toBeDisabled();
  expect(await accountCounts(page)).toEqual({ accounts: 1, devices: 1 });
});

test('a failed ledger result is shown as failed rather than confirmed', async ({ session }) => {
  const { page, context, xdr } = session;
  const hash = Buffer.from(TransactionBuilder.fromXdr(xdr, Networks.TESTNET).hash()).toString('hex');
  await context.route('https://horizon-testnet.stellar.org/transactions', route => route.abort());
  await context.route('https://horizon-testnet.stellar.org/transactions/*', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' }, json: { hash, successful: false },
  }));
  await signPayment(page, xdr);
  await page.click('#stellarSubmit');
  await expect(page.locator('#stellarStatus')).toHaveText(`Transaction failed: ${hash}`);
  await expect(page.locator('#stellarSubmit')).toBeDisabled();
});

test('a lost iframe connection rejects signing and allows explicit recovery of the same account', async ({ session }) => {
  test.setTimeout(45000);
  const { page, context, account, xdr } = session;
  let heldShare;
  let signalRequest;
  const started = new Promise(resolve => { signalRequest = resolve; });
  await context.route('http://localhost:7054/v1/devices/*', route => { heldShare = route; signalRequest(); });
  await page.fill('#stellarUnsignedXdr', xdr);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#stellarSign');
  await started;
  await page.locator('#worker-iframe').evaluate(frame => frame.remove());
  await heldShare.abort().catch(() => {});
  await expect(page.locator('#stellarStatus')).toContainText(/timed out|timeout|connection/i, { timeout: 35000 });
  await expect(page.locator('#stellarSignedXdr')).toHaveValue('');
  await expect(page.locator('#stellarSubmit')).toBeDisabled();
  await context.unroute('http://localhost:7054/v1/devices/*');
  await page.click('#recoverIframeBtn');
  await page.fill('#accountIdInput', account.accountId);
  await page.click('button[onclick="confirmRecover()"]');
  await expect(page.locator('#stellarAccount')).toHaveText(`Account ${account.accountId} — ${account.publicKey}`);
  verifyEnvelope(xdr, await signPayment(page, xdr), account.publicKey);
  expect(await accountCounts(page)).toEqual({ accounts: 1, devices: 1 });
});
