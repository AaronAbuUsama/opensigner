import { Account, Asset, Networks, Operation, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk/base';

export type StellarSigningAccount = { accountId: string; publicKey: string };

export type EmbeddedWallet = {
  get(): Promise<{ id: string; address: string; chainType: string }>;
  signMessage(message: Uint8Array, options: { hashMessage: false }): Promise<string>;
};

export type AccountWallet<RecoveryParams> = EmbeddedWallet & {
  list(params: { accountType: 'Externally Owned Account'; chainType: 'SVM'; limit: number }): Promise<Array<{ id: string; address: string; chainType: string }>>;
  create(params: { accountType: 'Externally Owned Account'; chainType: 'SVM'; recoveryParams: RecoveryParams }): Promise<{ id: string; address: string; chainType: string }>;
};

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fromBase58(value: string): Uint8Array {
  if (!value) throw new Error('Empty Base58 value');
  if (value.length > 128) throw new Error('Base58 value is too long');
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid Base58 value');
    number = number * 58n + BigInt(digit);
  }
  let hex = number === 0n ? '' : number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array((value.match(/^1*/)?.[0].length ?? 0) + hex.length / 2);
  const offset = bytes.length - hex.length / 2;
  for (let i = 0; i < hex.length; i += 2) bytes[offset + i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

export function stellarAccount(account: { id: string; address: string; chainType: string }): StellarSigningAccount {
  if (account.chainType !== 'SVM') throw new Error('Account is not Ed25519');
  const publicKeyBytes = fromBase58(account.address);
  if (publicKeyBytes.length !== 32) throw new Error('Invalid Ed25519 public key');
  return { accountId: account.id, publicKey: StrKey.encodeEd25519PublicKey(publicKeyBytes) };
}

export async function getOrCreateAccount<RecoveryParams>(
  wallet: AccountWallet<RecoveryParams>, recoveryParams: RecoveryParams,
): Promise<StellarSigningAccount> {
  const listed = await wallet.list({ accountType: 'Externally Owned Account', chainType: 'SVM', limit: 100 });
  if (listed.some((account) => !['EVM', 'SVM'].includes(account.chainType))) {
    throw new Error('Account types are unavailable; cannot safely create another account');
  }
  const accounts = listed.filter((account) => account.chainType === 'SVM');
  if (accounts.length === 0) {
    return stellarAccount(await wallet.create({ accountType: 'Externally Owned Account', chainType: 'SVM', recoveryParams }));
  }
  const active = await wallet.get().catch(() => null);
  if (active && accounts.some((account) => account.id === active.id)) return stellarAccount(active);
  throw new Error('Recover an existing Ed25519 account before creating another');
}

export async function signTransaction(
  wallet: EmbeddedWallet,
  input: { accountId: string; transactionXdr: string; networkPassphrase: string },
): Promise<{ signedTransactionXdr: string; publicKey: string; transactionHash: string }> {
  if (input.networkPassphrase !== Networks.TESTNET) throw new Error('Only Stellar testnet is supported');
  const account = await wallet.get();
  if (account.id !== input.accountId) throw new Error('Requested account is not active');
  const { publicKey } = stellarAccount(account);
  const { transaction } = parsePayment(input.transactionXdr);
  if (transaction.source !== publicKey) throw new Error('Expected a payment from the selected account');

  const hash = transaction.hash();
  const signature = fromBase58(await wallet.signMessage(hash, { hashMessage: false }));
  if (signature.length !== 64) throw new Error('Invalid Ed25519 signature length');
  transaction.addSignature(publicKey, btoa(String.fromCharCode(...signature)));
  return {
    signedTransactionXdr: transaction.toXdr(),
    publicKey,
    transactionHash: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export function buildPaymentXdr(input: {
  publicKey: string; destination: string; amount: string; sequence: string;
}): string {
  if (!StrKey.isValidEd25519PublicKey(input.publicKey) || !StrKey.isValidEd25519PublicKey(input.destination)) {
    throw new Error('Invalid Stellar address');
  }
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(input.amount) || BigInt(input.amount.replace('.', '')) <= 0n) {
    throw new Error('Invalid XLM amount');
  }
  return new TransactionBuilder(new Account(input.publicKey, input.sequence), {
    fee: '100', networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.payment({ destination: input.destination, asset: Asset.native(), amount: input.amount }))
    .setTimeout(300).build().toXdr();
}

export function paymentDetails(transactionXdr: string): { source: string; destination: string; amount: string; fee: string } {
  const { transaction, operation } = parsePayment(transactionXdr);
  return { source: transaction.source, destination: operation.destination, amount: operation.amount, fee: transaction.fee };
}

function parsePayment(transactionXdr: string) {
  const transaction = TransactionBuilder.fromXdr(transactionXdr, Networks.TESTNET);
  if (!(transaction instanceof Transaction) || transaction.toEnvelope().type !== 'envelopeTypeTx') {
    throw new Error('Unsupported transaction envelope');
  }
  const [operation] = transaction.operations;
  if (transaction.operations.length !== 1 || operation?.type !== 'payment' || !operation.asset.isNative()
    || !StrKey.isValidEd25519PublicKey(operation.destination) || BigInt(operation.amount.replace('.', '')) <= 0n
    || (operation.source && operation.source !== transaction.source)) {
    throw new Error('Only one positive XLM payment from the transaction source to a G-address is supported');
  }
  return { transaction, operation };
}
