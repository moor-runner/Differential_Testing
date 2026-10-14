package com.duipai.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class RunEngineTest {
    @TempDir Path temporary;
    private static final String GENERATOR = "public class Main { public static void main(String[] a) { System.out.println(a[0]); } }";
    private static final String ECHO = "public class Main { public static void main(String[] a) throws Exception { System.out.write(System.in.readAllBytes()); } }";

    @Test void normalizationPreservesMeaningfulWhitespaceAndEmptyLines() {
        assertNull(RunEngine.firstDifference("a  \r\nb\t\r\n \r\n", "a\nb\n"));
        assertNull(RunEngine.firstDifference("\n\n", ""));
        assertEquals(Map.of("line", 1, "expected", " a", "actual", "a"), RunEngine.firstDifference(" a", "a"));
        assertEquals(Map.of("line", 1, "expected", "a  b", "actual", "a b"), RunEngine.firstDifference("a  b", "a b"));
        assertEquals(2, RunEngine.firstDifference("a\n\nb", "a\nb").get("line"));
        Map<String, Object> missing = RunEngine.firstDifference("a\nb", "a");
        assertEquals("b", missing.get("expected"));
        assertNull(missing.get("actual"));
    }

    @Test void deterministicSeedRangeAndReplayIncludeCompleteOutputs() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> run = run(engine, codes(GENERATOR, ECHO, ECHO),
                    Map.of("rounds", 3, "parallelism", 1, "startSeed", "9223372036854775805"), null);
            assertEquals("PASS", run.get("verdict"));
            assertEquals(3, run.get("completed"));
            assertEquals("9223372036854775807", run.get("seed"));
            assertEquals("9223372036854775807" + System.lineSeparator(), run.get("input"));
            Map<String, Object> replay = run(engine, codes(GENERATOR, ECHO, ECHO), Map.of("rounds", 100), (String) run.get("seed"));
            assertEquals(1, replay.get("total"));
            assertEquals("PASS", replay.get("verdict"));
            assertEquals(run.get("input"), result(replay, "optimized").get("stdout"));
            ObjectMapper json = new ObjectMapper();
            Map<?, ?> restored = json.readValue(json.writeValueAsBytes(replay), Map.class);
            assertEquals("9223372036854775807", restored.get("seed"));
            assertEquals("Main", ((Map<?, ?>) restored.get("codes")).get("generator").toString().split("class ")[1].split(" ")[0]);
            assertEquals("FINISHED", restored.get("state"));
            assertThrows(UnsupportedOperationException.class, () -> replay.put("state", "RUNNING"));
            assertThrows(UnsupportedOperationException.class, () -> result(replay, "optimized").put("stdout", "corrupt"));
        }
    }

    @Test void invalidSeedsAndOverflowAreRejectedBeforeScheduling() {
        try (RunEngine engine = new RunEngine(temporary)) {
            assertThrows(IllegalArgumentException.class, () -> engine.start("overflow", codes(GENERATOR, ECHO, ECHO),
                    Map.of("rounds", 2, "startSeed", Long.toString(Long.MAX_VALUE)), null, null));
            assertThrows(IllegalArgumentException.class, () -> engine.start("precision", codes(GENERATOR, ECHO, ECHO),
                    Map.of("startSeed", 123L), null, null));
            assertThrows(IllegalArgumentException.class, () -> engine.start("bad", codes(GENERATOR, ECHO, ECHO),
                    Map.of(), "9223372036854775808", null));
            assertThrows(IllegalArgumentException.class, () -> engine.start("zero", codes(GENERATOR, ECHO, ECHO),
                    Map.of("rounds", 0), null, null));
            assertFalse(engine.isBusy());
        }
    }

    @Test void compilationErrorsStayAssociatedWithTheirRoleAndUtf8Source() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            String invalid = "public class Main {\n  public static void main(String[] a) {\n    中文错误;\n  }\n}";
            Map<String, Object> result = run(engine, codes(GENERATOR, ECHO, invalid), Map.of(), "1");
            assertEquals("CE", result.get("verdict"));
            List<?> errors = (List<?>) result.get("compileErrors");
            assertEquals(1, errors.size());
            Map<?, ?> error = (Map<?, ?>) errors.getFirst();
            assertEquals("optimized", error.get("role"));
            assertTrue(error.get("output").toString().contains("Main.java:3:"));
            Map<?, ?> diagnostic = (Map<?, ?>) ((List<?>) error.get("diagnostics")).getFirst();
            assertEquals(3L, diagnostic.get("line"));
            assertEquals(invalid, ((Map<?, ?>) result.get("codes")).get("optimized"));
        }
    }

    @Test void wrongAnswerRecordsCounterexampleAndFirstDifference() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            String wrong = "public class Main { public static void main(String[] a) { System.out.println(99); } }";
            Map<String, Object> result = run(engine, codes(GENERATOR, ECHO, wrong), Map.of("rounds", 100, "parallelism", 4, "startSeed", "7"), null);
            assertEquals("WA", result.get("verdict"));
            assertTrue((Integer) result.get("completed") <= 4);
            assertEquals("99" + System.lineSeparator(), result(result, "optimized").get("stdout"));
            assertEquals(1, ((Map<?, ?>) result.get("firstDifference")).get("line"));
            assertEquals(result.get("seed") + System.lineSeparator(), result.get("input"));
            assertFalse(engine.isBusy());
        }
    }

    @Test void timeoutAndRuntimeErrorAreDistinctAndFailedRuntimeCountsInMaximum() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            String sleeping = "public class Main { public static void main(String[] a) throws Exception { Thread.sleep(30000); } }";
            Map<String, Object> timeout = run(engine, codes(GENERATOR, ECHO, sleeping), Map.of("optimizedTimeoutMs", 300), "1");
            assertEquals("TLE", timeout.get("verdict"));
            assertEquals(true, result(timeout, "optimized").get("timedOut"));
            assertTrue((Long) timeout.get("maxOptimizedMs") >= 300);
            String crashing = "public class Main { public static void main(String[] a) { throw new IllegalStateException(\"失败信息\"); } }";
            Map<String, Object> error = run(engine, codes(GENERATOR, ECHO, crashing), Map.of(), "2");
            assertEquals("RE", error.get("verdict"));
            assertTrue(result(error, "optimized").get("stderr").toString().contains("失败信息"));
            assertNotEquals(0, result(error, "optimized").get("exitCode"));
        }
    }

    @Test void generatorAndBruteFailuresHaveJudgeVerdicts() throws Exception {
        String crashing = "public class Main { public static void main(String[] a) { System.exit(3); } }";
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> generator = run(engine, codes(crashing, ECHO, ECHO), Map.of(), "1");
            assertEquals("GENERATOR_ERROR", generator.get("verdict"));
            assertNull(generator.get("brute"));
            Map<String, Object> brute = run(engine, codes(GENERATOR, crashing, ECHO), Map.of(), "1");
            assertEquals("BRUTE_ERROR", brute.get("verdict"));
            assertTrue(brute.get("message").toString().contains("裁判或数据有问题"));
        }
    }

    @Test void cleanupKeepsNormalExitStatusAcrossRepeatedParallelPrograms() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> snapshot = run(engine, codes(GENERATOR, ECHO, ECHO),
                    Map.of("rounds", 80, "parallelism", 4, "startSeed", "0"), null);
            assertEquals("PASS", snapshot.get("verdict"), () -> "Unexpected cleanup status: " + snapshot);
            assertEquals(80, snapshot.get("completed"));
            for (String role : List.of("generator", "brute", "optimized")) assertEquals(0, result(snapshot, role).get("exitCode"));
        }
    }

    @Test void runawayStdoutAndStderrAreBoundedAndKillProcess() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            for (String stream : List.of("out", "err")) {
                String noisy = "public class Main { public static void main(String[] a) throws Exception { byte[] b = new byte[8192]; java.util.Arrays.fill(b, (byte)'x'); while (true) System." + stream + ".write(b); } }";
                Map<String, Object> result = run(engine, codes(GENERATOR, ECHO, noisy), Map.of("optimizedTimeoutMs", 5000), "1");
                assertEquals("OLE", result.get("verdict"));
                Map<String, Object> process = result(result, "optimized");
                assertEquals(true, process.get("outputLimited"));
                assertTrue(process.get("stdout").toString().length() <= RunEngine.STDOUT_LIMIT);
                assertTrue(process.get("stderr").toString().length() <= RunEngine.STDERR_LIMIT);
                assertFalse(engine.isBusy());
            }
        }
    }

    @Test void largeUnreadStdinAndBothOutputPipesCannotDeadlock() throws Exception {
        String generator = "public class Main { public static void main(String[] a) { byte[] b = new byte[1024*1024]; java.util.Arrays.fill(b, (byte)'x'); System.out.write(b, 0, b.length); } }";
        String exitsWithoutInput = "public class Main { public static void main(String[] a) { System.err.println(\"stderr\"); System.out.println(1); } }";
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> result = run(engine, codes(generator, exitsWithoutInput, exitsWithoutInput), Map.of(), "1");
            assertEquals("PASS", result.get("verdict"));
            assertEquals(1024 * 1024, result.get("input").toString().length());
            assertEquals("stderr" + System.lineSeparator(), result(result, "optimized").get("stderr"));
        }
    }

    @Test void cancelCleansTheRunningJvmAndItsDescendantBeforeFinished() throws Exception {
        String forks = """
                public class Main {
                    public static void main(String[] a) throws Exception {
                        if (a[0].equals("child")) { Thread.sleep(30000); return; }
                        String exe = System.getProperty("os.name").toLowerCase().contains("win") ? "java.exe" : "java";
                        String executable = java.nio.file.Path.of(System.getProperty("java.home"), "bin", exe).toString();
                        Process child = new ProcessBuilder(executable, "-cp", System.getProperty("java.class.path"), "Main", "child").start();
                        java.nio.file.Files.writeString(java.nio.file.Path.of("pids"), ProcessHandle.current().pid() + " " + child.pid());
                        Thread.sleep(30000);
                    }
                }
                """;
        try (RunEngine engine = new RunEngine(temporary)) {
            CompletableFuture<Map<String, Object>> finalResult = new CompletableFuture<>();
            Map<String, Object> initial = engine.start("cancel", codes(forks, ECHO, ECHO), Map.of("generatorTimeoutMs", 30000), "1",
                    snapshot -> { if ("FINISHED".equals(snapshot.get("state"))) finalResult.complete(snapshot); });
            assertEquals("COMPILING", initial.get("state"));
            assertThrows(IllegalStateException.class, () -> engine.start("busy", codes(GENERATOR, ECHO, ECHO), Map.of(), null, null));
            Path pids = awaitFile(temporary, "pids");
            String[] ids = Files.readString(pids).trim().split(" ");
            engine.cancel("cancel");
            assertEquals("CANCELLED", finalResult.get(15, TimeUnit.SECONDS).get("verdict"));
            awaitIdle(engine);
            for (String id : ids) assertFalse(ProcessHandle.of(Long.parseLong(id)).map(ProcessHandle::isAlive).orElse(false), "remaining PID " + id);
            assertFalse(engine.isBusy());
        }
    }

    @Test void closeDuringCompilationCancelsAndRefusesNewTasks() throws Exception {
        RunEngine engine = new RunEngine(temporary);
        CompletableFuture<Map<String, Object>> finish = new CompletableFuture<>();
        engine.start("closing", codes(GENERATOR, ECHO, ECHO), Map.of("rounds", 10000), null,
                result -> { if ("FINISHED".equals(result.get("state"))) finish.complete(result); });
        engine.close();
        assertEquals("CANCELLED", finish.get(5, TimeUnit.SECONDS).get("verdict"));
        assertFalse(engine.isBusy());
        assertThrows(IllegalStateException.class, () -> engine.start("closed", codes(GENERATOR, ECHO, ECHO), Map.of(), null, null));
    }

    @Test @EnabledOnOs(OS.WINDOWS) void rapidParentExitStillCleansDescendantAndItsInheritedPipes() throws Exception {
        String forks = """
                public class Main {
                    public static void main(String[] a) throws Exception {
                        if (a[0].equals("child")) { Thread.sleep(30000); return; }
                        String executable = java.nio.file.Path.of(System.getProperty("java.home"), "bin", "java.exe").toString();
                        Process child = new ProcessBuilder(executable, "-cp", System.getProperty("java.class.path"), "Main", "child").inheritIO().start();
                        java.nio.file.Files.writeString(java.nio.file.Path.of("child-pid"), Long.toString(child.pid()));
                        System.out.println(a[0]);
                    }
                }
                """;
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> result = run(engine, codes(forks, ECHO, ECHO), Map.of(), "1");
            assertEquals("PASS", result.get("verdict"));
            Path pidFile = awaitFile(temporary, "child-pid");
            long pid = Long.parseLong(Files.readString(pidFile));
            assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        }
    }

    @Test void userProgramsDoNotInheritTheBackendAuthenticationToken() throws Exception {
        String environment = "public class Main { public static void main(String[] a) { System.out.println(System.getenv(\"DUIPAI_TOKEN\") == null ? \"absent\" : \"exposed\"); } }";
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> result = run(engine, codes(environment, ECHO, ECHO), Map.of(), "1");
            assertEquals("PASS", result.get("verdict"));
            assertEquals("absent" + System.lineSeparator(), result.get("input"));
        }
    }

    @Test void callbackSnapshotsRemainOrderedAndImmutableInParallelExecution() throws Exception {
        try (RunEngine engine = new RunEngine(temporary)) {
            List<Map<String, Object>> snapshots = new ArrayList<>();
            CompletableFuture<Map<String, Object>> finished = new CompletableFuture<>();
            engine.start("parallel", codes(GENERATOR, ECHO, ECHO), Map.of("rounds", 16, "parallelism", 4, "startSeed", "-8"), null,
                    snapshot -> {
                        snapshots.add(snapshot);
                        if ("FINISHED".equals(snapshot.get("state"))) finished.complete(snapshot);
                    });
            Map<String, Object> result = finished.get(30, TimeUnit.SECONDS);
            assertEquals("PASS", result.get("verdict"), () -> "Parallel failure: " + result);
            assertEquals(16, result.get("completed"));
            int previous = 0;
            for (Map<String, Object> snapshot : snapshots) {
                int completed = (Integer) snapshot.get("completed");
                assertTrue(completed >= previous);
                previous = completed;
                assertThrows(UnsupportedOperationException.class, () -> snapshot.put("completed", -1));
            }
            assertEquals("FINISHED", snapshots.getLast().get("state"));
        }
    }

    @Test void testRunJudgesEveryCaseAgainstItsExpectedOutputAndCleansUp() throws Exception {
        String doubled = """
                import java.util.Scanner;
                public class Main {
                    public static void main(String[] a) {
                        String s = new Scanner(System.in).next();
                        if (s.equals("loop")) while (true) { }
                        System.out.println(Long.parseLong(s) * 2);
                    }
                }""";
        try (RunEngine engine = new RunEngine(temporary)) {
            List<RunEngine.TestCase> cases = List.of(new RunEngine.TestCase("1\n", "2\n\n"), new RunEngine.TestCase("2\n", "5"),
                    new RunEngine.TestCase("3\n", null), new RunEngine.TestCase("x\n", "0"), new RunEngine.TestCase("loop\n", "0"));
            Map<String, Object> run = engine.runTests("tests-1", "optimized", doubled, cases, 3000, 3);
            assertEquals("tests-1", run.get("id"));
            assertEquals("FAIL", run.get("verdict"));
            List<?> results = (List<?>) run.get("results");
            assertEquals(List.of("PASS", "WA", "UNCHECKED", "RE", "TLE"), results.stream().map(r -> ((Map<?, ?>) r).get("verdict")).toList());
            assertEquals(Map.of("line", 1, "expected", "5", "actual", "4"), ((Map<?, ?>) results.get(1)).get("firstDifference"));
            assertEquals("6" + System.lineSeparator(), ((Map<?, ?>) results.get(2)).get("stdout"));
            assertTrue(((String) ((Map<?, ?>) results.get(3)).get("stderr")).contains("NumberFormatException"));
            assertFalse(engine.isBusy());
            try (var left = Files.list(temporary)) { assertEquals(0, left.count()); }
            assertThrows(IllegalArgumentException.class, () -> engine.runTests(null, "generator", doubled, cases, 1000, 1));
            assertThrows(IllegalArgumentException.class, () -> engine.runTests(null, "optimized", doubled, List.of(), 1000, 1));
        }
    }

    @Test void compareRunChecksOptimizedAgainstBruteAndBruteAgainstExpected() throws Exception {
        String brute = "public class Main { public static void main(String[] a) { System.out.println(Long.parseLong(new java.util.Scanner(System.in).next()) * 2); } }";
        String optimized = """
                public class Main {
                    public static void main(String[] a) {
                        long x = Long.parseLong(new java.util.Scanner(System.in).next());
                        if (x == 5) throw new IllegalStateException("boom");
                        System.out.println(x == 3 ? 7 : x * 2);
                    }
                }""";
        try (RunEngine engine = new RunEngine(temporary)) {
            List<RunEngine.TestCase> cases = List.of(new RunEngine.TestCase("1\n", "2"), new RunEngine.TestCase("3\n", null),
                    new RunEngine.TestCase("4\n", "9"), new RunEngine.TestCase("x\n", null), new RunEngine.TestCase("5\n", null));
            Map<String, Object> run = engine.compareTests("compare-1", brute, optimized, cases, 3000, 3000, 2);
            assertEquals("compare", run.get("role"));
            assertEquals("FAIL", run.get("verdict"));
            List<?> results = (List<?>) run.get("results");
            assertEquals(List.of("PASS", "WA", "BRUTE_WA", "BRUTE_ERROR", "RE"), results.stream().map(r -> ((Map<?, ?>) r).get("verdict")).toList());
            Map<?, ?> mismatch = (Map<?, ?>) results.get(1);
            assertEquals(Map.of("line", 1, "expected", "6", "actual", "7"), mismatch.get("firstDifference"));
            assertEquals("6" + System.lineSeparator(), ((Map<?, ?>) mismatch.get("brute")).get("stdout"));
            assertEquals("7" + System.lineSeparator(), mismatch.get("stdout"));
            assertNull(mismatch.get("expectedDifference"));
            Map<?, ?> bruteWrong = (Map<?, ?>) results.get(2);
            assertEquals(Map.of("line", 1, "expected", "9", "actual", "8"), bruteWrong.get("expectedDifference"));
            assertNull(bruteWrong.get("firstDifference"));
            assertTrue(((String) ((Map<?, ?>) ((Map<?, ?>) results.get(3)).get("brute")).get("stderr")).contains("NumberFormatException"));
            assertTrue(((String) ((Map<?, ?>) results.get(4)).get("stderr")).contains("boom"));
            assertFalse(engine.isBusy());
            try (var left = Files.list(temporary)) { assertEquals(0, left.count()); }
            Map<String, Object> invalid = engine.compareTests(null, brute, "public class Main { 错误 }", List.of(new RunEngine.TestCase("1\n", null)), 1000, 1000, 1);
            assertEquals("CE", invalid.get("verdict"));
            assertEquals("optimized", ((Map<?, ?>) ((List<?>) invalid.get("compileErrors")).getFirst()).get("role"));
            assertThrows(IllegalArgumentException.class, () -> engine.compareTests(null, "", optimized, cases, 1000, 1000, 1));
        }
    }

    @Test void testRunReportsCompileErrorsExcludesDuipaiJobsAndCanBeCancelled() throws Exception {
        String sleeping = "public class Main { public static void main(String[] a) throws Exception { java.nio.file.Files.writeString(java.nio.file.Path.of(\"started\"), \"1\"); Thread.sleep(30000); } }";
        try (RunEngine engine = new RunEngine(temporary)) {
            Map<String, Object> invalid = engine.runTests(null, "brute", "public class Main { 错误 }", List.of(new RunEngine.TestCase("", "")), 1000, 1);
            assertEquals("CE", invalid.get("verdict"));
            assertEquals("brute", ((Map<?, ?>) ((List<?>) invalid.get("compileErrors")).getFirst()).get("role"));
            CompletableFuture<Map<String, Object>> running = CompletableFuture.supplyAsync(() ->
                    engine.runTests("tests-2", "optimized", sleeping, List.of(new RunEngine.TestCase("", null), new RunEngine.TestCase("", null)), 30000, 2));
            awaitFile(temporary, "started");
            assertTrue(engine.isTesting());
            assertThrows(IllegalStateException.class, () -> engine.start("blocked", codes(GENERATOR, ECHO, ECHO), Map.of(), "1", null));
            assertThrows(IllegalStateException.class, () -> engine.runTests(null, "optimized", ECHO, List.of(new RunEngine.TestCase("", null)), 1000, 1));
            assertFalse(engine.cancelTests("other"));
            assertTrue(engine.cancelTests("tests-2"));
            Map<String, Object> cancelled = running.get(15, TimeUnit.SECONDS);
            assertEquals("CANCELLED", cancelled.get("verdict"));
            // Processes killed by the stop must not be reported as runtime errors.
            assertTrue(((List<?>) cancelled.get("results")).stream().allMatch(java.util.Objects::isNull));
            assertFalse(engine.isBusy());
        }
    }

    private static Map<String, String> codes(String generator, String brute, String optimized) {
        return Map.of("generator", generator, "brute", brute, "optimized", optimized);
    }

    private static Map<String, Object> run(RunEngine engine, Map<String, String> codes, Map<String, Object> settings, String seed) throws Exception {
        CompletableFuture<Map<String, Object>> finalResult = new CompletableFuture<>();
        Map<String, Object> initial = engine.start(UUID.randomUUID().toString(), codes, settings, seed,
                result -> { if ("FINISHED".equals(result.get("state"))) finalResult.complete(result); });
        assertEquals("COMPILING", initial.get("state"));
        Map<String, Object> result = finalResult.get(30, TimeUnit.SECONDS);
        awaitIdle(engine);
        return result;
    }

    @SuppressWarnings("unchecked") private static Map<String, Object> result(Map<String, Object> snapshot, String role) {
        return (Map<String, Object>) snapshot.get(role);
    }

    private static Path awaitFile(Path root, String name) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        while (System.nanoTime() < deadline) {
            try (var files = Files.walk(root)) {
                Path found = files.filter(path -> path.getFileName().toString().equals(name)).findFirst().orElse(null);
                if (found != null && Files.size(found) > 0) return found;
            }
            Thread.sleep(30);
        }
        throw new AssertionError("program did not create " + name);
    }

    private static void awaitIdle(RunEngine engine) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (engine.isBusy() && System.nanoTime() < deadline) Thread.sleep(5);
        assertFalse(engine.isBusy());
    }
}
