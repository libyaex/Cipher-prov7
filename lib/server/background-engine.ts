import { buildBtcContext, prepare, resolveModeConfig } from '../cx-engine/analyzer';
import { TF_MS } from '../cx-engine/indicators';
import { evaluate } from '../cx-engine/planner';
import type {
  BtcContext,
  Candle,
  DerivData,
  SignalEvaluation,
  SymbolMeta,
} from '../cx-engine/types';
import { binanceServer } from './binance-client';
import {
  computeEqualAllocationPlan,
  evaluateSmartProfitShieldExit,
  monitorPositionWithMarket,
  openPaperTrade,
  reconcilePositionIntrabar,
} from './portfolio-guard';
import { emitAlert } from './push-service';
import { DEFAULT_USER_ID, repo } from './repository';

const RANK: Record<string, number> = { NONE: 0, WATCH: 1, GOOD: 2, STRONG: 3 };

export interface AutoCandidate {
  symbol: string;
  evaluation: SignalEvaluation;
  meta: Partial<SymbolMeta>;
  markPrice: number;
  vol24h?: number;
  spreadBps?: number;
  trigMs: number;
  priorityScore: number;
}

export function computeCandidatePriority(R: SignalEvaluation): number {
  const rr1 = Number(R.plan?.rr1 || 1);
  const earlyBonus = R.earlyEntry?.entryKind === 'EARLY_ENTRY' ? 4 : 0;
  const distPenalty = Number(R.earlyEntry?.distanceMovedPct || 0) * 3;
  return R.score + rr1 * 6 + earlyBonus - distPenalty;
}

export function rankAutoTradeCandidates<T extends { evaluation: SignalEvaluation; priorityScore?: number }>(
  candidates: T[]
): T[] {
  return [...candidates].sort((a, b) => {
    const pa = a.priorityScore ?? computeCandidatePriority(a.evaluation);
    const pb = b.priorityScore ?? computeCandidatePriority(b.evaluation);
    return pb - pa;
  });
}

export function isFreshExecutableSignal(params: {
  evaluation: SignalEvaluation;
  minTier: 'GOOD' | 'STRONG';
  nowMs: number;
  trigMs: number;
}): { eligible: boolean; reason?: string } {
  const { evaluation: R, minTier, nowMs, trigMs } = params;
  if (!R || !R.plan || !R.plan.ok || !R.dir) {
    return { eligible: false, reason: 'لا توجد خطة تنفيذ صالحة' };
  }
  if (RANK[R.tier] < RANK[minTier]) {
    return { eligible: false, reason: `مستوى الإشارة (${R.tier}) أقل من الحد المطلوب (${minTier})` };
  }
  if (R.earlyEntry && (!R.earlyEntry.stillValid || R.earlyEntry.entryStatus === 'CANCELLED')) {
    return { eligible: false, reason: 'الإشارة أصبحت ملغاة أو مُطاردة للسعر (Anti-FOMO)' };
  }
  if (nowMs - R.tClose > 2 * trigMs) {
    return { eligible: false, reason: 'إشارة قديمة متجاوزة للإطار الزمني الحالي' };
  }
  return { eligible: true };
}

export interface EngineStatusSnapshot {
  workerId: string;
  started: boolean;
  startedAt: string | null;
  runningCycle: boolean;
  lastHeartbeatAt: string | null;
  lastScanAt: string | null;
  lastSignalEvalAt: string | null;
  lastTradeExecAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  cyclesCompleted: number;
  activeSignalsCount: number;
  monitoredSymbols: string[];
  latestMarkPrices: Record<string, { mark: number; index: number; funding: number; next: number }>;
  btcContext?: BtcContext | null;
}

class BackgroundTradingEngine {
  private started = false;
  private runningCycle = false;
  private monitoringPositions = false;
  private metaCache: Record<string, SymbolMeta> = {};
  private metaLoadedAt = 0;
  private lastBarScanned: Record<string, number> = {};
  private lastModeScanned: Record<string, string> = {};
  private lastPosMonitorTs: Record<string, number> = {};
  private last1mCheckTs: Record<string, number> = {};
  private lastShieldCheckTs: Record<string, number> = {};
  private lastStatePersistAt: Record<string, number> = {};
  private lastErrorAlertAt = 0;

  public status: EngineStatusSnapshot = {
    workerId: `worker-${process.pid || 1}`,
    started: false,
    startedAt: null,
    runningCycle: false,
    lastHeartbeatAt: null,
    lastScanAt: null,
    lastSignalEvalAt: null,
    lastTradeExecAt: null,
    lastError: null,
    consecutiveErrors: 0,
    cyclesCompleted: 0,
    activeSignalsCount: 0,
    monitoredSymbols: [],
    latestMarkPrices: {},
    btcContext: null,
  };

  ensureStarted() {
    if (
      this.started ||
      process.env.NEXT_PHASE === 'phase-production-build' ||
      process.env.npm_lifecycle_event === 'build'
    ) {
      return;
    }
    this.started = true;
    this.status.started = true;
    this.status.startedAt = this.status.startedAt || new Date().toISOString();

    // Crash/Restart recovery log
    repo
      .appendEngineLog({
        userId: DEFAULT_USER_ID,
        level: 'INFO',
        category: 'WORKER',
        symbol: null,
        message: 'تشغيل محرك المراقبة والتداول الخلفي واستعادة الحالة من قاعدة البيانات.',
        details: { workerId: this.status.workerId },
      })
      .catch(() => undefined);

    setInterval(() => {
      this.monitorLoop().catch((e) => console.error('[bg-engine] monitorLoop:', e));
    }, 5000);

    setInterval(() => {
      this.scanLoop(false).catch((e) => console.error('[bg-engine] scanLoop:', e));
    }, 20_000);

    setTimeout(() => {
      this.monitorLoop().catch(() => undefined);
    }, 1500);
  }

  private async ensureMeta() {
    if (Object.keys(this.metaCache).length && Date.now() - this.metaLoadedAt < 3600_000) {
      return this.metaCache;
    }
    await binanceServer.syncTime();
    this.metaCache = await binanceServer.exchangeInfo();
    this.metaLoadedAt = Date.now();
    return this.metaCache;
  }

  private async persistHeartbeat(userId: string, force = false) {
    const now = Date.now();
    if (!force && now - (this.lastStatePersistAt[userId] || 0) < 12_000) return;
    this.lastStatePersistAt[userId] = now;
    try {
      const [settings, trades] = await Promise.all([
        repo.getBotSettings(userId),
        repo.getTrades(userId),
      ]);
      const openPositionsCount = trades.filter((t) => t.status === 'OPEN').length;
      const pendingOrdersCount = trades.filter((t) => t.status === 'PENDING').length;
      const todayPrefix = new Date().toISOString().slice(0, 10);
      const tradesToday = trades.filter((t) => t.openedAt.startsWith(todayPrefix)).length;
      const startedMs = this.status.startedAt ? new Date(this.status.startedAt).getTime() : now;

      await repo.saveEngineState({
        userId,
        workerId: this.status.workerId,
        workerStatus: this.status.started ? (this.status.consecutiveErrors >= 5 ? 'ERROR' : 'RUNNING') : 'STOPPED',
        executionMode: settings.autoTradeEnabled && settings.executionMode !== 'MANUAL' ? 'AUTO' : 'MANUAL',
        workerConnected: this.status.started,
        supabaseConnected: repo.isSupabaseConfigured(),
        lastHeartbeatAt: this.status.lastHeartbeatAt || new Date().toISOString(),
        lastScanAt: this.status.lastScanAt,
        lastSignalEvalAt: this.status.lastSignalEvalAt,
        lastTradeExecAt: this.status.lastTradeExecAt,
        startedAt: this.status.startedAt,
        uptimeSec: Math.max(0, Math.floor((now - startedMs) / 1000)),
        symbolsScanned: this.status.monitoredSymbols.length,
        activeSignalsCount: this.status.activeSignalsCount,
        openPositionsCount,
        pendingOrdersCount,
        tradesToday,
        cyclesCompleted: this.status.cyclesCompleted,
        lastError: this.status.lastError,
        consecutiveErrors: this.status.consecutiveErrors,
        paperTradingStatus: settings.emergencyStopped
          ? 'متوقف طارئاً'
          : settings.autoTradeEnabled
            ? 'آلي نشط (Paper Trading)'
            : 'يدوي + حماية المراكز المفتوحة',
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore transient state persistence error
    }
  }

  async monitorLoop() {
    if (this.monitoringPositions) return;
    this.monitoringPositions = true;
    try {
      const userIds = await repo.getAllActiveAutoUsers();
      if (!userIds.includes(DEFAULT_USER_ID)) userIds.push(DEFAULT_USER_ID);

      let anyOpen = false;
      const openByUser: Record<string, Awaited<ReturnType<typeof repo.getTrades>>> = {};
      for (const uid of userIds) {
        const trades = await repo.getTrades(uid);
        const live = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
        openByUser[uid] = live;
        if (live.length > 0) anyOpen = true;
      }

      if (!anyOpen) {
        this.status.lastHeartbeatAt = new Date().toISOString();
        await this.persistHeartbeat(DEFAULT_USER_ID);
        return;
      }

      const [pm, tk] = await Promise.all([binanceServer.premium(), binanceServer.tickers()]);
      this.status.latestMarkPrices = pm;
      this.status.lastHeartbeatAt = new Date().toISOString();
      this.status.consecutiveErrors = 0;
      this.status.lastError = null;

      const now = Date.now();
      for (const uid of userIds) {
        const userCfg = openByUser[uid].length ? await repo.getBotSettings(uid) : null;
        for (const pos of openByUser[uid]) {
          const pInfo = pm[pos.symbol];
          const tInfo = tk[pos.symbol];
          if (!pInfo && !tInfo) continue;

          const liveMark = pInfo?.mark ?? tInfo?.price ?? pos.markPriceLast;
          const liveLast = tInfo?.price ?? pInfo?.mark ?? pos.markPriceLast;

          const lastMon = this.lastPosMonitorTs[pos.id] || new Date(pos.filledAt || pos.openedAt).getTime();
          const last1m = this.last1mCheckTs[pos.id] || 0;
          const nearTargetOrStop =
            liveLast > 0 &&
            (Math.abs(liveLast - pos.stopCurrent) / liveLast <= 0.008 ||
              pos.tps.some((t) => !t.hit && Math.abs(liveLast - t.p) / liveLast <= 0.008) ||
              (pos.status === 'PENDING' && Math.abs(liveLast - pos.entryPrice) / liveLast <= 0.008));
          const needGapBackfill = now - lastMon > 75_000 && now - lastMon < 6 * 3600_000;
          const needPeriodic1m = now - last1m >= 15_000 || (nearTargetOrStop && now - last1m >= 4_500);

          if (needGapBackfill || needPeriodic1m) {
            try {
              const mins = needGapBackfill ? Math.min(240, Math.ceil((now - lastMon) / 60_000) + 2) : 5;
              const c1m = await binanceServer.klines(pos.symbol, '1m', mins);
              const floorMs = needGapBackfill ? lastMon - 60_000 : now - 5 * 60_000;
              const relevant = c1m.filter((c) => (c.T ?? c.t + 60_000) >= floorMs);
              this.last1mCheckTs[pos.id] = now;
              if (relevant.length) {
                await reconcilePositionIntrabar({
                  userId: uid,
                  pos,
                  candles1m: relevant,
                  fundingRate: pInfo?.funding,
                  nextFundingTime: pInfo?.next,
                });
              }
            } catch {
              // continue with live tick
            }
          }
          this.lastPosMonitorTs[pos.id] = now;

          if (pos.status === 'OPEN' || pos.status === 'PENDING') {
            await monitorPositionWithMarket({
              userId: uid,
              pos,
              markPrice: liveMark,
              lastPrice: liveLast,
              fundingRate: pInfo?.funding,
              nextFundingTime: pInfo?.next,
            });
          }

          // Smart Take Profit & Profit Shield active in BOTH Auto & Manual modes for open positions
          const useSmartTp = userCfg?.smartTakeProfitEnabled !== false;
          const useShield = userCfg?.smartProfitShield !== false;
          if (
            pos.status === 'OPEN' &&
            (useSmartTp || useShield) &&
            now - (this.lastShieldCheckTs[pos.id] || 0) >= 15_000
          ) {
            const riskDist = Math.abs(pos.entryPrice - pos.stopLoss);
            const dir = pos.side === 'LONG' ? 1 : -1;
            const curFavR = riskDist > 0 ? (dir * (liveLast - pos.entryPrice)) / riskDist : 0;
            const peakFavR = Math.max(Number(pos.meta?.peakFavR || 0), curFavR);
            const tp1Hit = Boolean(pos.tps[0]?.hit);
            const minSmartR = userCfg?.smartTakeProfitMinR ?? 0.6;
            const smartEligible = useSmartTp && (curFavR >= minSmartR || (peakFavR >= 1.5 && curFavR >= 0.45));
            const shieldEligible = useShield && ((tp1Hit && curFavR >= 0.65) || (peakFavR >= 1.6 && curFavR >= 0.8));

            if (smartEligible || shieldEligible) {
              this.lastShieldCheckTs[pos.id] = now;
              try {
                const [c1mRes, c5mRes, dpRes] = await Promise.allSettled([
                  binanceServer.klines(pos.symbol, '1m', 40),
                  binanceServer.klines(pos.symbol, '5m', 30),
                  binanceServer.depth(pos.symbol, 50),
                ]);
                const c1m = c1mRes.status === 'fulfilled' ? c1mRes.value : [];
                const c5m = c5mRes.status === 'fulfilled' ? c5mRes.value : [];
                const book = dpRes.status === 'fulfilled' ? binanceServer.bookAnalysis(dpRes.value) : null;
                if (c1m.length || c5m.length) {
                  await evaluateSmartProfitShieldExit({
                    userId: uid,
                    pos,
                    livePrice: liveLast,
                    microCandles1m: c1m,
                    microCandles5m: c5m,
                    book,
                  });
                }
              } catch {
                // ignore transient orderflow fetch failure
              }
            }
          }
        }
        await this.persistHeartbeat(uid);
      }
    } catch (err: any) {
      this.handleEngineError(err);
    } finally {
      this.monitoringPositions = false;
    }
  }

  async scanLoop(forceNow = false) {
    if (this.runningCycle) return { skipped: true };
    this.runningCycle = true;
    this.status.runningCycle = true;

    try {
      const userIds = await repo.getAllActiveAutoUsers();
      if (!userIds.includes(DEFAULT_USER_ID)) userIds.push(DEFAULT_USER_ID);

      const activeConfigs = [];
      for (const uid of userIds) {
        const cfg = await repo.getBotSettings(uid);
        if (cfg.autoTradeEnabled && cfg.executionMode !== 'MANUAL' && !cfg.emergencyStopped) {
          activeConfigs.push(cfg);
        }
      }

      if (!activeConfigs.length && !forceNow) {
        this.status.lastHeartbeatAt = new Date().toISOString();
        await this.persistHeartbeat(DEFAULT_USER_ID);
        return { skipped: true, reason: 'manual_or_paused' };
      }

      const meta = await this.ensureMeta();
      const [pm, tkAll] = await Promise.all([binanceServer.premium(), binanceServer.tickers()]);
      this.status.latestMarkPrices = pm;

      const targetConfigs = activeConfigs.length
        ? activeConfigs
        : [await repo.getBotSettings(DEFAULT_USER_ID)];

      const allSymbols = new Set<string>();
      for (const cfg of targetConfigs) {
        for (const sym of cfg.allowedSymbols) {
          if (meta[sym]) allSymbols.add(sym);
        }
      }
      this.status.monitoredSymbols = [...allSymbols];

      for (const cfg of targetConfigs) {
        const isAuto = Boolean(cfg.autoTradeEnabled && cfg.executionMode !== 'MANUAL' && !cfg.emergencyStopped);
        if (!isAuto && !forceNow) continue;

        const tfs = resolveModeConfig(cfg.mode, cfg.earlyTriggerTf);
        const trigMs = TF_MS[tfs.trigger] || 900e3;
        const barBucket = Math.floor(binanceServer.now() / trigMs);
        const modeSig = `${cfg.mode}:${tfs.trigger}`;

        if (this.lastModeScanned[cfg.userId] !== modeSig) {
          delete this.lastBarScanned[cfg.userId];
          this.lastModeScanned[cfg.userId] = modeSig;
        }

        if (!forceNow && this.lastBarScanned[cfg.userId] === barBucket) {
          continue;
        }

        const wallet = await repo.getWallet(cfg.userId);
        const existingTrades = await repo.getTrades(cfg.userId);
        const openTrades = existingTrades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
        const allocPlan = computeEqualAllocationPlan({
          wallet,
          settings: cfg,
          openTradesCount: openTrades.length,
        });

        const tfList = [...new Set([tfs.trigger, tfs.setup, tfs.trend, tfs.htf].filter(Boolean) as string[])];

        // Compute shared BTC Macro Context once per scan cycle
        let btcContext: BtcContext | null = null;
        try {
          const btcRaw = await Promise.all(
            tfList.map((tf) => binanceServer.klines('BTCUSDT', tf, tf === tfs.htf ? 120 : 280))
          );
          const btcMap: Record<string, Candle[]> = {};
          tfList.forEach((tf, idx) => {
            btcMap[tf] = btcRaw[idx].filter((c) => c.x !== false);
          });
          const btcPrepared = prepare(btcMap, tfs, meta.BTCUSDT);
          btcContext = buildBtcContext(btcPrepared);
          this.status.btcContext = btcContext;
        } catch {
          btcContext = this.status.btcContext || null;
        }

        const candidates: AutoCandidate[] = [];
        let evaluatedCount = 0;

        for (const sym of cfg.allowedSymbols) {
          if (!meta[sym]) continue;
          const tInfo = tkAll[sym];
          if (tInfo && (cfg.minVolumeUsdt || 0) > 0 && tInfo.vol < cfg.minVolumeUsdt) {
            continue;
          }

          try {
            const candlesMap: Record<string, Candle[]> = {};
            const klineResults = await Promise.all(
              tfList.map((tf) => binanceServer.klines(sym, tf, tf === tfs.htf ? 120 : 400))
            );
            tfList.forEach((tf, idx) => {
              candlesMap[tf] = klineResults[idx].filter((c) => c.x !== false);
            });

            const ctx = prepare(candlesMap, tfs, meta[sym], {
              mode: cfg.mode,
              earlyTriggerTf: cfg.earlyTriggerTf,
              minScore: cfg.minScore,
              strongScore: cfg.strongScore,
              watchScore: cfg.watchScore,
              equity: wallet.balanceUsdt,
              riskPct: cfg.riskPct,
              maxLev: cfg.maxLeverage,
              takerFee: cfg.takerFee,
              makerFee: cfg.makerFee,
              slip: cfg.slippage,
              minLiqSafetyPct: cfg.minLiqSafetyPct,
              minVolumeUsdt: cfg.minVolumeUsdt,
              maxSpreadBps: cfg.maxSpreadBps,
              tpPcts: cfg.tpPcts,
              limitExpireBars: cfg.limitExpireBars,
              cancelChasedAtr: cfg.cancelChasedAtr,
              useFvgFilter: cfg.filterFlags?.useFvg ?? true,
              useObFilter: cfg.filterFlags?.useOb ?? true,
              useChochBosFilter: cfg.filterFlags?.useChochBos ?? true,
              useMomentumFilter: cfg.filterFlags?.useMomentum ?? true,
              earlyWeights: cfg.earlyWeights,
            });

            const T = ctx.B.trigger;
            if (!T || T.n < 80) continue;

            const pInfo = pm[sym];
            const deriv: DerivData = {};
            if (pInfo) {
              deriv.funding = pInfo.funding;
              deriv.fundingMs = pInfo.next;
              if (pInfo.index > 0) deriv.basisBps = (1e4 * (pInfo.mark - pInfo.index)) / pInfo.index;
            }
            let book = null;
            const microCandles: Record<string, Candle[]> = {};
            if (candlesMap['5m']?.length) microCandles['5m'] = candlesMap['5m'].slice(-90);
            try {
              const [oi, ls, top, tk, dp, c1m, c5m] = await Promise.allSettled([
                binanceServer.oiHist(sym, '15m', 20),
                binanceServer.lsGlobal(sym, '15m', 1),
                binanceServer.lsTop(sym, '15m', 1),
                binanceServer.taker(sym, '15m', 4),
                binanceServer.depth(sym, 100),
                binanceServer.klines(sym, '1m', 90),
                microCandles['5m'] ? Promise.resolve(microCandles['5m']) : binanceServer.klines(sym, '5m', 90),
              ]);
              if (oi.status === 'fulfilled' && Array.isArray(oi.value) && oi.value.length >= 17) {
                const arr = oi.value.map((x: any) => Number(x.sumOpenInterestValue || x.sumOpenInterest));
                const n = arr.length;
                deriv.oiChg1h = 100 * (arr[n - 1] / arr[n - 5] - 1);
                deriv.oiChg4h = 100 * (arr[n - 1] / arr[n - 17] - 1);
                deriv.oiUsd = arr[n - 1];
              }
              if (ls.status === 'fulfilled' && ls.value?.[0]) {
                deriv.lsRatio = Number(ls.value[0].longShortRatio);
                deriv.lsLongPct = Number(ls.value[0].longAccount) * 100;
              }
              if (top.status === 'fulfilled' && top.value?.[0]) {
                deriv.topLongPct = Number(top.value[0].longAccount) * 100;
              }
              if (tk.status === 'fulfilled' && Array.isArray(tk.value) && tk.value.length) {
                let b = 0;
                let s = 0;
                for (const x of tk.value) {
                  b += Number(x.buyVol);
                  s += Number(x.sellVol);
                }
                if (s > 0) deriv.takerRatio = b / s;
              }
              if (dp.status === 'fulfilled') {
                book = binanceServer.bookAnalysis(dp.value);
              }
              if (c1m.status === 'fulfilled' && Array.isArray(c1m.value)) {
                microCandles['1m'] = c1m.value;
              }
              if (c5m.status === 'fulfilled' && Array.isArray(c5m.value) && !microCandles['5m']) {
                microCandles['5m'] = c5m.value;
              }
            } catch {
              // continue with partial derivs
            }

            const livePx = tInfo?.price ?? (await binanceServer.tickerPrice(sym).catch(() => T.c[T.n - 1]));
            const nowMs = binanceServer.now();
            const R = evaluate(ctx, T.n - 1, {
              price: livePx,
              deriv,
              book,
              btcContext: sym === 'BTCUSDT' ? null : btcContext,
              microCandles,
              vol24h: tInfo?.vol,
              minVolumeUsdt: cfg.minVolumeUsdt,
              maxSpreadBps: cfg.maxSpreadBps,
              now: nowMs,
            });
            evaluatedCount++;
            this.status.lastSignalEvalAt = new Date().toISOString();

            if (!R || !R.dir) continue;

            const freshness = isFreshExecutableSignal({
              evaluation: R,
              minTier: cfg.minTier,
              nowMs,
              trigMs,
            });

            if (freshness.eligible && R.plan?.ok) {
              candidates.push({
                symbol: sym,
                evaluation: R,
                meta: meta[sym],
                markPrice: pInfo?.mark ?? livePx,
                vol24h: tInfo?.vol,
                spreadBps: book?.spreadBps,
                trigMs,
                priorityScore: computeCandidatePriority(R),
              });
            } else if (R.score >= cfg.watchScore) {
              // Record non-executed signal telemetry for missed/late analysis
              await repo.upsertSignalAnalytics({
                id: `sig-eval-${sym}-${R.t}-${cfg.mode}`,
                userId: cfg.userId,
                symbol: sym,
                side: R.dir > 0 ? 'LONG' : 'SHORT',
                strategyMode: cfg.mode,
                entryKind: R.earlyEntry?.entryKind || 'CONFIRMED_ENTRY',
                entryStatus: R.earlyEntry?.entryStatus || 'SKIPPED',
                timeframe: tfs.trigger,
                regime: R.regime?.type || 'range',
                score: R.score,
                rawScore: R.rawScore,
                signalPrice: R.price,
                entryPrice: R.plan?.entry || R.price,
                distanceMovedPct: R.earlyEntry?.distanceMovedPct ?? 0,
                stillValid: Boolean(R.earlyEntry?.stillValid),
                earlyReason: freshness.reason || R.earlyEntry?.earlyReason || '',
                confirmFactors: R.earlyEntry?.confirmFactors || [],
                missingConfirmations: R.earlyEntry?.missingConfirmations || [],
                scoreBreakdown: R.earlyEntry?.breakdown || {},
                takenByUserOrAuto: false,
                wasLateEntry: Boolean(R.earlyEntry?.fomoChasing),
                simulationRunId: wallet.simulationRunId || 'run-1',
                createdAt: new Date().toISOString(),
              });
            }
          } catch (symErr) {
            console.error(`[bg-engine] symbol ${sym} error:`, symErr);
          }
        }

        // Rank ALL eligible opportunities by composite quality instead of executing blind symbol order
        const ranked = rankAutoTradeCandidates(candidates);
        this.status.activeSignalsCount = ranked.length;

        await repo.appendEngineLog({
          userId: cfg.userId,
          level: 'INFO',
          category: 'SCAN',
          symbol: null,
          message: `اكتمل مسح ${evaluatedCount} عملة (${cfg.mode} · ${tfs.trigger}): ${ranked.length} إشارات مؤهلة · ${isAuto ? 'تنفيذ AUTO' : 'وضع MANUAL'}`,
          details: { topSymbols: ranked.slice(0, 4).map((c) => `${c.symbol}:${c.evaluation.score}`) },
        });

        if (isAuto && ranked.length > 0 && allocPlan.availableSleevesCount > 0) {
          let sleevesLeft = allocPlan.availableSleevesCount;
          for (const cand of ranked) {
            if (sleevesLeft <= 0) break;
            const res = await openPaperTrade({
              userId: cfg.userId,
              symbol: cand.symbol,
              evaluation: cand.evaluation,
              meta: cand.meta,
              markPrice: cand.markPrice,
              lastFundingTs: Date.now(),
              vol24h: cand.vol24h,
              spreadBps: cand.spreadBps,
              btcContext: cand.symbol === 'BTCUSDT' ? null : btcContext,
              expireBars: cand.evaluation.plan?.expireBars,
              triggerMs: cand.trigMs,
              source: 'AUTO',
            });
            if (res.ok) {
              sleevesLeft--;
              this.status.lastTradeExecAt = new Date().toISOString();
            } else if (res.reason) {
              await repo.appendEngineLog({
                userId: cfg.userId,
                level: 'WARN',
                category: 'EXECUTE',
                symbol: cand.symbol,
                message: `رفض فتح ${cand.symbol}: ${res.reason}`,
              });
            }
          }
        }

        this.lastBarScanned[cfg.userId] = barBucket;
        await this.persistHeartbeat(cfg.userId, true);
      }

      this.status.cyclesCompleted++;
      this.status.lastScanAt = new Date().toISOString();
      this.status.lastHeartbeatAt = new Date().toISOString();
      this.status.consecutiveErrors = 0;
      this.status.lastError = null;
      await this.persistHeartbeat(DEFAULT_USER_ID, true);

      return { skipped: false, cyclesCompleted: this.status.cyclesCompleted };
    } catch (err: any) {
      this.handleEngineError(err);
      return { skipped: false, error: String(err?.message || err) };
    } finally {
      this.runningCycle = false;
      this.status.runningCycle = false;
    }
  }

  private handleEngineError(err: any) {
    const msg = String(err?.message || err);
    this.status.consecutiveErrors++;
    this.status.lastError = msg;
    console.error('[bg-engine] error:', msg);
    repo
      .appendEngineLog({
        userId: DEFAULT_USER_ID,
        level: 'ERROR',
        category: 'WORKER',
        symbol: null,
        message: `خطأ في المحرك الخلفي: ${msg.slice(0, 140)}`,
      })
      .catch(() => undefined);

    if (this.status.consecutiveErrors >= 3 && Date.now() - this.lastErrorAlertAt > 15 * 60_000) {
      this.lastErrorAlertAt = Date.now();
      emitAlert({
        userId: DEFAULT_USER_ID,
        eventType: 'ENGINE_ERROR',
        severity: 'danger',
        title: 'تعطل مؤقت في محرك التداول الخلفي',
        body: `تعذر جلب بيانات السوق (${msg.slice(0, 100)}). يعاود المحرك المحاولة تلقائياً.`,
      }).catch(() => undefined);
    }
  }
}

const g = globalThis as unknown as { __cipherBgEngine?: BackgroundTradingEngine };
export function getBackgroundEngine(): BackgroundTradingEngine {
  if (!g.__cipherBgEngine) {
    g.__cipherBgEngine = new BackgroundTradingEngine();
  }
  g.__cipherBgEngine.ensureStarted();
  return g.__cipherBgEngine;
}
