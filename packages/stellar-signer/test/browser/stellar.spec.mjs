import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { buildPaymentXdr } from '../../dist/index.js';
import { accountCounts, configureProject, createAccount, createProject, login, mockStellarBalance, registerUser, signPayment, verifyEnvelope } from './helpers.mjs';

const sampleUrl = 'http://localhost:7051';
const networkSmoke = process.env.STELLAR_TESTNET_SMOKE === '1';

test('the real iframe creates, signs, and recovers the same Stellar account', async ({ browser, request }) => {
  test.setTimeout(networkSmoke ? 180000 : 90000);
  const denied = await request.get('http://localhost:7050/index.html', { headers: { Referer: 'https://untrusted.example/' } });
  expect(denied.status()).toBe(403);
  const suffix = randomUUID().slice(0, 8);
  const credentials = { username: `stellar_${suffix}`, email: `stellar-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
  const project = await createProject(request, `stellar-${suffix}`);

  const requests = [];
  const openContext = async () => {
    const context = await browser.newContext();
    context.on('request', request => requests.push(request.url()));
    if (!networkSmoke) {
      await mockStellarBalance(context);
    }
    const page = await context.newPage();
    await page.goto(sampleUrl);
    await configureProject(page, project);
    return { context, page };
  };

  const first = await openContext();
  await registerUser(first.page, credentials);
  await login(first.page, credentials);
  const { accountId, publicKey } = await createAccount(first.page);
  const unsignedXdr = buildPaymentXdr({ publicKey, destination: publicKey, amount: '1.0000000', sequence: '1' });
  verifyEnvelope(unsignedXdr, await signPayment(first.page, unsignedXdr), publicKey);
  await first.page.evaluate(() => {
    window.originalStellarSigner = StellarSigner;
    StellarSigner = { ...StellarSigner, signTransaction: async (...args) => {
      const result = await window.originalStellarSigner.signTransaction(...args);
      await new Promise(resolve => { window.releaseStellarSign = resolve; });
      return result;
    } };
  });
  await first.page.fill('#stellarUnsignedXdr', unsignedXdr);
  first.page.once('dialog', dialog => dialog.accept());
  await first.page.click('#stellarSign');
  await first.page.waitForFunction(() => typeof window.releaseStellarSign === 'function');
  await first.page.fill('#stellarUnsignedXdr', 'changed while signing');
  await first.page.evaluate(() => { window.releaseStellarSign(); StellarSigner = window.originalStellarSigner; });
  await expect(first.page.locator('#stellarStatus')).toContainText('changed while signing');
  await expect(first.page.locator('#stellarSignedXdr')).toHaveValue('');
  await expect(first.page.locator('#stellarSubmit')).toBeDisabled();
  expect(await accountCounts(first.page)).toEqual({ accounts: 1, devices: 1 });
  expect(await first.page.locator('#output').textContent()).not.toMatch(/"(?:privateKey|share)"\s*:/);

  if (networkSmoke) {
    const destination = Keypair.random().publicKey();
    for (const address of [publicKey, destination]) {
      const funding = await request.get(`https://friendbot.stellar.org/?addr=${address}`, { timeout: 30000 });
      expect(funding.ok()).toBe(true);
    }
    await first.page.fill('#stellarDestination', destination);
    await first.page.fill('#stellarAmount', '1.0000000');
    await first.page.click('#stellarBuild');
    await expect(first.page.locator('#stellarStatus')).toContainText('Payment built');
    const networkXdr = await first.page.locator('#stellarUnsignedXdr').inputValue();
    await signPayment(first.page, networkXdr);
    const hash = Buffer.from(TransactionBuilder.fromXdr(networkXdr, Networks.TESTNET).hash()).toString('hex');
    await first.page.click('#stellarSubmit');
    await expect(first.page.locator('#stellarStatus')).toHaveText(`Confirmed transaction: ${hash}`, { timeout: 30000 });
    const confirmed = await request.get(`https://horizon-testnet.stellar.org/transactions/${hash}`);
    expect((await confirmed.json()).successful).toBe(true);
    await expect(first.page.locator('#stellarBalance')).toContainText('9998.9999900');
    console.log(`Confirmed Stellar testnet payment: ${hash}`);
  }
  await first.context.close();

  const fresh = await openContext();
  await login(fresh.page, credentials);
  await fresh.page.click('#recoverIframeBtn');
  await fresh.page.fill('#accountIdInput', randomUUID());
  await fresh.page.click('button[onclick="confirmRecover()"]');
  await expect(fresh.page.locator('#output')).toContainText('"success": false');
  await expect(fresh.page.locator('#stellarAccount')).toHaveText('No Stellar account selected');
  expect(await accountCounts(fresh.page)).toEqual({ accounts: 1, devices: 1 });

  await fresh.page.click('#recoverIframeBtn');
  await fresh.page.fill('#accountIdInput', accountId);
  await fresh.page.click('button[onclick="confirmRecover()"]');
  await expect(fresh.page.locator('#stellarAccount')).toHaveText(`Account ${accountId} — ${publicKey}`);
  verifyEnvelope(unsignedXdr, await signPayment(fresh.page, unsignedXdr), publicKey);
  expect(await accountCounts(fresh.page)).toEqual({ accounts: 1, devices: 2 });
  await fresh.context.close();

  if (!networkSmoke) {
    expect(requests.filter(url => !['localhost', 'horizon-testnet.stellar.org'].includes(new URL(url).hostname))).toEqual([]);
  }
});
