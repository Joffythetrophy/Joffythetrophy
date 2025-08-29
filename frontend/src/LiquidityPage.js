import { useState, useMemo, useCallback, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import Decimal from "decimal.js";

// NOTE: We are not importing Orca SDK here yet to avoid impacting main bundle.
// We'll progressively enhance by lazy-importing inside handlers when user clicks.

const CRT_MINT = "9pjWtc6x88wrRMXTxkBcNB6YtcN7NNcyzDAfUMfRknty"; // your CRT
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // common devnet USDC mint

export default function LiquidityPage() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction, connected } = useWallet();

  const [seedCRT, setSeedCRT] = useState("20");
  const [seedUSDC, setSeedUSDC] = useState("100");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const onCreatePoolAndDeposit = useCallback(async () => {
    if (!connected || !publicKey) {
      setStatus("Connect wallet on devnet first");
      return;
    }
    setBusy(true);
    setStatus("Loading Orca SDK…");
    try {
      const [{ WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID, buildWhirlpoolClient, PriceMath, PDAUtil, WhirlpoolIx, IGNORE_CACHE, WhirlpoolClient } , anchor, web3] = await Promise.all([
        import("@orca-so/whirlpools-sdk"),
        import("@coral-xyz/anchor"),
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
      const tokenB = new web3.PublicKey(USDC_DEVNET);
      const tickSpacing = 64; // 0.30%
      const price = 5; // 1 CRT = 5 USDC

      setStatus("Checking/creating pool…");
      const sqrtPriceX64 = PriceMath.priceToSqrtPriceX64(price, 9, 6); // CRT 9d, USDC 6d
      const whirlpoolPda = PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, ctx.getConfig().publicKey, tokenA, tokenB, tickSpacing);

      // Try fetch pool
      let pool;
      try {
        pool = await client.getPool(whirlpoolPda.publicKey, IGNORE_CACHE);
      } catch {}

      if (!pool) {
        const tx = await client.createPool(ctx.getConfig().publicKey, tokenA, tokenB, tickSpacing, sqrtPriceX64);
        const signed = await signTransaction(tx);
        const sig = await sendTransaction(signed, connection);
        await connection.confirmTransaction(sig, "confirmed");
        setStatus(`Pool created. Sig: ${sig}`);
        pool = await client.getPool(whirlpoolPda.publicKey, IGNORE_CACHE);
      } else {
        setStatus(`Pool exists: ${whirlpoolPda.publicKey.toString()}`);
      }

      // Create a wide position around current tick
      const state = await pool.refreshData();
      const currentTick = state.tickCurrentIndex;
      const lower = Math.floor((currentTick - 64 * 100) / 64) * 64;
      const upper = Math.ceil((currentTick + 64 * 100) / 64) * 64;

      const positionMint = web3.Keypair.generate();
      const liquidityAmount = new Decimal(1_000_000); // placeholder; SDK computes needed token amounts internally when depositing exact tokens

      setStatus("Opening position…");
      const openTx = await pool.openPosition(lower, upper, { liquidityAmount, tokenAmountA: null, tokenAmountB: null }, publicKey, positionMint);
      openTx.partialSign(positionMint);
      const openSig = await sendTransaction(await signTransaction(openTx), connection);
      await connection.confirmTransaction(openSig, "confirmed");
      setStatus(`Position minted. Sig: ${openSig}`);

      // In a full implementation, convert seedCRT/seedUSDC via Jupiter as needed and add deposit instructions
      setStatus((s) => s + "\nDeposit step to be wired after seed swaps (Jupiter)." );
    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message || e}`);
    } finally {
      setBusy(false);
    }
  }, [connected, connection, publicKey, sendTransaction, signTransaction, seedCRT, seedUSDC]);

  return (
    <div className="container" style={{ padding: 24 }}>
      <Card className="card">
        <h2 className="mb-2">CRT/USDC Liquidity (Devnet)</h2>
        <p className="muted">Create Orca Whirlpool (0.30% fee) at 1 CRT = 5 USDC, then deposit.</p>
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
            <Button disabled={!connected || busy} onClick={onCreatePoolAndDeposit}>
              {busy ? "Processing…" : "Create Pool & Deposit"}
            </Button>
          </div>
        </div>
        {status && <div style={{ marginTop: 12 }} className="muted">{status}</div>}
      </Card>
    </div>
  );
}
