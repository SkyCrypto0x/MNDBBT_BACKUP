import { Telegraf } from "telegraf";
import "dotenv/config";
import http from "http";
import { appConfig } from "./config";
import { registerBuyBotFeature } from "./feature.buyBot";
import {
  startLiveBuyTracker,
  shutdownLiveBuyTracker
} from "./liveBuyTracker";
import {
  loadGroupSettingsFromDisk,
  saveGroupSettingsNow
} from "./storage";
import { globalAlertQueue } from "./queue";
import { db } from "./storage"; // ✅ নতুন লাইন: SQLite DB access for shutdown

async function main() {
  await loadGroupSettingsFromDisk();

  const bot = new Telegraf(appConfig.telegramBotToken);

  registerBuyBotFeature(bot);
  startLiveBuyTracker(bot);

<<<<<<< HEAD
  // ✅ PRIME FIX: setMyCommands কে non-fatal করা
  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Show bot info / help" },
      { command: "add", description: "Add or edit token settings" }
    ]);
    console.log("✅ Telegram commands set");
  } catch (err) {
    console.error("⚠️ Failed to set Telegram commands (non-fatal):", err);
    // এখানে কোনো throw বা process.exit নেই, শুধু লগ করে এগিয়ে যাচ্ছি
  }

  // ✅ Debug: bot identity confirm in Render logs
  bot.telegram.getMe().then(info => {
    console.log("🤖 Logged in as bot:", info.username);
  });
=======
  await bot.telegram.setMyCommands([
    { command: "start", description: "Show bot info / help" },
    { command: "add", description: "Add or edit token settings" }
  ]);
>>>>>>> b5bcbb8c4d91a651f13eed30f1b573a309cd7c01

  await bot.launch();
  console.log("✅ Premium Buy Bot is running with live tracking…");

  // simple /health endpoint (Docker / PM2 healthcheck এর জন্য)
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => {
    console.log(`🌡️ Health check listening on :${port}/health`);
  });

  const shutdown = async (signal: string) => {
    console.log(`🔻 Received ${signal}, shutting down…`);
    try {
      globalAlertQueue.stop();
      await shutdownLiveBuyTracker();
      await saveGroupSettingsNow();

      // ✅ নতুন অংশ: SQLite connection cleanly close
      if (db) {
        db.close();
        console.log("SQLite connection closed");
      }

      server.close();
      await bot.stop(signal);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
