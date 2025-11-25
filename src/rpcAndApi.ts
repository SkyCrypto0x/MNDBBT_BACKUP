import fetch from "node-fetch";
import { ChainId } from "./config";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url?: string;
  liquidity?: {
    usd?: number;
  };
}

/**
 * Normalize DexScreener chain field → our ChainId
 * Only effectively use: ethereum, bsc, base, monad
 */
function normalizeDexChain(raw: any): string | undefined {
  if (!raw) return undefined;
  let c = String(raw).toLowerCase();

  // alias handling
  if (c === "eth") c = "ethereum";
  if (c === "bnb" || c === "bsc") c = "bsc";

  // "base", "monad" etc already okay as-is
  return c;
}

// simple in-memory cache (future Redis-ready)
const tokenPairsCache = new Map<
  string,
  { value: DexPair[]; ts: number }
>();
const TOKEN_PAIRS_TTL_MS = 2 * 60 * 1000; // 2 min

export async function fetchTokenPairs(
  chain: ChainId,
  tokenAddress: string
): Promise<DexPair[]> {
  const addr = tokenAddress.toLowerCase();
  const cacheKey = `${chain}:${addr}`;
  const now = Date.now();
  const cached = tokenPairsCache.get(cacheKey);
  if (cached && now - cached.ts < TOKEN_PAIRS_TTL_MS) {
    return cached.value;
  }

  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
    let res = await fetch(url);
    let data: any = await res.json();

    let pairs: any[] = Array.isArray(data.pairs) ? data.pairs : [];

    // If no direct token result, fallback to search
    if (!pairs.length) {
      const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${addr}`;
      const searchRes = await fetch(searchUrl);
      const searchData: any = await searchRes.json();
      if (Array.isArray(searchData.pairs)) {
        pairs = searchData.pairs;
      }
    }

    if (!pairs.length) {
      tokenPairsCache.set(cacheKey, { value: [], ts: now });
      return [];
    }

    const result: DexPair[] = pairs
      .filter((p: any) => {
        const n = normalizeDexChain(
          p.chainId ?? p.chain?.id ?? p.chainName ?? p.chain?.name
        );
        return n === chain;
      })
      // small dust pools ছাঁটাই → কমপক্ষে $10 liq
      .filter((p: any) => {
        const liq = p.liquidity?.usd ?? 0;
        return liq >= 10;
      })
      .map((p: any) => ({
        chainId:
          (normalizeDexChain(
            p.chainId ?? p.chain?.id ?? p.chainName ?? p.chain?.name
          ) as string) ?? "",
        dexId: p.dexId,
        pairAddress: p.pairAddress,
        url: p.url,
        liquidity: { usd: p.liquidity?.usd }
      }));

    tokenPairsCache.set(cacheKey, { value: result, ts: now });
    return result;
  } catch (e) {
    console.error("DexScreener fetch error:", e);
    return [];
  }
}

export async function resolvePairFromToken(
  chain: ChainId,
  tokenAddress: string
): Promise<string | null> {
  const pairs = await fetchTokenPairs(chain, tokenAddress);
  if (!pairs.length) return null;

  let best = pairs[0];
  for (const p of pairs) {
    const bestLiq = Number(best?.liquidity?.usd ?? 0);
    const curLiq = Number(p?.liquidity?.usd ?? 0);
    if (curLiq > bestLiq) best = p;
  }
  return best.pairAddress ?? null;
}
