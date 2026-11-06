import { randomUUID } from "crypto";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

interface LoadSample {
  durationMs: number;
  status: number;
  txStatus?: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return Number((sorted[idx] ?? 0).toFixed(2));
}

interface TargetInstance {
  baseUrl: string;
  close?: () => Promise<void>;
}

async function runLoadBenchmark() {
  const targetEnv = process.env.LOAD_TEST_TARGET?.toLowerCase();
  const useDockerCluster =
    targetEnv === "docker" ||
    targetEnv === "cluster" ||
    targetEnv === "remote";

  let instances: TargetInstance[];

  if (useDockerCluster) {
    console.log(
      "Running load benchmark against live Docker Compose cluster (app-1:3000, app-2:3001, app-3:3002)...",
    );
    instances = [
      { baseUrl: "http://localhost:3000" },
      { baseUrl: "http://localhost:3001" },
      { baseUrl: "http://localhost:3002" },
    ];
  } else {
    console.log(
      "Starting 3-instance Distributed Wagering Processor cluster for load testing...",
    );
    instances = await Promise.all([
      createTestAppInstance({ workersEnabled: true, instanceId: "load-node-1" }),
      createTestAppInstance({ workersEnabled: true, instanceId: "load-node-2" }),
      createTestAppInstance({ workersEnabled: true, instanceId: "load-node-3" }),
    ]);
  }

  const walletIds: string[] = [];
  const samples: LoadSample[] = [];

  try {
    // 1. Provision 20 wallets with 500.00 BRL each
    const wallets = await Promise.all(
      Array.from({ length: 20 }, async (_, idx) => {
        const inst = instances[idx % instances.length]!;
        const res = await fetch(`${inst.baseUrl}/wallets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            playerId: randomUUID(),
            initialBalance: { amount: "500.00", currency: "BRL" },
          }),
        });
        const w = (await res.json()) as { id: string; playerId: string };
        walletIds.push(w.id);
        return w;
      }),
    );

    const benchStart = performance.now();

    // Phase 1: Distributed Multi-Wallet Workload (200 transactions with concurrency 25)
    const phase1Tasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < 200; i++) {
      const w = wallets[i % wallets.length]!;
      const inst = instances[i % instances.length]!;
      const isWin = i % 4 === 3;
      const isLoss = i % 5 === 4 && !isWin;
      const kind = isWin ? "WIN" : isLoss ? "LOSS" : "BET";
      const amount = isLoss ? "0.00" : isWin ? "30.00" : "25.00";
      const extId = `load-p1-${i}-${randomUUID()}`;

      phase1Tasks.push(async () => {
        const t0 = performance.now();
        const res = await fetch(`${inst.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": `prov-load:${extId}`,
          },
          body: JSON.stringify({
            providerId: "prov-load",
            externalTransactionId: extId,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `round-${i}`,
            gameId: "fortune-chimp",
            kind,
            money: { amount, currency: "BRL" },
          }),
        });
        const body = (await res.json()) as { status?: string };
        samples.push({
          durationMs: performance.now() - t0,
          status: res.status,
          txStatus: body.status,
        });
      });
    }

    // Execute with concurrency pool of 25
    const runPool = async (tasks: Array<() => Promise<void>>, concurrency: number) => {
      let idx = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (idx < tasks.length) {
          const current = idx++;
          const fn = tasks[current];
          if (fn) await fn();
        }
      });
      await Promise.all(workers);
    };

    await runPool(phase1Tasks, 25);

    // Phase 2: Hot Wallet Contention + Idempotent Replay Storm (100 concurrent operations on Wallet[0])
    const hotWallet = wallets[0]!;
    const hotDuplicateExtId = `hot-dup-${randomUUID()}`;
    const phase2Tasks: Array<() => Promise<void>> = [];

    for (let i = 0; i < 100; i++) {
      const inst = instances[i % instances.length]!;
      const isReplay = i < 40; // 40 parallel identical requests + 60 distinct bets competing for balance
      const extId = isReplay ? hotDuplicateExtId : `hot-distinct-${i}-${randomUUID()}`;

      phase2Tasks.push(async () => {
        const t0 = performance.now();
        const res = await fetch(`${inst.baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": `prov-load:${extId}`,
          },
          body: JSON.stringify({
            providerId: "prov-load",
            externalTransactionId: extId,
            playerId: hotWallet.playerId,
            walletId: hotWallet.id,
            roundId: "round-hot",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "15.00", currency: "BRL" },
          }),
        });
        const body = (await res.json()) as { status?: string };
        samples.push({
          durationMs: performance.now() - t0,
          status: res.status,
          txStatus: body.status,
        });
      });
    }

    await runPool(phase2Tasks, 25);

    const totalElapsedMs = performance.now() - benchStart;

    // Wait briefly for background outbox publishers to drain
    await new Promise((r) => setTimeout(r, 600));
    if (!useDockerCluster) {
      await Promise.all(
        (instances as TestAppInstance[]).map((i) => i.outboxWorker.publishBatch(100)),
      );
      // Verify 100% ledger reconciliation invariant across all 20 wallets
      await assertAllWalletsConsistent(instances[0] as TestAppInstance, walletIds);
    } else {
      // Reconcile via HTTP endpoint on Docker cluster
      for (const wid of walletIds) {
        const recRes = await fetch(`http://localhost:3000/wallets/${wid}/reconciliation`, {
          method: "POST",
        });
        const recData = (await recRes.json()) as { consistent: boolean };
        if (!recData.consistent) {
          throw new Error(`Wallet ${wid} reconciliation failed on Docker cluster`);
        }
      }
    }

    const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const totalRequests = samples.length;
    const http5xx = samples.filter((s) => s.status >= 500).length;
    const processedCount = samples.filter((s) => s.txStatus === "PROCESSED").length;
    const rejectedCount = samples.filter((s) => s.txStatus === "REJECTED").length;
    const throughputRps = Number(
      ((totalRequests / totalElapsedMs) * 1000).toFixed(2),
    );

    const metricsSnapshots = await Promise.all(
      instances.map(async (inst) => {
        const res = await fetch(`${inst.baseUrl}/metrics/json`);
        return (await res.json()) as {
          duplicatesDetected: { total: number };
          lockConflicts: number;
          outboxLagSeconds: number;
          outboxPendingCount: number;
        };
      }),
    );

    const totalDuplicates = metricsSnapshots.reduce(
      (acc, m) => acc + m.duplicatesDetected.total,
      0,
    );
    const totalLockConflicts = metricsSnapshots.reduce(
      (acc, m) => acc + m.lockConflicts,
      0,
    );
    const maxOutboxLag = Math.max(
      ...metricsSnapshots.map((m) => m.outboxLagSeconds),
    );

    const report = {
      environment: {
        runtime: `Bun ${Bun.version}`,
        instances: instances.length,
        database: "PostgreSQL 16 (Docker)",
        broker: "LocalStack SQS FIFO (Docker)",
      },
      workload: {
        wallets: wallets.length,
        totalRequests,
        concurrency: 25,
        elapsedMs: Number(totalElapsedMs.toFixed(2)),
      },
      results: {
        throughputRps,
        latencyMs: {
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
          p99: percentile(durations, 99),
          max: Number((durations[durations.length - 1] ?? 0).toFixed(2)),
        },
        outcomes: {
          processed: processedCount,
          rejectedByBusinessRule: rejectedCount,
          duplicatesDetected: totalDuplicates,
          http5xxErrors: http5xx,
          errorRatePercent: Number(((http5xx / totalRequests) * 100).toFixed(2)),
        },
        concurrencyAndOutbox: {
          lockConflicts: totalLockConflicts,
          finalOutboxLagSeconds: maxOutboxLag,
          allWalletsReconciledConsistent: true,
        },
      },
    };

    console.log("\n=== LOAD TEST REPORT ===");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!useDockerCluster) {
      await Promise.all(
        instances.map((i) => i.close && i.close()),
      );
    }
  }
}

runLoadBenchmark().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

