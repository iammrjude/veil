'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { VeilLogo } from '@/components/VeilLogo'
import { derToRawSignature, bufferToHex } from '@veil/utils'
import { deriveFeePayerKeypair } from '@/lib/deriveFeePayer'
import { getNetwork } from '@/lib/network'
import {
  rpc as SorobanRpc, Contract, TransactionBuilder, BASE_FEE,
  Account, Keypair, scValToNative,
} from '@stellar/stellar-sdk'

const network = getNetwork()

type Step = 'idle' | 'authenticating' | 'done' | 'error'

export default function RecoverPage() {
  const router = useRouter()
  const [step, setStep]               = useState<Step>('idle')
  const [error, setError]             = useState<string | null>(null)
  const [walletInput, setWalletInput] = useState('')

  async function handleRecover() {
    const walletAddress = walletInput.trim()
    if (!walletAddress.startsWith('C') || walletAddress.length !== 56) {
      setError('Enter a valid C... wallet address.')
      return
    }

    setError(null)
    setStep('authenticating')

    try {
      const server = new SorobanRpc.Server(network.rpcUrl)

      // ── 1. Fetch on-chain signers ────────────────────────────────────────
      const dummyKp      = Keypair.random()
      const sourceAcct   = new Account(dummyKp.publicKey(), '0')
      const walletContract = new Contract(walletAddress)

      const tx = new TransactionBuilder(sourceAcct, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(walletContract.call('get_signers'))
        .setTimeout(30)
        .build()

      const sim = await server.simulateTransaction(tx)
      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error('Could not read wallet on-chain. Check the address and try again.')
      }

      const simResult  = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
      if (!simResult) throw new Error('No result from contract simulation.')

      // Parse the XDR ScVal directly — avoids scValToNative runtime differences
      // get_signers returns Map<u32, BytesN<65>> → SCV_MAP of (SCV_U32, SCV_BYTES) entries
      let publicKeys: Uint8Array[] = []
      try {
        const entries = simResult.retval.map() as Array<{ val: () => { bytes: () => Buffer } }>
        publicKeys = entries.map(e => new Uint8Array(e.val().bytes()))
      } catch {
        // Fallback: scValToNative handles all possible return shapes
        const raw = scValToNative(simResult.retval)
        if (Array.isArray(raw)) {
          publicKeys = raw as Uint8Array[]
        } else if (raw instanceof Map) {
          publicKeys = Array.from((raw as Map<number, Uint8Array>).values())
        } else {
          publicKeys = Object.values(raw as Record<string, Uint8Array>)
        }
      }
      if (publicKeys.length === 0) throw new Error('No signers found on this wallet.')

      // ── 2. Discoverable passkey assertion ────────────────────────────────
      // Empty allowCredentials lets the OS show ALL available passkeys so
      // the user can pick the right one even on a new device.
      const challenge = crypto.getRandomValues(new Uint8Array(32))
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [],
          userVerification: 'required',
        },
      }) as PublicKeyCredential | null

      if (!assertion) throw new Error('Passkey prompt was cancelled.')

      const response      = assertion.response as AuthenticatorAssertionResponse
      const authData      = new Uint8Array(response.authenticatorData)
      const clientDataJSON = new Uint8Array(response.clientDataJSON)
      const sigDer        = new Uint8Array(response.signature)
      const rawSig        = derToRawSignature(sigDer.buffer.slice(sigDer.byteOffset, sigDer.byteOffset + sigDer.byteLength) as ArrayBuffer)

      // ── 3. Verify signature against each on-chain public key ─────────────
      // WebAuthn signed: SHA-256(authData || SHA-256(clientDataJSON))
      // SubtleCrypto ECDSA hashes internally so we pass authData || SHA-256(clientDataJSON)
      const clientDataHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', clientDataJSON.buffer as ArrayBuffer)
      )
      const message = new Uint8Array([...authData, ...clientDataHash])

      let matchedHex: string | null = null

      for (const pubKeyBytes of publicKeys) {
        try {
          const cryptoKey = await crypto.subtle.importKey(
            'raw',
            pubKeyBytes.buffer as ArrayBuffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
          )
          const valid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            cryptoKey,
            rawSig.buffer as ArrayBuffer,
            message.buffer as ArrayBuffer
          )
          if (valid) {
            matchedHex = bufferToHex(pubKeyBytes)
            break
          }
        } catch {
          // Try next key
        }
      }

      if (!matchedHex) {
        throw new Error(
          'This passkey does not match any signer on this wallet. Make sure you are using the correct passkey and wallet address.'
        )
      }

      // ── 4. Restore localStorage + session ────────────────────────────────
      localStorage.setItem('invisible_wallet_address',    walletAddress)
      localStorage.setItem('invisible_wallet_key_id',     assertion.id)
      localStorage.setItem('invisible_wallet_public_key', matchedHex)
      sessionStorage.setItem('invisible_wallet_address', walletAddress)

      // Derive fee-payer from the passkey credential ID — recovers the same
      // keypair that was created during initial registration, so any funds
      // on the fee-payer G... account are immediately accessible again.
      const derived = await deriveFeePayerKeypair(assertion.id)
      localStorage.setItem('veil_signer_secret', derived.secret())
      localStorage.setItem('veil_signer_public_key', derived.publicKey())
      sessionStorage.setItem('veil_signer_secret', derived.secret())

      setStep('done')
      setTimeout(() => router.push('/dashboard'), 800)

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('NotAllowedError') || msg.includes('not allowed')
          ? 'Biometric verification was cancelled. Please try again.'
          : msg
      )
      setStep('error')
    }
  }

  return (
    <div className="wallet-shell" style={{ justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem', minHeight: '100dvh' }}>
      <div style={{ maxWidth: 400, width: '100%' }}>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', marginBottom: '2.5rem' }}>
          <VeilLogo size={48} />
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem' }}>
              Recover wallet
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.375rem', lineHeight: 1.6 }}>
              Enter your wallet address, then verify with your passkey
            </p>
          </div>
        </div>

        {(step === 'idle' || step === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                WALLET ADDRESS
              </label>
              <input
                className="input-field mono"
                type="text"
                placeholder="C..."
                value={walletInput}
                onChange={e => { setWalletInput(e.target.value.trim()); setError(null) }}
                autoComplete="off"
                spellCheck={false}
              />
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)', marginTop: '0.5rem', lineHeight: 1.5 }}>
                Find this on another device where your wallet is open — it starts with C.
              </p>
            </div>

            {error && (
              <div style={{ borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', padding: '0.75rem 1rem' }}>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(252,165,165,1)', lineHeight: 1.5 }}>{error}</p>
              </div>
            )}

            <button
              className="btn-gold"
              onClick={handleRecover}
              disabled={walletInput.length < 10}
            >
              Verify with passkey
            </button>
            <button className="btn-ghost" onClick={() => router.push('/')}>
              Back
            </button>
          </div>
        )}

        {step === 'authenticating' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey...</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
              Approve the prompt on your device
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto 0.75rem' }}>
              <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5" />
              <path d="M13 20.5l5 5 9-9" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p style={{ fontWeight: 500 }}>Wallet recovered</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.375rem' }}>Redirecting to dashboard...</p>
          </div>
        )}
      </div>
    </div>
  )
}
