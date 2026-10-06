package com.duipai.engine;

import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Reproducible fresh-JVM throughput check; run as a Java main, outside unit tests. */
public final class EngineBenchmark {
    public static void main(String[] args) throws Exception {
        Path work = Path.of(args.length == 0 ? "target/benchmark-work" : args[0]);
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 120;
        String generator = "public class Main { public static void main(String[] args) { long n=Long.parseLong(args[0]); System.out.println(n + \" \" + (n+1)); } }";
        String solver = "public class Main { public static void main(String[] args) throws Exception { String[] a=new String(System.in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).trim().split(\" \"); System.out.println(Long.parseLong(a[0])+Long.parseLong(a[1])); } }";
        try (RunEngine engine = new RunEngine(work)) {
            for (int parallelism : new int[]{1, 4}) {
                CompletableFuture<Map<String, Object>> complete = new CompletableFuture<>();
                AtomicLong runningMs = new AtomicLong();
                engine.start(UUID.randomUUID().toString(), Map.of("generator", generator, "brute", solver, "optimized", solver),
                        Map.of("rounds", rounds, "parallelism", parallelism, "startSeed", "1"), null, snapshot -> {
                            if ("RUNNING".equals(snapshot.get("state"))) runningMs.compareAndSet(0, ((Number) snapshot.get("elapsedMs")).longValue());
                            if ("FINISHED".equals(snapshot.get("state"))) complete.complete(snapshot);
                        });
                Map<String, Object> result = complete.get(120, TimeUnit.SECONDS);
                if (!"PASS".equals(result.get("verdict"))) throw new IllegalStateException(result.get("verdict") + ": " + result.get("compileErrors") + " " + result.get("message"));
                long elapsed = ((Number) result.get("elapsedMs")).longValue();
                double executionRate = rounds * 1000.0 / Math.max(1, elapsed - runningMs.get());
                System.out.printf("parallelism=%d rounds=%d verdict=%s totalMs=%d compileMs=%d overallRoundsPerSecond=%.2f executionRoundsPerSecond=%.2f maxOptimizedMs=%s%n",
                        parallelism, rounds, result.get("verdict"), elapsed, runningMs.get(), result.get("roundsPerSecond"), executionRate, result.get("maxOptimizedMs"));
                // The final callback returns before the engine releases its busy flag.
                while (engine.isBusy()) Thread.sleep(5);
            }
        }
    }
}
