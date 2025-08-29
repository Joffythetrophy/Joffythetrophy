import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import axios from "axios";
// Shadcn UI components (local)
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";
import { AspectRatio } from "./components/ui/aspect-ratio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";

// Solana & Wallet Adapter
import { clusterApiUrl, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
// Jupiter API (REST) client
const JUP_BASE = "https://quote-api.jup.ag/v6"; // devnet-compatible
const JUP_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // devnet USDC (Jupiter uses canonical)
const JUP_WSOLA = "So11111111111111111111111111111111111111112"; // wrapped SOL mint

import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

function WalletUI() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, wallet } = useWallet();

  const [solBalance, setSolBalance] = useState(null);
  const [crtMint, setCrtMint] = useState("9pjWtc6x88wrRMXTxkBcNB6YtcN7NNcyzDAfUMfRknty");
  const [crtUiAmount, setCrtUiAmount] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recipient, setRecipient] = useState("");
  // ==== Native Mini Roulette helpers ====
  const rouletteNumbers = {
    red: [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36],
    black: [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35],
    green: [0],
  };
  const betConfig = {
    red: { payout: 1, label: "Red" },
    black: { payout: 1, label: "Black" },
    even: { payout: 1, label: "Even" },
    odd: { payout: 1, label: "Odd" },
    straight: { payout: 35, label: "Straight (single number)" },
  };
  const [betType, setBetType] = useState("red");
  const [straightNo, setStraightNo] = useState("");
  const [betCurrency, setBetCurrency] = useState("SOL");
  const [betAmount, setBetAmount] = useState("0.01");
  const [lastSpin, setLastSpin] = useState(null);
  const [history, setHistory] = useState([]);

  const getColor = (n) => (rouletteNumbers.red.includes(n) ? "red" : rouletteNumbers.black.includes(n) ? "black" : "green");
  const isWin = (n) => {
    if (betType === "red") return rouletteNumbers.red.includes(n);
    if (betType === "black") return rouletteNumbers.black.includes(n);
    if (betType === "even") return n !== 0 && n % 2 === 0;
    if (betType === "odd") return n % 2 === 1;
    if (betType === "straight") return String(n) === String(straightNo);
    return false;
  };
  const recordLossAPI = useCallback(async (amt, currency) => {
    if (!publicKey) return; // require wallet for accounting
    try {
      await api.post("/gaming/loss", {
        wallet_address: publicKey.toString(),
        amount: amt,
        currency,
      });
      await fetchSummary();
    } catch (e) {
      console.warn("loss log failed", e);
    }
  }, [api, fetchSummary, publicKey]);

  const spinRoulette = useCallback(async () => {
    const amt = parseFloat(betAmount);
    if (!amt || amt <= 0) return setError("Enter a positive bet amount");
    if (betType === "straight") {
      const sn = parseInt(straightNo, 10);
      if (isNaN(sn) || sn < 0 || sn > 36) return setError("Enter straight number 0-36");
    }
    const n = Math.floor(Math.random() * 37);
    const won = isWin(n);
    const payout = betConfig[betType].payout;
    const net = won ? amt * payout : -amt; // net profit (loss negative)
    setLastSpin({ n, color: getColor(n), won, net, bet: amt, type: betType, currency: betCurrency });
    setHistory((h) => [{ n, won, net, bet: amt, type: betType, currency: betCurrency, ts: Date.now() }, ...h].slice(0, 10));
    if (net < 0) {
      await recordLossAPI(-net, betCurrency);
    }
  }, [betAmount, betCurrency, betType, straightNo, recordLossAPI]);

  const [amount, setAmount] = useState("0.01");
  const [error, setError] = useState("");

  const [lossAmount, setLossAmount] = useState("");
  const [lossCurrency, setLossCurrency] = useState("SOL");
  const [summary, setSummary] = useState({});

  const api = useMemo(() => axios.create({ baseURL: API_BASE }), []);

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
  // ==== CRT Converter (Jupiter) ====
  const [swapFrom, setSwapFrom] = useState("CRT");
  const [swapTo, setSwapTo] = useState("USDC");
  const [swapAmt, setSwapAmt] = useState("1");
  const [quote, setQuote] = useState(null);

  const mintFor = (sym) => {
    if (sym === "CRT") return crtMint; // your mint
    if (sym === "USDC") return JUP_USDC;
    if (sym === "SOL") return JUP_WSOLA;
    return crtMint;
  };

  const fetchQuote = useCallback(async () => {
    try {
      if (!publicKey) return setError("Connect wallet first");
      const inMint = mintFor(swapFrom);
      const outMint = mintFor(swapTo);
      if (!inMint || !outMint || inMint === outMint) return setError("Select different tokens");
      // amount in smallest units: assume 6 decimals for demo; better: fetch decimals for each mint
      const ui = parseFloat(swapAmt || "0");
      if (!ui || ui <= 0) return setError("Enter swap amount");
      const amount = Math.floor(ui * 10 ** 6);
      const res = await fetch(`${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=100`);
      const data = await res.json();
      if (!data || !data.outAmount) {
        setError("No route found");
        setQuote(null);
        return;
      }
      setQuote(data);
    } catch (e) {
      console.error(e);
      setError("Quote failed");
    }
  }, [publicKey, swapFrom, swapTo, swapAmt, crtMint]);

  const doSwap = useCallback(async () => {
    try {
      if (!publicKey || !sendTransaction) return setError("Connect wallet first");
      const inMint = mintFor(swapFrom);
      const outMint = mintFor(swapTo);
      const ui = parseFloat(swapAmt || "0");
      const amount = Math.floor(ui * 10 ** 6);
      // Build swap transaction via Jupiter /swap
      const swapRes = await fetch(`${JUP_BASE}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: publicKey.toString(),
          wrapAndUnwrapSol: true,
        }),
      });
      const txData = await swapRes.json();
      if (!txData || !txData.swapTransaction) return setError("Swap build failed");
      const swapTxBuf = Buffer.from(txData.swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(swapTxBuf);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      alert(`Swap sent! ${sig}`);
    } catch (e) {
      console.error(e);
      setError(e?.message || "Swap failed");
    }
  }, [publicKey, sendTransaction, connection, swapFrom, swapTo, swapAmt, quote]);

      const mintPk = new PublicKey(crtMint);
      const ata = await getAssociatedTokenAddress(mintPk, publicKey);
      const acctInfo = await connection.getAccountInfo(ata);
      if (!acctInfo) {
        setCrtUiAmount(0);
        return;
      }
      const tokenAccount = await getAccount(connection, ata);
      let decimals = 0;
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
    } finally {
      setIsLoading(false);
    }
  }, [connection, crtMint, publicKey]);

  const sendSol = useCallback(async () => {
    if (!publicKey) return setError("Connect wallet first");
    try {
      setIsLoading(true);
      setError("");
      const to = new PublicKey(recipient);
      const ix = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: to,
        lamports: Math.floor(parseFloat(amount || "0") * LAMPORTS_PER_SOL),
      });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
      try {
        await api.post("/transactions/log", {
          id: crypto.randomUUID(),
          signature: sig,
          wallet_address: publicKey.toString(),
          transaction_type: "SOL_TRANSFER",
          amount: parseFloat(amount),
          recipient: to.toString(),
          network: "devnet",
          additional_data: { source: "frontend" },
        });
      } catch (e) { console.warn("tx log failed", e); }
      await fetchSol();
      setRecipient("");
      setAmount("0.01");
      alert(`Sent! Signature: ${sig}`);
    } catch (e) {
      console.error(e);
      setError(e?.message || "Transaction failed");
    } finally {
      setIsLoading(false);
    }
  }, [amount, api, connection, fetchSol, publicKey, recipient, sendTransaction]);

  const fetchSummary = useCallback(async () => {
    if (!publicKey) return;
    try {
      const res = await api.get(`/gaming/summary`, { params: { wallet_address: publicKey.toString() } });
      setSummary(res.data?.totals || {});
    } catch (e) {
      console.warn("summary fetch failed", e);
    }
  }, [api, publicKey]);

  const recordLoss = useCallback(async () => {
    if (!publicKey) return setError("Connect wallet first");
    const amt = parseFloat(lossAmount);
    if (!amt || amt <= 0) return setError("Enter a positive loss amount");
    try {
      setIsLoading(true);
      setError("");
      await api.post("/gaming/loss", {
        wallet_address: publicKey.toString(),
        amount: amt,
        currency: lossCurrency,
      });
      await fetchSummary();
      setLossAmount("");
      alert(`Recorded loss: ${amt} ${lossCurrency} → 70% savings / 30% liquidity`);
    } catch (e) {
      console.error(e);
      setError("Failed to record loss");
    } finally {
      setIsLoading(false);
    }
  }, [api, fetchSummary, lossAmount, lossCurrency, publicKey]);

  useEffect(() => {
    if (connected && publicKey) {
      logWalletConnection();
      fetchSol();
      if (crtMint) fetchCRT();
      fetchSummary();
    } else {
      setSolBalance(null);
      setCrtUiAmount(null);
      setSummary({});
    }
  }, [connected, publicKey]);

  return (
    <>
      <Card className="card">
        <div className="card-header">
          <h2>Wallet</h2>
          <WalletMultiButton className="wallet-btn" />
        </div>
        {connected && publicKey ? (
          <div className="wallet-info">
            <div>Connected: {wallet?.adapter?.name}</div>
            <div className="mono">{publicKey.toString()}</div>
          </div>
        ) : (
          <div className="muted">Connect Phantom or Solflare on Devnet</div>
        )}
      </Card>

      <Card className="card">
        <h3 className="mb-2">Mini Roulette (Native)</h3>
        <div className="grid">
          <div>
            <Label>Bet Type</Label>
            <Select value={betType} onValueChange={setBetType}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="red">Red (1:1)</SelectItem>
                <SelectItem value="black">Black (1:1)</SelectItem>
                <SelectItem value="even">Even (1:1)</SelectItem>
                <SelectItem value="odd">Odd (1:1)</SelectItem>
                <SelectItem value="straight">Straight (35:1)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {betType === "straight" && (
            <div>
              <Label htmlFor="straight">Number (0-36)</Label>
              <Input id="straight" value={straightNo} onChange={(e) => setStraightNo(e.target.value)} />
            </div>
          )}
          <div>
            <Label htmlFor="betAmt">Bet Amount</Label>
            <Input id="betAmt" type="number" step="0.0001" value={betAmount} onChange={(e) => setBetAmount(e.target.value)} />
          </div>
          <div>
            <Label>Currency (for accounting)</Label>
            <Select value={betCurrency} onValueChange={setBetCurrency}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="USDC">USDC</SelectItem>
                <SelectItem value="CRT">CRT</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="self-end"><Button onClick={spinRoulette}>Spin</Button></div>
        </div>
        {lastSpin && (
          <div style={{ marginTop: 12 }}>
            <div className="pill">Result: {lastSpin.n} ({lastSpin.color}) • {lastSpin.won ? "WIN" : "LOSS"} • Net {lastSpin.net}</div>
          </div>
        )}
        {history.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h4 className="mb-2">Recent Spins</h4>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {history.map((h, i) => (
                <div key={i} className="pill">{h.n} {h.won ? "W" : "L"} {h.net}</div>
              ))}
            </div>
          </div>
        )}
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
              <Input id="crt" placeholder="Paste CRT mint address" value={crtMint} onChange={(e) => setCrtMint(e.target.value)} />
            </div>
            <div className="self-end">
              <Button onClick={fetchCRT} disabled={!crtMint || isLoading}>Detect Balance</Button>
            </div>
          </div>
        </Card>
      )}

      {connected && (
        <Card className="card">
          <h3 className="mb-2">Record a Loss (auto 70% savings / 30% liquidity)</h3>
          <div className="grid">
            <div>
              <Label htmlFor="lossAmt">Loss Amount</Label>
              <Input id="lossAmt" type="number" step="0.0001" value={lossAmount} onChange={(e) => setLossAmount(e.target.value)} />
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={lossCurrency} onValueChange={setLossCurrency}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SOL">SOL</SelectItem>
                  <SelectItem value="USDC">USDC</SelectItem>
                  <SelectItem value="CRT">CRT</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="self-end">
              <Button onClick={recordLoss} disabled={isLoading || !lossAmount}>Record Loss</Button>
            </div>
          </div>
          {Object.keys(summary || {}).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4 className="mb-2">Totals</h4>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {Object.entries(summary).map(([cur, vals]) => (
                  <div key={cur} className="pill">{cur}: total {vals.total} • savings {vals.savings} • liq {vals.liquidity}</div>
                ))}
              </div>
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </Card>
      )}

      {connected && (
        <Card className="card">
          <h3 className="mb-2">Send SOL (Devnet)</h3>
          <div className="grid">
            <div>
              <Label htmlFor="amt">Amount (SOL)</Label>
              <Input id="amt" type="number" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="to">Recipient Address</Label>
              <Input id="to" placeholder="Enter Solana address" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            </div>
            <div className="self-end">
              <Button onClick={sendSol} disabled={isLoading || !recipient || !amount}>{isLoading ? "Sending…" : "Send"}</Button>
            </div>
          </div>
          {error && <div className="error">{error}</div>}
        </Card>
      )}
    </>
  );
}

function App() {
  const network = "devnet";
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
        <header className="header">
          <div>
            <h1 className="title">Solana Devnet Onboarding</h1>
            <p className="subtitle">Connect wallet • Detect CRT • Send SOL</p>
          </div>
        </header>
        <ConnectionProvider endpoint={endpoint}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <main className="main">
                <WalletUI />
              </main>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </div>
    </div>
  );
}

export default App;