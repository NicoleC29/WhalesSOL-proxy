// Vercel Serverless Function — Solana Whale Tracker Proxy
// Location: api/proxy.js

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

module.exports = async function handler(req, res) {

  // ── CORS — allow all origins ──────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { endpoint, wallet, limit = 20 } = req.query;

  if (!wallet) {
    return res.status(400).json({ error: "wallet address required" });
  }

  try {

    // ── 1. Balance (Solana public RPC) ──────────────────────────────────
    if (endpoint === "balance") {
      const r = await fetch("https://api.mainnet-beta.solana.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [wallet]
        })
      });
      const data = await r.json();
      const sol = (data.result?.value || 0) / 1e9;
      return res.status(200).json({ sol });
    }

    // ── 2. Transactions (Helius) ─────────────────────────────────────────
    if (endpoint === "transactions") {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=SWAP`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Helius error: ${r.status}`);
      const data = await r.json();

      const trades = data.map(tx => {
        const swap = tx.events?.swap;
        const tokenIn  = swap?.tokenInputs?.[0]  || {};
        const tokenOut = swap?.tokenOutputs?.[0] || {};
        return {
          signature: tx.signature,
          timeAgo: timeAgo(tx.timestamp),
          source: tx.source || "UNKNOWN",
          tokenIn: {
            symbol: tokenIn.symbol || tokenIn.tokenStandard || "???",
            amount: tokenIn.rawTokenAmount?.tokenAmount || 0,
            mint: tokenIn.mint || ""
          },
          tokenOut: {
            symbol: tokenOut.symbol || tokenOut.tokenStandard || "???",
            amount: tokenOut.rawTokenAmount?.tokenAmount || 0,
            mint: tokenOut.mint || ""
          }
        };
      }).filter(t => t.tokenIn.mint);

      return res.status(200).json({ trades });
    }

    // ── 3. Portfolio (Birdeye) ───────────────────────────────────────────
    if (endpoint === "portfolio") {
      const url = `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`;
      const r = await fetch(url, {
        headers: {
          "X-API-KEY": BIRDEYE_KEY,
          "x-chain": "solana"
        }
      });
      if (!r.ok) throw new Error(`Birdeye error: ${r.status}`);
      const data = await r.json();

      const tokens = (data.data?.items || [])
        .filter(t => t.uiAmount > 0)
        .map(t => ({
          symbol: t.symbol || "???",
          mint: t.address,
          balance: t.uiAmount,
          usdValue: t.valueUsd || 0,
          price: t.priceUsd || 0,
          change24h: t.priceChange24hPercent || 0
        }))
        .sort((a, b) => b.usdValue - a.usdValue)
        .slice(0, 20);

      const totalUsd = tokens.reduce((s, t) => s + t.usdValue, 0);
      return res.status(200).json({ tokens, totalUsd });
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });

  } catch (err) {
    console.error("[proxy error]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

function timeAgo(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

