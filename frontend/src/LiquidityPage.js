import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import Decimal from "decimal.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";

const CRT_MINT = "Aay7He9wCubaREq8EGm4BvEZiL77rPC2BfnjgJ5qzdxu"; // mainnet CRT
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
const JUP_BASE = "https://quote-api.jup.ag/v6"; // Jupiter REST

const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=mainnet-beta`;

export default function LiquidityPage() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction, connected } = useWallet();

  const [seedCRT, setSeedCRT] = useState("2000");
  const [seedUSDC, setSeedUSDC] = useState("10");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [sigs, setSigs] = useState([]);

  const pushSig = (label, sig) => setSigs((s) => [{ label, sig }, ...s].slice(0, 8));

  // Ensure ATAs exist for CRT and USDC
  const ensureATAs = useCallback(async () => {
    if (!publicKey) throw new Error("Connect wallet");
    const crtMint = new PublicKey(CRT_MINT);
    const usdcMint = new PublicKey(USDC_MAINNET);
    const crtAta = await getAssociatedTokenAddress(crtMint, publicKey);
    const usdcAta = await getAssociatedTokenAddress(usdcMint, publicKey);

    const tx = new Transaction();
    const infos = await Promise.all([
      connection.getAccountInfo(crtAta),
      connection.getAccountInfo(usdcAta),
    ]);
    if (!infos[0]) tx.add(createAssociatedTokenAccountInstruction(publicKey, crtAta, publicKey, crtMint));
    if (!infos[1]) tx.add(createAssociatedTokenAccountInstruction(publicKey, usdcAta, publicKey, usdcMint));

    if (tx.instructions.length) {
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const signed = await signTransaction(tx);
      const sig = await sendTransaction(signed, connection);
      await connection.confirmTransaction(sig, "confirmed");
      pushSig("Create ATAs", sig);
    }
    return { crtAta, usdcAta };
  }, [connection, publicKey, sendTransaction, signTransaction]);

  const getBalances = useCallback(async ({ crtAta, usdcAta }) => {
    let crt = 0, usdc = 0;
    try { const a = await getAccount(connection, crtAta); crt = Number(a.amount) / 1e9; } catch {}
    try { const b = await getAccount(connection, usdcAta); usdc = Number(b.amount) / 1e6; } catch {}
    return { crt, usdc };
  }, [connection]);

  const jupSwap = useCallback(async ({ inMint, outMint, uiAmount }) => {
    if (!publicKey) throw new Error("Connect wallet");
    // amount in smallest unit based on input token (assume CRT 9d, USDC 6d, SOL 9d)
    const dec = outMint === USDC_MAINNET ? 6 : 9;
    const smallest = Math.floor(uiAmount * 10 ** dec);
    const res = await fetch(`${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${smallest}&slippageBps=100`);
    const quote = await res.json();
    if (!quote || !quote.outAmount) throw new Error("No route found");

    const swapRes = await fetch(`${JUP_BASE}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: publicKey.toString(), wrapAndUnwrapSol: true }),
    });
    const txData = await swapRes.json();
    if (!txData || !txData.swapTransaction) throw new Error("Swap build failed");
    const buf = Buffer.from(txData.swapTransaction, "base64");
    const { VersionedTransaction } = await import("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(buf);
    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }, [publicKey, connection, sendTransaction]);

  const onPrepareSeed = useCallback(async () => {
    try {
      if (!connected || !publicKey) throw new Error("Connect wallet on mainnet");
      setBusy(true); setStatus("Preparing seed balances (CRT/USDC) via Jupiter…");
      const { crtAta, usdcAta } = await ensureATAs();
      const { crt, usdc } = await getBalances({ crtAta, usdcAta });
      const needCRT = Math.max(0, parseFloat(seedCRT || "0") - crt);
      const needUSDC = Math.max(0, parseFloat(seedUSDC || "0") - usdc);

      if (needCRT > 0) {
        setStatus((s) => s + `\nSwapping SOL → CRT (${needCRT})…`);
        const sig = await jupSwap({ inMint: "So11111111111111111111111111111111111111112", outMint: CRT_MINT, uiAmount: needCRT });
        pushSig("Swap SOL→CRT", sig);
      }
      if (needUSDC > 0) {
        setStatus((s) => s + `\nSwapping SOL → USDC (${needUSDC})…`);
        const sig = await jupSwap({ inMint: "So11111111111111111111111111111111111111112", outMint: USDC_MAINNET, uiAmount: needUSDC });
        pushSig("Swap SOL→USDC", sig);
      }
      setStatus((s) => s + "\nSeed prepared.");
    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message || e}`);
    } finally { setBusy(false); }
  }, [connected, publicKey, ensureATAs, getBalances, seedCRT, seedUSDC, jupSwap]);

  const onCreatePoolAndPosition = useCallback(async () => {
    if (!connected || !publicKey) { setStatus("Connect wallet on mainnet first"); return; }
    setBusy(true); setStatus("Loading Orca SDK…");
    try {
      const [{ WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient, PriceMath, PDAUtil, IGNORE_CACHE } , web3] = await Promise.all([
        import("@orca-so/whirlpools-sdk"),
        import("@solana/web3.js"),
      ]);

      const walletInterface = {
        publicKey,
        signTransaction,
        signAllTransactions: async (txs) => Promise.all(txs.map(tx => signTransaction(tx)))
      };

      const ctx = WhirlpoolContext.from(connection, walletInterface, ORCA_WHIRLPOOL_PROGRAM_ID);
      const client = buildWhirlpoolClient(ctx);

      // Parameters
      const tokenA = new web3.PublicKey(CRT_MINT);
      const tokenB = new web3.PublicKey(USDC_MAINNET);
      const tickSpacing = 64; // 0.30%
      const price = 5; // 1 CRT = 5 USDC

      setStatus("Checking/creating pool…");
      const sqrtPriceX64 = PriceMath.priceToSqrtPriceX64(price, 9, 6); // CRT 9d, USDC 6d
      const whirlpoolPda = PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, ctx.getConfig().publicKey, tokenA, tokenB, tickSpacing);

      // Try fetch pool
      let pool;
      try { pool = await client.getPool(whirlpoolPda.publicKey, IGNORE_CACHE); } catch {}

      if (!pool) {
        const tx = await client.createPool(ctx.getConfig().publicKey, tokenA, tokenB, tickSpacing, sqrtPriceX64);
        const signed = await signTransaction(tx);
        const sig = await sendTransaction(signed, connection);
        await connection.confirmTransaction(sig, "confirmed");
        pushSig("Create Pool", sig);
        setStatus(`Pool created.`);
        pool = await client.getPool(whirlpoolPda.publicKey, IGNORE_CACHE);
      } else { setStatus(`Pool exists: ${whirlpoolPda.publicKey.toString()}`); }

      // Open a wide position
      const state = await pool.refreshData();
      const currentTick = state.tickCurrentIndex;
      const lower = Math.floor((currentTick - 64 * 100) / 64) * 64;
      const upper = Math.ceil((currentTick + 64 * 100) / 64) * 64;

      const positionMint = web3.Keypair.generate();
      const liquidityAmount = new Decimal(1_000_000);

      setStatus("Opening position…");
      const openTx = await pool.openPosition(lower, upper, { liquidityAmount, tokenAmountA: null, tokenAmountB: null }, publicKey, positionMint);
      openTx.partialSign(positionMint);
      const signedOpen = await signTransaction(openTx);
      const openSig = await sendTransaction(signedOpen, connection);
      await connection.confirmTransaction(openSig, "confirmed");
      pushSig("Open Position", openSig);
      setStatus(`Position opened.`);

      setStatus((s) => s + "\nNext: Deposit Liquidity and Remove Liquidity buttons will be enabled in the next step.");
    } catch (e) { console.error(e); setStatus(`Error: ${e.message || e}`); } finally { setBusy(false); }
  }, [connected, connection, publicKey, sendTransaction, signTransaction]);

  const onDeposit = useCallback(async () => {
    setStatus("Deposit flow will be added next.");
  }, []);

  const onRemove = useCallback(async () => {
    setStatus("Remove liquidity flow will be added next.");
  }, []);

  return (
    <div className="container" style={{ padding: 24 }}>
      <Card className="card">
        <h2 className="mb-2">CRT/USDC Liquidity (Mainnet)</h2>
        <p className="muted">Create Orca Whirlpool (0.30% fee) at 1 CRT = 5 USDC, then manage liquidity.</p>
        <div className="grid">
          <div>
            <Label>Seed CRT</Label>
            <Input value={seedCRT} onChange={(e) => setSeedCRT(e.target.value)} />
          </div>
          <div>
            <Label>Seed USDC</Label>
            <Input value={seedUSDC} onChange={(e) => setSeedUSDC(e.target.value)} />
          </div>
          <div className="self-end">
            <div className="row">
              <Button disabled={!connected || busy} onClick={onPrepareSeed}>
                {busy ? "Working…" : "Prepare Seed (Jupiter)"}
              </Button>
              <Button disabled={!connected || busy} onClick={onCreatePoolAndPosition}>
                {busy ? "Processing…" : "Create Pool & Position"}
              </Button>
              <Button disabled={!connected || busy} onClick={onDeposit}>Deposit Liquidity</Button>
              <Button disabled={!connected || busy} onClick={onRemove}>Remove Liquidity</Button>
            </div>
          </div>
        </div>
        {status && <div style={{ marginTop: 12 }} className="muted">{status}</div>}
        {sigs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h4 className="mb-2">Recent Transactions</h4>
            {sigs.map(({ label, sig }, i) => (
              <div key={i} className="pill" style={{ marginBottom: 6 }}>
                {label}: <a href={explorerTx(sig)} target="_blank" rel="noreferrer">{sig.slice(0, 10)}…</a>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}