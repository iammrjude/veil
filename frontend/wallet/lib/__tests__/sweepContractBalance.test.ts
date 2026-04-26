/**
 * Unit tests for sweepContractBalance.
 *
 * All Soroban RPC interactions and WebAuthn calls are mocked — no real network
 * calls are made. The mock structure mirrors the pattern established in the SDK's
 * useInvisibleWallet tests.
 */

import { sweepContractBalance } from '../sweepContractBalance'
import { rpc as SorobanRpc, Keypair, Account, Networks } from '@stellar/stellar-sdk'

// ── Module-level mock ─────────────────────────────────────────────────────────
// Jest hoists jest.mock() above imports automatically.

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    // Override scValToNative so we can control what "balance" is returned
    scValToNative: jest.fn(),
    // Override XDR constructors used when attaching the WebAuthn signature
    xdr: {
      ...actual.xdr,
      SorobanAddressCredentials: jest.fn().mockImplementation(() => ({})),
      SorobanCredentials: {
        ...actual.xdr.SorobanCredentials,
        sorobanCredentialsAddress: jest.fn().mockReturnValue({}),
      },
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn(),
      assembleTransaction: jest.fn(),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: jest.fn(),
      },
    },
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const { scValToNative }          = jest.requireMock('@stellar/stellar-sdk') as { scValToNative: jest.Mock }
const { isSimulationError }      = (jest.requireMock('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk')).rpc.Api as { isSimulationError: jest.Mock }
const { assembleTransaction }    = (jest.requireMock('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk')).rpc as { assembleTransaction: jest.Mock }

// Simulated RPC response shapes
const makeBalanceSim = (balance: bigint) => {
  scValToNative.mockReturnValueOnce(balance)
  return { latestLedger: 100, result: { retval: {}, auth: [] } }
}

const makeTransferSim = (auth: unknown[] = []) => ({
  latestLedger: 100,
  result: { retval: {}, auth },
})

const makeSimError = (message = 'contract error') => ({
  error: message,
  latestLedger: 100,
})

// Mock auth entry for tests that exercise signAuthEntry
function makeMockAuthEntry() {
  const entry = {
    credentials: jest.fn(),
    rootInvocation: jest.fn().mockReturnValue({
      toXDR: jest.fn().mockReturnValue(new Uint8Array(64)),
    }),
  }
  // credentials() acts as a getter (no args) and a setter (with args)
  entry.credentials.mockImplementation((newCred?: unknown) => {
    if (newCred === undefined) {
      return {
        switch:  () => ({ value: 1 }), // SOROBAN_CREDENTIALS_ADDRESS
        address: () => ({
          address:                   () => ({}),
          nonce:                     () => 0n,
          signatureExpirationLedger: () => 0,
        }),
      }
    }
    // setter — no-op, the new credentials are embedded in the assembled tx by reference
  })
  return entry
}

// Mock assembled transaction returned by assembleTransaction().build()
const mockAssembled = { sign: jest.fn() }

// ── Test constants ────────────────────────────────────────────────────────────

const CONTRACT_ADDRESS  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const FEE_PAYER_KP      = Keypair.random()
const RPC_URL           = 'https://soroban-testnet.stellar.org'
const NETWORK_PASSPHRASE = Networks.TESTNET

// Fake WebAuthnSignature returned by the mock signAuthEntry
const FAKE_WEBAUTHN_SIG = {
  publicKey:      new Uint8Array(65),
  authData:       new Uint8Array(37),
  clientDataJSON: new Uint8Array(100),
  signature:      new Uint8Array(64),
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('sweepContractBalance', () => {
  let mockServer: {
    simulateTransaction: jest.Mock
    sendTransaction:     jest.Mock
    getTransaction:      jest.Mock
    getAccount:          jest.Mock
  }
  let mockSignAuthEntry: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()

    // Fresh server mock for every test
    mockServer = {
      simulateTransaction: jest.fn(),
      sendTransaction:     jest.fn(),
      getTransaction:      jest.fn(),
      getAccount:          jest.fn().mockResolvedValue(
        new Account(FEE_PAYER_KP.publicKey(), '100')
      ),
    }
    ;(SorobanRpc.Server as jest.Mock).mockImplementation(() => mockServer)

    // assembleTransaction returns a builder whose build() gives mockAssembled
    assembleTransaction.mockReturnValue({ build: jest.fn().mockReturnValue(mockAssembled) })
    mockAssembled.sign.mockClear()

    // Default: simulation succeeds (not an error)
    isSimulationError.mockReturnValue(false)

    // Default signAuthEntry resolves with a valid WebAuthn signature
    mockSignAuthEntry = jest.fn().mockResolvedValue(FAKE_WEBAUTHN_SIG)
  })

  // ── Test 1 ────────────────────────────────────────────────────────────────

  it('does not build or submit a transfer when contract balance is zero', async () => {
    mockServer.simulateTransaction.mockResolvedValueOnce(makeBalanceSim(0n))

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('Contract balance is zero')

    // The balance sim was called once; the transfer sim and send were never reached
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── Test 2 ────────────────────────────────────────────────────────────────

  it('builds the correct SAC.transfer call and submits the transaction', async () => {
    const BALANCE = 5_000_000n // 0.5 XLM in stroops
    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(BALANCE))   // balance check
      .mockResolvedValueOnce(makeTransferSim())          // transfer simulation

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'txhash-abc' })
    mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const hash = await sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    // Both simulations were called and the transaction was submitted
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2)
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1)
    expect(hash).toBe('txhash-abc')

    // The assembled tx was signed with the fee-payer keypair
    expect(mockAssembled.sign).toHaveBeenCalledWith(FEE_PAYER_KP)
  })

  // ── Test 3 ────────────────────────────────────────────────────────────────

  it('calls signAuthEntry with a 32-byte SHA-256 payload when auth entry is present', async () => {
    const BALANCE = 10_000_000n
    const authEntry = makeMockAuthEntry()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(BALANCE))
      .mockResolvedValueOnce(makeTransferSim([authEntry]))

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'tx-signed' })
    mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' })

    await sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    expect(mockSignAuthEntry).toHaveBeenCalledTimes(1)

    const [payload] = mockSignAuthEntry.mock.calls[0] as [Uint8Array]
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(payload.byteLength).toBe(32) // SHA-256 output is always 32 bytes
  })

  // ── Test 4 ────────────────────────────────────────────────────────────────

  it('polls getTransaction until SUCCESS and resolves with the transaction hash', async () => {
    jest.useFakeTimers()
    const BALANCE = 1_000_000n

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(BALANCE))
      .mockResolvedValueOnce(makeTransferSim())

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'polled-hash' })
    mockServer.getTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' })

    const promise = sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    // Advance through 2 poll intervals (2 × 1000 ms)
    await jest.advanceTimersByTimeAsync(3_000)

    const hash = await promise
    expect(hash).toBe('polled-hash')
    expect(mockServer.getTransaction).toHaveBeenCalledTimes(3)

    jest.useRealTimers()
  })

  // ── Test 5 ────────────────────────────────────────────────────────────────

  it('throws when the transfer simulation returns an error', async () => {
    const BALANCE = 2_000_000n

    mockServer.simulateTransaction.mockResolvedValueOnce(makeBalanceSim(BALANCE))

    // Transfer simulation is an error
    isSimulationError
      .mockReturnValueOnce(false) // balance check passes
      .mockReturnValueOnce(true)  // transfer sim fails
    mockServer.simulateTransaction.mockResolvedValueOnce(makeSimError('insufficient reserves'))

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('Simulation failed')

    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── Test 6 ────────────────────────────────────────────────────────────────

  it('throws when the user cancels the passkey prompt (signAuthEntry returns null)', async () => {
    const BALANCE = 3_000_000n
    const authEntry = makeMockAuthEntry()

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(BALANCE))
      .mockResolvedValueOnce(makeTransferSim([authEntry]))

    // Simulate user pressing "Cancel" on the biometric prompt
    mockSignAuthEntry.mockResolvedValue(null)

    await expect(
      sweepContractBalance(CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE)
    ).rejects.toThrow('WebAuthn signing was cancelled')

    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // ── Test 7 ────────────────────────────────────────────────────────────────

  it('throws after the maximum number of poll attempts when the transaction stays NOT_FOUND', async () => {
    jest.useFakeTimers()
    const BALANCE = 7_000_000n

    mockServer.simulateTransaction
      .mockResolvedValueOnce(makeBalanceSim(BALANCE))
      .mockResolvedValueOnce(makeTransferSim())

    mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'slow-hash' })
    // Always NOT_FOUND — simulates a permanent network timeout
    mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' })

    const promise = sweepContractBalance(
      CONTRACT_ADDRESS, FEE_PAYER_KP, mockSignAuthEntry, RPC_URL, NETWORK_PASSPHRASE
    )

    // Advance past 30 poll intervals (30 × 1000 ms)
    await jest.advanceTimersByTimeAsync(35_000)

    await expect(promise).rejects.toThrow('Transaction timed out')

    jest.useRealTimers()
  })
})
