package com.duipai.engine;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.*;

class DebugEngineTest {
    @TempDir Path temporary;
    private DebugEngine engine;
    private final DebugSession.Listener quiet = new DebugSession.Listener() {
        @Override public void changed(DebugSession session) { }
        @Override public void output(DebugSession session) { }
    };

    private static final String SUM = """
            import java.util.*;

            public class Main {
                static int calls;
                public static void main(String[] args) {
                    Scanner in = new Scanner(System.in);
                    int n = in.nextInt();
                    long sum = 0;
                    for (int i = 0; i < n; i++) {
                        int x = in.nextInt();
                        sum += square(x);
                    }
                    System.out.println(sum);
                }
                static int square(int v) {
                    calls++;
                    return v * v;
                }
            }
            """;

    @BeforeEach void open() { engine = new DebugEngine(temporary); }
    @AfterEach void close() { engine.close(); }

    @Test void pausesAtBreakpointsStepsThroughCallsAndJudgesTheOutput() throws Exception {
        DebugSession session = start(SUM, "3\n1 2 3\n", "14", 11);
        Map<String, Object> paused = await(session, DebugEngineTest::isPaused);
        assertEquals("breakpoint", pause(paused).get("reason"));
        assertEquals(11, pause(paused).get("line"));
        List<Map<String, Object>> locals = variables(paused);
        assertEquals("3", variable(locals, "n").get("value"));
        assertEquals("0", variable(locals, "sum").get("value"));
        assertEquals("1", variable(locals, "x").get("value"));
        assertEquals("long", variable(locals, "sum").get("type"));
        Map<String, Object> statics = variable(locals, "静态字段");
        assertEquals("static", statics.get("kind"));
        List<Map<String, Object>> fields = children(session, paused, statics);
        assertEquals("0", variable(fields, "calls").get("value"));

        Map<String, Object> into = settle(session, session.step(DebugSession.Step.INTO));
        assertEquals(16, pause(into).get("line"));
        List<Map<String, Object>> frames = frames(into);
        assertEquals("square", frames.get(0).get("method"));
        assertEquals("main", frames.get(1).get("method"));
        assertEquals(16, frames.get(0).get("methodStart"), "the first line with code, below the signature");
        assertEquals(17, frames.get(0).get("methodEnd"));
        assertEquals("1", variable(variables(into), "v").get("value"));
        List<Map<String, Object>> caller = session.frameVariables(((Number) into.get("generation")).intValue(), 1);
        assertEquals("1", variable(caller, "x").get("value"));

        Map<String, Object> out = settle(session, session.step(DebugSession.Step.OUT));
        assertEquals(11, pause(out).get("line"));
        assertEquals("main", frames(out).getFirst().get("method"));
        Map<String, Object> over = settle(session, session.step(DebugSession.Step.OVER));
        assertEquals(9, pause(over).get("line"), "the loop update follows the body");
        int stale = ((Number) over.get("generation")).intValue() - 1;
        assertThrows(IllegalStateException.class, () -> session.frameVariables(stale, 0));

        Map<String, Object> second = settle(session, session.resume());
        assertEquals(11, pause(second).get("line"));
        assertEquals("2", variable(variables(second), "x").get("value"));
        assertEquals("1", variable(variables(second), "sum").get("value"));

        session.setBreakpoints(List.of());
        session.resume();
        Map<String, Object> done = await(session, DebugEngineTest::isTerminated);
        assertEquals("PASS", result(done).get("verdict"));
        assertEquals(0, result(done).get("exitCode"));
        assertEquals("14" + System.lineSeparator(), result(done).get("stdout"));
        assertEquals("14" + System.lineSeparator(), consoleText(session, "out"));
        try (var entries = Files.list(temporary)) { assertTrue(entries.noneMatch(path -> path.getFileName().toString().startsWith("debug-")), "work files are removed"); }
    }

    @Test void uncaughtExceptionsPauseAtTheUsersFrameAndThenEndAsRuntimeErrors() throws Exception {
        String code = """
                public class Main {
                    public static void main(String[] args) {
                        int[] a = new int[3];
                        int index = Integer.parseInt(new java.util.Scanner(System.in).next());
                        a[index] = 1;
                    }
                }
                """;
        DebugSession session = start(code, "5\n", null);
        Map<String, Object> paused = await(session, DebugEngineTest::isPaused);
        assertEquals("exception", pause(paused).get("reason"));
        assertEquals(5, pause(paused).get("line"));
        Map<?, ?> exception = (Map<?, ?>) pause(paused).get("exception");
        assertEquals("ArrayIndexOutOfBoundsException", exception.get("type"));
        assertTrue(String.valueOf(exception.get("message")).contains("Index 5 out of bounds for length 3"), String.valueOf(exception.get("message")));
        assertTrue(((Number) ((Map<?, ?>) exception.get("variable")).get("ref")).intValue() > 0, "the exception can be expanded");
        session.resume();
        Map<String, Object> done = await(session, DebugEngineTest::isTerminated);
        assertEquals("RE", result(done).get("verdict"));
        assertEquals(1, result(done).get("exitCode"));
        assertTrue(consoleText(session, "err").contains("ArrayIndexOutOfBoundsException"));

        DebugSession library = start(code, "x\n", null);
        Map<String, Object> thrown = await(library, DebugEngineTest::isPaused);
        List<Map<String, Object>> frames = frames(thrown);
        assertFalse((Boolean) frames.getFirst().get("user"), "NumberFormatException is thrown inside the JDK");
        int selected = ((Number) pause(thrown).get("frameIndex")).intValue();
        assertTrue(selected > 0);
        assertEquals("main", frames.get(selected).get("method"));
        assertEquals(4, pause(thrown).get("line"), "the selected frame is the user's call site");
        library.stop();
        assertEquals("STOPPED", result(await(library, DebugEngineTest::isTerminated)).get("verdict"));
    }

    @Test void pauseInterruptsARunawayLoopAndStopEndsIt() throws Exception {
        String code = """
                public class Main {
                    public static void main(String[] args) {
                        long k = 0;
                        while (true) {
                            k++;
                            if (k < 0) break;
                        }
                        System.out.println(k);
                    }
                }
                """;
        DebugSession session = start(code, "", null);
        await(session, snapshot -> "RUNNING".equals(snapshot.get("state")));
        Thread.sleep(300);
        Map<String, Object> paused = session.pause();
        assertEquals("pause", pause(paused).get("reason"));
        assertTrue(List.of(4, 5, 6).contains(pause(paused).get("line")), String.valueOf(pause(paused).get("line")));
        long first = Long.parseLong((String) variable(variables(paused), "k").get("value"));
        assertTrue(first > 0);
        Map<String, Object> stepped = settle(session, session.step(DebugSession.Step.OVER));
        assertTrue(List.of(4, 5, 6).contains(pause(stepped).get("line")));
        assertThrows(IllegalStateException.class, session::pause);
        session.stop();
        Map<String, Object> done = await(session, DebugEngineTest::isTerminated);
        assertEquals("STOPPED", result(done).get("verdict"));
        assertThrows(IllegalStateException.class, session::resume);
    }

    @Test void variablesShowCollectionsStringsAndStaticsWithoutRunningCode() throws Exception {
        String code = """
                import java.math.BigInteger;
                import java.util.*;

                public class Main {
                    static long[] memo = new long[200];
                    static final int MOD = 1_000_000_007;
                    static class Node { int v; Node next; Node(int v) { this.v = v; } }
                    public static void main(String[] args) {
                        int[] arr = {3, 1, 2};
                        int[][] grid = {{1, 2}, {3, 4}};
                        int[] large = new int[1_000_000];
                        large[999_999] = 7;
                        List<Integer> list = new ArrayList<>(List.of(5, 3, 9));
                        Map<String, Integer> map = new HashMap<>();
                        map.put("a", 1); map.put("b", 2);
                        TreeMap<Integer, String> tree = new TreeMap<>(Map.of(3, "c", 1, "a", 2, "b"));
                        Map<String, Integer> linked = new LinkedHashMap<>();
                        linked.put("z", 26); linked.put("y", 25);
                        ArrayDeque<Integer> deque = new ArrayDeque<>();
                        deque.addLast(1); deque.addLast(2); deque.addFirst(0);
                        PriorityQueue<Long> heap = new PriorityQueue<>(List.of(4L, 1L, 3L));
                        LinkedList<String> chain = new LinkedList<>(List.of("x", "y"));
                        Set<Integer> hashed = new HashSet<>(List.of(7, 8, 9));
                        TreeSet<String> sorted = new TreeSet<>(List.of("pear", "apple"));
                        List<Integer> pair = List.of(1, 2);
                        StringBuilder sb = new StringBuilder("héllo中");
                        String s = "line\\n";
                        Integer boxed = 42;
                        char c = 'x';
                        BigInteger huge = BigInteger.TWO.pow(100);
                        Node head = new Node(1); head.next = new Node(2);
                        Object nothing = null;
                        System.out.println(arr.length);
                    }
                }
                """;
        DebugSession session = start(code, "", null, 33);
        Map<String, Object> paused = await(session, DebugEngineTest::isPaused);
        List<Map<String, Object>> locals = variables(paused);
        assertRow(variable(locals, "arr"), "int[3]", "[3, 1, 2]", "array");
        assertRow(variable(locals, "grid"), "int[2][]", "[[1, 2], [3, 4]]", "array");
        assertEquals(1_000_000, variable(locals, "large").get("size"));
        Map<String, Object> page = session.children(generation(paused), ref(variable(locals, "large")), 999_990, 100);
        List<Map<String, Object>> tail = rows(page);
        assertEquals(10, tail.size());
        assertEquals("[999999]", tail.getLast().get("name"));
        assertEquals("7", tail.getLast().get("value"));
        assertRow(variable(locals, "list"), "ArrayList size=3", "[5, 3, 9]", "collection");
        List<Map<String, Object>> entries = children(session, paused, variable(locals, "map"));
        assertEquals(Set.of("\"a\"=1", "\"b\"=2"), new HashSet<>(entries.stream().map(row -> row.get("name") + "=" + row.get("value")).toList()));
        assertEquals("{1=\"a\", 2=\"b\", 3=\"c\"}", variable(locals, "tree").get("value"));
        assertEquals("{\"z\"=26, \"y\"=25}", variable(locals, "linked").get("value"));
        assertEquals("[0, 1, 2]", variable(locals, "deque").get("value"));
        assertEquals("PriorityQueue size=3", variable(locals, "heap").get("type"));
        assertEquals("[\"x\", \"y\"]", variable(locals, "chain").get("value"));
        assertEquals("HashSet size=3", variable(locals, "hashed").get("type"));
        assertEquals("[\"apple\", \"pear\"]", variable(locals, "sorted").get("value"));
        assertRow(variable(locals, "pair"), "List.of size=2", "[1, 2]", "collection");
        assertRow(variable(locals, "sb"), "StringBuilder", "\"héllo中\"", "string");
        assertRow(variable(locals, "s"), "String", "\"line\\n\"", "string");
        assertRow(variable(locals, "boxed"), "Integer", "42", "leaf");
        assertRow(variable(locals, "c"), "char", "'x' 120", "primitive");
        assertRow(variable(locals, "huge"), "BigInteger", "1267650600228229401496703205376", "leaf");
        assertRow(variable(locals, "nothing"), "Object", "null", "null");
        Map<String, Object> head = variable(locals, "head");
        assertTrue(String.valueOf(head.get("value")).startsWith("{v=1, next=Node@"), String.valueOf(head.get("value")));
        assertTrue(String.valueOf(head.get("type")).startsWith("Node@"));
        Map<String, Object> next = variable(children(session, paused, head), "next");
        assertEquals("2", variable(children(session, paused, next), "v").get("value"));
        List<Map<String, Object>> statics = children(session, paused, variable(locals, "静态字段"));
        assertEquals("long[200]", variable(statics, "memo").get("type"));
        assertEquals("1000000007", variable(statics, "MOD").get("value"));
        assertEquals(List.of("memo", "MOD"), statics.stream().map(row -> row.get("name")).toList());
        assertThrows(IllegalArgumentException.class, () -> session.children(generation(paused), 999_999, 0, 10));
        session.stop();
        await(session, DebugEngineTest::isTerminated);
    }

    @Test void breakpointsAttachToLinesWithCodeAndNestedClassesAsTheyLoad() throws Exception {
        String code = """
                public class Main {
                    static class Helper {
                        static int twice(int x) {
                            return x * 2;
                        }
                    }

                    public static void main(String[] args) {
                        int total = 0;
                        for (int i = 0; i < 3; i++) {
                            total += i;
                        }
                        // comment
                        System.out.println(Helper.twice(total));
                    }
                }
                """;
        DebugSession session = start(code, "", "6", 10, 6, 4);
        Map<String, Object> first = await(session, DebugEngineTest::isPaused);
        assertEquals(10, pause(first).get("line"));
        assertEquals(Map.of(4, false, 6, false, 10, true), verified(first), "Helper has not loaded yet; line 6 has no code");
        int stops = 1;
        Map<String, Object> current = settle(session, session.resume());
        while (pause(current) != null && Integer.valueOf(10).equals(pause(current).get("line"))) {
            stops++;
            current = settle(session, session.resume());
        }
        assertEquals(4, stops, "a for header stops on entry and once per iteration, not again at its condition");
        assertEquals(4, pause(current).get("line"));
        assertEquals("Helper", frames(current).getFirst().get("className"));
        assertTrue(verified(current).get(4));
        session.stop();
        await(session, DebugEngineTest::isTerminated);

        DebugSession cursor = start(code, "", "6", 9);
        Map<String, Object> entry = await(cursor, DebugEngineTest::isPaused);
        assertThrows(IllegalArgumentException.class, () -> cursor.runToLine(13), "a comment line has no code");
        Map<String, Object> reached = settle(cursor, cursor.runToLine(14));
        assertEquals("cursor", pause(reached).get("reason"));
        assertEquals(14, pause(reached).get("line"));
        assertEquals("3", variable(variables(reached), "total").get("value"));
        assertNotEquals(generation(entry), generation(reached));
        cursor.resume();
        assertEquals("PASS", result(await(cursor, DebugEngineTest::isTerminated)).get("verdict"));
    }

    @Test void steppingIntoLambdasStaysInTheUsersCode() throws Exception {
        String code = """
                import java.util.*;

                public class Main {
                    public static void main(String[] args) {
                        List<Integer> list = List.of(3, 1, 2);
                        list.forEach(x -> System.out.println(x * 2));
                        Integer[] boxes = {3, 1, 2};
                        Arrays.sort(boxes, (a, b) -> b - a);
                        System.out.println(Arrays.toString(boxes));
                    }
                }
                """;
        DebugSession session = start(code, "", null, 6);
        Map<String, Object> current = await(session, DebugEngineTest::isPaused);
        Set<Integer> lines = new TreeSet<>();
        for (int i = 0; i < 40 && "PAUSED".equals(current.get("state")); i++) {
            Map<String, Object> top = frames(current).getFirst();
            assertTrue((Boolean) top.get("user"), "stopped outside the user's code at " + top);
            lines.add((Integer) pause(current).get("line"));
            current = settle(session, session.step(DebugSession.Step.INTO));
        }
        assertTrue(lines.containsAll(List.of(6, 7, 8, 9)), String.valueOf(lines));
        if (!isTerminated(current)) { session.resume(); current = await(session, DebugEngineTest::isTerminated); }
        assertEquals("UNCHECKED", result(current).get("verdict"));
    }

    @Test void compileErrorsEndTheSessionAndOutputKeepsItsStreamOrder() throws Exception {
        DebugSession broken = start("public class Main { public static void main(String[] a) { int x = ; } }", "", null);
        Map<String, Object> failed = await(broken, DebugEngineTest::isTerminated);
        assertEquals("CE", result(failed).get("verdict"));
        assertEquals(1, ((List<?>) failed.get("compileErrors")).size());

        String code = """
                public class Main {
                    public static void main(String[] args) throws Exception {
                        String line = new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine();
                        System.out.println("out " + line);
                        System.out.flush();
                        Thread.sleep(50);
                        System.err.println("err 中文");
                        System.err.flush();
                        Thread.sleep(50);
                        System.out.println("tail");
                    }
                }
                """;
        DebugSession session = start(code, "hello", "out hello\nother");
        Map<String, Object> done = await(session, DebugEngineTest::isTerminated);
        assertEquals("WA", result(done).get("verdict"));
        assertEquals(2, ((Map<?, ?>) result(done).get("firstDifference")).get("line"));
        Map<String, Object> console = session.console(0);
        List<?> chunks = (List<?>) console.get("chunks");
        assertEquals(List.of("out", "err", "out"), chunks.stream().map(chunk -> ((Map<?, ?>) chunk).get("stream")).toList());
        assertTrue(((String) ((Map<?, ?>) chunks.get(1)).get("text")).startsWith("err 中文"));
        int length = (Integer) console.get("length");
        assertEquals(List.of(), session.console(length).get("chunks"));
        String tail = "tail" + System.lineSeparator();
        assertEquals(tail, ((Map<?, ?>) ((List<?>) session.console(length - tail.length()).get("chunks")).getFirst()).get("text"));
    }

    @Test void runawayOutputEndsTheSessionAtTheEngineLimit() throws Exception {
        String code = "public class Main { public static void main(String[] a) { String s = \"x\".repeat(1000); while (true) System.out.println(s); } }";
        DebugSession session = start(code, "", null);
        Map<String, Object> done = await(session, DebugEngineTest::isTerminated);
        assertEquals("OLE", result(done).get("verdict"));
        assertEquals(true, result(done).get("stdoutTruncated"));
        Map<String, Object> console = session.console(0);
        assertEquals(DebugSession.CONSOLE_LIMIT, console.get("length"), "the console keeps only its display limit");
        assertEquals(true, console.get("truncated"));
    }

    @Test void startingAnotherSessionStopsThePreviousOne() throws Exception {
        String loop = "public class Main { public static void main(String[] a) { while (true) { } } }";
        DebugSession first = start(loop, "", null);
        await(first, snapshot -> "RUNNING".equals(snapshot.get("state")));
        DebugSession second = start(SUM, "1\n4\n", "16");
        assertEquals("STOPPED", result(await(first, DebugEngineTest::isTerminated)).get("verdict"));
        assertNull(engine.find(first.id()));
        assertSame(second, engine.find(second.id()));
        assertEquals("PASS", result(await(second, DebugEngineTest::isTerminated)).get("verdict"));
    }

    // ---- helpers ----

    private DebugSession start(String code, String input, String expected, Integer... breakpoints) {
        return engine.start(new DebugSession.Request("optimized", "用例", code, input, expected, List.of(breakpoints)), quiet);
    }

    private static Map<String, Object> await(DebugSession session, Predicate<Map<String, Object>> condition) throws InterruptedException {
        long deadline = System.nanoTime() + 30_000_000_000L;
        while (true) {
            Map<String, Object> snapshot = session.snapshot();
            if (condition.test(snapshot)) return snapshot;
            if (System.nanoTime() > deadline) fail("等待调试状态超时：" + snapshot);
            Thread.sleep(20);
        }
    }

    /** A command's reply after it settled: paused again or ended. */
    private static Map<String, Object> settle(DebugSession session, Map<String, Object> reply) throws InterruptedException {
        return "RUNNING".equals(reply.get("state")) ? await(session, snapshot -> !"RUNNING".equals(snapshot.get("state"))) : reply;
    }

    private static boolean isPaused(Map<String, Object> snapshot) { return "PAUSED".equals(snapshot.get("state")); }
    private static boolean isTerminated(Map<String, Object> snapshot) { return "TERMINATED".equals(snapshot.get("state")); }
    @SuppressWarnings("unchecked") private static Map<String, Object> pause(Map<String, Object> snapshot) { return (Map<String, Object>) snapshot.get("pause"); }
    @SuppressWarnings("unchecked") private static Map<String, Object> result(Map<String, Object> snapshot) { return (Map<String, Object>) snapshot.get("result"); }
    @SuppressWarnings("unchecked") private static List<Map<String, Object>> variables(Map<String, Object> snapshot) { return (List<Map<String, Object>>) pause(snapshot).get("variables"); }
    @SuppressWarnings("unchecked") private static List<Map<String, Object>> frames(Map<String, Object> snapshot) { return (List<Map<String, Object>>) pause(snapshot).get("frames"); }
    @SuppressWarnings("unchecked") private static List<Map<String, Object>> rows(Map<String, Object> page) { return (List<Map<String, Object>>) page.get("variables"); }
    private static int generation(Map<String, Object> snapshot) { return ((Number) snapshot.get("generation")).intValue(); }
    private static int ref(Map<String, Object> row) { return ((Number) row.get("ref")).intValue(); }

    private static List<Map<String, Object>> children(DebugSession session, Map<String, Object> snapshot, Map<String, Object> row) {
        assertTrue(ref(row) > 0, row.get("name") + " should expand");
        return rows(session.children(generation(snapshot), ref(row), 0, 100));
    }

    private static Map<String, Object> variable(List<Map<String, Object>> rows, String name) {
        return rows.stream().filter(row -> name.equals(row.get("name"))).findFirst().orElseThrow(() -> new AssertionError("没有变量 " + name + "：" + rows));
    }

    private static void assertRow(Map<String, Object> row, String type, String value, String kind) {
        assertEquals(type, row.get("type"), row.toString());
        assertEquals(value, row.get("value"), row.toString());
        assertEquals(kind, row.get("kind"), row.toString());
    }

    private static Map<Integer, Boolean> verified(Map<String, Object> snapshot) {
        Map<Integer, Boolean> map = new TreeMap<>();
        for (Object item : (List<?>) snapshot.get("breakpoints")) map.put((Integer) ((Map<?, ?>) item).get("line"), (Boolean) ((Map<?, ?>) item).get("verified"));
        return map;
    }

    private static String consoleText(DebugSession session, String stream) {
        StringBuilder text = new StringBuilder();
        for (Object chunk : (List<?>) session.console(0).get("chunks")) {
            if (stream.equals(((Map<?, ?>) chunk).get("stream"))) text.append(((Map<?, ?>) chunk).get("text"));
        }
        return text.toString();
    }
}
