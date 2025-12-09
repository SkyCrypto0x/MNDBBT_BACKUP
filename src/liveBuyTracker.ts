import { Telegraf } from "telegraf";
import { ethers } from "ethers";
import { appConfig, ChainId } from "./config";
import { groupSettings, markGroupSettingsDirty } from "./storage";
import {
  runtimes,
  PAIR_V2_ABI,
  attachSwapListener,
  getAllValidPairs,
  scanNewPoolsLoop,
  clearChainCaches,
  ChainRuntime,
  stopAllHybridScanners,
  attachNadBondingCurveListener, // 🆕 Nad.fun bonding listener
  resetNadBondingFlag // 🆕 bonding flag reset helper
} from "./chains.runtime";
import { clearAlertCooldowns } from "./alerts.buy";

let syncTimer: NodeJS.Timeout | null = null;
let trackerRunning = false; // ✅ নতুন flag

// ────────────────── PUBLIC API ──────────────────

export function startLiveBuyTracker(bot: Telegraf) {
  trackerRunning = true;

  // প্রথম sync (overlap ছাড়া)
  void syncLoop(bot);

  // Hybrid new-pool watcher (just logs, no listeners)
  const chainsToWatch = Object.keys(appConfig.chains).filter(
    (c): c is ChainId => !!appConfig.chains[c as ChainId]?.rpcUrl
  );

  for (const chain of chainsToWatch) {
    void scanNewPoolsLoop(chain);
  }
}

export async function shutdownLiveBuyTracker() {
  trackerRunning = false;
  if (syncTimer) {
    clearTimeout(syncTimer); // ✅ আগে clearInterval ছিল
    syncTimer = null;
  }

  for (const [chain, runtime] of runtimes.entries()) {
    for (const [addr, pr] of runtime.pairs.entries()) {
      try {
        pr.v2.removeAllListeners();
        pr.v3?.removeAllListeners();
        pr.v4?.removeAllListeners();
        console.log(`🧹 Removed listeners for ${chain}:${addr}`);
      } catch {
        // ignore
      }
    }

    const anyProv = (runtime as ChainRuntime).provider as any;
    if (anyProv._websocket && typeof anyProv._websocket.close === "function") {
      try {
        anyProv._websocket.close();
      } catch {
        // ignore
      }
    }

    // 🆕 bonding flag reset, যেন পরে fresh attach হতে পারে
    resetNadBondingFlag(chain);
  }

  // Stop background hybrid scanners
  stopAllHybridScanners();

  runtimes.clear();
  console.log("🔻 LiveBuyTracker shutdown complete");
}

// Manual clear for /clearcache
export async function clearLiveTrackerCaches(bot: Telegraf) {
  for (const [chain, runtime] of runtimes.entries()) {
    for (const [, pr] of runtime.pairs.entries()) {
      try {
        pr.v2.removeAllListeners();
        pr.v3?.removeAllListeners();
        pr.v4?.removeAllListeners();
      } catch {
        // ignore
      }
    }
    runtime.pairs.clear();

    const anyProv = (runtime as ChainRuntime).provider as any;
    if (
      runtime.isWebSocket &&
      anyProv._websocket &&
      typeof anyProv._websocket.close === "function"
    ) {
      try {
        anyProv._websocket.close();
      } catch {
        // ignore
      }
    }

    // 🆕 bonding flag reset here too
    resetNadBondingFlag(chain);
  }

  runtimes.clear();
  clearAlertCooldowns();
  clearChainCaches();

  setTimeout(() => {
    syncListeners(bot).catch((e) =>
      console.error("Sync error after clearcache:", e)
    );
  }, 2000);

  console.log("🧹 Manual cache clear triggered via /clearcache");
}

// ────────────────── SYNC LOOP (no overlap) ──────────────────

async function syncLoop(bot: Telegraf) {
  if (!trackerRunning) return;

  try {
    await syncListeners(bot);
  } catch (e) {
    console.error("Sync error:", e);
  }

  if (!trackerRunning) return;

  syncTimer = setTimeout(() => {
    void syncLoop(bot);
  }, 15_000);
}

// ────────────────── WS lifecycle helper ──────────────────

function attachWsLifecycle(chain: ChainId, runtime: ChainRuntime) {
  if (!runtime.isWebSocket) return;

  const anyRuntime = runtime as any;
  const provAny = runtime.provider as any;
  const ws = provAny._websocket;

  if (!ws || typeof ws.on !== "function") return;

  anyRuntime.wsDead = false;
  anyRuntime.lastWsActivity = Date.now();

  ws.on("close", () => {
    console.warn(`🔌 WS closed for ${chain}`);
    anyRuntime.wsDead = true;
  });

  ws.on("error", (err: any) => {
    console.error(`⚠️ WS error for ${chain}:`, err);
    anyRuntime.wsDead = true;
  });

  if (typeof runtime.provider.on === "function") {
    runtime.provider.on("block", () => {
      anyRuntime.lastWsActivity = Date.now();
    });
  }
}

// ────────────────── CORE SYNC LOGIC ──────────────────

async function syncListeners(bot: Telegraf) {
  console.log("🔁 Syncing live listeners...");

  // 0) Clean runtimes for chains removed from config
  for (const [chain, runtime] of runtimes.entries()) {
    if (!appConfig.chains[chain]) {
      console.log(`🧹 Removing runtime for chain ${chain} (no longer in config)`);
      for (const [, pr] of runtime.pairs.entries()) {
        try {
          pr.v2.removeAllListeners();
          pr.v3?.removeAllListeners();
          pr.v4?.removeAllListeners();
        } catch {
          // ignore
        }
      }
      runtime.pairs.clear();
      const anyProv = (runtime as ChainRuntime).provider as any;
      if (
        runtime.isWebSocket &&
        anyProv._websocket &&
        typeof anyProv._websocket.close === "function"
      ) {
        try {
          anyProv._websocket.close();
        } catch {
          // ignore
        }
      }

      // 🆕 bonding flag reset when chain removed
      resetNadBondingFlag(chain);

      runtimes.delete(chain);
    }
  }

  // 1) Auto cleanup: je pair gulo kono group-e nei, segulo remove
  const activePairAddrs = new Set<string>();
  for (const settings of groupSettings.values()) {
    settings.allPairAddresses?.forEach((p) =>
      activePairAddrs.add(p.toLowerCase())
    );
  }

  for (const [chain, runtime] of runtimes.entries()) {
    for (const addr of runtime.pairs.keys()) {
      if (!activePairAddrs.has(addr)) {
        const pr = runtime.pairs.get(addr);
        if (pr) {
          try {
            pr.v2.removeAllListeners();
            pr.v3?.removeAllListeners();
            pr.v4?.removeAllListeners();
          } catch {
            // ignore
          }
          runtime.pairs.delete(addr);
          console.log(`Auto-removed dead pair ${chain}:${addr}`);
        }
      }
    }
  }

  // 2) Build neededPairsByChain from all group settings
  const neededPairsByChain = new Map<ChainId, Set<string>>();

  for (const [, settings] of groupSettings.entries()) {
    const chain = settings.chain;
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg || !chainCfg.rpcUrl) continue;

    // If no pairs yet, auto-fill top 15 highest-liq pools
    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      const validPairs = await getAllValidPairs(settings.tokenAddress, chain);
      if (validPairs.length > 0) {
        settings.allPairAddresses = validPairs.map((p) => p.address);
        markGroupSettingsDirty();
        console.log(
          `Auto-added ${validPairs.length} pools for ${settings.tokenAddress}`
        );
      }
    }

    if (!settings.allPairAddresses || settings.allPairAddresses.length === 0) {
      continue;
    }

    let set = neededPairsByChain.get(chain);
    if (!set) {
      set = new Set<string>();
      neededPairsByChain.set(chain, set);
    }
    for (const pairAddr of settings.allPairAddresses) {
      set.add(pairAddr.toLowerCase());
    }
  }

  // 3) Ensure runtime per chain and attach listeners
  for (const [chain, neededPairs] of neededPairsByChain.entries()) {
    const chainCfg = appConfig.chains[chain];
    if (!chainCfg || !chainCfg.rpcUrl) continue;

    let runtime = runtimes.get(chain);
    if (!runtime) {
      const isWs = chainCfg.rpcUrl.startsWith("wss");
      const provider = isWs
        ? new ethers.providers.WebSocketProvider(chainCfg.rpcUrl)
        : new ethers.providers.JsonRpcProvider(chainCfg.rpcUrl);

      runtime = {
        provider,
        pairs: new Map(),
        rpcUrl: chainCfg.rpcUrl,
        isWebSocket: isWs
      };
      runtimes.set(chain, runtime);
      console.log(`🔗 Connected to ${chain} RPC (${isWs ? "WS" : "HTTP"})`);

      if (isWs) {
        attachWsLifecycle(chain, runtime);
      }

      // 🆕 Nad.fun BondingCurve listener attach (first time)
      attachNadBondingCurveListener(bot, chain, runtime);
    } else if (runtime.isWebSocket) {
      const anyRuntime = runtime as any;
      const ws = (runtime.provider as any)._websocket;

      const noActivityTooLong =
        typeof anyRuntime.lastWsActivity === "number" &&
        Date.now() - anyRuntime.lastWsActivity > 60_000; // 60s inactivity

      if (!ws || ws.readyState !== 1 || anyRuntime.wsDead || noActivityTooLong) {
        console.warn(
          `⚠️ WS dead/stale for ${chain} (wsDead=${!!anyRuntime.wsDead}, noActivity=${noActivityTooLong}), recreating provider...`
        );
        try {
          // 🆕 bonding flag reset so we can re-attach on new provider
          resetNadBondingFlag(chain);

          const newProv = new ethers.providers.WebSocketProvider(
            runtime.rpcUrl
          );

          runtime.provider = newProv;
          attachWsLifecycle(chain, runtime);

          // reattach all current pairs to new provider
          for (const [addr, pr] of runtime.pairs.entries()) {
            try {
              pr.v2.removeAllListeners();
              pr.v3?.removeAllListeners();
              pr.v4?.removeAllListeners();

              const newPR = attachSwapListener(
                bot,
                chain,
                addr,
                newProv,
                {
                  token0: pr.token0,
                  token1: pr.token1
                },
                pr.targetToken
              );
              runtime.pairs.set(addr, newPR);
            } catch {
              // ignore
            }
          }

          // 🆕 Nad.fun bonding listener re-attach on the new provider
          attachNadBondingCurveListener(bot, chain, runtime);

          anyRuntime.wsDead = false;
          anyRuntime.lastWsActivity = Date.now();
          console.log(
            `✅ WS reconnected for ${chain} (${runtime.pairs.size} pairs reattached)`
          );
        } catch (e) {
          console.error(`❌ Failed to recreate WS provider for ${chain}`, e);
        }
      }
    }

    // cleanup unused pairs on this chain
    for (const addr of runtime.pairs.keys()) {
      if (!neededPairs.has(addr)) {
        const pr = runtime.pairs.get(addr)!;
        try {
          pr.v2.removeAllListeners();
          pr.v3?.removeAllListeners();
          pr.v4?.removeAllListeners();
        } catch {
          // ignore
        }
        runtime.pairs.delete(addr);
        console.log(`🧹 Stopped listening on pair ${chain}:${addr}`);
      }
    }

    // add new listeners for needed pairs
    for (const addr of neededPairs) {
      if (runtime.pairs.has(addr)) continue;

      if (!ethers.utils.isAddress(addr)) {
        console.warn(`Invalid address detected and skipped: ${addr}`);
        continue;
      }

      // figure out which token this pair belongs to (once, at attach time)
      let targetTokenLower = "";
      for (const s of groupSettings.values()) {
        if (
          s.chain === chain &&
          s.allPairAddresses?.some(
            (p) => p.toLowerCase() === addr.toLowerCase()
          )
        ) {
          targetTokenLower = s.tokenAddress.toLowerCase();
          break;
        }
      }
      if (!targetTokenLower) {
        console.warn(
          `⚠️ No matching settings found for pair ${chain}:${addr}, skipping attach`
        );
        continue;
      }

      try {
        // temporary contract to read token0/token1 (works for v2/v3/v4 pool addresses)
        const tmpContract = new ethers.Contract(
          addr,
          PAIR_V2_ABI,
          runtime.provider
        );

        let token0Lower: string;
        let token1Lower: string;
        try {
          const [t0, t1] = await Promise.all([
            tmpContract.token0(),
            tmpContract.token1()
          ]);
          token0Lower = t0.toLowerCase();
          token1Lower = t1.toLowerCase();
        } catch (inner) {
          console.warn(
            `Could not read token0/token1 for pair ${chain}:${addr}, skipping`,
            inner
          );
          continue;
        }

        const pairRuntime = attachSwapListener(
          bot,
          chain,
          addr,
          runtime.provider,
          {
            token0: token0Lower,
            token1: token1Lower
          },
          targetTokenLower
        );

        runtime.pairs.set(addr, pairRuntime);

        console.log(
          `Listening on pair ${chain}:${addr.substring(
            0,
            10
          )}… token0=${token0Lower.slice(0, 10)} token1=${token1Lower.slice(
            0,
            10
          )}`
        );
      } catch (e: any) {
        console.error(
          `Failed to attach listener to pair ${addr}:`,
          e.message || e
        );
      }
    }
  }
}
