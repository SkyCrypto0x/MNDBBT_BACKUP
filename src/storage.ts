// src/storage.ts - SQLite version (replacing JSON file storage)

import path from "path";
import type { BuyBotSettings } from "./feature.buyBot";
import Database from "better-sqlite3";

const DB_PATH = path.join(__dirname, "..", "data", "groupSettings.db");

// runtime map used by both feature.buyBot and liveBuyTracker
export const groupSettings = new Map<number, BuyBotSettings>();

let saveTimer: NodeJS.Timeout | null = null;
let db: Database.Database | null = null;

// ---------- DB INIT ----------

function getDb(): Database.Database {
  if (db) return db;

  // ensure directory exists – SQLite নিজেই ফাইল বানিয়ে নেবে
  const dbDir = path.dirname(DB_PATH);
  require("fs").mkdirSync(dbDir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL"); // better concurrency & durability

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS group_settings (
      chat_id            INTEGER PRIMARY KEY,
      chain              TEXT NOT NULL,
      token_address      TEXT NOT NULL,
      pair_address       TEXT NOT NULL,
      all_pair_addresses TEXT NOT NULL, -- JSON string of string[]
      emoji              TEXT NOT NULL,

      image_url          TEXT,
      image_file_id      TEXT,
      animation_file_id  TEXT,

      min_buy_usd        REAL NOT NULL,
      max_buy_usd        REAL,
      dollars_per_emoji  REAL NOT NULL,

      tg_group_link          TEXT,
      auto_pin_data_posts    INTEGER NOT NULL DEFAULT 0,
      auto_pin_kol_alerts    INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds       INTEGER
    )
  `
  ).run();

  return db;
}

// ---------- LOAD FROM DB (called at startup) ----------

export async function loadGroupSettingsFromDisk() {
  const db = getDb();
  groupSettings.clear();

  const rows = db.prepare(`SELECT * FROM group_settings`).all() as any[];

  for (const row of rows) {
    let allPairs: string[] = [];
    try {
      allPairs = JSON.parse(row.all_pair_addresses || "[]");
      if (!Array.isArray(allPairs)) allPairs = [];
    } catch {
      allPairs = [];
    }

    const settings: BuyBotSettings = {
      chain: row.chain,
      tokenAddress: row.token_address,
      pairAddress: row.pair_address,
      allPairAddresses: allPairs,
      emoji: row.emoji,

      imageUrl: row.image_url || undefined,
      imageFileId: row.image_file_id || undefined,
      animationFileId: row.animation_file_id || undefined,

      minBuyUsd: Number(row.min_buy_usd),
      maxBuyUsd: row.max_buy_usd != null ? Number(row.max_buy_usd) : undefined,
      dollarsPerEmoji: Number(row.dollars_per_emoji),

      tgGroupLink: row.tg_group_link || undefined,
      autoPinDataPosts: !!row.auto_pin_data_posts,
      autoPinKolAlerts: !!row.auto_pin_kol_alerts,
      cooldownSeconds:
        row.cooldown_seconds != null ? Number(row.cooldown_seconds) : undefined
    };

    groupSettings.set(Number(row.chat_id), settings);
  }

  console.log(`📥 Loaded ${groupSettings.size} group settings from SQLite`);
}

// ---------- MARK DIRTY + DEBOUNCED SAVE ----------

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  // ২ সেকেন্ডের মধ্যে যতগুলো change হবে, সব একসাথে save হবে
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveGroupSettingsNow();
  }, 2000);
}

export function markGroupSettingsDirty() {
  // বর্তমানে আমরা পুরা Map–টাই DB তে write করছি (পুরনো JSON-এর মতো)
  // পরে চাইলে per-group upsert করেও optimize করা যাবে।
  scheduleSave();
}

// ---------- SAVE ALL TO DB ----------

export async function saveGroupSettingsNow() {
  const db = getDb();

  const entries = Array.from(groupSettings.entries());

  const insertStmt = db.prepare(
    `
    INSERT INTO group_settings (
      chat_id,
      chain,
      token_address,
      pair_address,
      all_pair_addresses,
      emoji,
      image_url,
      image_file_id,
      animation_file_id,
      min_buy_usd,
      max_buy_usd,
      dollars_per_emoji,
      tg_group_link,
      auto_pin_data_posts,
      auto_pin_kol_alerts,
      cooldown_seconds
    )
    VALUES (
      @chat_id,
      @chain,
      @token_address,
      @pair_address,
      @all_pair_addresses,
      @emoji,
      @image_url,
      @image_file_id,
      @animation_file_id,
      @min_buy_usd,
      @max_buy_usd,
      @dollars_per_emoji,
      @tg_group_link,
      @auto_pin_data_posts,
      @auto_pin_kol_alerts,
      @cooldown_seconds
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      chain              = excluded.chain,
      token_address      = excluded.token_address,
      pair_address       = excluded.pair_address,
      all_pair_addresses = excluded.all_pair_addresses,
      emoji              = excluded.emoji,
      image_url          = excluded.image_url,
      image_file_id      = excluded.image_file_id,
      animation_file_id  = excluded.animation_file_id,
      min_buy_usd        = excluded.min_buy_usd,
      max_buy_usd        = excluded.max_buy_usd,
      dollars_per_emoji  = excluded.dollars_per_emoji,
      tg_group_link          = excluded.tg_group_link,
      auto_pin_data_posts    = excluded.auto_pin_data_posts,
      auto_pin_kol_alerts    = excluded.auto_pin_kol_alerts,
      cooldown_seconds       = excluded.cooldown_seconds
  `
  );

  const deleteStmt = db.prepare(
    `DELETE FROM group_settings WHERE chat_id NOT IN (${entries
      .map((_, i) => `@id${i}`)
      .join(",") || "NULL"})`
  );

  const tx = db.transaction(() => {
    // ১) সব current entries upsert করো
    for (let i = 0; i < entries.length; i++) {
      const [chatId, s] = entries[i];

      insertStmt.run({
        chat_id: chatId,
        chain: s.chain,
        token_address: s.tokenAddress,
        pair_address: s.pairAddress,
        all_pair_addresses: JSON.stringify(s.allPairAddresses || []),
        emoji: s.emoji,
        image_url: s.imageUrl ?? null,
        image_file_id: s.imageFileId ?? null,
        animation_file_id: s.animationFileId ?? null,
        min_buy_usd: s.minBuyUsd,
        max_buy_usd: s.maxBuyUsd ?? null,
        dollars_per_emoji: s.dollarsPerEmoji,
        tg_group_link: s.tgGroupLink ?? null,
        auto_pin_data_posts: s.autoPinDataPosts ? 1 : 0,
        auto_pin_kol_alerts: s.autoPinKolAlerts ? 1 : 0,
        cooldown_seconds: s.cooldownSeconds ?? null
      });
    }

    // ২) যেসব chat_id আর Map–এ নেই, সেগুলো DB থেকে delete করো
    if (entries.length > 0) {
      const params: Record<string, number> = {};
      entries.forEach(([chatId], i) => {
        params[`id${i}`] = chatId;
      });
      deleteStmt.run(params);
    } else {
      // কোনো গ্রুপ নাই → টেবিল খালি করে দাও
      db.prepare(`DELETE FROM group_settings`).run();
    }
  });

  try {
    tx();
    console.log(`💾 groupSettings persisted to SQLite (${entries.length} groups)`);
  } catch (e) {
    console.error("Failed to persist groupSettings to SQLite:", e);
  }
}
export { db };

