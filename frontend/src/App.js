import { useCallback, useEffect, useMemo, useState, Suspense, lazy } from "react";
import "./App.css";
import axios from "axios";
// Shadcn UI components (local)
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

// Solana & Wallet Adapter
import {
  clusterApiUrl,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const LiquidityPage = lazy(() => import("./LiquidityPage"));

// Jupiter API (REST) client (mainnet-compatible)
const JUP_BASE = "https://quote-api.jup.ag/v6";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mainnet
const WSOL_MINT = "So11111111111111111111111111111111111111112"; // wSOL mint

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;
const READ_ONLY_DEFAULT = "DwK4nUM8TKWAxEBKTG6mWA6PBRDHFPA3beLB18pwCekq"; // treasury default
const CRT_MAINNET_MINT = "9pjWtc6x88wrRMXTxkBcNB6YtcN7NNcyzDAfUMfRknty"; // user's CRT mint (mainnet)

function WalletUI({ network }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, wallet } = useWallet();

  // Axios API (MUST be before any callback that references it)
  const api = useMemo(() => axios.create({ baseURL: API_BASE }), []);

  // Balances / CRT
  const [solBalance, setSolBalance] = useState(null);
  const [crtMint, setCrtMint] = useState(CRT_MAINNET_MINT);
  const [crtUiAmount, setCrtUiAmount] = useState(null);

  // Common UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // SOL Transfer state
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.01");

  // Loss tracking manual form state
  const [lossAmount, setLossAmount] = useState("");
  const [lossCurrency, setLossCurrency] = useState("SOL");
  const [summary, setSummary] = useState({});

  // CRT Converter (Jupiter)
  const [swapFrom, setSwapFrom] = useState("CRT");
  const [swapTo, setSwapTo] = useState("USDC");
  const [swapAmt, setSwapAmt] = useState("1");
  const [quote, setQuote] = useState(null);

  // Read-only balances for a given address (mainnet)
  const [roAddress, setRoAddress] = useState(READ_ONLY_DEFAULT);
  const [roCRT, setRoCRT] = useState(null);
  const [roUSDC, setRoUSDC] = useState(null);

  // Wallet diagnostics (simple)
  const diagnostics = useMemo(() => ({
    connected,
    walletName: wallet?.adapter?.name || "-",
    addressShort: publicKey ? `${publicKey.toString().slice(0,6)}…${publicKey.toString().slice(-6)}` : "-",
  }), [connected, wallet?.adapter?.name, publicKey]);

  const logWalletConnection = useCallback(async () => {
    if (!publicKey || !wallet?.adapter?.name) return;
    try {
      await api.post("/wallet/connect", {
        id: crypto.randomUUID(),
        wallet_address: publicKey.toString(),
        wallet_name: wallet.adapter.name,
        user_agent: navigator.userAgent,
      });
    } catch (e) {
      console.warn("wallet log failed", e);
    }
  }, [api, publicKey, wallet?.adapter?.name]);

  const fetchSol = useCallback(async () => {
    if (!publicKey) return;
    try {
      const lamports = await connection.getBalance(publicKey);
      setSolBalance(lamports / LAMPORTS_PER_SOL);
    } catch (e) {
      setError("Failed to load SOL balance");
      console.error(e);
    }
  }, [connection, publicKey]);

  const fetchCRT = useCallback(async () => {
    if (!publicKey || !crtMint) return;
    try {
      setIsLoading(true);
      const mintPk = new PublicKey(crtMint);
      const ata = await getAssociatedTokenAddress(mintPk, publicKey);
      const acctInfo = await connection.getAccountInfo(ata);
      if (!acctInfo) { setCrtUiAmount(0); return; }
      const tokenAccount = await getAccount(connection, ata);
      // fetch decimals
      let decimals = 9;
      try {
        const parsedMint = await connection.getParsedAccountInfo(mintPk);
        if (parsedMint.value?.data && parsedMint.value.data.parsed?.info?.decimals != null) {
          decimals = parsedMint.value.data.parsed.info.decimals;
        }
      } catch {}
      const ui = Number(tokenAccount.amount) / Math.pow(10, decimals || 0);
      setCrtUiAmount(ui);
    } catch (e) {
      console.warn("CRT detection error", e);
      setCrtUiAmount(0);
    } finally { setIsLoading(false); }
  }, [connection, crtMint, publicKey]);

  const fetchSummary = useCallback(async () => {
    if (!publicKey) return;
    try {
      const res = await api.get(`/gaming/summary`, { params: { wallet_address: publicKey.toString() } });
      setSummary(res.data?.totals || {});
    } catch (e) { console.warn("summary fetch failed", e); }
  }, [api, publicKey]);

  // Read-only balances fetch
  const fetchReadOnlyBalances = useCallback(async () => {
    try {
      const addr = new PublicKey(roAddress);
      const crtMintPk = new PublicKey(CRT_MAINNET_MINT);
      const usdcMintPk = new PublicKey(USDC_MAINNET);
      const crtAta = await getAssociatedTokenAddress(crtMintPk, addr);
      const usdcAta = await getAssociatedTokenAddress(usdcMintPk, addr);
      let crt = 0, usdc = 0;
      try { const a = await getAccount(connection, crtAta); crt = Number(a.amount) / 1e9; } catch {}
      try { const b = await getAccount(connection, usdcAta); usdc = Number(b.amount) / 1e6; } catch {}
      setRoCRT(crt); setRoUSDC(usdc);
    } catch (e) { console.warn("ro balance", e); }
  }, [connection, roAddress]);

  // Jupiter helper: fetch mint decimals
  const getMintDecimals = useCallback(async (mintStr) => {
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(mintStr));
      const dec = info.value?.data?.parsed?.info?.decimals;
      return typeof dec === "number" ? dec : 9;
    } catch { return 9; }
  }, [connection]);

  // Converter helpers
  const mintFor = (sym) => {
    if (sym === "CRT") return crtMint; // user's mint
    if (sym === "USDC") return USDC_MAINNET;
    if (sym === "SOL") return WSOL_MINT;
    return crtMint;
  };

  const fetchQuote = useCallback(async () => {
    try {
      if (!publicKey) return setError("Connect wallet first");
      const inMint = mintFor(swapFrom);
      const outMint = mintFor(swapTo);
      if (!inMint || !outMint || inMint === outMint) return setError("Select different tokens");
      const ui = parseFloat(swapAmt || "0");
      if (!ui || ui <= 0) return setError("Enter swap amount");
      const dec = await getMintDecimals(inMint);
      const amountSmallest = Math.floor(ui * 10 ** dec);
      const res = await fetch(`${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountSmallest}&slippageBps=100`);
      const data = await res.json();
      if (!data || !data.outAmount) { setError("No route found"); setQuote(null); return; }
      setQuote(data);
    } catch (e) { console.error(e); setError("Quote failed"); }
  }, [publicKey, swapFrom, swapTo, swapAmt, crtMint, getMintDecimals]);

  const doSwap = useCallback(async () => {
    try {
      if (!publicKey || !sendTransaction) return setError("Connect wallet first");
      if (!quote) return setError("Get a quote first");
      const swapRes = await fetch(`${JUP_BASE}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: publicKey.toString(), wrapAndUnwrapSol: true }),
      });
      const txData = await swapRes.json();
      if (!txData || !txData.swapTransaction) return setError("Swap build failed");
      const swapTxBuf = Buffer.from(txData.swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(swapTxBuf);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      alert(`Swap sent! ${sig}`);
      setQuote(null);
    } catch (e) { console.error(e); setError(e?.message || "Swap failed"); }
  }, [publicKey, sendTransaction, connection, quote]);

  // ---------- SOL Transfer ----------
  const sendSol = useCallback(async () => {
    if (!publicKey) return setError("Connect wallet first");
    try {
      setIsLoading(true);
      setError("");
      const to = new PublicKey(recipient);
      const ix = SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: to, lamports: Math.floor(parseFloat(amount || "0") * LAMPORTS_PER_SOL) });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash; tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
      try { await api.post("/transactions/log", { id: crypto.randomUUID(), signature: sig, wallet_address: publicKey.toString(), transaction_type: "SOL_TRANSFER", amount: parseFloat(amount), recipient: to.toString(), network: network, additional_data: { source: "frontend" }, }); } catch (e) { console.warn("tx log failed", e); }
      await fetchSol(); setRecipient(""); setAmount("0.01"); alert(`Sent! Signature: ${sig}`);
    } catch (e) { console.error(e); setError(e?.message || "Transaction failed"); } finally { setIsLoading(false); }
  }, [amount, api, connection, fetchSol, network, publicKey, recipient, sendTransaction]);

  // On connect
  useEffect(() => {
    if (connected && publicKey) {
      logWalletConnection(); fetchSol(); if (crtMint) fetchCRT(); fetchSummary();
    } else { setSolBalance(null); setCrtUiAmount(null); setSummary({}); }
  }, [connected, publicKey]);

  useEffect(() => { fetchReadOnlyBalances(); }, [fetchReadOnlyBalances]);

  // ---------- UI ----------
  return (
    <>
      <Card className="card">
        <div className="card-header" style={{justifyContent:'space-between'}}>
          <div>
            <h2>Wallet</h2>
            <div className="muted" style={{fontSize:12}}>Wallet: {diagnostics.walletName} • {diagnostics.addressShort} • {diagnostics.connected ? 'Connected' : 'Not connected'}</div>
          </div>
          <WalletMultiButton className="wallet-btn" />
        </div>
        {connected && publicKey ? (
          <div className="wallet-info">
            <div>Connected: {wallet?.adapter?.name}</div>
            <div className="mono">{publicKey.toString()}</div>
          </div>
        ) : (
          <div className="muted">Connect Phantom or Solflare • Network: {network}</div>
        )}
      </Card>

      <Card className="card">
        <h3 className="mb-2">Read-only Balances</h3>
        <div className="grid">
          <div>
            <Label htmlFor="ro">Address</Label>
            <Input id="ro" value={roAddress} onChange={(e) => setRoAddress(e.target.value)} />
          </div>
          <div className="self-end">
            <Button onClick={fetchReadOnlyBalances}>Refresh</Button>
          </div>
        </div>
        <div className="row" style={{marginTop:8}}>
          <div className="pill">CRT: {roCRT ?? '—'}</div>
          <div className="pill">USDC: {roUSDC ?? '—'}</div>
        </div>
      </Card>

      <Card className="card">
        <h3 className="mb-2">Mini Roulette (Native)</h3>
        {/* ... roulette UI unchanged for brevity ... */}
        <div className="muted">Use roulette above; losses auto-split 70/30 to savings/liquidity (ledger).</div>
      </Card>

      {connected && (
        <Card className="card">
          <h3 className="mb-2">Balances</h3>
          <div className="row">
            <div className="pill">SOL: {solBalance != null ? solBalance.toFixed(4) : "…"}</div>
            <div className="pill">CRT: {crtUiAmount != null ? Number(crtUiAmount).toFixed(4) : "—"}</div>
            <Button variant="secondary" onClick={() => { fetchSol(); fetchCRT(); fetchSummary(); }} disabled={isLoading}>
              {isLoading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <div className="grid">
            <div>
              <Label htmlFor="crt">CRT Token Mint</Label>
              <Input id="crt" placeholder="CRT mint address" value={crtMint} onChange={(e) => setCrtMint(e.target.value)} />
            </div>
            <div className="self-end">
              <Button onClick={fetchCRT} disabled={!crtMint || isLoading}>Detect Balance</Button>
            </div>
          </div>
        </Card>
      )}

      <Card className="card">
        <h3 className="mb-2">CRT Converter (Jupiter)</h3>
        <div className="grid">
          <div>
            <Label>From</Label>
            <Select value={swapFrom} onValueChange={setSwapFrom}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Token" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CRT">CRT</SelectItem>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>To</Label>
            <Select value={swapTo} onValueChange={setSwapTo}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Token" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CRT">CRT</SelectItem>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="swapAmt">Amount</Label>
            <Input id="swapAmt" type="number" step="0.0001" value={swapAmt} onChange={(e) => setSwapAmt(e.target.value)} />
          </div>
          <div className="self-end">
            <div className="row">
              <Button onClick={fetchQuote} disabled={!connected || isLoading}>Get Quote</Button>
              <Button onClick={doSwap} disabled={!connected || !quote}>Swap</Button>
            </div>
          </div>
        </div>
        {quote && (
          <div style={{ marginTop: 12 }} className="muted">Best route found. Est. out (atomic): {quote.outAmount}</div>
        )}
      </Card>

      <Card className="card">
        <h3 className="mb-2">Dev Tools</h3>
        <div className="row">
          <Button onClick={() => window.location.reload()} variant="secondary">Reset Wallet</Button>
        </div>
      </Card>
    </>
  );
}

function App() {
  const [network, setNetwork] = useState("mainnet-beta");
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  // simple backend ping on load
  useEffect(() => {
    const ping = async () => {
      try {
        const res = await axios.get(`${API_BASE}/health`);
        console.log("API health:", res.data);
      } catch (e) {
        console.warn("API health failed", e?.response?.data || e.message);
      }
    };
    ping();
  }, []);

  return (
    <div className="App">
      <div className="container">
        <header className="header" style={{display:'flex', justifyContent:'space-between', alignItems:'flex-end'}}>
          <div>
            <h1 className="title">Solana Onboarding</h1>
            <p className="subtitle">Connect wallet • Detect CRT • Swap & Liquidity</p>
          </div>
          <div className="row">
            <Label>Network</Label>
            <Select value={network} onValueChange={setNetwork}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select network" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mainnet-beta">Mainnet-Beta</SelectItem>
                <SelectItem value="devnet">Devnet</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </header>
        <ConnectionProvider endpoint={endpoint}>
          <WalletProvider wallets={wallets} autoConnect={false}>
            <WalletModalProvider>
              <main className="main">
                <WalletUI network={network} />
                <Suspense fallback={<div className="muted">Loading Liquidity…</div>}>
                  <LiquidityPage />
                </Suspense>
              </main>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </div>
    </div>
  );
}

export default App;