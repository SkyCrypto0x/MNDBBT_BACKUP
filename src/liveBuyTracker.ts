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
  stopAllHybridScanners
} from "./chains.runtime";
import { clearAlertCooldowns } from "./alerts.buy";

let syncTimer: NodeJS.Timeout | null = null;

// ────────────────── PUBLIC API ──────────────────

export function startLiveBuyTracker(bot: Telegraf) {
  syncListeners(bot).catch((e) => console.error("Initial sync error:", e));
  syncTimer = setInterval(
    () => syncListeners(bot).catch((e) => console.error("Sync error:", e)),
    15_000
  );

  // Hybrid new-pool watcher (just logs, no listeners)
  const chainsToWatch = Object.keys(appConfig.chains).filter(
    (c): c is ChainId => !!appConfig.chains[c as ChainId]?.rpcUrl
  );

  for (const chain of chainsToWatch) {
    void scanNewPoolsLoop(chain);
  }
}

export async function shutdownLiveBuyTracker() {
  if (syncTimer) {
    clearInterval(syncTimer);
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
  }

  // Stop background hybrid scanners
  stopAllHybridScanners();

  runtimes.clear();
  console.log("🔻 LiveBuyTracker shutdown complete");
}

// Manual clear for /clearcache
export async function clearLiveTrackerCaches(bot: Telegraf) {
  for (const [, runtime] of runtimes.entries()) {
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
    } else if (runtime.isWebSocket) {
      const ws = (runtime.provider as any)._websocket;
      if (!ws || ws.readyState !== 1) {
        console.warn(`⚠️ WS dead for ${chain}, recreating provider...`);
        try {
          const newProv = new ethers.providers.WebSocketProvider(
            runtime.rpcUrl
          );
          // reattach all current pairs to new provider
          for (const [addr, pr] of runtime.pairs.entries()) {
            try {
              pr.v2.removeAllListeners();
              pr.v3?.removeAllListeners();
              pr.v4?.removeAllListeners();
            } catch {
              // ignore
            }

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
          }
          runtime.provider = newProv;
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
