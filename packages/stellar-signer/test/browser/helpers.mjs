import { createPublicKey, verify } from 'node:crypto';
import { expect } from '@playwright/test';
import { Networks, StrKey, TransactionBuilder } from '@stellar/stellar-sdk/base';

export async function createProject(request, name) {
  const registration = await request.post('http://localhost:7053/register', { data: { name, generate_encryption_key: true } });
  expect(registration.ok()).toBe(true);
  const project = await registration.json();
  const provider = await request.post('http://localhost:7053/project/providers', {
    headers: { 'X-API-Key': project.api_key, 'X-API-Secret': project.api_secret },
    data: { providers: { custom: { jwk: 'http://authservice:3000/.well-known/jwks.json' } } },
  });
  expect(provider.ok()).toBe(true);
  return project;
}

export async function mockStellarBalance(context) {
  await context.route('https://horizon-testnet.stellar.org/**', route => route.fulfill({
    headers: { 'access-control-allow-origin': '*' },
    json: { sequence: '1', balances: [{ asset_type: 'native', balance: '10000.0000000' }] },
  }));
}

export async function configureProject(page, project) {
  await page.fill('#existingShieldProjectId', project.id);
  await page.fill('#existingShieldApiKey', project.api_key);
  await page.fill('#existingShieldEncryptionPart', project.encryption_part);
  await page.click('button[onclick="useExistingShieldProject()"]');
  await expect(page.locator('#existingShieldStatus')).toHaveText('Project loaded for recovery');
}

export async function registerUser(page, credentials) {
  await page.locator('.tabs .tab').nth(1).click();
  await page.fill('#registerEmail', credentials.email);
  await page.fill('#registerUsername', credentials.username);
  await page.fill('#registerName', 'Stellar browser test');
  await page.fill('#registerPassword', credentials.password);
  await page.click('#register button');
  await expect(page.locator('#authStatus')).toContainText('Registration successful');
}

export async function login(page, credentials) {
  await page.locator('.tabs .tab').nth(0).click();
  await page.fill('#loginUsername', credentials.username);
  await page.fill('#loginPassword', credentials.password);
  await page.click('#login button');
  await expect(page.locator('#authStatus')).toContainText('Login successful');
  await page.click('#getJwtBtn');
  await expect(page.locator('#authStatus')).toContainText('JWT token obtained');
}

export async function createAccount(page) {
  await page.selectOption('#chainType', 'SVM');
  await page.click('#createIframeBtn');
  await expect(page.locator('#stellarAccount')).toContainText(/Account .* — G/);
  const [, accountId, publicKey] = (await page.locator('#stellarAccount').textContent()).match(/Account ([\w-]+) — (G\w+)/);
  return { accountId, publicKey };
}

export async function signPayment(page, transactionXdr) {
  await page.fill('#stellarUnsignedXdr', transactionXdr);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#stellarSign');
  await expect(page.locator('#stellarSignedXdr')).not.toHaveValue('');
  return page.locator('#stellarSignedXdr').inputValue();
}

export function verifyEnvelope(unsignedXdr, signedXdr, publicKey) {
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

export async function accountCounts(page) {
  return page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${jwtToken}` };
    const accounts = await fetch(`${HOT_STORAGE_SERVER}/v2/accounts?chainType=SVM`, { headers }).then(r => r.json());
    const devices = await fetch(`${HOT_STORAGE_SERVER}/v1/devices`, { headers }).then(r => r.json());
    return { accounts: accounts.data.length, devices: devices.data.length };
  });
}
