# Stellar signer

This package connects an OpenSigner Ed25519 account to a standard Stellar testnet XLM payment. The transaction body and network hash come from `@stellar/stellar-sdk`; the existing OpenSigner iframe supplies the detached Ed25519 signature. The package does not submit transactions or handle key shares.

## Local demo

From the repository root, copy `.env.example` to `.env` and generate each required secret as described there. Start the local deployment, then open `http://localhost:7051`:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build postgres auth_service hot_storage cold_storage iframe iframe-sample
```

1. Create a Shield project in the sample page and save its project ID, API key, and encryption part. Set up its auth provider once.
2. Register a local user, log in, and click **Get JWT Token**.
3. Select **Ed25519 (Solana / Stellar)** and click **Create (iFrame)**. The page shows the corresponding Stellar G-address and account ID.
4. Fund that address on Stellar testnet. Enter a funded recipient G-address and an XLM amount. Click **Build payment**, **Confirm and sign**, then **Submit to testnet**. Signing and submission are separate buttons.
5. To exercise recovery, use a fresh browser context. Enter the saved Shield project values under **Use an existing project for recovery**, log in as the same user, get a JWT, and click **Recover (iFrame)** with the original account ID. The G-address must match. Build and sign another payment without submitting it.

The sample's project setup and local HTTP origins are for development. A hosted deployment must place project configuration and credentials behind its own trusted service, serve the app and iframe over TLS on separate origins, and configure the allowed origins accordingly.

## API

`stellarAccount(account)` converts the iframe's Base58 Ed25519 public key to a Stellar G-address. `getOrCreateAccount(wallet, recoveryParams)` returns an active Ed25519 account, creates one if none exists, and requires recovery when an account exists but is not active. `signTransaction(wallet, { accountId, transactionXdr, networkPassphrase })` returns signed XDR and the transaction hash. The `wallet` argument is the existing browser signer bridge, with `get()` and `signMessage(bytes, { hashMessage: false })`; the sample page uses the pinned iframe directly.

The first release accepts only one positive native XLM payment in a V1 transaction envelope on `Networks.TESTNET`, with the selected account as the transaction source and a G-address recipient. It rejects legacy V0 and fee-bump envelopes, Soroban authorization entries, other operations and assets, account mismatches, and malformed signatures. Existing envelope signatures are preserved by the SDK. Internal account identifiers and Base58 public keys remain unchanged; the same Ed25519 key can be represented as a Solana address or a Stellar G-address.

## Verification and dependencies

Run `pnpm install --frozen-lockfile`, then `pnpm --filter @opensigner/stellar-signer test`. Run `go test -race ./...` in `hot_storage/sample`. The tests include a fixed hash vector from Stellar Base, an independent Node Ed25519 signer/verifier, unsupported inputs, preserved envelope signatures, account-selection failures, and chain-type storage filtering/migration.

Set `TEST_POSTGRES_DSN` to a PostgreSQL connection URL to run the migration test on PostgreSQL as well as SQLite. It creates and removes an isolated test schema, verifies that a forced backfill error rolls back the new column, retries successfully, preserves ownership and soft-deleted rows, and checks legacy model reads/EVM writes after the upgrade. The Go CI job provisions the pinned PostgreSQL image and enables this test automatically.

With the stack running, install Chromium using `pnpm exec playwright install chromium`, then run `pnpm test:browser`. The journey test uses the real iframe, auth, hot storage, and Shield. It creates an account, verifies a signature independently, rejects a bad recovery, recovers in a fresh browser context, and verifies another signature from the same public key. Its Stellar balance lookup is mocked; signing and recovery are not. These checks run in separate deterministic and browser CI jobs.

Three additional browser cases inject failures: a stalled submission response, a failed ledger result, and a lost iframe during signing. The submission test checks that the original transaction hash is looked up once even if the input changes, without a second POST. The iframe test checks that timeout discards the dead connection and permits explicit recovery and another signature from the same account. Stellar network responses are simulated in these failure tests; signatures still come from the real iframe. Network requests and iframe RPCs have 30-second limits.

Run `pnpm test:testnet` for the separate network smoke test. It funds new test accounts through Friendbot, builds/signs/submits one XLM payment through the sample, checks Horizon confirmation and the balance change, and repeats the fresh-browser recovery check. The command does not retry payment creation or submission. The executed smoke test confirmed transaction `9fc987966c326054358ca27071ea60c5052f8b88fbb7eb427ad000cc22cf31f4`.

Tested pins: OpenSigner base `a1fdc2d`, Openfort JS reference `f4aa6ca`, `@stellar/stellar-sdk` `17.1.0`, Shield `v0.3.2` image `sha256:e8510ae4...`, iframe `0.4.51` image `sha256:d9e51310...`, Penpal `7.0.6`, Node 24, pnpm 10.28.2, and Go 1.27.1. The runtime uses the direct iframe protocol; the Openfort JS checkout is a reference, rather than a tested runtime dependency. The iframe image contains the signing implementation but does not publish source/build provenance in its image labels; its source repository/commit remains unresolved. The deployment reproduces that binary by digest.

The required upstream inquiry is the source repository, matching commit, license, and build instructions for the iframe digest in `docker-compose.yml`. The binary's SVM raw-signing and recovery protocol has been verified locally; rebuilding that binary from source has not.

On first upgrade, the additive `chain_type` migration classifies old valid 32-byte Base58 addresses as SVM and keeps legacy EVM behavior for the remaining rows. Schema expansion and backfill share a transaction. Upgrade hot storage before deploying the Stellar client. The client rejects missing account-type metadata rather than creating another key. Rolling back to the previous server preserves the new column and legacy EVM reads/writes, but that server does not return or persist chain type; disable the Stellar client and Ed25519 account creation during rollback.
