package com.duipai.engine;

import com.sun.jdi.*;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.ListeningConnector;
import com.sun.jdi.connect.TransportTimeoutException;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;

/**
 * One interactive debugging run of a solver on a fixed stdin, driven through JDI. The solver is compiled with full
 * debug information and started in a fresh JVM whose JDWP agent connects back to a loopback listener of this
 * backend, so its stdout carries only program output. Unlike a test run there is no time limit (the program may sit
 * at a breakpoint), but the same heap and output caps apply. All JDI state is guarded by this object's monitor; the
 * session thread blocks on the VM's event queue outside it.
 */
public final class DebugSession {
    public enum State { STARTING, RUNNING, PAUSED, TERMINATED }
    public enum Step { OVER, INTO, OUT }

    /** Notified after every state change and when the console grows. Called with the session locked: it must not block. */
    public interface Listener {
        void changed(DebugSession session);
        void output(DebugSession session);
    }

    /** What to debug: one solver's source, its stdin, the expected output to compare with (null skips it) and initial breakpoints. */
    public record Request(String role, String label, String code, String input, String expected, Collection<Integer> breakpoints) { }

    static final int CONSOLE_LIMIT = 1024 * 1024;
    private static final int FRAME_HEAD = 200, FRAME_TAIL = 20, AUTO_STEP_LIMIT = 200, RESULT_STDOUT_LIMIT = 1024 * 1024;
    private static final long SETTLE_MILLIS = 300, CONNECT_TIMEOUT_NANOS = TimeUnit.SECONDS.toNanos(30);
    /** IDEA's default "do not step into" packages; stepping passes through them into the user's callbacks. */
    private static final List<String> LIBRARY_PACKAGES = List.of("java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*");

    private final String id;
    private final Request request;
    private final Path directory;
    private final Listener listener;
    private final Thread worker;
    private final String startedAt = Instant.now().toString();
    private final Console console = new Console(CONSOLE_LIMIT);
    private final Output stdout = new Output(RunEngine.STDOUT_LIMIT), stderr = new Output(RunEngine.STDERR_LIMIT);
    private final AtomicBoolean outputLimited = new AtomicBoolean();
    private final List<Thread> pipes = new ArrayList<>();

    // Guarded by this.
    private State state = State.STARTING;
    private String message = "正在编译…";
    private long version;
    private int generation;
    private Map<String, Object> pause;
    private ThreadReference pausedThread;
    private DebugValues values;
    private Map<String, Object> result;
    private List<Map<String, Object>> compileErrors = List.of();
    private final TreeMap<Integer, List<BreakpointRequest>> breakpoints = new TreeMap<>();
    private final List<BreakpointRequest> temporary = new ArrayList<>();
    private final List<ReferenceType> userTypes = new ArrayList<>();
    private final Set<String> compiledClasses = new HashSet<>();
    private final Map<Method, int[]> methodLines = new HashMap<>();
    private VirtualMachine vm;
    private Process process;
    private WindowsProcessJob windowsJob;
    private boolean stopRequested;
    private int stepDepth = StepRequest.STEP_OVER, autoSteps;

    DebugSession(String id, Path directory, Request request, Listener listener) {
        this.id = id;
        this.directory = directory;
        this.request = request;
        this.listener = listener;
        for (Integer line : request.breakpoints()) if (line != null && line > 0) breakpoints.put(line, new ArrayList<>());
        worker = Thread.ofPlatform().daemon(true).name("duipai-debug").unstarted(this::run);
    }

    void start() { worker.start(); }
    public String id() { return id; }
    public String role() { return request.role(); }
    public synchronized boolean isTerminated() { return state == State.TERMINATED; }
    boolean awaitTermination(long millis) throws InterruptedException { worker.join(millis); return !worker.isAlive(); }

    // ---- lifecycle ----

    private void run() {
        String verdict = null, text = null;
        try {
            Map<String, Object> error = RunEngine.compileRole(directory, request.role(), request.code(), List.of("-g"));
            if (error != null) {
                synchronized (this) { compileErrors = List.of(error); }
                verdict = "CE";
                text = "编译失败，请检查代码";
            } else if (!stopRequested()) {
                try (Stream<Path> files = Files.list(directory)) {
                    List<String> names = files.map(path -> path.getFileName().toString()).filter(name -> name.endsWith(".class"))
                            .map(name -> name.substring(0, name.length() - ".class".length())).toList();
                    synchronized (this) { compiledClasses.addAll(names); }
                }
                update("正在启动调试 JVM…");
                if (launch()) loop();
            }
        } catch (VMDisconnectedException disconnected) {
            // The program ended or was stopped; finish() reads how.
        } catch (Exception exception) {
            verdict = "ERROR";
            text = "调试器错误：" + describe(exception);
        } finally {
            finish(verdict, text);
        }
    }

    /** Starts the debuggee and waits for its agent to connect; false when stopped first. */
    private boolean launch() throws Exception {
        ListeningConnector connector = Bootstrap.virtualMachineManager().listeningConnectors().stream()
                .filter(candidate -> "dt_socket".equals(candidate.transport().name())).findFirst()
                .orElseThrow(() -> new IllegalStateException("当前 JDK 缺少 JDWP 套接字调试支持"));
        Map<String, Connector.Argument> arguments = connector.defaultArguments();
        arguments.get("port").setValue("0");
        if (arguments.containsKey("localAddress")) arguments.get("localAddress").setValue("127.0.0.1");
        arguments.get("timeout").setValue("250");
        String address = connector.startListening(arguments);
        try {
            String port = address.substring(address.lastIndexOf(':') + 1);
            // server=n: the agent connects out to this listener, so the program prints no "Listening for transport" banner.
            ProcessBuilder builder = RunEngine.userProcess(directory,
                    List.of("-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=127.0.0.1:" + port), null);
            Process started;
            synchronized (this) {
                if (stopRequested) return false;
                WindowsProcessJob job = RunEngine.isWindows() ? WindowsProcessJob.create() : null;
                try { started = builder.start(); }
                catch (IOException exception) { if (job != null) job.close(); throw exception; }
                if (job != null) {
                    try { job.assign(started); }
                    catch (RuntimeException exception) { started.destroyForcibly(); job.close(); throw exception; }
                }
                process = started;
                windowsJob = job;
            }
            startPipes(started);
            long deadline = System.nanoTime() + CONNECT_TIMEOUT_NANOS;
            while (true) {
                try {
                    VirtualMachine connected = connector.accept(arguments);
                    synchronized (this) {
                        vm = connected;
                        if (stopRequested) { exitQuietly(connected); return false; }
                    }
                    return true;
                } catch (TransportTimeoutException timeout) {
                    if (stopRequested()) return false;
                    if (!started.isAlive()) throw new IllegalStateException("调试 JVM 未能启动（退出码 " + started.exitValue() + "）。" + stderr.text().strip());
                    if (System.nanoTime() > deadline) throw new IllegalStateException("调试 JVM 连接超时");
                }
            }
        } finally {
            try { connector.stopListening(arguments); } catch (Exception ignored) { /* already closed */ }
        }
    }

    private void loop() throws InterruptedException {
        VirtualMachine machine;
        synchronized (this) {
            machine = vm;
            EventRequestManager requests = machine.eventRequestManager();
            // Every class compiled from Main.java, nested or not, receives the breakpoints of its lines when it loads.
            ClassPrepareRequest prepare = requests.createClassPrepareRequest();
            if (machine.canUseSourceNameFilters()) prepare.addSourceNameFilter("Main.java");
            prepare.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            prepare.enable();
            ExceptionRequest exceptions = requests.createExceptionRequest(null, false, true);
            exceptions.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            exceptions.enable();
            state = State.RUNNING;
            message = "运行中…";
            changed();
        }
        EventQueue queue = machine.eventQueue();
        while (true) {
            EventSet events = queue.remove();
            synchronized (this) { if (handle(events)) return; }
        }
    }

    /** Handles one event set; true once the VM is gone. */
    private boolean handle(EventSet events) {
        LocatableEvent stop = null;
        String reason = null;
        ObjectReference exception = null;
        for (Event event : events) {
            switch (event) {
                case VMDeathEvent ignored -> { return true; }
                case VMDisconnectEvent ignored -> { return true; }
                case ClassPrepareEvent prepared -> prepared(prepared.referenceType());
                case ExceptionEvent thrown -> {
                    if (reachesUserCode(thrown.thread())) { stop = thrown; reason = "exception"; exception = thrown.exception(); }
                }
                case BreakpointEvent hit -> {
                    boolean own = breakpoints.values().stream().anyMatch(list -> list.contains(hit.request()));
                    if (!"exception".equals(reason) && !"breakpoint".equals(reason)) { stop = hit; reason = own ? "breakpoint" : "cursor"; }
                }
                case StepEvent stepped -> { if (reason == null) { stop = stepped; reason = "step"; } }
                default -> { }
            }
        }
        if (stop == null || stopRequested) { events.resume(); return false; }
        // A step that lands outside the user's code, such as in a lambda's proxy class, keeps going the same way.
        if ("step".equals(reason) && !isUser(stop.location()) && autoSteps++ < AUTO_STEP_LIMIT) {
            step(stop.thread(), stepDepth);
            events.resume();
            return false;
        }
        autoSteps = 0;
        clearSteps();
        clearTemporary();
        paused(stop.thread(), reason, exception);
        return false;
    }

    private void prepared(ReferenceType type) {
        if (!compiledClasses.contains(type.name())) return;
        userTypes.add(type);
        boolean added = false;
        for (Map.Entry<Integer, List<BreakpointRequest>> entry : breakpoints.entrySet()) {
            for (Location location : lineStarts(type, entry.getKey())) { entry.getValue().add(breakpoint(location)); added = true; }
        }
        if (added) changed();
    }

    private void paused(ThreadReference thread, String reason, ObjectReference exception) {
        state = State.PAUSED;
        pausedThread = thread;
        generation++;
        values = new DebugValues(vm, type -> compiledClasses.contains(type.name()));
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", reason);
        details.put("thread", thread.name());
        int line = -1;
        try {
            int count = thread.frameCount();
            List<Map<String, Object>> frames = new ArrayList<>();
            List<StackFrame> head = thread.frames(0, count <= FRAME_HEAD + FRAME_TAIL ? count : FRAME_HEAD);
            for (int i = 0; i < head.size(); i++) frames.add(frame(i, head.get(i)));
            if (count > FRAME_HEAD + FRAME_TAIL) {
                List<StackFrame> tail = thread.frames(count - FRAME_TAIL, FRAME_TAIL);
                for (int i = 0; i < tail.size(); i++) frames.add(frame(count - FRAME_TAIL + i, tail.get(i)));
            }
            int selected = 0;
            for (int i = 0; i < head.size(); i++) if (isUser(head.get(i).location())) { selected = i; break; }
            line = head.isEmpty() ? -1 : head.get(selected).location().lineNumber();
            details.put("frames", frames);
            details.put("frameCount", count);
            details.put("frameIndex", selected);
            details.put("line", line);
            details.put("variables", head.isEmpty() ? List.of() : values.frame(head.get(selected)));
        } catch (IncompatibleThreadStateException | InvalidStackFrameException exceptionState) {
            details.put("frames", List.of()); details.put("frameCount", 0); details.put("frameIndex", 0); details.put("line", -1); details.put("variables", List.of());
        }
        String where = line > 0 ? "第 " + line + " 行" : "库代码中";
        if (exception != null) {
            Map<String, Object> thrown = new LinkedHashMap<>();
            Map<String, Object> variable = values.variable("抛出的异常", exception, null);
            thrown.put("type", DebugValues.simpleName(exception.referenceType().name()));
            thrown.put("className", exception.referenceType().name());
            thrown.put("message", variable.get("value"));
            thrown.put("variable", variable);
            details.put("exception", thrown);
            message = "未捕获的异常 " + thrown.get("type") + " · " + where;
        } else {
            details.put("exception", null);
            message = switch (reason) {
                case "breakpoint" -> "已在断点暂停 · " + where;
                case "cursor" -> "已运行到光标 · " + where;
                case "pause" -> "已手动暂停 · " + where;
                default -> "已暂停 · " + where;
            };
        }
        pause = Collections.unmodifiableMap(details);
        changed();
    }

    private Map<String, Object> frame(int index, StackFrame frame) {
        Location location = frame.location();
        Method method = location.method();
        int[] lines = methodLines.computeIfAbsent(method, DebugSession::lineRange);
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("index", index);
        map.put("method", method.name());
        map.put("className", DebugValues.simpleName(location.declaringType().name()));
        map.put("line", location.lineNumber());
        map.put("user", isUser(location));
        map.put("methodStart", lines[0]);
        map.put("methodEnd", lines[1]);
        return map;
    }

    private void finish(String verdict, String text) {
        Process running;
        VirtualMachine machine;
        boolean stopped;
        synchronized (this) { running = process; machine = vm; stopped = stopRequested; }
        Integer exitCode = null;
        if (running != null) {
            try {
                if (!running.waitFor(5, TimeUnit.SECONDS)) { running.destroyForcibly(); running.waitFor(3, TimeUnit.SECONDS); }
            } catch (InterruptedException interrupted) { running.destroyForcibly(); Thread.currentThread().interrupt(); }
            if (!running.isAlive()) exitCode = running.exitValue();
        }
        for (Thread pipe : pipes) {
            try { pipe.join(3000); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        }
        if (machine != null) { try { machine.dispose(); } catch (RuntimeException ignored) { /* already disconnected */ } }
        WindowsProcessJob job;
        synchronized (this) { job = windowsJob; windowsJob = null; }
        if (job != null) job.close();
        RunEngine.deleteQuietly(directory);
        String output = stdout.text();
        Map<String, Object> difference = null;
        if (verdict == null) {
            if (stopped) { verdict = "STOPPED"; text = "已停止调试"; }
            else if (outputLimited.get()) { verdict = "OLE"; text = "输出超过 8 MiB 上限，已停止调试"; }
            else if (exitCode == null) { verdict = "ERROR"; text = "调试 JVM 意外结束"; }
            else if (exitCode != 0) { verdict = "RE"; text = "程序异常退出（退出码 " + exitCode + "）"; }
            else if (request.expected() == null) { verdict = "UNCHECKED"; text = "程序已结束 · 没有期望输出，未比对"; }
            else {
                difference = RunEngine.firstDifference(request.expected(), output);
                verdict = difference == null ? "PASS" : "WA";
                text = difference == null ? "程序已结束 · 输出与期望一致" : "程序已结束 · 第 " + difference.get("line") + " 行与期望不同";
            }
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("verdict", verdict);
        summary.put("message", text);
        summary.put("exitCode", exitCode);
        summary.put("firstDifference", difference);
        summary.put("stdout", output.length() > RESULT_STDOUT_LIMIT ? output.substring(0, RESULT_STDOUT_LIMIT) : output);
        summary.put("stdoutTruncated", output.length() > RESULT_STDOUT_LIMIT);
        synchronized (this) {
            state = State.TERMINATED;
            pause = null;
            pausedThread = null;
            values = null;
            temporary.clear();
            userTypes.clear();
            breakpoints.replaceAll((line, requests) -> new ArrayList<>());
            result = Collections.unmodifiableMap(summary);
            message = text;
            changed();
        }
    }

    // ---- commands ----

    public synchronized Map<String, Object> snapshot() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", id);
        map.put("role", request.role());
        map.put("label", request.label());
        map.put("state", state.name());
        map.put("version", version);
        map.put("generation", generation);
        map.put("message", message);
        map.put("startedAt", startedAt);
        map.put("pause", pause);
        map.put("breakpoints", breakpointList());
        map.put("result", result);
        map.put("compileErrors", compileErrors);
        map.put("consoleLength", console.length());
        return map;
    }

    public synchronized Map<String, Object> resume() {
        requirePaused();
        proceed();
        return awaitSettled();
    }

    public synchronized Map<String, Object> step(Step kind) {
        requirePaused();
        step(pausedThread, switch (kind) {
            case OVER -> StepRequest.STEP_OVER;
            case INTO -> StepRequest.STEP_INTO;
            case OUT -> StepRequest.STEP_OUT;
        });
        autoSteps = 0;
        proceed();
        return awaitSettled();
    }

    public synchronized Map<String, Object> runToLine(int line) {
        requirePaused();
        List<Location> locations = new ArrayList<>();
        for (ReferenceType type : userTypes) locations.addAll(lineStarts(type, line));
        if (locations.isEmpty()) throw new IllegalArgumentException("第 " + line + " 行没有可执行代码，或所在的类尚未加载");
        for (Location location : locations) temporary.add(breakpoint(location));
        proceed();
        return awaitSettled();
    }

    public synchronized Map<String, Object> pause() {
        if (state != State.RUNNING) throw new IllegalStateException(state == State.PAUSED ? "程序已暂停" : "程序没有在运行");
        vm.suspend();
        ThreadReference thread = pausableThread();
        if (thread == null) { vm.resume(); throw new IllegalStateException("没有可以暂停的线程"); }
        clearSteps();
        clearTemporary();
        paused(thread, "pause", null);
        return snapshot();
    }

    /** Replaces the breakpoints; lines of classes already loaded take effect at once. */
    public synchronized List<Map<String, Object>> setBreakpoints(Collection<Integer> lines) {
        Set<Integer> wanted = new TreeSet<>();
        for (Integer line : lines) if (line != null && line > 0) wanted.add(line);
        boolean live = vm != null && state != State.TERMINATED;
        Iterator<Map.Entry<Integer, List<BreakpointRequest>>> entries = breakpoints.entrySet().iterator();
        while (entries.hasNext()) {
            Map.Entry<Integer, List<BreakpointRequest>> entry = entries.next();
            if (wanted.contains(entry.getKey())) continue;
            if (live) deleteRequests(entry.getValue());
            entries.remove();
        }
        for (int line : wanted) {
            if (breakpoints.containsKey(line)) continue;
            List<BreakpointRequest> requests = new ArrayList<>();
            breakpoints.put(line, requests);
            if (live) for (ReferenceType type : userTypes) for (Location location : lineStarts(type, line)) requests.add(breakpoint(location));
        }
        changed();
        return breakpointList();
    }

    public void stop() {
        VirtualMachine machine;
        Process running;
        synchronized (this) {
            if (state == State.TERMINATED || stopRequested) return;
            stopRequested = true;
            message = "正在停止…";
            machine = vm;
            running = process;
            changed();
        }
        if (machine != null) exitQuietly(machine);
        if (running != null) running.destroyForcibly();
    }

    /** Top-level variables of one frame of the current pause; {@code generation} guards against a pause that has ended. */
    public synchronized List<Map<String, Object>> frameVariables(int expectedGeneration, int index) {
        requireGeneration(expectedGeneration);
        try { return values.frame(pausedThread.frame(index)); }
        catch (IncompatibleThreadStateException | IndexOutOfBoundsException missing) { throw new IllegalArgumentException("调用栈中没有这一帧"); }
    }

    public synchronized Map<String, Object> children(int expectedGeneration, int reference, int start, int count) {
        requireGeneration(expectedGeneration);
        return values.children(reference, start, count);
    }

    /** Console text from {@code from} on, as stdout/stderr chunks in arrival order. */
    public Map<String, Object> console(int from) { return console.since(from); }

    public int consoleLength() { return console.length(); }

    // ---- helpers ----

    private void proceed() {
        // A user pause and an event can both hold the thread. Release exactly the holds it has now: once it runs it may
        // stop at the next breakpoint within microseconds, and that new hold must stay.
        int holds = 1;
        try { holds = Math.max(1, Math.min(8, pausedThread.suspendCount())); }
        catch (RuntimeException gone) { /* the thread ended; one resume releases the VM */ }
        state = State.RUNNING;
        pause = null;
        pausedThread = null;
        values = null;
        message = "运行中…";
        changed();
        for (int i = 0; i < holds; i++) vm.resume();
    }

    /** Lets a step or resume settle briefly, so the reply usually already shows where the program stopped. */
    private Map<String, Object> awaitSettled() {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(SETTLE_MILLIS);
        while (state == State.RUNNING) {
            long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (remaining <= 0) break;
            try { wait(remaining); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
        }
        return snapshot();
    }

    private void step(ThreadReference thread, int depth) {
        EventRequestManager requests = vm.eventRequestManager();
        requests.deleteEventRequests(requests.stepRequests());
        StepRequest step = requests.createStepRequest(thread, StepRequest.STEP_LINE, depth);
        LIBRARY_PACKAGES.forEach(step::addClassExclusionFilter);
        for (String name : compiledClasses) step.addClassExclusionFilter(name + "$$Lambda*");
        step.addCountFilter(1);
        step.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        step.enable();
        stepDepth = depth;
    }

    private BreakpointRequest breakpoint(Location location) {
        BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(location);
        request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        request.enable();
        return request;
    }

    private void clearSteps() {
        EventRequestManager requests = vm.eventRequestManager();
        requests.deleteEventRequests(requests.stepRequests());
    }

    private void clearTemporary() {
        deleteRequests(temporary);
        temporary.clear();
    }

    private void deleteRequests(List<? extends EventRequest> requests) {
        try { vm.eventRequestManager().deleteEventRequests(requests); }
        catch (VMDisconnectedException ignored) { /* the program has ended */ }
    }

    private List<Map<String, Object>> breakpointList() {
        List<Map<String, Object>> list = new ArrayList<>();
        breakpoints.forEach((line, requests) -> list.add(Map.of("line", line, "verified", !requests.isEmpty())));
        return list;
    }

    /** The main thread, or else any thread running the user's code. */
    private ThreadReference pausableThread() {
        ThreadReference fallback = null;
        for (ThreadReference thread : vm.allThreads()) {
            try {
                if (thread.frameCount() == 0) continue;
                if ("main".equals(thread.name())) return thread;
                if (fallback == null && reachesUserCode(thread)) fallback = thread;
            } catch (IncompatibleThreadStateException | ObjectCollectedException ignored) { /* not suspended or gone */ }
        }
        return fallback;
    }

    /** Uncaught exceptions of JDK-internal threads are not the user's concern. */
    private boolean reachesUserCode(ThreadReference thread) {
        try {
            for (StackFrame frame : thread.frames()) if (isUser(frame.location())) return true;
        } catch (IncompatibleThreadStateException | ObjectCollectedException ignored) { /* treat as library */ }
        return false;
    }

    private boolean isUser(Location location) {
        return compiledClasses.contains(location.declaringType().name()) && location.lineNumber() > 0;
    }

    private void requirePaused() {
        if (state != State.PAUSED) throw new IllegalStateException(state == State.TERMINATED ? "调试已结束" : "程序未暂停");
    }

    private void requireGeneration(int expected) {
        if (state != State.PAUSED || values == null) throw new IllegalStateException("程序未暂停，变量不可查看");
        if (expected != generation) throw new IllegalStateException("程序已继续执行，变量已过期");
    }

    private synchronized boolean stopRequested() { return stopRequested; }

    private synchronized void update(String text) {
        message = text;
        changed();
    }

    private void changed() {
        version++;
        notifyAll();
        listener.changed(this);
    }

    /**
     * Where a line's code begins in each method of a type: the first location of every run of that line in code
     * order. A {@code for} header thus stops once on entry and once per iteration (at the update), not again at the
     * condition that javac places right after the initializer.
     */
    static List<Location> lineStarts(ReferenceType type, int line) {
        List<Location> starts = new ArrayList<>();
        for (Method method : type.methods()) {
            List<Location> locations;
            try { locations = new ArrayList<>(method.allLineLocations()); }
            catch (AbsentInformationException absent) { continue; }
            locations.sort(Comparator.comparingLong(Location::codeIndex));
            int previous = -1;
            for (Location location : locations) {
                if (location.lineNumber() == line && previous != line) starts.add(location);
                previous = location.lineNumber();
            }
        }
        return starts;
    }

    private static int[] lineRange(Method method) {
        try {
            int min = Integer.MAX_VALUE, max = 0;
            for (Location location : method.allLineLocations()) {
                min = Math.min(min, location.lineNumber());
                max = Math.max(max, location.lineNumber());
            }
            return min <= max ? new int[]{ min, max } : new int[]{ 0, 0 };
        } catch (AbsentInformationException absent) { return new int[]{ 0, 0 }; }
    }

    private static void exitQuietly(VirtualMachine machine) {
        try { machine.exit(1); } catch (RuntimeException ignored) { /* already gone */ }
    }

    private static String describe(Exception exception) {
        return exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage();
    }

    // ---- program streams ----

    private void startPipes(Process started) {
        pipes.add(pipe("duipai-debug-out", started.getInputStream(), stdout, 0));
        pipes.add(pipe("duipai-debug-err", started.getErrorStream(), stderr, 1));
        pipes.add(Thread.ofPlatform().daemon(true).name("duipai-debug-in").start(() -> {
            try (OutputStream sink = started.getOutputStream()) {
                if (!request.input().isEmpty()) sink.write(request.input().getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) { /* A program may exit without reading all of its input. */ }
        }));
    }

    private Thread pipe(String name, InputStream stream, Output capture, int channel) {
        return Thread.ofPlatform().daemon(true).name(name).start(() -> {
            Utf8 decoder = new Utf8();
            byte[] buffer = new byte[8192];
            try (stream) {
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    boolean kept = capture.add(buffer, count);
                    console.append(channel, decoder.decode(buffer, count, false));
                    listener.output(this);
                    if (!kept) {
                        outputLimited.set(true);
                        terminateForOutput();
                        break;
                    }
                }
                console.append(channel, decoder.decode(buffer, 0, true));
            } catch (IOException ignored) { /* Killing the program closes its pipes. */ }
            listener.output(this);
        });
    }

    private void terminateForOutput() {
        VirtualMachine machine;
        Process running;
        synchronized (this) { machine = vm; running = process; }
        if (machine != null) exitQuietly(machine);
        if (running != null) running.destroyForcibly();
    }

    /** Program output in arrival order, bounded for display; each segment remembers whether it came from stdout or stderr. */
    private static final class Console {
        private final StringBuilder text = new StringBuilder();
        private final List<int[]> segments = new ArrayList<>(); // {start offset, 0 = stdout / 1 = stderr}
        private final int limit;
        private boolean truncated;

        Console(int limit) { this.limit = limit; }

        synchronized void append(int channel, String chunk) {
            if (chunk.isEmpty() || truncated) return;
            if (text.length() + chunk.length() > limit) {
                chunk = chunk.substring(0, limit - text.length());
                truncated = true;
                if (chunk.isEmpty()) return;
            }
            if (segments.isEmpty() || segments.getLast()[1] != channel) segments.add(new int[]{ text.length(), channel });
            text.append(chunk);
        }

        synchronized int length() { return text.length(); }

        synchronized Map<String, Object> since(int from) {
            int start = Math.max(0, Math.min(from, text.length()));
            List<Map<String, Object>> chunks = new ArrayList<>();
            int first = segments.size() - 1;
            while (first > 0 && segments.get(first)[0] > start) first--;
            for (int i = Math.max(0, first); i < segments.size(); i++) {
                int begin = Math.max(segments.get(i)[0], start);
                int end = i + 1 < segments.size() ? segments.get(i + 1)[0] : text.length();
                if (begin < end) chunks.add(Map.of("stream", segments.get(i)[1] == 0 ? "out" : "err", "text", text.substring(begin, end)));
            }
            return Map.of("from", start, "length", text.length(), "truncated", truncated, "chunks", chunks);
        }
    }

    /** Captured bytes of one stream up to the engine's limit; the judged stdout comes from here, not from the console. */
    private static final class Output {
        private final int limit;
        private final ByteArrayOutputStream bytes = new ByteArrayOutputStream(8192);
        Output(int limit) { this.limit = limit; }
        synchronized boolean add(byte[] buffer, int count) {
            int available = limit - bytes.size();
            bytes.write(buffer, 0, Math.max(0, Math.min(available, count)));
            return count <= available;
        }
        synchronized String text() { return bytes.toString(StandardCharsets.UTF_8); }
    }

    /** Incremental UTF-8 decoding: a character split across two reads is kept until its last byte arrives. */
    private static final class Utf8 {
        private final CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE);
        private byte[] carry = new byte[0];

        String decode(byte[] bytes, int count, boolean end) {
            ByteBuffer input = ByteBuffer.allocate(carry.length + count);
            input.put(carry).put(bytes, 0, count).flip();
            CharBuffer output = CharBuffer.allocate(input.remaining() + 2);
            decoder.decode(input, output, end);
            if (end) decoder.flush(output);
            carry = new byte[input.remaining()];
            input.get(carry);
            return output.flip().toString();
        }
    }
}
