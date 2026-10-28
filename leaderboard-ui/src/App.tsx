import { useState, useEffect, useCallback, useRef } from 'react';
import type { InitialAPI, ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { useLeaderboard } from './hooks/useLeaderboard';
import { BrowserLeaderboardManager } from './contexts/BrowserLeaderboardManager';
import pino from 'pino';

const NETWORK_ID = import.meta.env.VITE_NETWORK_ID ?? 'preprod';
const DEFAULT_CONTRACT = import.meta.env.VITE_DEFAULT_CONTRACT ?? '';

enum DisplayMode { PUBLIC = 0, ANONYMOUS = 1, CUSTOM = 2 }
type WalletState = 'detecting' | 'no-wallet' | 'ready' | 'connecting' | 'connected';

function findWallet(): InitialAPI | undefined {
  const midnight = (window as any).midnight;
  if (!midnight) return undefined;
  return Object.values(midnight).find(
    (w): w is InitialAPI => !!w && typeof w === 'object' && 'apiVersion' in w,
  );
}

function truncAddr(addr: string): string {
  return addr.length <= 24 ? addr : `${addr.slice(0, 14)}...${addr.slice(-8)}`;
}

function friendlyError(e: any): string {
  const msg = extractErrorMessage(e);
  if (msg.includes('User rejected')) return 'Transaction cancelled.';
  if (msg.includes('not the owner')) return 'This entry does not belong to your wallet.';
  if (msg.includes('entry not found')) return 'Entry not found on the leaderboard.';
  if (msg.includes('Failed to fetch') || msg.includes('Failed Proof Server')) return 'Could not reach the proof server. Check your connection and try again.';
  if (msg.includes('mismatched verifier keys')) return 'Contract version mismatch. Try deploying a new leaderboard.';
  if (msg.includes('submission') || msg.includes('Submission')) return 'Transaction failed to submit. Please try again.';
  return msg || 'An unexpected error occurred. Check the browser console for details.';
}

function extractErrorMessage(e: any): string {
  if (!e) return '';
  if (e.message && e.message !== '') return e.message;
  const failure = e?.cause?.failure;
  if (failure?.message) return failure.message;
  if (failure?.cause?.message) return failure.cause.message;
  if (e?.cause?.message) return e.cause.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export default function App() {
  const [walletState, setWalletState] = useState<WalletState>('detecting');
  const [walletAPI, setWalletAPI] = useState<InitialAPI | undefined>();
  const [wallet, setWallet] = useState<ConnectedAPI | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contractAddress, setContractAddress] = useState(DEFAULT_CONTRACT);
  const [joinInput, setJoinInput] = useState('');
  const [showJoinPanel, setShowJoinPanel] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [clicks, setClicks] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [timeLeft, setTimeLeft] = useState(10);
  const [showResult, setShowResult] = useState(false);
  const [lastScore, setLastScore] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clickRef = useRef(0);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.ANONYMOUS);
  const [customName, setCustomName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [verifiedIds, setVerifiedIds] = useState<Set<number>>(new Set());

  const managerRef = useRef<BrowserLeaderboardManager | null>(null);

  const getManager = useCallback(() => {
    if (!managerRef.current) {
      const logger = pino({ level: 'warn', browser: { asObject: true } });
      managerRef.current = new BrowserLeaderboardManager(logger);
    }
    return managerRef.current;
  }, []);

  const { entries: leaderboardEntries, refresh: refreshLeaderboard } = useLeaderboard(contractAddress || null);
  const leaderboard = leaderboardEntries.map((e, i) => ({
    rank: i + 1, id: e.id, displayName: e.displayName, score: BigInt(e.score),
  }));

  // Wallet detection: poll for Lace extension
  useEffect(() => {
    const found = findWallet();
    if (found) { setWalletAPI(found); setWalletState('ready'); return; }
    let elapsed = 0;
    const t = setInterval(() => {
      elapsed += 100;
      const w = findWallet();
      if (w) { setWalletAPI(w); setWalletState('ready'); clearInterval(t); }
      else if (elapsed >= 5_000) { setWalletState('no-wallet'); clearInterval(t); }
    }, 100);
    return () => clearInterval(t);
  }, []);

  const connect = useCallback(async () => {
    if (!walletAPI) return;
    setWalletState('connecting');
    setError(null);
    try {
      const c = await walletAPI.connect(NETWORK_ID);
      setWallet(c);
      const { unshieldedAddress } = await c.getUnshieldedAddress();
      setAddress(unshieldedAddress);
      setWalletState('connected');
    } catch (e) { setError(friendlyError(e)); setWalletState('ready'); }
  }, [walletAPI]);

  // Helper to resolve a contract (deploy or join)
  const resolveContract = useCallback(async (addr?: any) => {
    const manager = getManager();
    const deployment$ = manager.resolve(addr);
    return new Promise<any>((resolve, reject) => {
      const sub = deployment$.subscribe((d) => {
        if (d.status === 'deployed') { Promise.resolve().then(() => sub.unsubscribe()); resolve(d); }
        if (d.status === 'failed') { Promise.resolve().then(() => sub.unsubscribe()); reject(d.error); }
      });
    });
  }, [getManager]);

  const deployContract = useCallback(async () => {
    if (!wallet) return;
    setDeploying(true); setError(null);
    try {
      const result = await resolveContract();
      setContractAddress(result.api.deployedContractAddress);
      setShowJoinPanel(false); setClicks(0); setShowResult(false);
    } catch (e: any) { setError(friendlyError(e)); }
    finally { setDeploying(false); }
  }, [wallet, resolveContract]);

  const joinContract = useCallback(() => {
    const addr = joinInput.trim();
    if (!addr || !/^[0-9a-fA-F]{64}$/.test(addr)) {
      setError('Invalid contract address. Must be 64 hex characters.'); return;
    }
    setContractAddress(addr); setShowJoinPanel(false); setJoinInput('');
  }, [joinInput]);

  // Game logic
  const startGame = useCallback(() => {
    setClicks(0); clickRef.current = 0;
    setTimeLeft(10); setIsPlaying(true); setShowResult(false);
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          setIsPlaying(false); setShowResult(true);
          setLastScore(clickRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
  }, []);

  const handleClick = useCallback(() => {
    if (!isPlaying) return;
    clickRef.current += 1;
    setClicks(clickRef.current);
  }, [isPlaying]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Submit score
  const submitScore = useCallback(async () => {
    if (lastScore === 0 || !wallet) return;
    setSubmitting(true); setSubmitStatus('Joining contract...'); setError(null);
    try {
      const result = await resolveContract(contractAddress as any);
      setSubmitStatus('Generating proof & submitting...');
      const name = displayMode === DisplayMode.PUBLIC
        ? address!.slice(0, 12) + '..' + address!.slice(-12)
        : displayMode === DisplayMode.CUSTOM ? customName : undefined;
      await result.api.submitScore(lastScore, name);
      setSubmitting(false); setSubmitStatus(null);
      setShowResult(false); setLastScore(0);
      setTimeout(() => refreshLeaderboard(), 3000);
    } catch (e: any) { setSubmitting(false); setSubmitStatus(null); setError(friendlyError(e)); }
  }, [wallet, lastScore, displayMode, customName, contractAddress, refreshLeaderboard, address, resolveContract]);

  // Verify ownership
  const verifyEntry = useCallback(async (entryId: number) => {
    if (!wallet) return;
    setVerifyingId(entryId); setError(null);
    try {
      const result = await resolveContract(contractAddress as any);
      await result.api.verifyOwnership(entryId);
      setVerifiedIds(prev => new Set(prev).add(entryId));
    } catch (e: any) { setError(friendlyError(e)); }
    finally { setVerifyingId(null); }
  }, [wallet, contractAddress, resolveContract]);

  const isConnected = walletState === 'connected';

  return (
    <div>
      <h1>Midnight Leaderboard</h1>

      {walletState === 'no-wallet' ? (
        <a href="https://chromewebstore.google.com/detail/lace/gafhhkghbfjjkeiendhlofajokpaflmk" target="_blank" rel="noopener noreferrer">Install Lace Wallet</a>
      ) : isConnected && address ? (
        <p>Connected: {truncAddr(address)}</p>
      ) : (
        <button onClick={connect} disabled={walletState !== 'ready'}>Connect Wallet</button>
      )}

      {error && <p style={{ color: 'red' }}>{error} <button onClick={() => setError(null)}>dismiss</button></p>}

      <p>Contract: {truncAddr(contractAddress)}</p>
      <button onClick={() => setShowJoinPanel(!showJoinPanel)}>{showJoinPanel ? 'Cancel' : 'Switch Contract'}</button>

      {showJoinPanel && (
        <div>
          <input type="text" placeholder="Contract address (64 hex chars)" value={joinInput} onChange={e => setJoinInput(e.target.value)} />
          <button onClick={joinContract} disabled={!joinInput.trim()}>Join</button>
          {isConnected ? (
            <button onClick={deployContract} disabled={deploying}>{deploying ? 'Deploying...' : 'Deploy New'}</button>
          ) : (
            <button onClick={connect} disabled={walletState !== 'ready'}>Connect to Deploy</button>
          )}
        </div>
      )}

      <h2>Click Challenge</h2>
      <p>Time: {isPlaying ? timeLeft : 10}s | Clicks: {clicks}</p>

      {isPlaying && (
        <button onPointerDown={handleClick}>CLICK!</button>
      )}

      {!isPlaying && !showResult && (
        <button onClick={startGame}>Start Game</button>
      )}

      {lastScore > 0 && !isPlaying && (
        <div>
          <button onClick={startGame}>Try Again</button>
          <div>
            {([[DisplayMode.ANONYMOUS, 'Anonymous'], [DisplayMode.PUBLIC, 'Public'], [DisplayMode.CUSTOM, 'Custom']] as const).map(([m, label]) => (
              <button key={m} onClick={() => setDisplayMode(m)} style={{ fontWeight: displayMode === m ? 'bold' : 'normal' }}>{label}</button>
            ))}
          </div>
          {displayMode === DisplayMode.CUSTOM && (
            <input type="text" placeholder="Display name (max 32)" maxLength={32} value={customName} onChange={e => setCustomName(e.target.value)} />
          )}
          {isConnected ? (
            <button onClick={submitScore} disabled={submitting || (displayMode === DisplayMode.CUSTOM && !customName.trim())}>
              {submitting ? submitStatus : 'Submit to Chain'}
            </button>
          ) : (
            <button onClick={connect} disabled={walletState !== 'ready'}>Connect Wallet to Submit</button>
          )}
        </div>
      )}

      <h2>Leaderboard ({leaderboard.length} entries)</h2>
      {leaderboard.length === 0 ? (
        <p>No scores yet.</p>
      ) : (
        <table>
          <thead><tr><th>#</th><th>Player</th><th>Score</th><th></th></tr></thead>
          <tbody>
            {leaderboard.map(e => (
              <tr key={e.id}>
                <td>{e.rank}</td>
                <td>{e.displayName} {verifiedIds.has(e.id) && <span>✓ yours</span>}</td>
                <td>{Number(e.score).toLocaleString()}</td>
                <td>
                  {isConnected && !verifiedIds.has(e.id) && (
                    <button onClick={() => verifyEntry(e.id)} disabled={verifyingId !== null}>
                      {verifyingId === e.id ? '...' : 'Prove'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}