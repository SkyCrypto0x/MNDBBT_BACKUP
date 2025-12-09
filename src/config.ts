import fs from "fs";
import path from "path";

export type ChainId = "ethereum" | "bsc" | "base" | "monad";

export interface ChainConfig {
  rpcUrl: string;
  explorer: string;
  nativeToken?: string;
  nativeWrappedToken?: string;
}

export interface AppConfig {
  telegramBotToken: string;
  chains: Record<ChainId, ChainConfig>;

  // 🆕 extra fields – এগুলো alerts.buy.ts / feature.buyBot.ts থেকে ইউজ হচ্ছে
  defaultChain: ChainId;
  botUsername: string;
  trendingChannelUrl: string;
  adsContactUrl: string;
}

// ----------------- optional config.json loader -----------------

const configPath = path.join(process.cwd(), "config.json");
let rawJson: any = {};
try {
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    rawJson = JSON.parse(raw);
    console.log("Loaded config.json");
  }
} catch (e) {
  console.warn("Could not read config.json, continuing with env only:", e);
}

// ----------------- chains -----------------

const chains: Record<ChainId, ChainConfig> = {
  ethereum: {
    rpcUrl:
      process.env.ETH_RPC_URL ||
      rawJson.chains?.ethereum?.rpcUrl ||
      "",
    explorer:
      process.env.ETH_EXPLORER ||
      rawJson.chains?.ethereum?.explorer ||
      "https://etherscan.io"
  },

  bsc: {
    rpcUrl:
      process.env.BSC_RPC_URL ||
      rawJson.chains?.bsc?.rpcUrl ||
      "",
    explorer:
      process.env.BSC_EXPLORER ||
      rawJson.chains?.bsc?.explorer ||
      "https://bscscan.com"
  },

  base: {
    rpcUrl:
      process.env.BASE_RPC_URL ||
      rawJson.chains?.base?.rpcUrl ||
      "",
    explorer:
      process.env.BASE_EXPLORER ||
      rawJson.chains?.base?.explorer ||
      "https://basescan.org"
  },

  monad: {
    rpcUrl:
      process.env.MONAD_RPC_URL ||
      rawJson.chains?.monad?.rpcUrl ||
      "",
    explorer:
      process.env.MONAD_EXPLORER ||
      rawJson.chains?.monad?.explorer ||
      "https://monadscan.com/",
    // MON / WMON info – Nad.fun bonding curve এর জন্য
    nativeToken:
      process.env.MONAD_NATIVE_TOKEN ||
      rawJson.chains?.monad?.nativeToken ||
      "MON",
    nativeWrappedToken:
      process.env.MONAD_NATIVE_WRAPPED ||
      rawJson.chains?.monad?.nativeWrappedToken ||
      // Nad.fun docs এ দেওয়া WMON address
      "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"
  }
};

// ----------------- exported appConfig -----------------

// default chain resolve (config.json → env → ethereum)
const resolvedDefaultChain = (rawJson.defaultChain ??
  process.env.DEFAULT_CHAIN ??
  "ethereum") as ChainId;

export const appConfig: AppConfig = {
  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN || rawJson.telegramBotToken || "",
  chains,

  defaultChain: resolvedDefaultChain,
  botUsername: process.env.BOT_USERNAME || rawJson.botUsername || "",
  trendingChannelUrl:
    process.env.TRENDING_CHANNEL_URL ||
    rawJson.trendingChannelUrl ||
    "https://t.me/trending",
  adsContactUrl:
    process.env.ADS_CONTACT_URL ||
    rawJson.adsContactUrl ||
    "https://t.me/yourusername"
};
