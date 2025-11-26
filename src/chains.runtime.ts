import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import fetch from "node-fetch";
import { appConfig, ChainId } from "./config";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import { BuyBotSettings } from "./feature.buyBot";
import { globalAlertQueue } from "./queue";
import {
  getNewPairsHybrid,
  type SimplePairInfo,
  GECKO_MAP
} from "./utils/hybridApi";
import { sendPremiumBuyAlert, PremiumAlertData } from "./alerts.buy";

// ────────────────── V2 / V3 / V4 Swap ABIs ──────────────────
export const PAIR_V2_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)"
];

export const PAIR_V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

export const PAIR_V4_ABI = [
  "event Swap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint256 feeProtocol)"
];

// ────────────────── Monad special DEX addresses ──────────────────

const MONAD_NAD_BONDING_ROUTER =
  "0x6F6B8F1a20703309951a5127c45B49b1CD981A22".toLowerCase();
// চাইলে চাইলে এটারও ব্যবহার করতে পারো, কিন্তু listener bonding router-এই থাকবে
const MONAD_NAD_BONDING_CURVE =
  "0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE".toLowerCase();

// ভবিষ্যতে দরকার হলে আলাদা ভাবে ব্যবহার করার জন্য রাখলাম:
const MONAD_NAD_DEX_ROUTER =
  "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137".toLowerCase();
const MONAD_KURU_SWAP_ROUTER =
  "0x465D06d4521ae9Ce724E0c182Daad5D8a2Ff7040".toLowerCase();
const MONAD_CAPRICORN_ROUTER =
  "0xdac97b6a3951641B177283028A8f428332333071".toLowerCase();

// Nad.fun BondingCurveRouter minimal ABI – শুধু event টা দরকার
const NAD_BONDING_ROUTER_ABI = [
  "event CurveBuy(address indexed to, address indexed token, uint256 actualAmountIn, uint256 effectiveAmountOut)"
];

// Nad.fun DEX_ROUTER minimal ABI – DexRouterBuy / DexRouterSell
const NAD_DEX_ROUTER_ABI = [
  "event DexRouterBuy(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut)",
  "event DexRouterSell(address indexed sender, address indexed token, uint256 amountIn, uint256 amountOut)"
];

export interface PairRuntime {
  v2: ethers.Contract;
  v3?: ethers.Contract;
  v4?: ethers.Contract;
  token0: string;
  token1: string;
  targetToken: string; // track which token this pair is for
}

export interface ChainRuntime {
  provider: ethers.providers.BaseProvider;
  pairs: Map<string, PairRuntime>;
  rpcUrl: string;
  isWebSocket: boolean;
}

export const runtimes = new Map<ChainId, ChainRuntime>();

// native price cache
const nativePriceCache = new Map<string, { value: number; ts: number }>();
const NATIVE_TTL_MS = 30_000;

// Dex pair info cache (legacy – still kept, but main throttling uses dexPairCache)
const pairInfoCache = new Map<string, { value: any | null; ts: number }>();
const PAIR_INFO_TTL_MS = 15_000;

// 🔥 NEW: dedicated DexScreener pair cache (throttled + fallback)
const DEX_PAIR_TTL_MS = 8_000; // 8s per pair
const dexPairCache = new Map<string, { data: any | null; ts: number }>();

// --- GeckoTerminal fallback cache (minimal) ---
const geckoPairCache = new Map<string, { value: any | null; ts: number }>();
const GECKO_PAIR_TTL_MS = 10_000; // 10s per pair

async function getGeckoPairInfo(
  chain: ChainId,
  pairAddress: string
): Promise<{
  priceUsd: number;
  fdv: number;
  liquidityUsd: number;
  volume24h: number;
} | null> {
  const geckoNetwork = GECKO_MAP[chain];
  if (!geckoNetwork) return null; // এই chain Geckoterminal সাপোর্ট না করলে

  const key = `${geckoNetwork}:${pairAddress.toLowerCase()}`;
  const now = Date.now();
  const cached = geckoPairCache.get(key);
  if (cached && now - cached.ts < GECKO_PAIR_TTL_MS) {
    return cached.value;
  }

  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${geckoNetwork}/pools/${pairAddress}`
    );
    if (!res.ok) {
      console.warn(`Gecko HTTP ${res.status} for ${key}`);
      return cached?.value ?? null;
    }

    const json: any = await res.json();
    const attrs = json?.data?.attributes;
    if (!attrs) return null;

    const value = {
      priceUsd: Number(attrs.base_token_price_usd ?? 0),
      fdv: Number(attrs.fdv_usd ?? 0),
      liquidityUsd: Number(
        attrs.reserve_in_usd ??
          attrs.reserve_usd ??
          attrs.total_reserve_in_usd ??
          0
      ),
      volume24h: Number(attrs.volume_usd_24h ?? 0)
    };

    geckoPairCache.set(key, { value, ts: now });
    return value;
  } catch (e: any) {
    console.error(`Gecko fetch failed for ${key}:`, e?.message ?? e);
    return cached?.value ?? null;
  }
}

async function getDexPairInfoThrottled(
  chain: ChainId,
  pairAddress: string
): Promise<any | null> {
  const key = `${chain}:${pairAddress.toLowerCase()}`;
  const now = Date.now();

  const cached = dexPairCache.get(key);
  if (cached && now - cached.ts < DEX_PAIR_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/${chain}/${pairAddress}`
    );

    if (!res.ok) {
      console.warn(`DexScreener HTTP ${res.status} for ${key}`);
      // fallback to cached (even if stale) so bot doesn't break
      return cached?.data ?? null;
    }

    const json: any = await res.json();
    const pairsArr = Array.isArray(json?.pairs)
      ? json.pairs
      : json?.pair
      ? [json.pair]
      : [];

    const data = pairsArr[0] || null;
    dexPairCache.set(key, { data, ts: now });
    return data;
  } catch (e: any) {
    console.error(`DexScreener fetch failed for ${key}:`, e?.message ?? e);
    // fallback to last known data if available
    return cached?.data ?? null;
  }
}

// 🔥 NEW: known routers + contract-check cache
const KNOWN_ROUTERS = new Set(
  [
    // nad.fun / অন্য aggregator / router গুলো এখানে অ্যাড করতে পারো
    "0xe7671fab48a5e213a14238e8e669688cfdfbb02a" // nad.fun উদাহরণ
  ].map((a) => a.toLowerCase())
);

const contractCheckCache = new Map<string, boolean>();

async function isContractAddress(
  chain: ChainId,
  address: string
): Promise<boolean> {
  const lower = address.toLowerCase();

  // FIX: chain-aware cache key
  const key = `${chain}:${lower}`;

  if (contractCheckCache.has(key)) {
    return contractCheckCache.get(key)!;
  }

  try {
    const runtime = runtimes.get(chain);
    if (!runtime) {
      // runtime না থাকলে, safe side এ EOA ধরছি
      contractCheckCache.set(key, false);
      return false;
    }

    const code = await runtime.provider.getCode(lower);
    const isContract = !!code && code !== "0x";
    contractCheckCache.set(key, isContract);
    return isContract;
  } catch (e) {
    console.warn(
      `getCode failed for ${lower} on ${chain}`,
      (e as any)?.message ?? e
    );
    // RPC error হলে real buyer miss না করার জন্য contract না ধরে নিচ্ছি
    contractCheckCache.set(key, false);
    return false;
  }
}

// Periodic pruning to avoid unbounded Map size
const CACHE_PRUNE_INTERVAL_MS = 5 * 60_000; // 5 minutes

setInterval(() => {
  const now = Date.now();

  // nativePriceCache: delete entries long past TTL
  for (const [key, entry] of nativePriceCache.entries()) {
    if (now - entry.ts > NATIVE_TTL_MS + 60_000) {
      nativePriceCache.delete(key);
    }
  }

  // pairInfoCache: delete entries long past TTL (legacy – kept for compatibility)
  for (const [key, entry] of pairInfoCache.entries()) {
    if (now - entry.ts > PAIR_INFO_TTL_MS + 5 * 60_000) {
      pairInfoCache.delete(key);
    }
  }

  // 🔥 NEW: prune DexScreener cache too
  for (const [key, entry] of dexPairCache.entries()) {
    if (now - entry.ts > DEX_PAIR_TTL_MS + 60_000) {
      dexPairCache.delete(key);
    }
  }

  // GeckoTerminal cache: delete entries long past TTL
  for (const [key, entry] of geckoPairCache.entries()) {
    if (now - entry.ts > GECKO_PAIR_TTL_MS + 60_000) {
      geckoPairCache.delete(key);
    }
  }
}, CACHE_PRUNE_INTERVAL_MS);

// per-chain abort controller for hybrid scanners
const scannerAbortControllers = new Map<ChainId, AbortController>();

// Nad.fun bonding listeners per chain
const nadBondingAttached = new Map<ChainId, boolean>();

// helpers – clear caches from /clearcache
export function clearChainCaches() {
  pairInfoCache.clear();
  nativePriceCache.clear();
  dexPairCache.clear(); // 🔥 NEW: also clear DexScreener throttle cache
  geckoPairCache.clear(); // 🔥 NEW: also clear Gecko fallback cache
}

// 🆕 helper – WS reconnect এর সময় আবার attach করতে চাইলে
export function resetNadBondingFlag(chain: ChainId) {
  nadBondingAttached.delete(chain);
}

// ────────────────── SWAP LISTENER ATTACH (V2+V3+V4) ──────────────────

export function attachSwapListener(
  bot: Telegraf,
  chain: ChainId,
  addr: string,
  provider: ethers.providers.BaseProvider,
  tokens: { token0: string; token1: string },
  targetToken: string
): PairRuntime {
  const targetTokenLower = targetToken.toLowerCase();

  // V2
  const v2 = new ethers.Contract(addr, PAIR_V2_ABI, provider);
  v2.on(
    "Swap",
    (sender, amount0In, amount1In, amount0Out, amount1Out, to, event) => {
      handleSwap(
        bot,
        chain,
        addr,
        tokens,
        event.transactionHash,
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to,
        event.blockNumber
      );
    }
  );

  // V3
  const v3 = new ethers.Contract(addr, PAIR_V3_ABI, provider);
  v3.on(
    "Swap",
    (sender, recipient, amount0, amount1, _p, _l, _t, event) => {
      try {
        const a0 = BigInt(amount0.toString());
        const a1 = BigInt(amount1.toString());

        const isToken0 = tokens.token0 === targetTokenLower;
        const isBuy = (isToken0 && a0 < 0n) || (!isToken0 && a1 < 0n);
        if (!isBuy) return;

        const amount0In = a0 > 0n ? a0 : 0n;
        const amount1In = a1 > 0n ? a1 : 0n;
        const amount0Out = a0 < 0n ? -a0 : 0n;
        const amount1Out = a1 < 0n ? -a1 : 0n;

        handleSwap(
          bot,
          chain,
          addr,
          tokens,
          event.transactionHash,
          ethers.BigNumber.from(amount0In),
          ethers.BigNumber.from(amount1In),
          ethers.BigNumber.from(amount0Out),
          ethers.BigNumber.from(amount1Out),
          recipient,
          event.blockNumber
        );
      } catch (e) {
        console.error("V3 Swap handler error:", e);
      }
    }
  );

  // V4
  const v4 = new ethers.Contract(addr, PAIR_V4_ABI, provider);
  v4.on(
    "Swap",
    (sender, recipient, amount0, amount1, _p, _l, _t, _fee, event) => {
      try {
        const a0 = BigInt(amount0.toString());
        const a1 = BigInt(amount1.toString());

        const isToken0 = tokens.token0 === targetTokenLower;
        const isBuy = (isToken0 && a0 < 0n) || (!isToken0 && a1 < 0n);
        if (!isBuy) return;

        const amount0In = a0 > 0n ? a0 : 0n;
        const amount1In = a1 > 0n ? a1 : 0n;
        const amount0Out = a0 < 0n ? -a0 : 0n;
        const amount1Out = a1 < 0n ? -a1 : 0n;

        handleSwap(
          bot,
          chain,
          addr,
          tokens,
          event.transactionHash,
          ethers.BigNumber.from(amount0In),
          ethers.BigNumber.from(amount1In),
          ethers.BigNumber.from(amount0Out),
          ethers.BigNumber.from(amount1Out),
          recipient,
          event.blockNumber
        );
      } catch (e) {
        console.error("V4 Swap handler error:", e);
      }
    }
  );

  return {
    v2,
    v3,
    v4,
    token0: tokens.token0,
    token1: tokens.token1,
    targetToken: targetTokenLower
  };
}

// ────────────────── SWAP HANDLER ──────────────────

async function handleSwap(
  bot: Telegraf,
  chain: ChainId,
  pairAddress: string,
  tokens: { token0: string; token1: string },
  txHash: string,
  amount0In: ethers.BigNumber,
  amount1In: ethers.BigNumber,
  amount0Out: ethers.BigNumber,
  amount1Out: ethers.BigNumber,
  to: string,
  blockNumber: number
) {
  const relatedGroups: [number, BuyBotSettings][] = [];

  for (const [groupId, settings] of groupSettings.entries()) {
    if (
      settings.chain === chain &&
      settings.allPairAddresses?.some(
        (p) => p.toLowerCase() === pairAddress.toLowerCase()
      )
    ) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (relatedGroups.length === 0) return;

  const settings = relatedGroups[0][1];

  if (!settings.allPairAddresses || settings.allPairAddresses.length <= 1) {
    const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
    if (validPairs.length > 0) {
      settings.allPairAddresses = validPairs.map((p) => p.address);
      markGroupSettingsDirty();
      console.log(
        `🔎 Auto-filled ${validPairs.length} pools from DexScreener for ${settings.tokenAddress}`
      );
    }
  }

  const targetToken = settings.tokenAddress.toLowerCase();
  const isToken0 = tokens.token0 === targetToken;
  const isToken1 = tokens.token1 === targetToken;
  if (!isToken0 && !isToken1) return;

  const baseTokenAddr = isToken0 ? tokens.token1 : tokens.token0;
  const baseIn = isToken0 ? amount1In : amount0In;
  const tokenOut = isToken0 ? amount0Out : amount1Out;
  if (baseIn.lte(0) || tokenOut.lte(0)) return;

  // 🔥 Buyer resolve + Monad aggregator fix
  let buyer = ethers.utils.getAddress(to);
  let buyerLower = buyer.toLowerCase();

  // jodi recipient already EOA hoy → direct use
  if (await isContractAddress(chain, buyerLower)) {
    // 👉 Monad special case: router/aggregator ke tx.from diye resolve koro
    if (chain === "monad") {
      try {
        const runtime = runtimes.get(chain);
        const tx = await runtime?.provider.getTransaction(txHash);

        if (tx?.from) {
          const fromAddr = ethers.utils.getAddress(tx.from);
          const fromLower = fromAddr.toLowerCase();

          // jodi from eoA hoy tahole oitai real buyer
          if (!(await isContractAddress(chain, fromLower))) {
            console.log(
              `🔁 Monad aggregator swap: recipient=${buyer} → real buyer=${fromAddr}`
            );
            buyer = fromAddr;
            buyerLower = fromLower;
          } else {
            console.log(
              `Contract buyer skipped (Monad, tx.from o contract/router): ${buyer}`
            );
            return;
          }
        } else {
          console.log(
            `Contract buyer skipped (Monad, tx.from missing): ${buyer}`
          );
          return;
        }
      } catch (e) {
        console.warn(
          `getTransaction failed for ${txHash} on ${chain}, skipping contract buyer ${buyer}:`,
          (e as any)?.message ?? e
        );
        return;
      }
    } else {
      // non-Monad chain e old behaviour same thakuk
      console.log(`Contract buyer skipped: ${buyer} on ${chain}`);
      return;
    }
  }

  let priceUsd = 0;
  let marketCap = 0;
  let volume24h = 0;
  let tokenSymbol = "TOKEN";
  let pairLiquidityUsd = 0;

  // 🔥 NEW: use throttled / cached DexScreener helper
  const pairData: any | null = await getDexPairInfoThrottled(
    chain,
    pairAddress
  );

  if (pairData) {
    const p = pairData;
    if (
      p.baseToken?.address.toLowerCase() === settings.tokenAddress.toLowerCase()
    ) {
      priceUsd = parseFloat(p.priceUsd || "0");
      tokenSymbol = p.baseToken.symbol || "TOKEN";
    } else if (
      p.quoteToken?.address.toLowerCase() ===
      settings.tokenAddress.toLowerCase()
    ) {
      const raw = parseFloat(p.priceUsd || "0");
      priceUsd = raw ? 1 / raw : 0;
      tokenSymbol = p.quoteToken.symbol || "TOKEN";
    }
    marketCap = p.fdv || 0;
    volume24h = p.volume?.h24 || 0;
    pairLiquidityUsd = p.liquidity?.usd || 0;
  }

  // 🔁 GeckoTerminal fallback: DexScreener data নাই / একদম zero হলে
  const needGeckoFallback =
    (!pairData ||
      (pairLiquidityUsd === 0 && marketCap === 0 && volume24h === 0)) &&
    !!GECKO_MAP[chain];

  if (needGeckoFallback) {
    const geckoInfo = await getGeckoPairInfo(chain, pairAddress);
    if (geckoInfo) {
      if (priceUsd === 0 && geckoInfo.priceUsd > 0) {
        priceUsd = geckoInfo.priceUsd;
      }
      if (marketCap === 0 && geckoInfo.fdv > 0) {
        marketCap = geckoInfo.fdv;
      }
      if (pairLiquidityUsd === 0 && geckoInfo.liquidityUsd > 0) {
        pairLiquidityUsd = geckoInfo.liquidityUsd;
      }
      if (volume24h === 0 && geckoInfo.volume24h > 0) {
        volume24h = geckoInfo.volume24h;
      }

      console.log(
        `ℹ️ Gecko fallback used for ${chain}:${pairAddress} (liq=$${pairLiquidityUsd.toFixed(
          0
        )}, mc=$${marketCap.toFixed(0)})`
      );
    }
  }

  let baseTokenSymbol = "";
  let baseTokenDecimals = 18;

  if (pairData) {
    const baseAddrDs = pairData.baseToken?.address?.toLowerCase();
    const quoteAddrDs = pairData.quoteToken?.address?.toLowerCase();
    const spentAddr = baseTokenAddr.toLowerCase();

    if (spentAddr === baseAddrDs) {
      baseTokenSymbol = pairData.baseToken.symbol || "";
      if (
        typeof pairData.baseToken.decimals === "number" &&
        Number.isFinite(pairData.baseToken.decimals)
      ) {
        baseTokenDecimals = pairData.baseToken.decimals;
      }
    } else if (spentAddr === quoteAddrDs) {
      baseTokenSymbol = pairData.quoteToken.symbol || "";
      if (
        typeof pairData.quoteToken.decimals === "number" &&
        Number.isFinite(pairData.quoteToken.decimals)
      ) {
        baseTokenDecimals = pairData.quoteToken.decimals;
      }
    }
  }

  // --- base token decimals fallback ---
  if (baseTokenDecimals === 18) {
    const sym = (baseTokenSymbol || "").toUpperCase();
    if (sym === "USDC" || sym === "USDT" || sym === "DAI" || sym === "BUSD") {
      baseTokenDecimals = 6;
    }
  }

  // On-chain fallback
  if (baseTokenDecimals === 18) {
    try {
      const runtime = runtimes.get(chain);
      if (runtime?.provider) {
        const baseTokenContract = new ethers.Contract(
          baseTokenAddr,
          ["function decimals() view returns (uint8)"],
          runtime.provider
        );
        const dec = await baseTokenContract.decimals();
        const n = typeof dec === "number" ? dec : Number(dec);
        if (Number.isFinite(n) && n >= 0 && n <= 36) {
          baseTokenDecimals = n;
        }
      }
    } catch (e: any) {
      console.warn(
        `Base decimals fetch failed for ${baseTokenAddr}, keeping ${baseTokenDecimals}`,
        e?.message ?? e
      );
    }
  }

  let tokenDecimals = 18;

  if (pairData) {
    const target = settings.tokenAddress.toLowerCase();
    const baseAddr = pairData.baseToken?.address?.toLowerCase();
    const quoteAddr = pairData.quoteToken?.address?.toLowerCase();

    if (
      baseAddr === target &&
      typeof pairData.baseToken?.decimals === "number"
    ) {
      tokenDecimals = pairData.baseToken.decimals;
    } else if (
      quoteAddr === target &&
      typeof pairData.quoteToken?.decimals === "number"
    ) {
      tokenDecimals = pairData.quoteToken.decimals;
    }
  }

  if (tokenDecimals === 18) {
    try {
      const runtime = runtimes.get(chain);
      if (runtime?.provider) {
        const tokenContract = new ethers.Contract(
          settings.tokenAddress,
          ["function decimals() view returns (uint8)"],
          runtime.provider
        );
        const dec = await tokenContract.decimals();
        const n = typeof dec === "number" ? dec : Number(dec);
        if (Number.isFinite(n) && n >= 0 && n <= 36) {
          tokenDecimals = n;
        }
      }
    } catch (e) {
      console.warn(
        `Decimals fetch failed for ${settings.tokenAddress}, keeping ${tokenDecimals}`,
        (e as any)?.message ?? e
      );
    }
  }

  const rawTokenAmount = Number(
    ethers.utils.formatUnits(tokenOut, tokenDecimals)
  );

  const tokenAmountDisplay = rawTokenAmount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: rawTokenAmount < 1 ? 6 : 0
  });

  const baseAmount = parseFloat(
    ethers.utils.formatUnits(baseIn, baseTokenDecimals)
  );

  let usdValue = 0;

  if (priceUsd > 0 && rawTokenAmount > 0) {
    usdValue = rawTokenAmount * priceUsd;
  } else {
    const nativePriceUsd = await getNativePrice(chain);
    usdValue = baseAmount * nativePriceUsd;
  }

  const MIN_POSITION_USD = 100;
  let positionIncrease: number | null = null;

  if (usdValue >= MIN_POSITION_USD) {
    try {
      const prevBalance = await getPreviousBalance(
        chain,
        settings.tokenAddress,
        buyer,
        blockNumber - 1
      );

      if (prevBalance > 0n) {
        const thisBuyAmount = tokenOut.toBigInt();
        const increaseTimes10 = (thisBuyAmount * 1000n) / prevBalance;
        const MAX_PERCENT_TIMES10 = 1_000_000n * 10n;
        if (increaseTimes10 <= MAX_PERCENT_TIMES10) {
          const rawIncrease = Number(increaseTimes10) / 10;
          if (Number.isFinite(rawIncrease) && rawIncrease > 0) {
            positionIncrease = Math.round(rawIncrease);
          }
        } else {
          positionIncrease = null;
        }
      } else {
        positionIncrease = null;
      }
    } catch {
      // কোনো error হলে line skip করা safest
      positionIncrease = null;
    }
  }

  const tokenAmount = rawTokenAmount;

  for (const [groupId, s] of relatedGroups) {
    const alertData: PremiumAlertData = {
      usdValue,
      baseAmount: baseAmount, // ← এখানে আগের মতোই রেখেছি, শুধু buyer filter + Dex cache fix হয়েছে
      tokenAmount,
      tokenAmountDisplay,
      tokenSymbol,
      txHash,
      chain,
      buyer,
      positionIncrease,
      marketCap,
      volume24h,
      priceUsd,
      pairAddress,
      pairLiquidityUsd,
      baseSymbol: baseTokenSymbol // ← USDC / WMON
    };

    globalAlertQueue.enqueue({
      groupId,
      run: () => sendPremiumBuyAlert(bot, groupId, s, alertData)
    });
  }
}

// ────────────────── DIRECT TOKEN BUY HANDLER (Nad.fun BondingCurve + DEX_ROUTER) ──────────────────

async function handleDirectTokenBuy(
  bot: Telegraf,
  chain: ChainId,
  tokenAddress: string, // Nad.fun bonding curve token
  baseTokenAddr: string, // MON / WMON
  baseIn: ethers.BigNumber, // actualAmountIn
  tokenOut: ethers.BigNumber, // effectiveAmountOut
  buyerAddress: string,
  txHash: string,
  blockNumber: number
) {
  const tokenLower = tokenAddress.toLowerCase();

  // 1) relatedGroups বের করো tokenAddress দিয়ে
  const relatedGroups: [number, BuyBotSettings][] = [];
  for (const [groupId, settings] of groupSettings.entries()) {
    if (
      settings.chain === chain &&
      settings.tokenAddress.toLowerCase() === tokenLower
    ) {
      relatedGroups.push([groupId, settings]);
    }
  }
  if (relatedGroups.length === 0) return;

  // একটা main settings ধরে নেই (আগেই যেমন করছো)
  const settings = relatedGroups[0][1];

  // 2) pairAddress resolve করো – DexScreener stats এর জন্য
  if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
    const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
    if (validPairs.length > 0) {
      settings.allPairAddresses = validPairs.map((p) => p.address);
      markGroupSettingsDirty();
      console.log(
        `🔎 [Nad] Auto-filled ${validPairs.length} pools for ${settings.tokenAddress}`
      );
    }
  }

  const pairAddress =
    settings.allPairAddresses && settings.allPairAddresses[0]
      ? settings.allPairAddresses[0]
      : tokenAddress; // একদম fallback: token কে pseudo pair ধরে নিলাম

  if (baseIn.lte(0) || tokenOut.lte(0)) return;

  // 3) buyer filter – Monad aggregator fix (tx.from → real buyer)
  let buyer = ethers.utils.getAddress(buyerAddress);
  let buyerLower = buyer.toLowerCase();

  // jodi already EOA হয় → use it, na hole Monad-e tx.from দিয়ে resolve
  if (await isContractAddress(chain, buyerLower)) {
    // Monad এ bonding/DEX সবসময় router/aggregator diye যায় – real buyer holo tx.from
    if (chain === "monad") {
      try {
        const runtime = runtimes.get(chain);
        const tx = await runtime?.provider.getTransaction(txHash);

        if (tx?.from) {
          const fromAddr = ethers.utils.getAddress(tx.from);
          const fromLower = fromAddr.toLowerCase();

          if (!(await isContractAddress(chain, fromLower))) {
            console.log(
              `[Nad] Monad aggregator buy: recipient=${buyer} → real buyer=${fromAddr}`
            );
            buyer = fromAddr;
            buyerLower = fromLower;
          } else {
            console.log(
              `[Nad] Contract buyer skipped (Monad, tx.from contract/router): ${buyer}`
            );
            return;
          }
        } else {
          console.log(
            `[Nad] Contract buyer skipped (Monad, tx.from missing): ${buyer}`
          );
          return;
        }
      } catch (e) {
        console.warn(
          `[Nad] getTransaction failed for ${txHash} on ${chain}, skipping contract buyer ${buyer}:`,
          (e as any)?.message ?? e
        );
        return;
      }
    } else {
      console.log(`[Nad] Contract buyer skipped (nad direct) ${buyer}`);
      return;
    }
  }

  // 4) DexScreener / Gecko থেকে price, mc, liq, volume বের করো
  let priceUsd = 0;
  let marketCap = 0;
  let volume24h = 0;
  let tokenSymbol = "TOKEN";
  let pairLiquidityUsd = 0;

  const pairData: any | null = await getDexPairInfoThrottled(
    chain,
    pairAddress
  );

  if (pairData) {
    const p = pairData;
    if (
      p.baseToken?.address.toLowerCase() === settings.tokenAddress.toLowerCase()
    ) {
      priceUsd = parseFloat(p.priceUsd || "0");
      tokenSymbol = p.baseToken.symbol || "TOKEN";
    } else if (
      p.quoteToken?.address.toLowerCase() ===
      settings.tokenAddress.toLowerCase()
    ) {
      const raw = parseFloat(p.priceUsd || "0");
      priceUsd = raw ? 1 / raw : 0;
      tokenSymbol = p.quoteToken.symbol || "TOKEN";
    }
    marketCap = p.fdv || 0;
    volume24h = p.volume?.h24 || 0;
    pairLiquidityUsd = p.liquidity?.usd || 0;
  }

  const needGeckoFallback =
    (!pairData ||
      (pairLiquidityUsd === 0 && marketCap === 0 && volume24h === 0)) &&
    !!GECKO_MAP[chain];

  if (needGeckoFallback) {
    const geckoInfo = await getGeckoPairInfo(chain, pairAddress);
    if (geckoInfo) {
      if (priceUsd === 0 && geckoInfo.priceUsd > 0) {
        priceUsd = geckoInfo.priceUsd;
      }
      if (marketCap === 0 && geckoInfo.fdv > 0) {
        marketCap = geckoInfo.fdv;
      }
      if (pairLiquidityUsd === 0 && geckoInfo.liquidityUsd > 0) {
        pairLiquidityUsd = geckoInfo.liquidityUsd;
      }
      if (volume24h === 0 && geckoInfo.volume24h > 0) {
        volume24h = geckoInfo.volume24h;
      }

      console.log(
        `ℹ️ Gecko fallback used [nad] for ${chain}:${pairAddress} (liq=$${pairLiquidityUsd.toFixed(
          0
        )}, mc=$${marketCap.toFixed(0)})`
      );
    }
  }

  // 5) base/token decimals – handleSwap এর মতো
  let baseTokenSymbol = "";
  let baseTokenDecimals = 18;

  if (pairData) {
    const baseAddrDs = pairData.baseToken?.address?.toLowerCase();
    const quoteAddrDs = pairData.quoteToken?.address?.toLowerCase();
    const spentAddr = baseTokenAddr.toLowerCase();

    if (spentAddr === baseAddrDs) {
      baseTokenSymbol = pairData.baseToken.symbol || "";
      if (
        typeof pairData.baseToken.decimals === "number" &&
        Number.isFinite(pairData.baseToken.decimals)
      ) {
        baseTokenDecimals = pairData.baseToken.decimals;
      }
    } else if (spentAddr === quoteAddrDs) {
      baseTokenSymbol = pairData.quoteToken.symbol || "";
      if (
        typeof pairData.quoteToken.decimals === "number" &&
        Number.isFinite(pairData.quoteToken.decimals)
      ) {
        baseTokenDecimals = pairData.quoteToken.decimals;
      }
    }
  }

  if (baseTokenDecimals === 18) {
    const sym = (baseTokenSymbol || "").toUpperCase();
    if (sym === "USDC" || sym === "USDT" || sym === "DAI" || sym === "BUSD") {
      baseTokenDecimals = 6;
    }
  }

  if (baseTokenDecimals === 18) {
    try {
      const runtime = runtimes.get(chain);
      if (runtime?.provider) {
        const baseTokenContract = new ethers.Contract(
          baseTokenAddr,
          ["function decimals() view returns (uint8)"],
          runtime.provider
        );
        const dec = await baseTokenContract.decimals();
        const n = typeof dec === "number" ? dec : Number(dec);
        if (Number.isFinite(n) && n >= 0 && n <= 36) {
          baseTokenDecimals = n;
        }
      }
    } catch (e: any) {
      console.warn(
        `Base decimals fetch failed [nad] for ${baseTokenAddr}, keeping ${baseTokenDecimals}`,
        e?.message ?? e
      );
    }
  }

  let tokenDecimals = 18;

  if (pairData) {
    const target = settings.tokenAddress.toLowerCase();
    const baseAddr = pairData.baseToken?.address?.toLowerCase();
    const quoteAddr = pairData.quoteToken?.address?.toLowerCase();

    if (
      baseAddr === target &&
      typeof pairData.baseToken?.decimals === "number"
    ) {
      tokenDecimals = pairData.baseToken.decimals;
    } else if (
      quoteAddr === target &&
      typeof pairData.quoteToken?.decimals === "number"
    ) {
      tokenDecimals = pairData.quoteToken.decimals;
    }
  }

  if (tokenDecimals === 18) {
    try {
      const runtime = runtimes.get(chain);
      if (runtime?.provider) {
        const tokenContract = new ethers.Contract(
          settings.tokenAddress,
          ["function decimals() view returns (uint8)"],
          runtime.provider
        );
        const dec = await tokenContract.decimals();
        const n = typeof dec === "number" ? dec : Number(dec);
        if (Number.isFinite(n) && n >= 0 && n <= 36) {
          tokenDecimals = n;
        }
      }
    } catch (e: any) {
      console.warn(
        `Decimals fetch failed [nad] for ${settings.tokenAddress}, keeping ${tokenDecimals}`,
        e?.message ?? e
      );
    }
  }

  const rawTokenAmount = Number(
    ethers.utils.formatUnits(tokenOut, tokenDecimals)
  );

  const tokenAmountDisplay = rawTokenAmount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: rawTokenAmount < 1 ? 6 : 0
  });

  const baseAmount = parseFloat(
    ethers.utils.formatUnits(baseIn, baseTokenDecimals)
  );

  let usdValue = 0;

  if (priceUsd > 0 && rawTokenAmount > 0) {
    usdValue = rawTokenAmount * priceUsd;
  } else {
    const nativePriceUsd = await getNativePrice(chain);
    usdValue = baseAmount * nativePriceUsd;
  }

  const MIN_POSITION_USD = 100;
  let positionIncrease: number | null = null;

  if (usdValue >= MIN_POSITION_USD) {
    try {
      const prevBalance = await getPreviousBalance(
        chain,
        settings.tokenAddress,
        buyer,
        blockNumber - 1
      );

      if (prevBalance > 0n) {
        const thisBuyAmount = tokenOut.toBigInt();
        const increaseTimes10 = (thisBuyAmount * 1000n) / prevBalance;
        const MAX_PERCENT_TIMES10 = 1_000_000n * 10n;
        if (increaseTimes10 <= MAX_PERCENT_TIMES10) {
          const rawIncrease = Number(increaseTimes10) / 10;
          if (Number.isFinite(rawIncrease) && rawIncrease > 0) {
            positionIncrease = Math.round(rawIncrease);
          }
        } else {
          positionIncrease = null;
        }
      } else {
        positionIncrease = null;
      }
    } catch {
      positionIncrease = null;
    }
  }

  // 8) relatedGroups loop করে alert পাঠাও
  for (const [groupId, s] of relatedGroups) {
    const alertData: PremiumAlertData = {
      usdValue,
      baseAmount,
      tokenAmount: rawTokenAmount,
      tokenAmountDisplay,
      tokenSymbol,
      txHash,
      chain,
      buyer,
      positionIncrease,
      marketCap,
      volume24h,
      priceUsd,
      pairAddress,
      pairLiquidityUsd,
      baseSymbol: baseTokenSymbol
    };

    globalAlertQueue.enqueue({
      groupId,
      run: () => sendPremiumBuyAlert(bot, groupId, s, alertData)
    });
  }
}

// ────────────────── Nad.fun BondingCurve + DEX_ROUTER LISTENER ──────────────────

export function attachNadBondingCurveListener(
  bot: Telegraf,
  chain: ChainId,
  runtime: ChainRuntime
) {
  if (chain !== "monad") return;
  if (nadBondingAttached.get(chain)) return; // already attached

  const provider = runtime.provider;

  // ---- BondingCurveRouter ----
  const bonding = new ethers.Contract(
    MONAD_NAD_BONDING_ROUTER,
    NAD_BONDING_ROUTER_ABI,
    provider
  );

  bonding.on(
    "CurveBuy",
    async (
      to: string,
      token: string,
      actualAmountIn: ethers.BigNumber,
      effectiveAmountOut: ethers.BigNumber,
      event: any
    ) => {
      try {
        const baseAsset =
          appConfig.chains[chain].nativeWrappedToken ??
          appConfig.chains[chain].nativeToken ??
          "0x0000000000000000000000000000000000000000";

        await handleDirectTokenBuy(
          bot,
          chain,
          token,
          baseAsset,
          actualAmountIn,
          effectiveAmountOut,
          to,
          event.transactionHash,
          event.blockNumber
        );
      } catch (e) {
        console.error("Nad.fun CurveBuy handler error:", e);
      }
    }
  );

  // ---- Nad.fun DEX_ROUTER ----
  const dexRouter = new ethers.Contract(
    MONAD_NAD_DEX_ROUTER,
    NAD_DEX_ROUTER_ABI,
    provider
  );

  dexRouter.on(
    "DexRouterBuy",
    async (
      sender: string,
      token: string,
      amountIn: ethers.BigNumber,
      amountOut: ethers.BigNumber,
      event: any
    ) => {
      try {
        const baseAsset =
          appConfig.chains[chain].nativeWrappedToken ??
          appConfig.chains[chain].nativeToken ??
          "0x0000000000000000000000000000000000000000";

        await handleDirectTokenBuy(
          bot,
          chain,
          token,
          baseAsset,
          amountIn,
          amountOut,
          sender,
          event.transactionHash,
          event.blockNumber
        );
      } catch (e) {
        console.error("Nad.fun DexRouterBuy handler error:", e);
      }
    }
  );

  nadBondingAttached.set(chain, true);
  console.log(
    "✅ Nad.fun BondingCurve + DEX router listeners attached on Monad"
  );
}

// ────────────────── HELPERS ──────────────────

export function getChainIdNumber(chain: ChainId): number | undefined {
  const map: Record<string, number> = {
    ethereum: 1,
    bsc: 56,
    base: 8453,
    monad: 143
  };
  const key = chain.toLowerCase();
  return map[key];
}

export async function getAllValidPairs(
  tokenAddress: string,
  chain: ChainId
): Promise<Array<{ address: string; liquidityUsd: number }>> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );
    const data: any = await res.json();

    if (!data.pairs || data.pairs.length === 0) return [];

    const pairs = data.pairs
      .filter((p: any) => {
        const targetChain = chain.toLowerCase();
        const apiChainId = String(p.chainId ?? "").toLowerCase();
        const apiChainName = String(p.chain ?? "").toLowerCase();
        const numericId = getChainIdNumber(chain);

        const isCorrectChain =
          apiChainId === targetChain ||
          apiChainName === targetChain ||
          (numericId !== undefined && apiChainId === String(numericId));

        const tokenAddrLower = tokenAddress.toLowerCase();
        const baseAddr = p.baseToken?.address?.toLowerCase();
        const quoteAddr = p.quoteToken?.address?.toLowerCase();

        const tokenMatch =
          baseAddr === tokenAddrLower || quoteAddr === tokenAddrLower;

        return isCorrectChain && tokenMatch;
      })
      .filter((p: any) => {
        const liq = p.liquidity?.usd ?? 0;
        return liq >= 10;
      })
      .map((p: any) => ({
        address: p.pairAddress,
        liquidityUsd: p.liquidity?.usd ?? 0
      }))
      .sort((a: any, b: any) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, 15);

    console.log(
      `[PAIRS] ${chain} ${tokenAddress} →`,
      pairs.map(
        (p: { address: string; liquidityUsd: number }) => ({
          addr: p.address,
          liq: p.liquidityUsd
        })
      )
    );

    return pairs;
  } catch (e: any) {
    console.error(
      `❌ getAllValidPairs error for token ${tokenAddress} on ${chain}: ${
        e?.message || e
      }`
    );
    return [];
  }
}

export async function getNativePrice(chain: ChainId): Promise<number> {
  const now = Date.now();
  const cached = nativePriceCache.get(chain);
  if (cached && now - cached.ts < NATIVE_TTL_MS) {
    return cached.value;
  }

  let price = chain === "bsc" ? 875 : 3400;
  try {
    const symbol = chain === "bsc" ? "BNBUSDT" : "ETHUSDT";
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    const data: any = await res.json();
    price = parseFloat(data.price);
  } catch {
    // fallback
  }
  nativePriceCache.set(chain, { value: price, ts: now });
  return price;
}

export async function getPreviousBalance(
  chain: ChainId,
  token: string,
  wallet: string,
  block: number
): Promise<bigint> {
  try {
    const runtime = runtimes.get(chain);
    if (!runtime) return 0n;

    const tokenContract = new ethers.Contract(
      token,
      ["function balanceOf(address) view returns (uint256)"],
      runtime.provider
    );

    const balance: ethers.BigNumber = await tokenContract.balanceOf(wallet, {
      blockTag: block
    });
    return balance.toBigInt();
  } catch {
    return 0n;
  }
}

// ----------------------------------------------------
// Hybrid new-pool scanner (DexScreener + GeckoTerminal)
// ----------------------------------------------------
export async function scanNewPoolsLoop(chain: ChainId) {
  // যদি আগেরটা already চলে, আগে abort
  const existing = scannerAbortControllers.get(chain);
  existing?.abort();

  const controller = new AbortController();
  scannerAbortControllers.set(chain, controller);

  console.log(`🚀 Starting hybrid new-pool watcher for ${chain}...`);

  const POLL_INTERVAL_MS = 30_000;

  while (!controller.signal.aborted) {
    try {
      const pairs: SimplePairInfo[] = await getNewPairsHybrid(
        chain,
        5000,
        600
      );

      if (pairs.length > 0) {
        console.log(`[HYBRID] ${chain}: ${pairs.length} fresh pools detected`);

        for (const p of pairs.slice(0, 5)) {
          console.log(
            `  • ${p.symbol} | ${p.address} | liq≈$${p.liquidityUsd.toFixed(
              0
            )} | age ${p.age}s | ${p.source}`
          );
        }
      }
    } catch (err: any) {
      if (!controller.signal.aborted) {
        console.error(
          `[HYBRID] ${chain} scanner error:`,
          err?.message ?? err
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.log(`🛑 Hybrid new-pool watcher stopped for ${chain}`);
}

export function stopAllHybridScanners() {
  for (const [chain, controller] of scannerAbortControllers.entries()) {
    controller.abort();
    console.log(`🛑 Stopping hybrid scanner for ${chain}`);
  }
  scannerAbortControllers.clear();
}
