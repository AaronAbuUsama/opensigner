import { randomBytes, randomUUID, createPublicKey, verify } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Keypair, Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { buildPaymentXdr } from '../../dist/index.js';

const sampleUrl = 'http://localhost:7051';
const networkSmoke = process.env.STELLAR_TESTNET_SMOKE === '1';

async function configureProject(page, project) {
  await page.fill('#existingShieldProjectId', project.id);
  await page.fill('#existingShieldApiKey', project.api_key);
  await page.fill('#existingShieldEncryptionPart', project.encryption_part);
  await page.click('button[onclick="useExistingShieldProject()"]');
  await expect(page.locator('#existingShieldStatus')).toHaveText('Project loaded for recovery');
}

async function login(page, credentials) {
  await page.locator('.tabs .tab').nth(0).click();
  await page.fill('#loginUsername', credentials.username);
  await page.fill('#loginPassword', credentials.password);
  await page.click('#login button');
  await expect(page.locator('#authStatus')).toContainText('Login successful');
  await page.click('#getJwtBtn');
  await expect(page.locator('#authStatus')).toContainText('JWT token obtained');
}

async function signPayment(page, transactionXdr) {
  await page.fill('#stellarUnsignedXdr', transactionXdr);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#stellarSign');
  await expect(page.locator('#stellarSignedXdr')).not.toHaveValue('');
  return page.locator('#stellarSignedXdr').inputValue();
}

function verifyEnvelope(unsignedXdr, signedXdr, publicKey) {
  const unsigned = TransactionBuilder.fromXdr(unsignedXdr, Networks.TESTNET);
  const signed = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET);
  expect(signed.hash()).toEqual(unsigned.hash());
  expect(signed.signatures).toHaveLength(1);
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), StrKey.decodeEd25519PublicKey(publicKey)]),
    format: 'der', type: 'spki',
  });
  expect(verify(null, unsigned.hash(), key, new Uint8Array(signed.signatures[0].signature.value))).toBe(true);
}

async function accountCounts(page) {
  return page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${jwtToken}` };
    const accounts = await fetch(`${HOT_STORAGE_SERVER}/v2/accounts?chainType=SVM`, { headers }).then(r => r.json());
    const devices = await fetch(`${HOT_STORAGE_SERVER}/v1/devices`, { headers }).then(r => r.json());
    return { accounts: accounts.data.length, devices: devices.data.length };
  });
}

test('the real iframe creates, signs, and recovers the same Stellar account', async ({ browser, request }) => {
  test.setTimeout(networkSmoke ? 180000 : 90000);
  const denied = await request.get('http://localhost:7050/index.html', { headers: { Referer: 'https://untrusted.example/' } });
  expect(denied.status()).toBe(403);
  const suffix = randomUUID().slice(0, 8);
  const credentials = { username: `stellar_${suffix}`, email: `stellar-${suffix}@example.test`, password: randomBytes(24).toString('hex') };
  const registration = await request.post('http://localhost:7053/register', { data: { name: `stellar-${suffix}`, generate_encryption_key: true } });
  expect(registration.ok()).toBe(true);
  const project = await registration.json();
  const provider = await request.post('http://localhost:7053/project/providers', {
    headers: { 'X-API-Key': project.api_key, 'X-API-Secret': project.api_secret },
    data: { providers: { custom: { jwk: 'http://authservice:3000/.well-known/jwks.json' } } },
  });
  expect(provider.ok()).toBe(true);

  const requests = [];
  const openContext = async () => {
    const context = await browser.newContext();
    context.on('request', request => requests.push(request.url()));
    if (!networkSmoke) {
      await context.route('https://horizon-testnet.stellar.org/**', route => route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: { sequence: '1', balances: [{ asset_type: 'native', balance: '10000.0000000' }] },
      }));
    }
    const page = await context.newPage();
    await page.goto(sampleUrl);
    await configureProject(page, project);
    return { context, page };
  };

  const first = await openContext();
  await first.page.locator('.tabs .tab').nth(1).click();
  await first.page.fill('#registerEmail', credentials.email);
  await first.page.fill('#registerUsername', credentials.username);
  await first.page.fill('#registerName', 'Stellar browser test');
  await first.page.fill('#registerPassword', credentials.password);
  await first.page.click('#register button');
  await expect(first.page.locator('#authStatus')).toContainText('Registration successful');
  await login(first.page, credentials);
  await first.page.selectOption('#chainType', 'SVM');
  await first.page.click('#createIframeBtn');
  await expect(first.page.locator('#stellarAccount')).toContainText(/Account .* — G/);
  const [, accountId, publicKey] = (await first.page.locator('#stellarAccount').textContent()).match(/Account ([\w-]+) — (G\w+)/);
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
