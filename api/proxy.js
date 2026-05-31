/**
 * Vercel Serverless Function — Solana Whale Tracker Proxy
 * File location: /api/proxy.js
 *
 * Securely proxies requests to Helius & Birdeye APIs.
 * Your API keys never leave the server.
 *
 * Deploy: push this folder to GitHub → import on vercel.com
 */

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "http://localhost:3000",
  // Add your own domain here when you deploy the frontend
];

module.exports = async function handler(req, res){
  // ── CORS ──────────────────────────────────────────────────────────────
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { endpoint, wallet, limit = 20 } = req.query;

  if (!wallet) return res.status(400).json({ error: "wallet address required" });

  try {
    switch (endpoint) {

      // ── 1. Recent transactions (Helius parsed) ──────────────────────
      case "transactions": {
        const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=SWAP`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Helius error: ${r.status}`);
        const data = await r.json();

        // Normalise into a clean trade schema
        const trades = data.map(tx => {
          const swap = tx.events?.swap;
          const tokenIn  = swap?.tokenInputs?.[0]  || {};
          const tokenOut = swap?.tokenOutputs?.[0] || {};
          return {
            signature: tx.signature,
            timestamp: tx.timestamp,
            timeAgo: timeAgo(tx.timestamp),
            action: "SWAP",
            tokenIn:  { mint: tokenIn.mint,  symbol: tokenIn.tokenStandard  || "???", amount: tokenIn.rawTokenAmount?.tokenAmount  || 0 },
            tokenOut: { mint: tokenOut.mint, symbol: tokenOut.tokenStandard || "???", amount: tokenOut.rawTokenAmount?.tokenAmount || 0 },
            fee: tx.fee,
            source: tx.source, // e.g. JUPITER, RAYDIUM
          };
        }).filter(t => t.tokenIn.mint); // drop non-swap txs

        return res.status(200).json({ trades });
      }

      // ── 2. Wallet portfolio + PnL (Birdeye) ────────────────────────
      case "portfolio": {
        const url = `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`;
        const r = await fetch(url, {
          headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" }
        });
        if (!r.ok) throw new Error(`Birdeye error: ${r.status}`);
        const data = await r.json();

        const tokens = (data.data?.items || [])
          .filter(t => t.uiAmount > 0)
          .map(t => ({
            symbol:   t.symbol,
            mint:     t.address,
            balance:  t.uiAmount,
            usdValue: t.valueUsd,
            price:    t.priceUsd,
            change24h: t.priceChange24hPercent,
          }))
          .sort((a, b) => b.usdValue - a.usdValue)
          .slice(0, 20);

        const totalUsd = tokens.reduce((s, t) => s + (t.usdValue || 0), 0);
        return res.status(200).json({ tokens, totalUsd });
      }

      // ── 3. Token price (Birdeye) ────────────────────────────────────
      case "price": {
        const { mint } = req.query;
        if (!mint) return res.status(400).json({ error: "mint required" });
        const url = `https://public-api.birdeye.so/defi/price?address=${mint}`;
        const r = await fetch(url, {
          headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" }
        });
        if (!r.ok) throw new Error(`Birdeye price error: ${r.status}`);
        const data = await r.json();
        return res.status(200).json({ price: data.data?.value, mint });
      }

      // ── 4. Wallet SOL balance (public RPC) ─────────────────────────
      case "balance": {
        const r = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getBalance",
            params: [wallet]
          })
        });
        const data = await r.json();
        const sol = (data.result?.value || 0) / 1e9;
        return res.status(200).json({ sol });
      }

      default:
        return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
    }
  } catch (err) {
    console.error("[proxy error]", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────
function timeAgo(unixTs) {
  const diff = Math.floor(Date.now() / 1000) - unixTs;
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

