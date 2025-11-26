import { Telegraf } from "telegraf";
import { appConfig, ChainId } from "./config";
import { BuyBotSettings } from "./feature.buyBot";
import { globalAlertQueue } from "./queue";

// Premium alert data type (unchanged)
export interface PremiumAlertData {
  usdValue: number;
  baseAmount: number;
  tokenAmount: number;
  tokenAmountDisplay: string;
  tokenSymbol: string;
  txHash: string;
  chain: ChainId;
  buyer: string;
  positionIncrease: number | null;
  marketCap: number;
  volume24h: number;
  priceUsd: number;
  pairAddress: string;
  pairLiquidityUsd: number;
  baseSymbol: string; // ⭐ নতুন: যেই token দিয়ে buy হয়েছে (USDC / MONAD / WETH ...)
}


// cooldown per group+pair (moved here)
const lastAlertAt = new Map<string, number>();

// helper – clear cooldowns from /clearcache
export function clearAlertCooldowns() {
  lastAlertAt.clear();
}

// Periodic cleanup for cooldown map: delete entries older than 24h
const COOLDOWN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastAlertAt.entries()) {
    if (now - ts > COOLDOWN_MAX_AGE_MS) {
      lastAlertAt.delete(key);
    }
  }
}, 60 * 60 * 1000); // every 1h

// ────────────────── ALERT RENDERING ──────────────────

function escapeHtml(str: string): string {
  return str.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"
  );
}

function shorten(addr: string, len = 6) {
  if (!addr) return "";
  return `${addr.slice(0, len)}...${addr.slice(-len + 2)}`;
}

function formatCompactUsd(value: number): string {
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    const s = m.toFixed(2);
    return (s.endsWith(".00") ? s.slice(0, -3) : s) + "M";
  }
  if (value >= 1_000) {
    const k = Math.round(value / 1_000);
    return `${k}K`;
  }
  return value.toFixed(0);
}

export async function sendPremiumBuyAlert(
  bot: Telegraf,
  groupId: number,
  settings: BuyBotSettings,
  data: PremiumAlertData
) {
    const {
    usdValue,
    baseAmount,
    tokenAmount,
    tokenAmountDisplay,
    tokenSymbol,
    txHash,
    chain,
    buyer,
    positionIncrease,
    marketCap,
    volume24h,
    priceUsd, // eslint-disable-line @typescript-eslint/no-unused-vars
    pairAddress,
    pairLiquidityUsd,
    baseSymbol
  } = data;


  const buyUsd = Math.round(usdValue);
  if (buyUsd < settings.minBuyUsd) return;
  if (settings.maxBuyUsd && buyUsd > settings.maxBuyUsd) return;

  const key = `${groupId}:${pairAddress.toLowerCase()}`;
  const now = Date.now();
  const cdMs = (settings.cooldownSeconds ?? 3) * 1000;
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < cdMs) return;
  lastAlertAt.set(key, now);

  const chainStr = String(chain).toLowerCase();

    let baseEmoji = "";
  let baseSymbolText = "";
  if (chainStr === "bsc") {
    baseEmoji = "🟡";
    baseSymbolText = "BNB";
  } else if (
    chainStr === "ethereum" ||
    chainStr === "eth" ||
    chainStr === "mainnet"
  ) {
    baseEmoji = "🔹";
    baseSymbolText = "ETH";
  } else if (chainStr === "base") {
    baseEmoji = "🟦";
    baseSymbolText = "ETH";
  } else if (chainStr === "arbitrum" || chainStr === "arb") {
    baseEmoji = "🌀";
    baseSymbolText = "ETH";
  } else if (chainStr === "solana" || chainStr === "sol") {
    baseEmoji = "🟢";
    baseSymbolText = "SOL";
  } else if (chainStr === "polygon" || chainStr === "matic") {
    baseEmoji = "🟣";
    baseSymbolText = "MATIC";
  } else {
    baseEmoji = "💠";
    baseSymbolText = "NATIVE";
  }

  // ⭐ DexScreener theke paoa baseSymbol > chain-native fallback
  const baseDisplaySymbol = baseSymbol || baseSymbolText || "NATIVE";
  const safeBaseSymbol = escapeHtml(baseDisplaySymbol);

  const explorerBase =
    appConfig.chains[chain]?.explorer ||
    (chainStr === "bsc"
      ? "https://bscscan.com"
      : "https://etherscan.io");

  const safeTokenSymbol = escapeHtml(tokenSymbol);
  const safeBuyer = escapeHtml(shorten(buyer));
  const txUrl = `${explorerBase}/tx/${txHash}`;
  const addrUrl = `${explorerBase}/address/${buyer}`;
  const pairLink = `${explorerBase}/address/${pairAddress}`;

  const emojiCount = Math.floor(
    buyUsd / (settings.dollarsPerEmoji || 50)
  );
  const emojiBar = settings.emoji.repeat(Math.min(50, emojiCount));

  // 🔥 MC compact format: 620K / 75.4M etc.
  const mcText =
    marketCap > 1_000 ? formatCompactUsd(marketCap) : "Low Liq";

  // 🔥 LP = এই buy যেই pair থেকে এসেছে, সেইটার LP
  const mainPairLp = pairLiquidityUsd || 0;
  const lpText = formatCompactUsd(mainPairLp);

  const whaleLoadLine =
    positionIncrease !== null && positionIncrease > 500
      ? "🚀🚀 <b>WHALE LOADING!</b> 🚀🚀\n"
      : "";

  const volumeLine = `🔥 Volume (24h): $${
    volume24h >= 1_000_000
      ? (volume24h / 1_000_000).toFixed(1) + "M"
      : (volume24h / 1_000).toFixed(0) + "K"
  }`;

  const headerLine =
    buyUsd >= 5000
      ? "🐳 <b>WHALE INCOMING!!!</b> 🐳"
      : buyUsd >= 3000
      ? "🚨🚨 <b>BIG BUY DETECTED!</b> 🚨🚨"
      : buyUsd >= 1000
      ? "🟢🟢🟢 <b>Strong Buy</b> 🟢🟢🟢"
      : "🟢 <b>New Buy</b> 🟢\n";

  const dexScreenerUrl = `https://dexscreener.com/${chain}/${pairAddress}`;
  const dextoolsNetwork =
    chainStr === "bsc"
      ? "bsc"
      : chainStr === "base"
      ? "base"
      : chainStr === "monad"
      ? "monad"
      : "ether";

  const dexToolsUrl = `https://www.dextools.io/app/${dextoolsNetwork}/pair-explorer/${pairAddress}`;

  // configurable links (fallback old defaults)
  const trendingUrl =
    appConfig.trendingChannelUrl || "https://t.me/trending";
  const adsContactUrl =
    appConfig.adsContactUrl || "https://t.me/yourusername";

  const message = `
${headerLine}
${whaleLoadLine}
💰 <b>$${buyUsd.toLocaleString()}</b> ${safeTokenSymbol} BUY

${emojiBar}

${baseEmoji} <b>${safeBaseSymbol}:</b> ${baseAmount.toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})} ($${buyUsd.toLocaleString()})
💳 ${safeTokenSymbol}: ${tokenAmountDisplay}

🔗 <a href="${pairLink}">View Pair</a> → $${lpText} LP

👤 Buyer: <a href="${addrUrl}">${safeBuyer}</a>
🔶 <a href="${txUrl}">View Transaction</a>
${
  //positionIncrease !== null
    //? `🧠 <b>Position Increased: +${positionIncrease.toFixed(0)}%</b>\n`
   // : ""
   ""
}📊 MC: $${mcText}
${volumeLine}

🔗 <a href="${dexToolsUrl}">DexT</a> | <a href="${dexScreenerUrl}">DexS</a> | <a href="${trendingUrl}">Trending</a>
`.trim();

  const row: any[] = [];

  if (settings.tgGroupLink) {
    row.push({
      text: "👥 Join Group",
      url: settings.tgGroupLink
    });
  }

  row.push({
    text: "✉️ DM for Ads",
    url: adsContactUrl
  });

  const keyboard: any = {
    inline_keyboard: [row]
  };

  try {
    if (settings.animationFileId) {
      await bot.telegram.sendAnimation(groupId, settings.animationFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageFileId) {
      await bot.telegram.sendPhoto(groupId, settings.imageFileId, {
        caption: message,
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    } else if (settings.imageUrl) {
      const isGif = settings.imageUrl.toLowerCase().endsWith(".gif");
      if (isGif) {
        await bot.telegram.sendAnimation(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
      } else {
        await bot.telegram.sendPhoto(groupId, settings.imageUrl, {
          caption: message,
          parse_mode: "HTML",
          reply_markup: keyboard
        } as any);
      }
    } else {
      await bot.telegram.sendMessage(groupId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard
      } as any);
    }
    console.log(`✅ Alert sent → $${buyUsd} to group ${groupId}`);
  } catch (err: any) {
    console.error(`Send failed to ${groupId}:`, err.message);
  }
}