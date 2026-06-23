# Time-locked vault

The vault holds one configured Soroban token and queues owner-authorized
withdrawals behind a fixed delay. Pending withdrawals can be cancelled by the
owner. Execution is permissionless after `unlock_at`.

## Build and upload

From `contracts/`:

```bash
cargo build --release --target wasm32-unknown-unknown -p vault

stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/vault.wasm \
  --network testnet
```

Set the returned hash in the wallet environment:

```bash
NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET=<64-character-wasm-hash>
```

The UI can then deploy and initialize vault instances from `/vault`. Existing
vault contract addresses can also be attached without configuring a WASM hash.
