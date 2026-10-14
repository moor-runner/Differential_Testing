package com.duipai.engine;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.stream.Stream;

/** Runs trusted local Java sources in fresh, bounded JVMs, one directory per role. */
public final class RunEngine implements AutoCloseable {
    public static final int STDOUT_LIMIT = 8 * 1024 * 1024;
    public static final int STDERR_LIMIT = 1024 * 1024;
    private static final List<String> ROLES = List.of("generator", "brute", "optimized");
    private final Path workRoot;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService coordinator = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "duipai-coordinator");
        t.setDaemon(true);
        return t;
    });
    private volatile Job active;
    private volatile TestRun testing;
    private volatile boolean closed;

    public RunEngine(Path workRoot) {
        this.workRoot = Objects.requireNonNull(workRoot).toAbsolutePath().normalize();
    }

    public synchronized Map<String, Object> start(String jobId, Map<String, String> codes,
                                                  Map<String, Object> settings, String replaySeed,
                                                  Consumer<Map<String, Object>> onUpdate) {
        if (closed) throw new IllegalStateException("对拍引擎已关闭");
        if (testing != null) throw new IllegalStateException("测试用例正在运行，请等待完成或停止");
        if (isBusy()) throw new IllegalStateException("已有对拍任务正在运行");
        if (jobId == null || jobId.isBlank() || jobs.containsKey(jobId)) {
            throw new IllegalArgumentException("任务编号为空或重复");
        }
        Map<String, String> source = new LinkedHashMap<>();
        for (String role : ROLES) {
            String code = codes == null ? null : codes.get(role);
            if (code == null || code.isBlank()) throw new IllegalArgumentException(role + " 代码不能为空");
            source.put(role, code);
        }
        Options options = Options.parse(settings, replaySeed);
        Job job = new Job(jobId, Collections.unmodifiableMap(source), options,
                onUpdate == null ? ignored -> { } : onUpdate,
                workRoot.resolve(UUID.randomUUID().toString()));
        // Durable history is owned by the backend; retain only the latest in-memory job.
        jobs.entrySet().removeIf(entry -> entry.getValue().finished);
        jobs.put(jobId, job);
        active = job;
        Map<String, Object> initial = job.snapshot();
        coordinator.execute(() -> execute(job));
        return initial;
    }

    public Map<String, Object> snapshot(String jobId) {
        Job job = jobs.get(jobId);
        return job == null ? null : job.snapshot();
    }

    public void cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job != null) job.requestCancel();
    }

    public boolean isBusy() {
        return active != null || testing != null;
    }

    public boolean isTesting() {
        return testing != null;
    }

    private void execute(Job job) {
        String finalVerdict = "INTERNAL_ERROR";
        String finalMessage = "引擎运行失败";
        ExecutorService workers = null;
        try {
            Files.createDirectories(job.directory);
            List<Map<String, Object>> errors = compile(job, job.codes, ROLES, () -> job.publish(false));
            if (job.cancelled.get()) {
                finalVerdict = "CANCELLED";
                finalMessage = "任务已停止";
            } else if (!errors.isEmpty()) {
                synchronized (job) { job.compileErrors = List.copyOf(errors); }
                finalVerdict = "CE";
                finalMessage = "编译失败，请检查对应编辑器中的代码";
            } else {
                synchronized (job) { job.state = "RUNNING"; }
                job.publish(true);
                workers = Executors.newFixedThreadPool(job.options.parallelism, r -> {
                    Thread thread = new Thread(r, "duipai-round");
                    thread.setDaemon(true);
                    return thread;
                });
                CountDownLatch done = new CountDownLatch(job.options.parallelism);
                AtomicInteger nextRound = new AtomicInteger();
                for (int i = 0; i < job.options.parallelism; i++) {
                    workers.execute(() -> {
                        try {
                            while (!job.stopped.get()) {
                                int index = nextRound.getAndIncrement();
                                if (index >= job.options.total) break;
                                RoundResult result = runRound(job, index);
                                if (result != null) job.record(result);
                            }
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        } catch (Exception e) {
                            job.failInternal(e);
                        } finally { done.countDown(); }
                    });
                }
                while (!done.await(100, TimeUnit.MILLISECONDS)) job.publish(false);
                synchronized (job) {
                    finalVerdict = job.cancelled.get() ? "CANCELLED" : job.verdict == null ? "PASS" : job.verdict;
                    finalMessage = job.cancelled.get() ? "任务已停止" : job.message == null ? "全部轮次通过" : job.message;
                }
            }
        } catch (InterruptedException e) {
            job.requestCancel();
            Thread.currentThread().interrupt();
            finalVerdict = "CANCELLED";
            finalMessage = "任务已停止";
        } catch (Exception e) {
            finalVerdict = "INTERNAL_ERROR";
            finalMessage = "引擎错误：" + safeMessage(e);
        } finally {
            job.stopped.set(true);
            job.killAll();
            if (workers != null) {
                workers.shutdownNow();
                awaitShutdown(workers);
            }
            job.io.shutdown();
            awaitShutdown(job.io);
            synchronized (job) {
                job.verdict = finalVerdict;
                job.message = finalMessage;
                job.state = "FINISHED";
                job.finishedAtNanos = System.nanoTime();
                job.finished = true;
            }
            job.publish(true);
            synchronized (this) { if (active == job) active = null; }
        }
    }

    /** One fixed stdin case; a null expected output is run without comparison. */
    public record TestCase(String input, String expected) { }

    /**
     * Compiles one solver and runs it on each case with the same JVM and output caps as a duipai round.
     * Blocks the caller until every case finished or {@link #cancelTests} stopped the run.
     */
    public Map<String, Object> runTests(String runId, String role, String code, List<TestCase> cases,
                                        long timeoutMs, int parallelism) {
        if (!"brute".equals(role) && !"optimized".equals(role)) throw new IllegalArgumentException("只能运行暴力解或优化解");
        if (code == null || code.isBlank()) throw new IllegalArgumentException(role + " 代码不能为空");
        if (timeoutMs < 1) throw new IllegalArgumentException("时限和并行度必须为正整数");
        return executeTests(runId, role, Map.of(role, code), cases, parallelism, (run, test, input) -> {
            ProcessResult result = runProcess(run, role, null, input, timeoutMs);
            return result == null ? null : testResult(test, result);
        });
    }

    /**
     * Runs brute and optimized on the same cases, like one duipai round per case. The top-level process fields
     * describe optimized; a given expected output is checked against brute, which is the solver being verified.
     */
    public Map<String, Object> compareTests(String runId, String bruteCode, String optimizedCode, List<TestCase> cases,
                                            long bruteTimeoutMs, long optimizedTimeoutMs, int parallelism) {
        if (bruteCode == null || bruteCode.isBlank()) throw new IllegalArgumentException("brute 代码不能为空");
        if (optimizedCode == null || optimizedCode.isBlank()) throw new IllegalArgumentException("optimized 代码不能为空");
        if (bruteTimeoutMs < 1 || optimizedTimeoutMs < 1) throw new IllegalArgumentException("时限和并行度必须为正整数");
        Map<String, String> codes = new LinkedHashMap<>();
        codes.put("brute", bruteCode);
        codes.put("optimized", optimizedCode);
        return executeTests(runId, "compare", codes, cases, parallelism, (run, test, input) -> {
            Future<ProcessResult> bruteFuture = run.io.submit(() -> runProcess(run, "brute", null, input, bruteTimeoutMs));
            ProcessResult optimized = runProcess(run, "optimized", null, input, optimizedTimeoutMs);
            ProcessResult brute = bruteFuture.get();
            return brute == null || optimized == null ? null : compareResult(test, brute, optimized);
        });
    }

    /** Returns null when the run was stopped while the case was running. */
    @FunctionalInterface private interface CaseRunner { Map<String, Object> run(TestRun run, TestCase test, byte[] input) throws Exception; }

    private Map<String, Object> executeTests(String runId, String role, Map<String, String> codes, List<TestCase> cases,
                                             int parallelism, CaseRunner runner) {
        if (cases == null || cases.isEmpty()) throw new IllegalArgumentException("没有可运行的测试用例");
        if (parallelism < 1) throw new IllegalArgumentException("时限和并行度必须为正整数");
        TestRun run;
        synchronized (this) {
            if (closed) throw new IllegalStateException("对拍引擎已关闭");
            if (active != null) throw new IllegalStateException("对拍任务运行中，请先停止对拍");
            if (testing != null) throw new IllegalStateException("测试用例正在运行，请等待完成或停止");
            run = new TestRun(runId == null || runId.isBlank() ? UUID.randomUUID().toString() : runId,
                    workRoot.resolve(UUID.randomUUID().toString()));
            testing = run;
        }
        long started = System.nanoTime();
        List<Map<String, Object>> compileErrors = List.of();
        @SuppressWarnings("unchecked") Map<String, Object>[] results = new Map[cases.size()];
        String verdict, message;
        ExecutorService workers = null;
        try {
            Files.createDirectories(run.directory);
            compileErrors = compile(run, codes, List.copyOf(codes.keySet()), () -> { });
            if (run.cancelled.get()) {
                verdict = "CANCELLED";
                message = "已停止运行";
            } else if (!compileErrors.isEmpty()) {
                verdict = "CE";
                message = "编译失败，请检查对应编辑器中的代码";
            } else {
                int threads = Math.min(parallelism, cases.size());
                workers = Executors.newFixedThreadPool(threads, r -> {
                    Thread thread = new Thread(r, "duipai-test");
                    thread.setDaemon(true);
                    return thread;
                });
                AtomicInteger next = new AtomicInteger();
                List<Future<?>> tasks = new ArrayList<>();
                for (int i = 0; i < threads; i++) {
                    tasks.add(workers.submit(() -> {
                        while (!run.stopped.get()) {
                            int index = next.getAndIncrement();
                            if (index >= cases.size()) break;
                            TestCase test = cases.get(index);
                            byte[] input = test.input() == null ? new byte[0] : test.input().getBytes(StandardCharsets.UTF_8);
                            Map<String, Object> result = runner.run(run, test, input);
                            // A process killed by cancellation has no verdict of its own.
                            if (result == null || run.stopped.get()) break;
                            results[index] = result;
                        }
                        return null;
                    }));
                }
                for (Future<?> task : tasks) task.get();
                if (run.cancelled.get()) {
                    verdict = "CANCELLED";
                    message = "已停止运行";
                } else {
                    long failed = Arrays.stream(results).filter(r -> !List.of("PASS", "UNCHECKED").contains(r.get("verdict"))).count();
                    long unchecked = Arrays.stream(results).filter(r -> "UNCHECKED".equals(r.get("verdict"))).count();
                    verdict = failed > 0 ? "FAIL" : unchecked > 0 ? "UNCHECKED" : "PASS";
                    message = failed > 0 ? failed + " 个用例未通过" : unchecked > 0 ? unchecked + " 个用例没有期望输出，未比对" : "全部用例通过";
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            verdict = "CANCELLED";
            message = "已停止运行";
        } catch (ExecutionException e) {
            verdict = "INTERNAL_ERROR";
            message = "引擎错误：" + safeMessage(e.getCause() instanceof Exception cause ? cause : e);
        } catch (Exception e) {
            verdict = "INTERNAL_ERROR";
            message = "引擎错误：" + safeMessage(e);
        } finally {
            run.stopped.set(true);
            run.killAll();
            if (workers != null) {
                workers.shutdownNow();
                awaitShutdown(workers);
            }
            run.io.shutdown();
            awaitShutdown(run.io);
            deleteQuietly(run.directory);
            synchronized (this) { if (testing == run) testing = null; }
        }
        return immutableMap("id", run.id, "role", role, "verdict", verdict, "message", message,
                "elapsedMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started),
                "compileErrors", compileErrors, "results", Collections.unmodifiableList(Arrays.asList(results)));
    }

    /** Returns false when the run already finished or another run is active. */
    public boolean cancelTests(String runId) {
        TestRun run = testing;
        if (run == null || !run.id.equals(runId)) return false;
        run.requestCancel();
        return true;
    }

    private static Map<String, Object> testResult(TestCase test, ProcessResult result) {
        String verdict = result.outputLimited ? "OLE" : result.timedOut ? "TLE" : result.exitCode != 0 ? "RE"
                : test.expected() == null ? "UNCHECKED" : null;
        Map<String, Object> difference = null;
        if (verdict == null) {
            difference = firstDifference(test.expected(), result.stdout);
            verdict = difference == null ? "PASS" : "WA";
        }
        Map<String, Object> map = new LinkedHashMap<>(result.asMap());
        map.put("verdict", verdict);
        map.put("firstDifference", difference);
        return Collections.unmodifiableMap(map);
    }

    /** A brute failure or a mismatch with the expected output outranks the optimized verdict. */
    private static Map<String, Object> compareResult(TestCase test, ProcessResult brute, ProcessResult optimized) {
        Map<String, Object> expectedDifference = null, difference = null;
        String verdict = null;
        if (brute.failure() != null) verdict = "BRUTE_ERROR";
        else if (test.expected() != null && (expectedDifference = firstDifference(test.expected(), brute.stdout)) != null) verdict = "BRUTE_WA";
        if (brute.failure() == null && optimized.failure() == null) difference = firstDifference(brute.stdout, optimized.stdout);
        if (verdict == null) verdict = optimized.outputLimited ? "OLE" : optimized.timedOut ? "TLE" : optimized.exitCode != 0 ? "RE"
                : difference == null ? "PASS" : "WA";
        Map<String, Object> map = new LinkedHashMap<>(optimized.asMap());
        map.put("verdict", verdict);
        map.put("firstDifference", difference);
        map.put("expectedDifference", expectedDifference);
        map.put("brute", brute.asMap());
        return Collections.unmodifiableMap(map);
    }

    static void deleteQuietly(Path directory) {
        if (!Files.exists(directory)) return;
        try (Stream<Path> paths = Files.walk(directory)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { /* Windows may still hold a just-exited JVM's files. */ }
            });
        } catch (IOException ignored) { }
    }

    private List<Map<String, Object>> compile(Execution execution, Map<String, String> codes, List<String> roles,
                                              Runnable progress) throws IOException {
        List<Map<String, Object>> errors = new ArrayList<>();
        for (String role : roles) {
            if (execution.cancelled.get()) break;
            Map<String, Object> error = compileRole(execution.directory.resolve(role), role, codes.get(role), List.of());
            if (error != null) errors.add(error);
            progress.run();
        }
        return errors;
    }

    /** Writes one role's Main.java into its own directory and compiles it there; returns its compile error, or null. */
    static Map<String, Object> compileRole(Path directory, String role, String code, List<String> extraOptions) throws IOException {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("需要完整的 JDK 21，当前运行时没有 javac");
        Files.createDirectories(directory);
        Path source = directory.resolve("Main.java");
        Files.writeString(source, code, StandardCharsets.UTF_8);
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        StringWriter output = new StringWriter();
        List<String> options = new ArrayList<>(List.of("-encoding", "UTF-8", "-d", directory.toString(), "-classpath", directory.toString(),
                "-proc:none", "-source", "21", "-target", "21", "-Xmaxerrs", "100", "-Xmaxwarns", "100"));
        options.addAll(extraOptions);
        try (StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            Iterable<? extends JavaFileObject> files = fileManager.getJavaFileObjects(source.toFile());
            if (Boolean.TRUE.equals(compiler.getTask(output, fileManager, diagnostics, options, null, files).call())) return null;
            List<Map<String, Object>> detail = new ArrayList<>();
            StringBuilder formatted = new StringBuilder(output.toString());
            for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
                if (diagnostic.getKind() != Diagnostic.Kind.ERROR) continue;
                String message = diagnostic.getMessage(null);
                detail.add(immutableMap("line", diagnostic.getLineNumber(), "column", diagnostic.getColumnNumber(), "message", message));
                formatted.append("Main.java:").append(diagnostic.getLineNumber()).append(':')
                        .append(diagnostic.getColumnNumber()).append(": ").append(message).append('\n');
            }
            return immutableMap("role", role, "output", formatted.toString(), "diagnostics", List.copyOf(detail));
        }
    }

    /**
     * A fresh user JVM for the class compiled into {@code directory}, with the engine's heap cap and UTF-8 streams.
     * Ambient JVM options must not remove caps, change encoding or inject agents into user processes.
     */
    static ProcessBuilder userProcess(Path directory, List<String> extraJvmOptions, String argument) {
        Path executable = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java");
        List<String> command = new ArrayList<>(List.of(executable.toString(), "-Xms16m", "-Xmx128m",
                "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Dfile.encoding=UTF-8",
                "-Dsun.stdout.encoding=UTF-8", "-Dsun.stderr.encoding=UTF-8"));
        command.addAll(extraJvmOptions);
        command.addAll(List.of("-cp", directory.toString(), "Main"));
        if (argument != null) command.add(argument);
        ProcessBuilder builder = new ProcessBuilder(command).directory(directory.toFile());
        builder.environment().remove("JAVA_TOOL_OPTIONS");
        builder.environment().remove("JDK_JAVA_OPTIONS");
        builder.environment().remove("_JAVA_OPTIONS");
        builder.environment().remove("DUIPAI_TOKEN");
        return builder;
    }

    private RoundResult runRound(Job job, int index) throws Exception {
        long seed = Math.addExact(job.options.seed, index);
        ProcessResult generator = runProcess(job, "generator", Long.toString(seed), null, job.options.generatorTimeoutMs);
        if (generator == null || job.stopped.get()) return null;
        String generatorFailure = generator.failure();
        if (generatorFailure != null) {
            return new RoundResult(index + 1, seed, generator.stdout, generator, null, null,
                    "GENERATOR_ERROR", "生成器 " + generatorFailure + "；请检查数据生成程序", null);
        }
        byte[] input = generator.stdout.getBytes(StandardCharsets.UTF_8);
        // Solvers have independent JVMs and pipes, so they can safely run concurrently.
        Future<ProcessResult> bruteFuture = job.io.submit(() -> runProcess(job, "brute", null, input, job.options.bruteTimeoutMs));
        Future<ProcessResult> optimizedFuture = job.io.submit(() -> runProcess(job, "optimized", null, input, job.options.optimizedTimeoutMs));
        ProcessResult brute = bruteFuture.get();
        ProcessResult optimized = optimizedFuture.get();
        if (brute == null || optimized == null || job.stopped.get()) return null;
        if (brute.failure() != null) {
            return new RoundResult(index + 1, seed, generator.stdout, generator, brute, optimized,
                    "BRUTE_ERROR", "暴力解 " + brute.failure() + "；裁判或数据有问题", null);
        }
        String verdict = optimized.outputLimited ? "OLE" : optimized.timedOut ? "TLE" : optimized.exitCode != 0 ? "RE" : "PASS";
        Map<String, Object> difference = null;
        if ("PASS".equals(verdict)) {
            difference = firstDifference(brute.stdout, optimized.stdout);
            if (difference != null) verdict = "WA";
        }
        String message = switch (verdict) {
            case "WA" -> "输出不一致，已保存首个发现的反例";
            case "TLE" -> "优化解超时";
            case "OLE" -> "优化解输出超过限制";
            case "RE" -> "优化解异常退出";
            default -> "本轮通过";
        };
        return new RoundResult(index + 1, seed, generator.stdout, generator, brute, optimized, verdict, message, difference);
    }

    private ProcessResult runProcess(Execution job, String role, String seed, byte[] input, long timeoutMs) throws Exception {
        long started = System.nanoTime();
        Process process;
        RunningProcess running;
        synchronized (job.processLock) {
            if (job.stopped.get()) return null;
            ProcessBuilder builder = userProcess(job.directory.resolve(role), List.of(), seed);
            // Load JNA and create the job before spawning, then attach during JVM startup.
            WindowsProcessJob windowsJob = isWindows() ? WindowsProcessJob.create() : null;
            try {
                process = builder.start();
                if (windowsJob != null) {
                    try { windowsJob.assign(process); }
                    catch (RuntimeException e) {
                        process.destroyForcibly();
                        process.waitFor(3, TimeUnit.SECONDS);
                        throw e;
                    }
                }
            } catch (Exception e) {
                if (windowsJob != null) windowsJob.close();
                throw e;
            }
            running = new RunningProcess(process, windowsJob);
            job.processes.add(running);
        }
        AtomicBoolean limited = new AtomicBoolean();
        Capture stdout = new Capture(STDOUT_LIMIT);
        Capture stderr = new Capture(STDERR_LIMIT);
        Future<?> outRead = job.io.submit(() -> capture(process.getInputStream(), stdout, limited, running));
        Future<?> errRead = job.io.submit(() -> capture(process.getErrorStream(), stderr, limited, running));
        Future<?> inputWrite = job.io.submit(() -> {
            try (OutputStream sink = process.getOutputStream()) {
                if (input != null) sink.write(input);
            } catch (IOException ignored) { /* A program may exit without consuming its whole input. */ }
        });
        boolean timedOut = false;
        int exitCode = -1;
        long nextDescendantScan = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(100);
        try {
            while (true) {
                if (!process.isAlive()) break;
                if (job.stopped.get() || limited.get()) {
                    running.terminate();
                    break;
                }
                long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
                if (elapsed >= timeoutMs) {
                    timedOut = true;
                    running.terminate();
                    break;
                }
                long now = System.nanoTime();
                if (now >= nextDescendantScan) {
                    running.observeDescendants();
                    nextDescendantScan = now + TimeUnit.MILLISECONDS.toNanos(100);
                }
                if (process.waitFor(Math.min(20, Math.max(1, timeoutMs - elapsed)), TimeUnit.MILLISECONDS)) break;
            }
            if (process.isAlive()) running.terminate();
            // Read the root's exit status before terminating the Windows job.
            // Job cleanup can otherwise replace a just-finished process status
            // with its forced-termination status, despite normal output.
            exitCode = process.exitValue();
            running.observeDescendants();
            running.terminateDescendants();
            inputWrite.get(3, TimeUnit.SECONDS);
            outRead.get(3, TimeUnit.SECONDS);
            errRead.get(3, TimeUnit.SECONDS);
            return new ProcessResult(stdout.value(), stderr.value(),
                    TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), exitCode, timedOut, limited.get());
        } finally {
            running.terminate();
            closeQuietly(process.getOutputStream());
            closeQuietly(process.getInputStream());
            closeQuietly(process.getErrorStream());
            inputWrite.cancel(true);
            outRead.cancel(true);
            errRead.cancel(true);
            job.processes.remove(running);
        }
    }

    private static void capture(InputStream stream, Capture capture, AtomicBoolean limited, RunningProcess running) {
        try (stream) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (!capture.add(buffer, count)) {
                    limited.set(true);
                    running.terminate();
                    break;
                }
            }
        } catch (IOException ignored) { /* Forced process termination closes its pipes. */ }
    }

    static Map<String, Object> firstDifference(String expected, String actual) {
        List<String> left = normalizedLines(expected);
        List<String> right = normalizedLines(actual);
        for (int index = 0; index < Math.max(left.size(), right.size()); index++) {
            String a = index < left.size() ? left.get(index) : null;
            String b = index < right.size() ? right.get(index) : null;
            if (!Objects.equals(a, b)) return immutableMap("line", index + 1, "expected", a, "actual", b);
        }
        return null;
    }

    private static List<String> normalizedLines(String output) {
        String[] lines = output.replace("\r\n", "\n").split("\n", -1);
        List<String> result = new ArrayList<>(lines.length);
        for (String line : lines) {
            int end = line.length();
            while (end > 0 && Character.isWhitespace(line.charAt(end - 1))) end--;
            result.add(line.substring(0, end));
        }
        while (!result.isEmpty() && result.getLast().isEmpty()) result.removeLast();
        return result;
    }

    static Map<String, Object> immutableMap(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
        return Collections.unmodifiableMap(map);
    }

    static boolean isWindows() { return System.getProperty("os.name").toLowerCase().contains("win"); }
    private static String safeMessage(Exception error) { return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
    private static void closeQuietly(AutoCloseable resource) { try { resource.close(); } catch (Exception ignored) { } }

    private static void awaitShutdown(ExecutorService executor) {
        boolean interrupted = false;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!executor.isTerminated() && System.nanoTime() < deadline) {
            try { executor.awaitTermination(100, TimeUnit.MILLISECONDS); }
            catch (InterruptedException e) { interrupted = true; executor.shutdownNow(); }
        }
        if (!executor.isTerminated()) executor.shutdownNow();
        if (interrupted) Thread.currentThread().interrupt();
    }

    @Override public void close() {
        synchronized (this) {
            if (closed) return;
            closed = true;
            Job job = active;
            if (job != null) job.requestCancel();
            TestRun run = testing;
            if (run != null) run.requestCancel();
            coordinator.shutdown();
        }
        awaitShutdown(coordinator);
        Job job = active;
        if (job != null) job.killAll();
    }

    private static final class Capture {
        final int limit;
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream(8192);
        Capture(int limit) { this.limit = limit; }
        synchronized boolean add(byte[] buffer, int count) {
            int available = limit - bytes.size();
            bytes.write(buffer, 0, Math.min(available, count));
            return count <= available;
        }
        synchronized String value() { return bytes.toString(StandardCharsets.UTF_8); }
    }

    private static final class RunningProcess {
        final Process process;
        final WindowsProcessJob windowsJob;
        final Set<ProcessHandle> descendants = ConcurrentHashMap.newKeySet();
        RunningProcess(Process process, WindowsProcessJob windowsJob) { this.process = process; this.windowsJob = windowsJob; }
        void observeDescendants() {
            // Windows enumerates the system process table here; never scan after the root has exited.
            if (windowsJob == null && process.isAlive()) process.descendants().forEach(descendants::add);
        }
        void terminateDescendants() {
            if (windowsJob != null) { windowsJob.close(); return; }
            observeDescendants();
            descendants.forEach(handle -> { if (handle.isAlive()) handle.destroyForcibly(); });
        }
        synchronized void terminate() {
            terminateDescendants();
            if (process.isAlive()) process.destroyForcibly();
            boolean interrupted = false;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (process.isAlive() && System.nanoTime() < deadline) {
                try { process.waitFor(50, TimeUnit.MILLISECONDS); }
                catch (InterruptedException e) { interrupted = true; }
            }
            for (ProcessHandle descendant : descendants) {
                if (descendant.isAlive()) {
                    descendant.destroyForcibly();
                    try { descendant.onExit().get(500, TimeUnit.MILLISECONDS); }
                    catch (InterruptedException e) { interrupted = true; }
                    catch (Exception ignored) { }
                }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private record ProcessResult(String stdout, String stderr, long elapsedMs, int exitCode, boolean timedOut, boolean outputLimited) {
        Map<String, Object> asMap() {
            return immutableMap("stdout", stdout, "stderr", stderr, "elapsedMs", elapsedMs, "exitCode", exitCode,
                    "timedOut", timedOut, "outputLimited", outputLimited);
        }
        String failure() {
            return outputLimited ? "输出超过限制" : timedOut ? "超时" : exitCode != 0 ? "异常退出（退出码 " + exitCode + "）" : null;
        }
    }

    private record RoundResult(int round, long seed, String input, ProcessResult generator, ProcessResult brute,
                               ProcessResult optimized, String verdict, String message, Map<String, Object> difference) { }

    private static final class Options {
        final int total, parallelism;
        final long seed, generatorTimeoutMs, bruteTimeoutMs, optimizedTimeoutMs;
        final boolean replay;
        final Map<String, Object> saved;
        Options(int total, int parallelism, long seed, long generatorTimeoutMs, long bruteTimeoutMs,
                long optimizedTimeoutMs, boolean replay, Map<String, Object> saved) {
            this.total = total;
            this.parallelism = Math.min(parallelism, total);
            this.seed = seed;
            this.generatorTimeoutMs = generatorTimeoutMs;
            this.bruteTimeoutMs = bruteTimeoutMs;
            this.optimizedTimeoutMs = optimizedTimeoutMs;
            this.replay = replay;
            this.saved = saved;
        }
        static Options parse(Map<String, Object> settings, String replaySeed) {
            Map<String, Object> input = settings == null ? Map.of() : settings;
            int rounds = (int) integer(input, "rounds", 1000, 1, 1_000_000);
            int parallelism = (int) integer(input, "parallelism", 4, 1, 32);
            long generator = integer(input, "generatorTimeoutMs", 5000, 1, 3_600_000);
            long brute = integer(input, "bruteTimeoutMs", 10000, 1, 3_600_000);
            long optimized = integer(input, "optimizedTimeoutMs", 2000, 1, 3_600_000);
            Object rawSeed = input.get("startSeed");
            if (rawSeed != null && !(rawSeed instanceof String)) throw new IllegalArgumentException("startSeed 必须为字符串，避免整数精度损失");
            String configured = rawSeed == null || ((String) rawSeed).isBlank() ? null : ((String) rawSeed).trim();
            if (configured != null) parseSeed(configured);
            boolean replay = replaySeed != null;
            if (replay && replaySeed.isBlank()) throw new IllegalArgumentException("复现种子不能为空");
            int total = replay ? 1 : rounds;
            long seed;
            if (replay) seed = parseSeed(replaySeed.trim());
            else if (configured != null) seed = parseSeed(configured);
            else {
                do { seed = ThreadLocalRandom.current().nextLong(); }
                while (seed > Long.MAX_VALUE - (total - 1L));
            }
            try { Math.addExact(seed, total - 1L); }
            catch (ArithmeticException e) { throw new IllegalArgumentException("起始种子加轮数超出有符号 64 位整数范围"); }
            Map<String, Object> saved = immutableMap("rounds", rounds, "startSeed", configured, "parallelism", parallelism,
                    "generatorTimeoutMs", generator, "bruteTimeoutMs", brute, "optimizedTimeoutMs", optimized);
            return new Options(total, parallelism, seed, generator, brute, optimized, replay, saved);
        }
        static long integer(Map<String, Object> settings, String name, long fallback, long min, long max) {
            Object value = settings.get(name);
            if (value == null) return fallback;
            long number;
            try { number = Long.parseLong(value.toString()); }
            catch (NumberFormatException e) { throw new IllegalArgumentException(name + " 必须为整数"); }
            if (number < min || number > max) throw new IllegalArgumentException(name + " 必须介于 " + min + " 和 " + max + " 之间");
            return number;
        }
        static long parseSeed(String seed) {
            try { return Long.parseLong(seed); }
            catch (NumberFormatException e) { throw new IllegalArgumentException("种子必须是有符号 64 位十进制整数"); }
        }
    }

    /** Working directory, child processes and pipe readers owned by one duipai job or test run. */
    private static class Execution {
        final Path directory;
        final AtomicBoolean stopped = new AtomicBoolean();
        final AtomicBoolean cancelled = new AtomicBoolean();
        final Object processLock = new Object();
        final Set<RunningProcess> processes = ConcurrentHashMap.newKeySet();
        final ExecutorService io = Executors.newVirtualThreadPerTaskExecutor();
        Execution(Path directory) { this.directory = directory; }
        void killAll() {
            synchronized (processLock) { processes.forEach(RunningProcess::terminate); }
        }
    }

    private static final class TestRun extends Execution {
        final String id;
        TestRun(String id, Path directory) { super(directory); this.id = id; }
        void requestCancel() {
            cancelled.set(true);
            stopped.set(true);
            killAll();
        }
    }

    private static final class Job extends Execution {
        final String id;
        final Map<String, String> codes;
        final Options options;
        final Consumer<Map<String, Object>> onUpdate;
        final String startedAt = Instant.now().toString();
        final long startedNanos = System.nanoTime();
        final Object publishLock = new Object();
        volatile boolean finished;
        String state = "COMPILING", verdict, message;
        int completed;
        long maxOptimizedMs, finishedAtNanos, lastPublishNanos;
        RoundResult last;
        List<Map<String, Object>> compileErrors = List.of();
        Job(String id, Map<String, String> codes, Options options, Consumer<Map<String, Object>> onUpdate, Path directory) {
            super(directory);
            this.id = id;
            this.codes = codes;
            this.options = options;
            this.onUpdate = onUpdate;
        }
        synchronized Map<String, Object> snapshot() {
            long elapsed = Math.max(0, TimeUnit.NANOSECONDS.toMillis((finished ? finishedAtNanos : System.nanoTime()) - startedNanos));
            return immutableMap("id", id, "state", state, "verdict", verdict, "message", message,
                    "startedAt", startedAt, "completed", completed, "total", options.total, "elapsedMs", elapsed,
                    "roundsPerSecond", elapsed == 0 ? 0.0 : completed * 1000.0 / elapsed,
                    "maxOptimizedMs", maxOptimizedMs, "seed", Long.toString(last == null ? options.seed : last.seed),
                    "round", last == null ? 0 : last.round, "input", last == null ? null : last.input,
                    "generator", last == null || last.generator == null ? null : last.generator.asMap(),
                    "brute", last == null || last.brute == null ? null : last.brute.asMap(),
                    "optimized", last == null || last.optimized == null ? null : last.optimized.asMap(),
                    "firstDifference", last == null ? null : last.difference, "compileErrors", compileErrors,
                    "codes", codes, "settings", options.saved);
        }
        void publish(boolean force) {
            synchronized (publishLock) {
                Map<String, Object> snapshot;
                synchronized (this) {
                    long now = System.nanoTime();
                    if (!force && now - lastPublishNanos < TimeUnit.MILLISECONDS.toNanos(300)) return;
                    lastPublishNanos = now;
                    snapshot = snapshot();
                }
                try { onUpdate.accept(snapshot); }
                catch (RuntimeException ignored) { /* A disconnected subscriber must not abort execution. */ }
            }
        }
        void record(RoundResult result) {
            boolean failure;
            synchronized (this) {
                if (stopped.get()) return;
                completed++;
                if (result.optimized != null) maxOptimizedMs = Math.max(maxOptimizedMs, result.optimized.elapsedMs);
                failure = !"PASS".equals(result.verdict);
                last = result;
                if (failure) {
                    verdict = result.verdict;
                    message = result.message;
                    stopped.set(true);
                }
            }
            if (failure) killAll();
            publish(failure);
        }
        void failInternal(Exception error) {
            synchronized (this) {
                if (stopped.get()) return;
                verdict = "INTERNAL_ERROR";
                message = "引擎错误：" + safeMessage(error);
                stopped.set(true);
            }
            killAll();
        }
        void requestCancel() {
            synchronized (this) {
                if (finished || stopped.get()) return;
                cancelled.set(true);
                stopped.set(true);
                message = "正在停止任务并清理子进程";
            }
            killAll();
        }
    }
}
