'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import {
  Horizon, Keypair, rpc as SorobanRpc, Contract, Account,
  TransactionBuilder, BASE_FEE, Asset, nativeToScVal, scValToNative,
} from '@stellar/stellar-sdk'
const Server = Horizon.Server
import { TxDetailSheet, type TxRecord } from '@/components/TxDetailSheet'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNativeAssetContractId, getNetwork } from '@/lib/network'

const network = getNetwork()

// ── Token metadata ────────────────────────────────────────────────────────────
const TOKEN_META: Record<string, { name: string; logo: string; color: string; bg: string }> = {
  XLM:  { name: 'Stellar Lumens', logo: '/tokens/xlm.png', color: '#fff',    bg: '#000' },
  USDC: { name: 'USD Coin',       logo: '/tokens/usdc.png', color: '#2775CA', bg: '#EEF4FF' },
}

// ── Simple SVG sparkline ──────────────────────────────────────────────────────
function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const w = 300, h = 64
  const xs = points.map((_, i) => (i / (points.length - 1)) * w)
  const ys = points.map(p => h - ((p - min) / range) * (h - 8) - 4)
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x},${ys[i]}`).join(' ')
  const fill = `${d} L${w},${h} L0,${h} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#sg)" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Token Page ────────────────────────────────────────────────────────────────
export default function TokenPage() {
  const router       = useRouter()
  const params       = useParams()
  const searchParams = useSearchParams()
  useInactivityLock()

  const code   = (params.code as string).toUpperCase()
  const issuer = searchParams.get('issuer') ?? null
  const meta   = TOKEN_META[code] ?? { name: code, logo: '', color: 'var(--gold)', bg: 'rgba(253,218,36,0.12)' }

  const [balance,         setBalance]         = useState<string | null>(null)
  const [contractBalance, setContractBalance] = useState<string | null>(null)
  const [feePayerBalance, setFeePayerBalance] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<TxRecord[]>([])
  const [selectedTx,   setSelectedTx]   = useState<TxRecord | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [sparkPoints,  setSparkPoints]  = useState<number[]>([])
  const [priceChange,  setPriceChange]  = useState<number | null>(null)

  const fetchData = useCallback(async () => {
    const signerSecret = sessionStorage.getItem('veil_signer_secret')
      ?? localStorage.getItem('veil_signer_secret')

    // Derive public key — prefer from secret, fall back to stored public key.
    // Never redirect to /lock here; missing secret just means read-only mode.
    let signerPublicKey: string
    if (signerSecret) {
      signerPublicKey = Keypair.fromSecret(signerSecret).publicKey()
    } else {
      const storedPubKey = localStorage.getItem('veil_signer_public_key')
      if (!storedPubKey) { router.replace('/dashboard'); return }
      signerPublicKey = storedPubKey
    }
    const walletAddress   = sessionStorage.getItem('invisible_wallet_address') ?? ''
    const horizonServer   = new Server(network.horizonUrl)

    setLoading(true)
    try {
      // ── Balance ────────────────────────────────────────────────────────────
      if (code === 'XLM') {
        // Query contract XLM (C... via Soroban RPC) and fee-payer XLM (G... via Horizon) separately
        let contractXlm = 0
        let fpXlm = 0

        if (walletAddress) {
          try {
            const rpcServer   = new SorobanRpc.Server(network.rpcUrl)
            const sacAddress  = getNativeAssetContractId()
            const sacContract = new Contract(sacAddress)
            const dummyKp     = Keypair.random()
            const dummyAcct   = new Account(dummyKp.publicKey(), '0')
            const balanceTx   = new TransactionBuilder(dummyAcct, { fee: BASE_FEE, networkPassphrase: network.networkPassphrase })
              .addOperation(sacContract.call('balance', nativeToScVal(walletAddress, { type: 'address' })))
              .setTimeout(30).build()
            const sim = await rpcServer.simulateTransaction(balanceTx)
            if (!SorobanRpc.Api.isSimulationError(sim)) {
              const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
              if (result) contractXlm = Number(scValToNative(result.retval) as bigint) / 10_000_000
            }
          } catch {}
        }

        try {
          const account = await horizonServer.loadAccount(signerPublicKey)
          const native  = account.balances.find((b: any) => b.asset_type === 'native')
          fpXlm = native ? parseFloat(native.balance) : 0
        } catch {}

        setContractBalance(contractXlm.toFixed(7))
        setFeePayerBalance(fpXlm.toFixed(7))
        setBalance((contractXlm + fpXlm).toFixed(7))
      } else {
        const account = await horizonServer.loadAccount(signerPublicKey)
        const b = (account.balances as any[]).find(b =>
          b.asset_code === code && (!issuer || b.asset_issuer === issuer)
        )
        setBalance(b ? b.balance : '0.0000000')
      }

      // ── Transaction history for this asset ────────────────────────────────
      type HorizonOp = {
        id: string; type: string
        from?: string; to?: string; funder?: string
        amount?: string; starting_balance?: string
        asset_type?: string; asset_code?: string
        source_amount?: string; source_asset_type?: string; source_asset_code?: string
        created_at: string; transaction_hash: string
      }
      const payments = await horizonServer.payments().forAccount(signerPublicKey).limit(50).order('desc').call()
      const filtered: TxRecord[] = (payments.records as HorizonOp[])
        .filter(p => {
          if (p.type === 'create_account' && code === 'XLM') return true
          if (p.type === 'payment') {
            const assetCode = p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '')
            return assetCode === code
          }
          if (p.type === 'path_payment_strict_send') {
            const srcCode = p.source_asset_type === 'native' ? 'XLM' : (p.source_asset_code ?? '')
            const dstCode = p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '')
            return srcCode === code || dstCode === code
          }
          return false
        })
        .map(p => {
          if (p.type === 'create_account') {
            return { id: p.id, type: 'received' as const, amount: p.starting_balance ?? '0', asset: 'XLM', counterparty: p.funder ?? 'Friendbot', timestamp: Math.floor(new Date(p.created_at).getTime() / 1000), hash: p.transaction_hash }
          }
          if (p.type === 'path_payment_strict_send') {
            const srcCode = p.source_asset_type === 'native' ? 'XLM' : (p.source_asset_code ?? 'XLM')
            const dstCode = p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '')
            return { id: p.id, type: 'swapped' as const, amount: p.source_amount ?? '0', asset: srcCode, destAmount: p.amount ?? '0', destAsset: dstCode, counterparty: 'Stellar DEX', timestamp: Math.floor(new Date(p.created_at).getTime() / 1000), hash: p.transaction_hash }
          }
          return {
            id: p.id,
            type: p.from === signerPublicKey ? 'sent' as const : 'received' as const,
            amount: p.amount ?? '0', asset: p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? ''),
            counterparty: p.from === signerPublicKey ? (p.to ?? '') : (p.from ?? ''),
            timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
            hash: p.transaction_hash,
          }
        })
      setTransactions(filtered)

      // ── Sparkline from balance history ────────────────────────────────────
      // Build running balance backwards from current
      const current = parseFloat(balance ?? '0')
      const pts = [current]
      let running = current
      for (const tx of filtered.slice(0, 14).reverse()) {
        const amt = parseFloat(tx.amount)
        if (tx.type === 'received') running -= amt
        else if (tx.type === 'sent') running += amt
        pts.unshift(Math.max(0, running))
      }
      setSparkPoints(pts)

      // Price change: first tx vs current
      if (pts.length > 1) {
        const first = pts[0], last = pts[pts.length - 1]
        setPriceChange(first > 0 ? ((last - first) / first) * 100 : null)
      }
    } catch (err) {
      console.error('[token]', err)
    } finally {
      setLoading(false)
    }
  }, [code, issuer, router])

  useEffect(() => { fetchData() }, [fetchData])

  const swapHref = code === 'XLM'
    ? `/swap`
    : `/swap?from=${code}${issuer ? `&issuer=${issuer}` : ''}`

  const sendHref = `/send`

  return (
    <div className="wallet-shell">
      {/* Nav */}
      <nav className="wallet-nav">
        <button onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--warm-grey)', display: 'flex', padding: '0.25rem' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '0.875rem', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>
          {code}
        </span>
        <div style={{ width: 28 }} />
      </nav>

      <main className="wallet-main">

        {/* ── Token header ── */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', paddingTop: '1rem', paddingBottom: '2rem' }}>
          {meta.logo ? (
            <div style={{ width: 64, height: 64, borderRadius: '50%', overflow: 'hidden', background: meta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Image src={meta.logo} alt={code} width={64} height={64}
                style={{ objectFit: 'contain', ...(code === 'XLM' ? { filter: 'invert(1)', padding: '10px' } : {}) }} />
            </div>
          ) : (
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(253,218,36,0.12)', border: '1px solid rgba(253,218,36,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold)' }}>
              {code[0]}
            </div>
          )}

          <div style={{ textAlign: 'center' }}>
            {loading ? (
              <>
                <div className="skeleton" style={{ width: 140, height: '2.25rem', borderRadius: 8, margin: '0 auto 0.375rem' }} />
                <div className="skeleton" style={{ width: 80, height: '1rem', borderRadius: 6, margin: '0 auto' }} />
              </>
            ) : (
              <>
                <div style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '2.25rem', color: 'var(--off-white)', lineHeight: 1.1 }}>
                  {balance !== null ? parseFloat(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}
                </div>
                <div style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.45)', marginTop: '0.25rem' }}>
                  {meta.name}
                  {priceChange !== null && (
                    <span style={{ marginLeft: '0.5rem', color: priceChange >= 0 ? 'var(--teal)' : '#FF6B6B', fontSize: '0.8125rem' }}>
                      {priceChange >= 0 ? '▲' : '▼'} {Math.abs(priceChange).toFixed(1)}%
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Sparkline chart ── */}
        {!loading && sparkPoints.length > 1 && (
          <div className="card" style={{ padding: '1rem 1rem 0.5rem', marginBottom: '1.5rem', overflow: 'hidden' }}>
            <div style={{ fontSize: '0.6875rem', fontFamily: 'Anton, Impact, sans-serif', color: 'rgba(246,247,248,0.3)', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
              BALANCE HISTORY
            </div>
            <Sparkline points={sparkPoints} color={meta.color === 'var(--gold)' ? '#FDDA24' : (code === 'USDC' ? '#2775CA' : '#FFFFFF')} />
          </div>
        )}

        {/* ── XLM balance breakdown ── */}
        {!loading && code === 'XLM' && (contractBalance !== null || feePayerBalance !== null) && (
          <div className="card" style={{ marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.6875rem', fontFamily: 'Anton, Impact, sans-serif', color: 'rgba(246,247,248,0.3)', letterSpacing: '0.08em' }}>
              BALANCE BREAKDOWN
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: '0.8125rem', color: 'var(--off-white)', fontWeight: 500 }}>Smart wallet</p>
                <p style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.35)', fontFamily: 'Inconsolata, monospace', marginTop: '0.125rem' }}>
                  Soroban contract (C…)
                </p>
              </div>
              <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.9375rem' }}>
                {contractBalance !== null ? parseFloat(contractBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'} XLM
              </span>
            </div>
            <div style={{ height: '1px', background: 'var(--border-dim)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: '0.8125rem', color: 'var(--off-white)', fontWeight: 500 }}>Fee-payer account</p>
                <p style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.35)', fontFamily: 'Inconsolata, monospace', marginTop: '0.125rem' }}>
                  Classic account (G…)
                </p>
              </div>
              <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.9375rem' }}>
                {feePayerBalance !== null ? parseFloat(feePayerBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'} XLM
              </span>
            </div>
          </div>
        )}

        {/* ── Actions ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '2rem' }}>
          <ActionBtn label="Send" onClick={() => router.push(sendHref)}
            icon={<path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>} />
          <ActionBtn label="Receive" onClick={() => router.push('/receive')}
            icon={<path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>} />
          <ActionBtn label="Swap" onClick={() => router.push(swapHref)}
            icon={<path d="M7 10l5-5 5 5M17 14l-5 5-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>} />
        </div>

        {/* ── Transactions ── */}
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', color: 'var(--warm-grey)', letterSpacing: '0.08em' }}>
              ACTIVITY
            </h2>
            <button onClick={() => fetchData()}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(246,247,248,0.4)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.875rem 1rem', borderBottom: i < 3 ? '1px solid var(--border-dim)' : 'none' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    <div className="skeleton" style={{ width: 48, height: '0.875rem' }} />
                    <div className="skeleton" style={{ width: 96, height: '0.75rem' }} />
                  </div>
                  <div className="skeleton" style={{ width: 72, height: '0.9375rem' }} />
                </div>
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)' }}>No {code} transactions yet.</p>
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {transactions.map((tx, i) => (
                <button key={tx.id} onClick={() => setSelectedTx(tx)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    width: '100%', padding: '0.875rem 1rem', background: 'none', border: 'none',
                    cursor: 'pointer', color: 'var(--off-white)', textAlign: 'left',
                    borderBottom: i < transactions.length - 1 ? '1px solid var(--border-dim)' : 'none',
                  }}
                >
                  <div>
                    <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>
                      {tx.type === 'sent' ? '↑ Sent' : tx.type === 'swapped' ? '⇄ Swap' : '↓ Received'}
                    </p>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.125rem', fontFamily: 'Inconsolata, monospace' }}>
                      {tx.counterparty.length > 12
                        ? `${tx.counterparty.slice(0, 6)}…${tx.counterparty.slice(-6)}`
                        : tx.counterparty}
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {tx.type === 'swapped' ? (
                      <>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem' }}>-{tx.amount} {tx.asset}</p>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem', color: 'var(--teal)', marginTop: '0.125rem' }}>+{tx.destAmount} {tx.destAsset}</p>
                      </>
                    ) : (
                      <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.9375rem' }}>
                        {tx.amount} {tx.asset}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

      </main>

      {selectedTx && <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  )
}

function ActionBtn({ label, onClick, icon }: { label: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button onClick={onClick} className="card"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', padding: '1rem 0.5rem', cursor: 'pointer', background: 'var(--surface)', transition: 'all 0.2s ease', border: '1px solid var(--border-dim)', borderRadius: 16 }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>{icon}</svg>
      <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{label}</span>
    </button>
  )
}
