// Vercel Serverless Function — Solana Whale Tracker Proxy
// Location: api/proxy.js

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;

module.exports = async function handler(req, res) {

  // ── CORS ─────────────────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { endpoint, wallet, limit = 20 } = req.query;
  if (!wallet) return res.status(400).json({ error: "wallet address required" });

  try {

    // ── 1. Balance ────────────────────────────────────────────────────
    if (endpoint === "balance") {
      const r = await fetch("https://api.mainnet-beta.solana.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"getBalance", params:[wallet] })
      });
      const data = await r.json();
      return res.status(200).json({ sol: (data.result?.value || 0) / 1e9 });
    }

    // ── 2. Transactions (Helius enhanced) ─────────────────────────────
    if (endpoint === "transactions") {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=SWAP`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Helius error: ${r.status}`);
      const data = await r.json();

      // Collect all unique mints to resolve symbols
      const mints = new Set();
      data.forEach(tx => {
        const swap = tx.events?.swap;
        if (swap?.tokenInputs?.[0]?.mint)  mints.add(swap.tokenInputs[0].mint);
        if (swap?.tokenOutputs?.[0]?.mint) mints.add(swap.tokenOutputs[0].mint);
        // Also check accountData for token info
        (tx.accountData || []).forEach(a => { if (a.tokenBalanceChanges) {
          a.tokenBalanceChanges.forEach(c => { if (c.mint) mints.add(c.mint); });
        }});
      });

      // Resolve symbols via Helius token metadata
      const symbolMap = {};
      if (mints.size > 0) {
        try {
          const metaRes = await fetch(`https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mintAccounts: [...mints], includeOffChain: false, disableCache: false })
          });
          if (metaRes.ok) {
            const metaData = await metaRes.json();
            metaData.forEach(m => {
              const sym = m.onChainMetadata?.metadata?.data?.symbol
                || m.legacyMetadata?.symbol
                || null;
              if (sym && m.account) symbolMap[m.account] = sym.trim();
            });
          }
        } catch(e) { /* symbol lookup failed, use mint short form */ }
      }

      // Known stable mints fallback
      const KNOWN = {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
        "So11111111111111111111111111111111111111112":   "SOL",
        "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
        "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
        "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "BTC",
        "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
        "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  "JUP",
        "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
        "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
      };

      const getSymbol = (mint) => {
        if (!mint) return "???";
        return KNOWN[mint] || symbolMap[mint] || mint.slice(0,4)+"…";
      };

      const trades = data.map(tx => {
        const swap = tx.events?.swap;
        const tokenIn  = swap?.tokenInputs?.[0]  || {};
        const tokenOut = swap?.tokenOutputs?.[0] || {};

        // Try to get amounts from nativeInput/nativeOutput too
        const amtIn  = tokenIn.rawTokenAmount?.tokenAmount  || tokenIn.rawTokenAmount || 0;
        const amtOut = tokenOut.rawTokenAmount?.tokenAmount || tokenOut.rawTokenAmount || 0;

        return {
          signature: tx.signature,
          timeAgo: timeAgo(tx.timestamp),
          source: tx.source || "UNKNOWN",
          tokenIn: {
            symbol: getSymbol(tokenIn.mint),
            amount: amtIn,
            mint: tokenIn.mint || ""
          },
          tokenOut: {
            symbol: getSymbol(tokenOut.mint),
            amount: amtOut,
            mint: tokenOut.mint || ""
          }
        };
      }).filter(t => t.tokenIn.mint);

      return res.status(200).json({ trades });
    }

    // ── 3. Portfolio (Birdeye) ────────────────────────────────────────
    if (endpoint === "portfolio") {
      const url = `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${wallet}`;
      const r = await fetch(url, {
        headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" }
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

