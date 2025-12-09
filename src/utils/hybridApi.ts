// src/utils/hybridApi.ts

import fetch, { type Response } from "node-fetch";

/**
 * Normalised pair info used by the rest of the bot.
 * DexScreener + GeckoTerminal both map into this shape.
 */
export interface HybridPair {
  address: string;
  symbol: string;
  liquidityUsd: number;
  age: number; // seconds
  chain: string;
  source: "dexscreener" | "geckoterminal";
}

/**
 * Backwards-compat type for older code that still refers to SimplePairInfo.
 * This fixes: "has no exported member 'SimplePairInfo'" in liveBuyTracker.ts
 */
export type SimplePairInfo = HybridPair;

export const GECKO_MAP: Record<string, string> = {
  bsc: "bsc",
  ethereum: "eth",
  base: "base",
  monad: "monad",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  solana: "solana",
  avalanche: "avax",
  sonic: "sonic-svm"
};

// timeout সহ fetch helper (Node 16 compatible)
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, { signal: controller.signal as any });
    return res as any;
  } finally {
    clearTimeout(id);
  }
}

// ---------------- DexScreener — PRIMARY ----------------

async function fetchDex(chain: string): Promise<HybridPair[]> {
  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}?orderBy=age&order=asc&limit=40`,
      7000
    );

    if (!res.ok) return [];

    const data: any = await res.json();
    if (!Array.isArray(data.pairs)) return [];

    const now = Date.now() / 1000;

    const pairs: HybridPair[] = data.pairs
      .map((p: any): HybridPair => {
        const ts: number = p.pairCreatedAt || p.createdAt || now * 1000;
        const age = Math.max(0, Math.floor(now - ts / 1000));

        return {
          address: String(p.pairAddress || "").toLowerCase(),
          symbol: `${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}`,
          liquidityUsd: Number(p.liquidity?.usd || 0),
          age,
          chain,
          source: "dexscreener"
        };
      })
      .filter((p: HybridPair) => p.address && p.liquidityUsd > 0);

    return pairs;
  } catch {
    // rate-limit / network error → just return empty, hybrid will fall back
    return [];
  }
}

// ---------------- GeckoTerminal — BACKUP ----------------

async function fetchGecko(chain: string): Promise<HybridPair[]> {
  const network = GECKO_MAP[chain];
  if (!network) return [];

  try {
    const res = await fetchWithTimeout(
      `https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?limit=40`,
      8000
    );

    if (!res.ok) return [];

    const data: any = await res.json();
    if (!data.data) return [];

    const now = Date.now() / 1000;

    const pairs: HybridPair[] = (data.data as any[]).map((p: any): HybridPair => {
      const a = p.attributes ?? {};
      const created = a.pool_created_at
        ? new Date(a.pool_created_at).getTime() / 1000
        : now;

      return {
        address: String(a.address || p.id || "").toLowerCase(),
        symbol: `${a.base_token_symbol ?? "?"}/${a.quote_token_symbol ?? "?"}`,
        liquidityUsd: Number(a.reserve_in_usd || 0),
        age: Math.max(0, Math.floor(now - created)),
        chain,
        source: "geckoterminal"
      };
    });

    return pairs;
  } catch {
    return [];
  }
}

// ---------------- PUBLIC HYBRID HELPER ----------------

/**
 * Hybrid new-pair fetch:
 * 1) DexScreener results first (primary, lower req / min)
 * 2) GeckoTerminal only for pairs that Dex didn't return
 */
export async function getNewPairsHybrid(
  chain: string,
  minLiquidityUsd = 1000,
  maxAgeSec = 600 // 10 min
): Promise<HybridPair[]> {
  const [dex, gecko] = await Promise.allSettled<HybridPair[]>([
    fetchDex(chain),
    fetchGecko(chain)
  ]);

  const dexPairs = dex.status === "fulfilled" ? dex.value : [];
  const geckoPairs = gecko.status === "fulfilled" ? gecko.value : [];

  const seen = new Set<string>();
  const result: HybridPair[] = [];

  // 1. DexScreener first (priority, because it lists new pairs earliest)
  for (const p of dexPairs) {
    if (seen.has(p.address)) continue;
    if (p.liquidityUsd >= minLiquidityUsd && p.age <= maxAgeSec) {
      seen.add(p.address);
      result.push(p);
    }
  }

  // 2. GeckoTerminal only if not already seen
  for (const p of geckoPairs) {
    if (seen.has(p.address)) continue;
    if (p.liquidityUsd >= minLiquidityUsd && p.age <= maxAgeSec) {
      seen.add(p.address);
      result.push(p);
    }
  }

  // Newest first (lowest age)
  result.sort((a, b) => a.age - b.age);

  return result;
}
