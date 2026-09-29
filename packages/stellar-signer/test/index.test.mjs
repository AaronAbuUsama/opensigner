import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { Account, Asset, Networks, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { buildPaymentXdr, getOrCreateAccount, paymentDetails, signTransaction, stellarAccount } from '../dist/index.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toBase58(bytes) {
  let number = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let text = '';
  while (number) {
    text = alphabet[Number(number % 58n)] + text;
    number /= 58n;
  }
  const firstNonzero = bytes.findIndex((byte) => byte !== 0);
  return `${'1'.repeat(firstNonzero < 0 ? bytes.length : firstNonzero)}${text}`;
}

const seed = Buffer.alloc(32, 7);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});
const publicKeyBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const publicKey = StrKey.encodeEd25519PublicKey(publicKeyBytes);
const embeddedAccount = { id: 'account-1', address: toBase58(publicKeyBytes), chainType: 'SVM' };
const legacyXdr = 'AAAAAAtjwtJadppTmm0NtAU99BFxXXfzPO1N/SqR43Z8aXqXAAAAZAAIj6YAAAACAAAAAAAAAAEAAAAB0QAAAAAAAAEAAAAAAAAAAQAAAADLa6390PDAqg3qDLpshQxS+uVw3ytSgKRirQcInPWt1QAAAAAAAAAAA1Z+AAAAAAAAAAABfGl6lwAAAEBC655+8Izq54MIZrXTVF/E1ycHgQWpVcBD+LFkuOjjJd995u/7wM8sFqQqambL0/ME2FTOtxMO65B9i3eAIu4P';

function paymentXdr() {
  return new TransactionBuilder(new Account(publicKey, '1'), {
    fee: '100', networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: 10000000000 },
  }).addOperation(Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '1' })).build().toXdr();
}

test('the existing Stellar hash fixture remains stable', () => {
  assert.equal(Buffer.from(TransactionBuilder.fromXdr(legacyXdr, Networks.PUBLIC).hash()).toString('hex'), 'a84d534b3742ad89413bdbf259e02fa4c5d039123769e9bcc63616f723a2bcd5');
});

test('signs exactly the Stellar hash and preserves the transaction', async () => {
  const unsignedXdr = paymentXdr();
  const expectedHash = TransactionBuilder.fromXdr(unsignedXdr, Networks.TESTNET).hash();
  const wallet = {
    get: async () => embeddedAccount,
    signMessage: async (bytes, options) => {
      assert.deepEqual(bytes, expectedHash);
      assert.deepEqual(options, { hashMessage: false });
      return toBase58(sign(null, bytes, privateKey));
    },
  };
  const result = await signTransaction(wallet, { accountId: embeddedAccount.id, transactionXdr: unsignedXdr, networkPassphrase: Networks.TESTNET });
  const signed = TransactionBuilder.fromXdr(result.signedTransactionXdr, Networks.TESTNET);
  assert.equal(result.publicKey, publicKey);
  assert.equal(result.transactionHash, Buffer.from(expectedHash).toString('hex'));
  assert.deepEqual(signed.hash(), expectedHash);
  assert.equal(signed.signatures.length, 1);
  assert.equal(verify(null, expectedHash, createPublicKey(privateKey), new Uint8Array(signed.signatures[0].signature.value)), true);
  assert.equal(stellarAccount(embeddedAccount).publicKey, publicKey);
});

test('rejects wrong account, network, and signer response', async () => {
  const transactionXdr = paymentXdr();
  const input = { accountId: embeddedAccount.id, transactionXdr, networkPassphrase: Networks.TESTNET };
  const wallet = { get: async () => embeddedAccount, signMessage: async () => toBase58(Buffer.alloc(64)) };
  await assert.rejects(signTransaction(wallet, { ...input, accountId: 'other' }), /not active/);
  await assert.rejects(signTransaction(wallet, { ...input, networkPassphrase: Networks.PUBLIC }), /testnet/);
  await assert.rejects(signTransaction(wallet, input), /Invalid signature/);
});

test('reuses an active Ed25519 account and never creates over a recovery gap', async () => {
  let creates = 0;
  const wallet = {
    get: async () => embeddedAccount,
    list: async () => [embeddedAccount],
    create: async (params) => {
      assert.deepEqual(params, { accountType: 'Externally Owned Account', chainType: 'SVM', recoveryParams: {} });
      creates++; return embeddedAccount;
    },
    signMessage: async () => '',
  };
  assert.deepEqual(await getOrCreateAccount(wallet, {}), { accountId: embeddedAccount.id, publicKey });
  wallet.get = async () => { throw new Error('fresh browser'); };
  await assert.rejects(getOrCreateAccount(wallet, {}), /Recover an existing/);
  assert.equal(creates, 0);
  wallet.list = async () => [{ ...embeddedAccount, chainType: undefined }];
  await assert.rejects(getOrCreateAccount(wallet, {}), /cannot safely create another account/);
  assert.equal(creates, 0);
  wallet.list = async () => [];
  assert.deepEqual(await getOrCreateAccount(wallet, {}), { accountId: embeddedAccount.id, publicKey });
  assert.equal(creates, 1);
});

test('builds a single native payment from an exact decimal amount', () => {
  const xdr = buildPaymentXdr({ publicKey, destination: publicKey, amount: '1.0000001', sequence: '1' });
  assert.deepEqual(paymentDetails(xdr).destination, publicKey);
  assert.deepEqual(paymentDetails(xdr).amount, '1.0000001');
  assert.throws(() => buildPaymentXdr({ publicKey, destination: publicKey, amount: '0.00000001', sequence: '1' }), /Invalid XLM amount/);
  assert.throws(() => buildPaymentXdr({ publicKey, destination: publicKey, amount: '0', sequence: '1' }), /Invalid XLM amount/);
});

test('keeps an existing envelope signature', async () => {
  const transaction = TransactionBuilder.fromXdr(paymentXdr(), Networks.TESTNET);
  transaction.addSignature(publicKey, sign(null, transaction.hash(), privateKey).toString('base64'));
  const first = new Uint8Array(transaction.signatures[0].signature.value);
  const wallet = {
    get: async () => embeddedAccount,
    signMessage: async (bytes) => toBase58(sign(null, bytes, privateKey)),
  };
  const result = await signTransaction(wallet, { accountId: embeddedAccount.id, transactionXdr: transaction.toXdr(), networkPassphrase: Networks.TESTNET });
  const signed = TransactionBuilder.fromXdr(result.signedTransactionXdr, Networks.TESTNET);
  assert.equal(signed.signatures.length, 2);
  assert.deepEqual(new Uint8Array(signed.signatures[0].signature.value), first);
});

test('rejects malformed and unsupported transactions before asking the iframe to sign', async () => {
  const builder = () => new TransactionBuilder(new Account(publicKey, '1'), {
    fee: '100', networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: 10000000000 },
  });
  const payment = (overrides = {}) => Operation.payment({ destination: publicKey, asset: Asset.native(), amount: '1', ...overrides });
  const anotherKey = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 8));
  const unsupported = [
    'malformed XDR', legacyXdr,
    TransactionBuilder.buildFeeBumpTransaction(publicKey, '100', TransactionBuilder.fromXdr(paymentXdr(), Networks.TESTNET), Networks.TESTNET).toXdr(),
    builder().addOperation(Operation.manageData({ name: 'test', value: 'value' })).build().toXdr(),
    builder().addOperation(payment()).addOperation(payment()).build().toXdr(),
    builder().addOperation(payment({ asset: new Asset('USD', publicKey) })).build().toXdr(),
    builder().addOperation(payment({ source: anotherKey })).build().toXdr(),
  ];
  let calls = 0;
  const wallet = { get: async () => embeddedAccount, signMessage: async () => { calls++; return ''; } };
  for (const transactionXdr of unsupported) {
    await assert.rejects(signTransaction(wallet, { accountId: embeddedAccount.id, transactionXdr, networkPassphrase: Networks.TESTNET }));
  }
  assert.equal(calls, 0);
});

test('validates Base58 key and signature boundaries', async () => {
  assert.equal(stellarAccount({ ...embeddedAccount, address: '1'.repeat(32) }).publicKey, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  assert.throws(() => stellarAccount({ ...embeddedAccount, address: '0' }), /Base58/);
  assert.throws(() => stellarAccount({ ...embeddedAccount, address: '1'.repeat(31) }), /public key/);
  const wallet = { get: async () => embeddedAccount, signMessage: async () => '1'.repeat(63) };
  await assert.rejects(signTransaction(wallet, { accountId: embeddedAccount.id, transactionXdr: paymentXdr(), networkPassphrase: Networks.TESTNET }), /signature length/);
});
