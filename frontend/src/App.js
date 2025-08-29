import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import axios from "axios";
// Shadcn UI components (local)
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Card } from "./components/ui/card";
import { Label } from "./components/ui/label";

// Solana & Wallet Adapter
import { clusterApiUrl, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const API_BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

function WalletUI() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected, wallet } = useWallet();

  const [solBalance, setSolBalance] = useState(null);
  const [crtMint, setCrtMint] = useState("");
  const [crtUiAmount, setCrtUiAmount] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [error, setError] = useState("");

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
      // non-blocking
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
      if (!acctInfo) {
        setCrtUiAmount(0);
        return;
      }
      const tokenAccount = await getAccount(connection, ata);
      // try to get decimals via parsed account (fallback 0)
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
      // log to backend (non-blocking)
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

  useEffect(() => {
    if (connected && publicKey) {
      logWalletConnection();
      fetchSol();
      if (crtMint) fetchCRT();
    } else {
      setSolBalance(null);
      setCrtUiAmount(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, publicKey]);

  return (
    &lt;&gt;
      &lt;Card className="card"&gt;
        &lt;div className="card-header"&gt;
          &lt;h2&gt;Wallet&lt;/h2&gt;
          &lt;WalletMultiButton className="wallet-btn" /&gt;
        &lt;/div&gt;
        {connected &amp;&amp; publicKey ? (
          &lt;div className="wallet-info"&gt;
            &lt;div&gt;Connected: {wallet?.adapter?.name}&lt;/div&gt;
            &lt;div className="mono"&gt;{publicKey.toString()}&lt;/div&gt;
          &lt;/div&gt;
        ) : (
          &lt;div className="muted"&gt;Connect Phantom or Solflare on Devnet&lt;/div&gt;
        )}
      &lt;/Card&gt;

      {connected &amp;&amp; (
        &lt;Card className="card"&gt;
          &lt;h3 className="mb-2"&gt;Balances&lt;/h3&gt;
          &lt;div className="row"&gt;
            &lt;div className="pill"&gt;SOL: {solBalance != null ? solBalance.toFixed(4) : "…"}&lt;/div&gt;
            &lt;div className="pill"&gt;CRT: {crtUiAmount != null ? Number(crtUiAmount).toFixed(4) : "—"}&lt;/div&gt;
            &lt;Button variant="secondary" onClick={() =&gt; { fetchSol(); fetchCRT(); }} disabled={isLoading}&gt;
              {isLoading ? "Refreshing…" : "Refresh"}
            &lt;/Button&gt;
          &lt;/div&gt;
          &lt;div className="grid"&gt;
            &lt;div&gt;
              &lt;Label htmlFor="crt"&gt;CRT Token Mint&lt;/Label&gt;
              &lt;Input id="crt" placeholder="Paste CRT mint address" value={crtMint} onChange={(e) =&gt; setCrtMint(e.target.value)} /&gt;
            &lt;/div&gt;
            &lt;div className="self-end"&gt;
              &lt;Button onClick={fetchCRT} disabled={!crtMint || isLoading}&gt;Detect Balance&lt;/Button&gt;
            &lt;/div&gt;
          &lt;/div&gt;
        &lt;/Card&gt;
      )}

      {connected &amp;&amp; (
        &lt;Card className="card"&gt;
          &lt;h3 className="mb-2"&gt;Send SOL (Devnet)&lt;/h3&gt;
          &lt;div className="grid"&gt;
            &lt;div&gt;
              &lt;Label htmlFor="amt"&gt;Amount (SOL)&lt;/Label&gt;
              &lt;Input id="amt" type="number" step="0.001" value={amount} onChange={(e) =&gt; setAmount(e.target.value)} /&gt;
            &lt;/div&gt;
            &lt;div&gt;
              &lt;Label htmlFor="to"&gt;Recipient Address&lt;/Label&gt;
              &lt;Input id="to" placeholder="Enter Solana address" value={recipient} onChange={(e) =&gt; setRecipient(e.target.value)} /&gt;
            &lt;/div&gt;
            &lt;div className="self-end"&gt;
              &lt;Button onClick={sendSol} disabled={isLoading || !recipient || !amount}&gt;{isLoading ? "Sending…" : "Send"}&lt;/Button&gt;
            &lt;/div&gt;
          &lt;/div&gt;
          {error &amp;&amp; &lt;div className="error"&gt;{error}&lt;/div&gt;}
        &lt;/Card&gt;
      )}
    &lt;/&gt;
  );
}

function App() {
  const network = "devnet";
  const endpoint = useMemo(() =&gt; clusterApiUrl(network), [network]);
  const wallets = useMemo(() =&gt; [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  // simple backend ping on load
  useEffect(() =&gt; {
    const ping = async () =&gt; {
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
    &lt;div className="App"&gt;
      &lt;div className="container"&gt;
        &lt;header className="header"&gt;
          &lt;div&gt;
            &lt;h1 className="title"&gt;Solana Devnet Onboarding&lt;/h1&gt;
            &lt;p className="subtitle"&gt;Connect wallet • Detect CRT • Send SOL&lt;/p&gt;
          &lt;/div&gt;
        &lt;/header&gt;
        &lt;ConnectionProvider endpoint={endpoint}&gt;
          &lt;WalletProvider wallets={wallets} autoConnect&gt;
            &lt;WalletModalProvider&gt;
              &lt;main className="main"&gt;
                &lt;WalletUI /&gt;
              &lt;/main&gt;
            &lt;/WalletModalProvider&gt;
          &lt;/WalletProvider&gt;
        &lt;/ConnectionProvider&gt;
      &lt;/div&gt;
    &lt;/div&gt;
  );
}

export default App;