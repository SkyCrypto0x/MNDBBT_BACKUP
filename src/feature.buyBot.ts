import { Telegraf, Context, Markup } from "telegraf";
import { appConfig, ChainId } from "./config";
import { fetchTokenPairs, DexPair } from "./rpcAndApi";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import fetch from "node-fetch";
import { clearLiveTrackerCaches } from "./liveBuyTracker";

export interface BuyBotSettings {
  chain: ChainId;
  tokenAddress: string;
  pairAddress: string; // main pair
  allPairAddresses: string[];
  emoji: string;

  // visual options
  imageUrl?: string;        // http(s) url
  imageFileId?: string;     // uploaded photo file_id
  animationFileId?: string; // uploaded gif/video file_id

  // filters
  minBuyUsd: number;
  maxBuyUsd?: number;
  dollarsPerEmoji: number;

  tgGroupLink?: string;
  autoPinDataPosts: boolean;
  autoPinKolAlerts: boolean;
  cooldownSeconds?: number; // per group+pair cooldown in seconds
}

type SetupStep =
  | "token"
  | "pair"
  | "emoji"
  | "image"
  | "minBuy"
  | "maxBuy"
  | "perEmoji"
  | "tgGroup";

interface BaseSetupState {
  step: SetupStep;
  settings: Partial<BuyBotSettings>;
  createdAt: number; // timestamp for cleanup
}

// DM flow: per-user state (targetChatId = which group they are configuring)
interface DmSetupState extends BaseSetupState {
  targetChatId: number;
}

// Group flow: per-group state
interface GroupSetupState extends BaseSetupState {
  initiatorId: number; // যে admin setup শুরু করেছে
}

const dmSetupStates = new Map<number, DmSetupState>(); // userId -> state
const groupSetupStates = new Map<number, GroupSetupState>(); // chatId -> state

const SETUP_STATE_TTL_MS = 60 * 60 * 1000; // 1 hour

setInterval(() => {
  const now = Date.now();

  for (const [userId, st] of dmSetupStates.entries()) {
    if (now - st.createdAt > SETUP_STATE_TTL_MS) {
      dmSetupStates.delete(userId);
    }
  }

  for (const [chatId, st] of groupSetupStates.entries()) {
    if (now - st.createdAt > SETUP_STATE_TTL_MS) {
      groupSetupStates.delete(chatId);
    }
  }
}, 15 * 60 * 1000); // every 15 min

// Multiple admins allowed – put your own Telegram user IDs here
const ADMINS: number[] = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isFinite(id))
  : [];

  if (ADMINS.length === 0) {
  console.warn("⚠️  ADMIN_IDS not configured – global admin access disabled");
}

type BotCtx = Context;

// ───────────────────────────────────────────
// Admin / permission helper
// ───────────────────────────────────────────
async function isAdminOrCreator(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.chat) return false;

  // In DM we allow everything (needed for deep-link setup)
  if (ctx.chat.type === "private") return true;

  // Global hard-coded bot admins
  if (ADMINS.includes(ctx.from.id)) return true;

  // Check Telegram chat role
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────
// Bot must be admin in group
// ───────────────────────────────────────────
async function requireBotAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    return true; // DM / অন্য chat এ দরকার নেই
  }

  try {
    const botId = (ctx as any).botInfo?.id;
    if (!botId) throw new Error("botInfo not available");

    const me = await ctx.telegram.getChatMember(ctx.chat.id, botId);

    if (me.status === "administrator" || me.status === "creator") {
      return true;
    }
  } catch (e) {
    // ignore, নিচে generic message
  }

  await ctx.reply(
    "🚫 I need to be a <b>Group Admin</b> to work properly.\n\n" +
      "Please:\n" +
      "1️⃣ Open group → Members → Promote this bot as Admin\n" +
      "2️⃣ Give permission to <b>send messages</b> (and pin if you want auto-pin)\n" +
      "3️⃣ Then run /add again ✅",
    { parse_mode: "HTML" }
  );

  return false;
}

export function registerBuyBotFeature(bot: Telegraf<BotCtx>) {
  // /start – DM + group UX
  bot.start(async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    const payload = (ctx as any).startPayload as string | undefined;

    // DM with payload: deep-link from group -> start setup wizard for that group
    if (chat.type === "private" && payload && payload.startsWith("setup_")) {
      const groupId = Number(payload.replace("setup_", ""));
      const userId = ctx.from!.id;

      // basic validation – payload থেকে groupId na paile
      if (!Number.isFinite(groupId)) {
        await ctx.reply(
          "❌ Invalid setup link.\nPlease send <code>/add</code> again in your group.",
          { parse_mode: "HTML" }
        );
        return;
      }

      // global ADMINS override পাবে, বাকিদের admin হতে হবে ওই group-এ
      if (!ADMINS.includes(userId)) {
        try {
          const member = await ctx.telegram.getChatMember(groupId, userId);
          const status = member.status;

          if (status !== "administrator" && status !== "creator") {
            await ctx.reply(
              "🚫 Only <b>group admins</b> can configure this group.\n" +
                "Ask an admin to send <code>/add</code> in the group.",
              { parse_mode: "HTML" }
            );
            return;
          }
        } catch (err) {
          await ctx.reply(
            "⚠️ I couldn't verify your admin status for that group.\n" +
              "Make sure I'm still in the group and try <code>/add</code> again there.",
            { parse_mode: "HTML" }
          );
          return;
        }
      }

      dmSetupStates.set(userId, {
        step: "token",
        targetChatId: groupId,
        settings: {
          chain: appConfig.defaultChain
        },
        createdAt: Date.now()
      });

      await ctx.reply(
        "🕵️ <b>Premium Buy Bot · Setup</b>\n\n" +
          "1️⃣ Send your <b>token contract address</b> (EVM · <code>0x...</code>)\n" +
          "➡️ I will auto-detect all pools and pick the main pair.",
        { parse_mode: "HTML" }
      );
      return;
    }

    // DM normal /start – premium welcome + Add to group button
    if (chat.type === "private") {
      const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;

      await ctx.reply(
        "💜 <b>Premium Buy Bot</b>\n" +
          "Smart buy alerts & clean analytics for your token communities.\n\n" +
          "✨ <b>What I do</b>\n" +
          "• Track every buy in real time on your main pools\n" +
          "• Work across ETH · BSC · BASE · MONAD\n" +
          "• Auto-detect all pools for your token (main + side pools)\n" +
          "• Show USD value, market cap, volume & liquidity in each alert\n" +
          "• Let you style alerts with custom emoji, image or GIF\n" +
          "• Filter by minimum / maximum USD & use cooldown to stop spam\n\n" +
          "🛠 <b>Key commands</b>\n" +
          "/add – Connect or update the token for a group\n" +
          "/stop – Turn off alerts in a group\n" +
          "/help – Show the full group control panel (DM overview)\n" +
          "/clearcache – (Bot admin) Reset listeners & cache\n\n" +
          "🚀 <b>Getting started</b>\n" +
          "1️⃣ Add this bot to your token group\n" +
          "2️⃣ In the group, send <code>/add</code>\n" +
          "3️⃣ Follow the wizard (token → pools → emoji → media → filters)\n\n" +
          "Add me now and let your holders see every buy in a clean, pro format 👇",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.url("➕ Add bot to group", addToGroupUrl)]
          ])
        }
      );
      return;
    }

    // Group /start – show control panel (bot must be admin)
    if (chat.type === "group" || chat.type === "supergroup") {
      if (!(await requireBotAdmin(ctx))) return;
      await sendGroupHelp(ctx);
      return;
    }
  });

  // /stop – stop alerts for this group (admin only)
  bot.command("stop", async (ctx) => {
    if (!(await isAdminOrCreator(ctx))) {
      await ctx.reply("🚫 Only group admins can use /stop.");
      return;
    }
    await handleStopCommand(ctx);
  });

  // /add – main entry point (group + DM) (admin only in groups)
  bot.command("add", async (ctx) => {
    if (!(await isAdminOrCreator(ctx))) {
      await ctx.reply("🚫 Only group admins can use /add.");
      return;
    }
    await handleAddCommand(ctx);
  });

  // Group inline button: "Set up here"
  bot.action("setup_here", async (ctx) => {
    const chat = ctx.chat;
    if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
      await ctx.answerCbQuery("Use this button inside your token group.");
      return;
    }

    // Bot must be admin
    if (!(await requireBotAdmin(ctx))) {
      await ctx.answerCbQuery("Bot must be admin in this group.", {
        show_alert: true
      });
      return;
    }

    // Admin gate for inline setup button
    if (!(await isAdminOrCreator(ctx))) {
      await ctx.answerCbQuery("Only group admins can set up the bot.", {
        show_alert: true
      });
      return;
    }

    const chatId = chat.id;
    groupSetupStates.set(chatId, {
      step: "token",
      settings: { chain: appConfig.defaultChain },
      createdAt: Date.now(),
      initiatorId: ctx.from!.id // এই admin-ই পরে reply করতে পারবে
    });

    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(
      "🕵️ <b>Group Setup</b>\n\n" +
        "1️⃣ Send your <b>token contract address</b> (EVM · <code>0x...</code>)\n" +
        "🔎 I will auto-detect pools and select the main pair.",
      { parse_mode: "HTML" }
    );

    await ctx.answerCbQuery();
  });

  // Text handler – DM + group wizard
  bot.on("text", async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();

    const text = ctx.message!.text.trim();

    // DM wizard (only whoever got deep-link)
    if (chat.type === "private") {
      const userId = ctx.from!.id;
      const state = dmSetupStates.get(userId);
      if (!state) return next();

      await runSetupStep(ctx, state, text);
      return;
    }

    // Group wizard – only group admins, bot must be admin
    if (chat.type === "group" || chat.type === "supergroup") {
      if (!(await requireBotAdmin(ctx))) return;
      if (!(await isAdminOrCreator(ctx))) return; // non-admin text ignore

      const chatId = chat.id;
      const state = groupSetupStates.get(chatId);
      if (!state) return next(); // no active wizard

      // 🔒 শুধুমাত্র সেই admin-এর reply নেবে, যে setup শুরু করেছে
      if (ctx.from && ctx.from.id !== state.initiatorId) {
        return next();
      }

      await runSetupStep(ctx, state, text);
      return;
    }

    return next();
  });

  // Photo / GIF handler – only used on “image” step
  bot.on(["photo", "animation"], async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat) return next();

    // find current state (DM or group)
    let state: BaseSetupState | undefined;

    if (chat.type === "private") {
      // DM setup: userId → dmSetupStates
      const userId = ctx.from!.id;
      state = dmSetupStates.get(userId);
    } else if (chat.type === "group" || chat.type === "supergroup") {
      // group: bot admin + only group admins can send media for wizard
      if (!(await requireBotAdmin(ctx))) return;
      if (!(await isAdminOrCreator(ctx))) return;

      const groupState = groupSetupStates.get(chat.id);
      if (!groupState) return next(); // কোনো active wizard নেই

      // 🔒 শুধু যে admin setup শুরু করেছে (initiatorId), তার media নেওয়া যাবে
      if (ctx.from && ctx.from.id !== groupState.initiatorId) {
        return next();
      }

      state = groupState;
    }

    // যদি কোনো active setup না থাকে / image step না হয়, ignore
    if (!state || state.step !== "image") {
      return next();
    }

    // photo upload
    if ("photo" in ctx.message! && ctx.message!.photo?.length) {
      const photos = ctx.message!.photo;
      const best = photos[photos.length - 1];
      (state.settings as any).imageFileId = best.file_id;

      state.step = "minBuy";
      await ctx.reply(
        "📸 Image saved!\n\n" +
          "5️⃣ Now send the <b>minimum $ buy</b> that should trigger an alert (e.g. <code>50</code>).",
        { parse_mode: "HTML" }
      );
      return;
    }

    // gif / animation upload
    if ("animation" in ctx.message! && ctx.message!.animation) {
      const anim = ctx.message!.animation;
      (state.settings as any).animationFileId = anim.file_id;

      state.step = "minBuy";
      await ctx.reply(
        "🎞 GIF saved!\n\n" +
          "5️⃣ Now send the <b>minimum $ buy</b> that should trigger an alert (e.g. <code>50</code>).",
        { parse_mode: "HTML" }
      );
      return;
    }

    return next();
  });

  // Inline button commands – direct actions (with admin checks)
  bot.action("cmd_add", async (ctx) => {
    const chat = ctx.chat;

    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      if (!(await requireBotAdmin(ctx))) {
        await ctx.answerCbQuery("Bot must be admin in this group.", {
          show_alert: true
        });
        return;
      }

      if (!(await isAdminOrCreator(ctx))) {
        await ctx.answerCbQuery("Only group admins can use this.", {
          show_alert: true
        });
        return;
      }
    }

    await ctx.answerCbQuery();
    await handleAddCommand(ctx);
  });

  bot.action("cmd_stop", async (ctx) => {
    const chat = ctx.chat;

    if (chat && (chat.type === "group" || chat.type === "supergroup")) {
      if (!(await requireBotAdmin(ctx))) {
        await ctx.answerCbQuery("Bot must be admin in this group.", {
          show_alert: true
        });
        return;
      }

      if (!(await isAdminOrCreator(ctx))) {
        await ctx.answerCbQuery("Only group admins can stop alerts.", {
          show_alert: true
        });
        return;
      }
    }

    await ctx.answerCbQuery();
    await handleStopCommand(ctx);
  });

  // /clearcache – Admin only, multiple admins supported
  bot.command("clearcache", async (ctx) => {
    const userId = ctx.from?.id || 0;
    if (!ADMINS.includes(userId)) {
      await ctx.reply("🚫 This command is restricted to bot admins.");
      return;
    }

    await ctx.reply("🧹 <b>Clearing cache & listeners…</b>", {
      parse_mode: "HTML"
    });

    try {
      await clearLiveTrackerCaches(bot as any);

      await ctx.reply(
        "✅ <b>Done.</b>\n" +
          "• Old listeners removed\n" +
          "• Cache cleared\n" +
          "• Fresh sync started",
        { parse_mode: "HTML" }
      );
    } catch (e: any) {
      console.error("clearcache error:", e);
      await ctx.reply("⚠️ Cache clear failed. Check logs.", {
        parse_mode: "HTML"
      });
    }
  });

  // /help – DM help only, group এ ছোট info
  bot.command("help", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;

    if (chat.type === "private") {
      await ctx.reply(
        "💡 <b>Help · Premium Buy Bot</b>\n\n" +
          "🛠 <b>Main commands</b>\n" +
          "/add – Run inside your token group to connect / update a token\n" +
          "/stop – Run inside the group to turn alerts off (admins only)\n" +
          "/start – In a group, opens the full control panel\n" +
          "/clearcache – (Bot admin) Reset listeners & cache\n\n" +
          "🚀 <b>How to use</b>\n" +
          "1️⃣ Add this bot to your token group\n" +
          "2️⃣ In the group, send /add\n" +
          "3️⃣ Follow the wizard (token → pools → emoji → media → filters)\n\n" +
          "For a live overview of the group status, just use /start inside your token group.",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (chat.type === "group" || chat.type === "supergroup") {
      // only admins, ছোট msg (no spam panel)
      if (!(await isAdminOrCreator(ctx))) return;
      if (!(await requireBotAdmin(ctx))) return;

      await ctx.reply(
        "ℹ️ Use /start in this group to open the full panel.\n" +
          "For detailed docs, open a DM with me and send /help.",
        { parse_mode: "HTML" }
      );
      return;
    }
  });
}

/* ======================
 *  COMMAND HANDLERS
 * ===================== */

async function handleStopCommand(ctx: Context) {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.reply("Use /stop inside your token group.");
    return;
  }

  if (!(await requireBotAdmin(ctx))) return;

  const groupId = ctx.chat.id;

  let hadSettings = false;
  let hadSetup = false;

  // 1) Active group wizard থাকলে cancel করো
  if (groupSetupStates.has(groupId)) {
    groupSetupStates.delete(groupId);
    hadSetup = true;
  }

  // 2) DM থেকে কেউ যদি এই group-এর setup করছিল, সেটাও cancel
  for (const [userId, st] of dmSetupStates.entries()) {
    if (st.targetChatId === groupId) {
      dmSetupStates.delete(userId);
      hadSetup = true;
    }
  }

  // 3) Buy alerts বন্ধ
  if (groupSettings.has(groupId)) {
    groupSettings.delete(groupId);
    markGroupSettingsDirty(); // persist change
    hadSettings = true;
  }

  // 4) এখন proper message
  if (hadSettings || hadSetup) {
    await ctx.reply(
      "🛑 <b>Buy alerts and setup stopped for this group.</b>\n\n" +
        "To enable again, send <code>/add</code>.",
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      "ℹ️ There is no active tracking or setup in this group.",
      { parse_mode: "HTML" }
    );
  }

  await sendGroupHelp(ctx);
}

async function handleAddCommand(ctx: Context) {
  const chat = ctx.chat;
  if (!chat) return;

  // DM: explain flow (must be triggered from a group)
  if (chat.type === "private") {
    const addToGroupUrl = `https://t.me/${appConfig.botUsername}?startgroup=true`;
    await ctx.reply(
      "⚙️ <b>How to set up the bot</b>\n\n" +
        "1️⃣ Add this bot to your token group\n" +
        "2️⃣ In the group, send <code>/add</code>\n" +
        "3️⃣ Then choose to set up in DM or directly in the group ✅",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.url("➕ Add bot to group", addToGroupUrl)]
        ])
      }
    );
    return;
  }

  // Group: offer DM setup + in-group setup
  if (chat.type === "group" || chat.type === "supergroup") {
    if (!(await requireBotAdmin(ctx))) return;

    const groupId = chat.id;
    const setupDmUrl = `https://t.me/${appConfig.botUsername}?start=setup_${groupId}`;

    // reset any previous state for this group
    groupSetupStates.delete(groupId);

    const text =
      "🕵️ <b>Premium Buy Bot · Setup</b>\n\n" +
      "Where do you want to configure? 👇\n\n" +
      "💬 In DM – private, clean flow\n" +
      "🏠 In this group – so everyone can see & learn\n";

    await ctx.reply(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.url("💬 Set up in DM", setupDmUrl),
          Markup.button.callback("🏠 Set up in this group", "setup_here")
        ]
      ])
    });

    return;
  }
}

/* ======================
 *  SETUP WIZARD
 * ===================== */

async function runSetupStep(
  ctx: Context,
  state: BaseSetupState,
  text: string
): Promise<void> {
  switch (state.step) {
    case "token": {
      const tokenAddr = text.trim();

      // Strong EVM contract validation
      if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
        await ctx.reply(
          "❌ Invalid token address.\n" +
            "Please send a valid EVM contract address in <code>0x...</code> format.",
          { parse_mode: "HTML" }
        );
        return;
      }

      state.settings.tokenAddress = tokenAddr.toLowerCase();

      // Auto-detect chain from DexScreener before fetching pools
      if (/^0x[a-fA-F0-9]{40}$/.test(tokenAddr)) {
        try {
          const tokenUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`;
          let res = await fetch(tokenUrl);
          let data: any = await res.json();

          let pairs: any[] = Array.isArray(data.pairs) ? data.pairs : [];

          console.log(
            "DexScreener raw token response first pair:",
            JSON.stringify(pairs[0])
          );

          // If tokens endpoint returns nothing, fallback to search
          if (!pairs.length) {
            const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${tokenAddr}`;
            const searchRes = await fetch(searchUrl);
            const searchData: any = await searchRes.json();
            if (Array.isArray(searchData.pairs)) {
              pairs = searchData.pairs;
              console.log(
                "Using DexScreener search() result, first pair:",
                JSON.stringify(pairs[0])
              );
            }
          }

          if (pairs.length > 0) {
            let detectedChain: any =
              pairs[0].chainId ??
              pairs[0].chain?.id ??
              pairs[0].chainName ??
              pairs[0].chain?.name;

            if (detectedChain) {
              detectedChain = String(detectedChain).toLowerCase();

              if (detectedChain === "eth") detectedChain = "ethereum";
              if (detectedChain === "bnb" || detectedChain === "bsc")
                detectedChain = "bsc";
              if (detectedChain === "base") detectedChain = "base";
              if (detectedChain === "monad") detectedChain = "monad";
            }

            const supportedChains = ["ethereum", "bsc", "base", "monad", "megaeth"];

            if (detectedChain && supportedChains.includes(detectedChain)) {
              state.settings.chain = detectedChain as ChainId;
              await ctx.reply(
                `🛰 Detected chain: <code>${detectedChain.toUpperCase()}</code>`,
                { parse_mode: "HTML" }
              );
            } else {
              console.log(
                "Unsupported/unknown chain from DexScreener:",
                detectedChain
              );
            }
          } else {
            console.log("No pairs in DexScreener token+search response");
          }
        } catch (e) {
          console.error("Chain auto-detect failed:", e);
        }
      }

      const chain = state.settings.chain || appConfig.defaultChain;

      await ctx.reply(
        `🔎 Scanning pools on <b>${String(chain).toUpperCase()}</b>…`,
        { parse_mode: "HTML" }
      );

      const pairs = await fetchTokenPairs(chain, tokenAddr);
      if (!pairs.length) {
        state.step = "pair";
        await ctx.reply(
          "❌ No pools found for this token.\n\n" +
            "2️⃣ Please send your <b>pair (pool) address</b> manually.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const sorted = sortPairsByLiquidity(pairs);
      const main = sorted[0];
      const allAddresses = sorted.map((p) => p.pairAddress);

      state.settings.pairAddress = main.pairAddress;
      (state.settings as any).allPairAddresses = allAddresses;

      let summary =
        `✅ Found <b>${sorted.length}</b> pools.\n\n` +
        `🌊 <b>Main pair:</b>\n<code>${main.pairAddress}</code>\n\n`;

      if (sorted.length > 1) {
        const others = sorted
          .slice(1, 4)
          .map((p) => `• ${p.pairAddress}`)
          .join("\n");
        summary += `<b>Other pools (top liquidity):</b>\n${others}\n\n`;
      }

      await ctx.reply(
        summary + "3️⃣ Now send a <b>buy emoji</b> (e.g. 🐶, 🧠, 🚀).",
        {
          parse_mode: "HTML"
        }
      );

      state.step = "emoji";
      return;
    }

    // 🔁 UPDATED BLOCK: strong validation for manual pair
    case "pair": {
      const pair = text.trim();

      // Strong validation
      if (!/^0x[a-fA-F0-9]{40}$/.test(pair)) {
        await ctx.reply(
          "❌ Invalid pair address.\n" +
            "Please send a valid pool address in <code>0x...</code> format.",
          { parse_mode: "HTML" }
        );
        return;
      }

      state.settings.pairAddress = pair.toLowerCase();
      (state.settings as any).allPairAddresses = [state.settings.pairAddress];

      state.step = "emoji";
      await ctx.reply(
        "3️⃣ Now send a <b>buy emoji</b> (e.g. 🐶, 🧠, 🚀).",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "emoji": {
      state.settings.emoji = text;
      state.step = "image";
      await ctx.reply(
        "4️⃣ Send an <b>image / GIF</b> (upload) or an <b>image/GIF URL</b>.\n" +
          "If you want text-only alerts, type <code>skip</code>.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "image": {
      if (text.toLowerCase() === "skip") {
        state.step = "minBuy";
        await ctx.reply(
          "5️⃣ Send the <b>minimum $ buy</b> that should trigger an alert (e.g. <code>50</code>).",
          { parse_mode: "HTML" }
        );
        return;
      }

      (state.settings as any).imageUrl = text;
      state.step = "minBuy";
      await ctx.reply(
        "🖼 Image URL saved.\n\n" +
          "5️⃣ Now send the <b>minimum $ buy</b> that should trigger an alert (e.g. <code>50</code>).",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "minBuy": {
      const val = Number(text);
      if (isNaN(val) || val < 0) {
        await ctx.reply(
          "Please send a valid number, e.g. <code>50</code>.",
          { parse_mode: "HTML" }
        );
        return;
      }
      state.settings.minBuyUsd = val;
      state.step = "maxBuy";
      await ctx.reply(
        "6️⃣ (Optional) Send a <b>maximum $ buy</b> to alert (e.g. <code>50000</code>),\n" +
          "or type <code>skip</code> if you don't want a max limit.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "maxBuy": {
      if (text.toLowerCase() !== "skip") {
        const val = Number(text);
        if (isNaN(val) || val <= 0) {
          await ctx.reply(
            "Please send a positive number, or <code>skip</code>.",
            { parse_mode: "HTML" }
          );
          return;
        }
        state.settings.maxBuyUsd = val;
      }
      state.settings.cooldownSeconds ??= 3; // default cooldown if user didn't set
      state.step = "perEmoji";
      await ctx.reply(
        "7️⃣ Send <b>$ per emoji</b> (e.g. <code>50</code> → every $50 = 1 emoji).\n" +
          "Example: $200 buy with $50 per emoji → 4 emojis.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "perEmoji": {
      const val = Number(text);
      if (isNaN(val) || val <= 0) {
        await ctx.reply(
          "Please send a positive number, e.g. <code>50</code>.",
          { parse_mode: "HTML" }
        );
        return;
      }
      state.settings.dollarsPerEmoji = val;
      state.step = "tgGroup";
      await ctx.reply(
        "8️⃣ (Optional) Send your <b>Telegram group link</b> (e.g. <code>https://t.me/yourgroup</code>),\n" +
          "or type <code>skip</code> to continue.",
        { parse_mode: "HTML" }
      );
      return;
    }

    case "tgGroup": {
      if (text.toLowerCase() !== "skip") {
        state.settings.tgGroupLink = text;
      }

      const finalSettings: BuyBotSettings = {
        chain: (state.settings.chain || appConfig.defaultChain) as ChainId,
        tokenAddress: state.settings.tokenAddress!,
        pairAddress: state.settings.pairAddress!,
        allPairAddresses:
          (state.settings as any).allPairAddresses ||
          [state.settings.pairAddress!],
        emoji: state.settings.emoji || "🟢",
        imageUrl: state.settings.imageUrl,
        imageFileId: (state.settings as any).imageFileId,
        animationFileId: (state.settings as any).animationFileId,
        minBuyUsd: state.settings.minBuyUsd ?? 10,
        maxBuyUsd: state.settings.maxBuyUsd,
        dollarsPerEmoji: state.settings.dollarsPerEmoji ?? 50,
        tgGroupLink: state.settings.tgGroupLink,
        autoPinDataPosts: state.settings.autoPinDataPosts ?? false,
        autoPinKolAlerts: state.settings.autoPinKolAlerts ?? false,
        cooldownSeconds: state.settings.cooldownSeconds ?? 3
      };

      const targetGroupId =
        (state as any).targetChatId || ctx.chat!.id;
      groupSettings.set(targetGroupId, finalSettings);
      markGroupSettingsDirty(); // persist to disk via storage.ts

      await ctx.reply(
        "✅ <b>Setup complete!</b>\n\n" +
          "Live buy alerts are now enabled for this group 🚀",
        { parse_mode: "HTML" }
      );

      // state cleanup
      if ((state as any).targetChatId) {
        dmSetupStates.delete(ctx.from!.id);
      } else {
        groupSetupStates.delete(ctx.chat!.id);
      }

      await sendGroupHelp(ctx);
      return;
    }
  }
}

/* ======================
 *  HELPERS
 * ===================== */

function sortPairsByLiquidity(pairs: DexPair[]): DexPair[] {
  return [...pairs].sort((a, b) => {
    const la = Number(a?.liquidity?.usd ?? 0);
    const lb = Number(b?.liquidity?.usd ?? 0);
    return lb - la;
  });
}

function shorten(addr: string, len = 6): string {
  if (!addr || addr.length <= len * 2) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

async function sendGroupHelp(ctx: Context) {
  const isActive = groupSettings.has(ctx.chat!.id);
  const statusLine = isActive
    ? "🟢 <b>Status:</b> Active – buy alerts are running."
    : "🔴 <b>Status:</b> Inactive – no token is being tracked yet.";

  await ctx.reply(
    "<b>Premium Buy Bot · Group Panel</b>\n\n" +
      statusLine + "\n\n" +
      "✨ <b>What this bot does</b>\n" +
      "• Tracks every buy on your main pools in real time\n" +
      "• Shows USD value, MC, volume & liquidity in each alert\n" +
      "• Lets you use custom emoji + image / GIF per token\n" +
      "• Min / Max USD filters and cooldown to avoid spam\n\n" +
      "🛠 <b>Key commands</b>\n" +
      "/add – Connect or update the token for this group\n" +
      "/stop – Turn off alerts in this group\n" +
      "\nUse the buttons below to quickly manage the token for this group 👇",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚙️ Add / Update Token", callback_data: "cmd_add" }],
          [{ text: "🛑 Stop Alerts", callback_data: "cmd_stop" }]
        ]
      }
    }
  );
}
