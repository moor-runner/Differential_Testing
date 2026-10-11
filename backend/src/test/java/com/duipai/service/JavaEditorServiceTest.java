package com.duipai.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.*;

class JavaEditorServiceTest {
    private final JavaEditorService editor = new JavaEditorService();

    private JavaEditorService.Result query(String marked, String operation) {
        int cursor = marked.indexOf('|');
        assertThat(cursor).isGreaterThanOrEqualTo(0);
        return editor.analyze(new JavaEditorService.Request(marked.substring(0, cursor) + marked.substring(cursor + 1), cursor, operation));
    }

    @Test
    void diagnosesActualCompilerErrorsWithUtf16RangesAndEnumeratesDeclarations() {
        String source = "class Main { String emoji = \"😀\"; int count; int twice(int value) { return value * 2; } void run() { int broken = \"text\"; } }";
        var result = editor.analyze(new JavaEditorService.Request(source, null, null));
        var error = result.diagnostics().stream().filter(d -> d.severity().equals("error")).findFirst().orElseThrow();
        assertThat(error.code()).isEqualTo("compiler.err.prob.found.req");
        assertThat(error.message()).contains("java.lang.String", "int");
        assertThat(source.substring(error.start(), error.end())).isEqualTo("\"text\"");
        assertThat(result.symbols()).extracting(JavaEditorService.Symbol::name).contains("Main", "emoji", "count", "twice", "run").doesNotContain("value", "broken");
        var method = result.symbols().stream().filter(s -> s.name().equals("twice")).findFirst().orElseThrow();
        assertThat(source.substring(method.selectionStart(), method.selectionEnd())).isEqualTo("twice");
        assertThat(method.detail()).isEqualTo("int twice(int value)");
    }

    @Test
    void completesScannerMembersAndPreservesRealOverloadsWithoutOtherReceiverMembers() {
        var result = query("import java.util.Scanner; class Main { void run() { Scanner input = new Scanner(System.in); input.ne|; } }", "complete");
        assertThat(result.completions()).extracting(JavaEditorService.Completion::label).contains("nextInt", "nextLine", "nextDouble").doesNotContain("println", "charAt", "notify");
        assertThat(result.completions()).filteredOn(c -> c.label().equals("nextInt")).hasSize(2);
        assertThat(result.completions()).filteredOn(c -> c.label().equals("nextInt")).extracting(JavaEditorService.Completion::detail).anyMatch(d -> d.contains("int nextInt()"));
    }

    @Test
    void followsSystemOutChainAndFiltersStaticReceiver() {
        var output = query("class Main { void run() { System.out.pr|; } }", "complete");
        assertThat(output.completions()).extracting(JavaEditorService.Completion::label).contains("println", "printf", "print").doesNotContain("parseInt", "nextInt");
        assertThat(output.completions()).filteredOn(c -> c.label().equals("println")).hasSizeGreaterThan(5);
        var system = query("class Main { void run() { System.|; } }", "complete");
        assertThat(system.completions()).extracting(JavaEditorService.Completion::label).contains("out", "in", "currentTimeMillis").doesNotContain("wait", "getClass");
    }

    @Test
    void substitutesGenericTypesAndFollowsMethodReturnValues() {
        var list = query("import java.util.*; class Main { void run() { List<String> words = new ArrayList<>(); words.ge|; } }", "complete");
        assertThat(list.completions()).filteredOn(c -> c.label().equals("get")).singleElement().satisfies(c -> assertThat(c.detail()).startsWith("java.lang.String get("));
        var chained = query("import java.util.*; class Main { void run() { List<String> words = new ArrayList<>(); words.get(0).sub|; } }", "complete");
        assertThat(chained.completions()).extracting(JavaEditorService.Completion::label).contains("substring", "subSequence").doesNotContain("nextInt");
    }

    @Test
    void completesLocalVariablesUserMethodsAndAutoImportCandidates() {
        var local = query("class Main { int field; private int doubleIt(int value) { return value * 2; } void run() { int answer = 42; ans|; } }", "complete");
        assertThat(local.completions()).extracting(JavaEditorService.Completion::label).contains("answer");
        var members = query("class Main { private int field; private int doubleIt(int value) { return value * 2; } void run() { this.|; } }", "complete");
        assertThat(members.completions()).extracting(JavaEditorService.Completion::label).contains("field", "doubleIt");
        var imported = query("class Main { void run() { Sca|; } }", "complete");
        assertThat(imported.completions()).filteredOn(c -> c.label().equals("Scanner")).singleElement().satisfies(c -> assertThat(c.importName()).isEqualTo("java.util.Scanner"));
        var arrayList = query("class Main { void run() { ArrayL|; } }", "complete");
        assertThat(arrayList.completions()).filteredOn(c -> c.label().equals("ArrayList")).singleElement().satisfies(c -> assertThat(c.importName()).isEqualTo("java.util.ArrayList"));
    }

    @Test
    void completionPrefixAcceptsEverythingMonacoCanStillMatchAsTypingContinues() {
        // The editor filters this list locally on later keystrokes, so a case-sensitive prefix would lose these for good.
        var hump = query("class Main { void run() { int maxValue = 1, minVal = 2, other = 3; int x = mV|; } }", "complete");
        assertThat(hump.completions()).extracting(JavaEditorService.Completion::label).contains("maxValue", "minVal").doesNotContain("other");
        var lowercase = query("class Main { static class Edge { int to; } void run() { ed|; } }", "complete");
        assertThat(lowercase.completions()).extracting(JavaEditorService.Completion::label).contains("Edge");
        assertThat(JavaEditorService.matches("MAX_VALUE", "v")).isTrue();
        assertThat(JavaEditorService.matches("ArrayList", "al")).isTrue();
        assertThat(JavaEditorService.matches("nextInt", "xt")).as("first letter must start a word").isFalse();
        assertThat(JavaEditorService.matches("nextInt", "nti")).isTrue();
    }

    @Test
    void exactPrefixMatchesRankBeforeFuzzyOnesSoTheCapDropsOnlyWeakMatches() {
        var result = query("class Main { void run() { int maxSum = 0; S|; } }", "complete");
        var labels = result.completions().stream().map(JavaEditorService.Completion::label).toList();
        assertThat(labels).contains("String", "maxSum");
        assertThat(labels.indexOf("String")).isLessThan(labels.indexOf("maxSum"));
    }

    private static List<String> labels(JavaEditorService.Result result) {
        return result.completions().stream().map(JavaEditorService.Completion::label).distinct().toList();
    }

    @Test
    void valuesOfTheExpectedTypeRankFirst() {
        String body = "import java.util.*; class Main { %s run() { List<Integer> list = new ArrayList<>(); String s = \"\"; int n = 3; %s } }";
        var condition = labels(query(body.formatted("void", "if (list.|) {}"), "complete"));
        assertThat(condition.indexOf("isEmpty")).isLessThan(condition.indexOf("size"));
        for (String statement : List.of("int size = list.|;", "int m = Math.max(1, list.|);", "int[] a = new int[3]; a[list.|] = 1;")) {
            var integer = labels(query(body.formatted("void", statement), "complete"));
            assertThat(integer.indexOf("size")).as(statement).isLessThan(integer.indexOf("add"));
        }
        var returned = labels(query(body.formatted("int", "return list.|;"), "complete"));
        assertThat(returned.indexOf("size")).isLessThan(returned.indexOf("add"));
        var initializer = labels(query(body.formatted("void", "String t = |;"), "complete"));
        assertThat(initializer).doesNotContain("t");
        assertThat(initializer.indexOf("s")).isLessThan(initializer.indexOf("n"));
    }

    @Test
    void instanceReceiversHideStaticMembersAndListObjectAndDeprecatedMembersLast() {
        var text = query("class Main { void run() { String s = \"\"; s.|; } }", "complete");
        assertThat(labels(text)).contains("charAt", "substring").doesNotContain("valueOf", "format", "CASE_INSENSITIVE_ORDER");
        assertThat(labels(text).indexOf("wait")).isGreaterThan(labels(text).indexOf("trim"));
        assertThat(labels(query("class Main { void run() { String.|; } }", "complete"))).contains("valueOf", "format");
        var entry = query("import java.util.*; class Main { void run(Map<String, Integer> m) { for (var e : m.entrySet()) { e.| } } }", "complete");
        assertThat(labels(entry)).contains("getKey", "getValue").doesNotContain("comparingByKey", "copyOf");
        var thread = query("class Main { void run(Thread t) { t.st|; } }", "complete");
        assertThat(thread.completions()).filteredOn(c -> c.label().equals("stop")).allMatch(JavaEditorService.Completion::deprecated);
        assertThat(labels(thread).indexOf("stop")).isGreaterThan(labels(thread).indexOf("start"));
    }

    @Test
    void keywordsAndTemplateContextFollowThePosition() {
        record Case(String marked, String context, List<String> present, List<String> absent) { }
        String header = "class Main {\n";
        for (var c : List.of(
                new Case(header + "  p|\n  void run() {}\n}", "member", List.of("public", "private"), List.of("package")),
                new Case(header + "  @Override pu|\n  void run() {}\n}", "member", List.of("public"), List.of()),
                new Case(header + "  void run() thr|\n}", "member", List.of("throws"), List.of()),
                new Case("imp|\nclass Main {}", "top", List.of("import"), List.of()),
                new Case(header + "  int run() {\n    re|\n  }\n}", "statement", List.of("return"), List.of("requires")),
                new Case(header + "  void run(boolean b) { if (b) { }\n    el|\n  }\n}", "statement", List.of("else"), List.of()),
                new Case(header + "  void run() {\n    el|\n  }\n}", "statement", List.of(), List.of("else")),
                new Case(header + "  void run() { try { int q = 1; }\n    ca|\n  }\n}", "statement", List.of("catch"), List.of("case")),
                new Case(header + "  void run() { for (int i = 0; i < 3; i++) {\n    br|\n  } }\n}", "statement", List.of("break"), List.of()),
                new Case(header + "  void run() {\n    br|\n  }\n}", "statement", List.of(), List.of("break")),
                new Case(header + "  void run(int k) { switch (k) {\n    ca|\n  } }\n}", "switch", List.of("case"), List.of("catch")),
                new Case(header + "  public static void main(String[] args) {\n    th|\n  }\n}", "statement", List.of("throw"), List.of("this")),
                new Case(header + "  void run() {\n    th|\n  }\n}", "statement", List.of("this", "throw"), List.of()),
                new Case(header + "  void run(Object o) { if (o inst|) {} }\n}", "statement", List.of("instanceof"), List.of()),
                new Case(header + "  void run() { int[] a = new i|; }\n}", "new", List.of("int"), List.of("if")))) {
            var result = query(c.marked(), "complete");
            assertThat(result.context()).as(c.marked()).isEqualTo(c.context());
            var keywords = result.completions().stream().filter(k -> k.kind().equals("keyword")).map(JavaEditorService.Completion::label).toList();
            assertThat(keywords).as(c.marked()).containsAll(c.present());
            for (String absent : c.absent()) assertThat(keywords).as(c.marked()).doesNotContain(absent);
        }
        var ordered = labels(query(header + "  int run() {\n    re|\n  }\n}", "complete"));
        assertThat(ordered.indexOf("return")).isLessThan(ordered.indexOf("record"));
    }

    @Test
    void aNewDeclarationNameGetsNoExistingNames() {
        for (String marked : List.of("class Main { void run() { int count = 0; int c| } }", "class Main { static class Edge {} void run() { Edge e| } }",
                "class Main { int c| }", "class Main { void run(int k|) {} }")) {
            var result = query(marked, "complete");
            assertThat(result.context()).as(marked).isEqualTo("name");
            assertThat(result.completions()).as(marked).isEmpty();
        }
    }

    @Test
    void listsCutAtTheCapAreMarkedForRequestingAgain() {
        String source = "import java.util.*; import java.io.*; class Main { void run() { int value = 1; | } }";
        assertThat(query(source, "complete").incomplete()).isTrue();
        assertThat(query(source.replace("|", "Sc|"), "complete").incomplete()).isFalse();
    }

    private static JavaEditorService.Completion first(JavaEditorService.Result result, String label) {
        return result.completions().stream().filter(c -> c.label().equals(label)).findFirst().orElseThrow(() -> new AssertionError(label + " missing"));
    }

    @Test
    void theWholeJdkIsOfferedWithImportsAndNestedTypesByTheirOuterName() {
        var atomic = first(query("class Main { void run() { Ato|; } }", "complete"), "AtomicInteger");
        assertThat(atomic.importName()).isEqualTo("java.util.concurrent.atomic.AtomicInteger");
        var starImported = first(query("import java.util.*; class Main { void run() { Ent|; } }", "complete"), "Entry");
        assertThat(starImported.insertText()).isEqualTo("Map.Entry");
        assertThat(starImported.importName()).isNull();
        assertThat(first(query("class Main { void run() { Ent|; } }", "complete"), "Entry").importName()).isEqualTo("java.util.Map");
        var common = labels(query("import java.util.*; class Main { void run() { Arr|; } }", "complete"));
        assertThat(common.indexOf("ArrayList")).isLessThan(common.indexOf("ArrayStoreException"));
    }

    @Test
    void anUnimportedJdkReceiverListsItsMembersAndImportsItOnAccept() {
        var arrays = query("class Main { void run(int[] a) { Arrays.so|; } }", "complete");
        assertThat(arrays.completions()).filteredOn(c -> c.label().equals("sort")).isNotEmpty().allSatisfy(c -> assertThat(c.importName()).isEqualTo("java.util.Arrays"));
        var imported = query("import java.util.Arrays; class Main { void run(int[] a) { Arrays.so|; } }", "complete");
        assertThat(imported.completions()).filteredOn(c -> c.label().equals("sort")).allSatisfy(c -> assertThat(c.importName()).isNull());
    }

    @Test
    void afterNewOnlyTypesAppearAsConstructorCallsRankedByTheExpectedType() {
        String body = "import java.util.*; class Main { static class Edge { int to; } void run() { int local = 1; %s } }";
        var list = query(body.formatted("List<Integer> l = new |;"), "complete");
        assertThat(list.context()).isEqualTo("new");
        assertThat(list.completions().getFirst()).satisfies(c -> assertThat(c.insertText()).isEqualTo("ArrayList<>()"));
        assertThat(labels(list)).doesNotContain("local", "run");
        assertThat(labels(query(body.formatted("Map<Integer, Long> m = new |;"), "complete")).getFirst()).isEqualTo("HashMap");
        assertThat(labels(query(body.formatted("Comparator<int[]> c = new |;"), "complete")).getFirst()).isEqualTo("Comparator");
        assertThat(labels(query(body.formatted("long[] dp = new |;"), "complete")).getFirst()).isEqualTo("long");
        assertThat(first(query(body.formatted("Edge e = new E|;"), "complete"), "Edge").insertText()).isEqualTo("Edge()");
        assertThat(labels(query(body.formatted("Object o = new Mat|;"), "complete"))).contains("MathContext").doesNotContain("Math");
    }

    @Test
    void unknownNamesCarryTheImportsThatResolveThem() {
        var result = editor.analyze(new JavaEditorService.Request("class Main { void run(int[] a) { AtomicInteger x = new AtomicInteger(); Arrays.sort(a); } }", null, null));
        assertThat(result.diagnostics()).filteredOn(d -> d.code().contains("cant.resolve")).flatExtracting(JavaEditorService.Issue::imports)
                .contains("java.util.concurrent.atomic.AtomicInteger", "java.util.Arrays");
        assertThat(JavaEditorService.importFixes("Entry")).containsExactly("java.util.Map.Entry");
    }

    @Test
    void otherMethodBodiesAreIgnoredButTheirSignaturesAndDefinitionsRemain() {
        String marked = "class Main { int helper(int x) { return undefinedName + broken(; } void run() { int v = hel|; } }";
        var completion = query(marked, "complete");
        assertThat(labels(completion).getFirst()).isEqualTo("helper");
        String call = "class Main { int twice(int value) { return value * 2; } void run() { int r = tw|ice(2); } }";
        var inspect = query(call, "inspect");
        assertThat(inspect.hover().contents()).contains("int twice(int value)");
        assertThat(inspect.definition().start()).isEqualTo(call.replace("|", "").indexOf("twice"));
    }

    @Test
    void warmUpExercisesEveryOperationOnTheStarterTemplate() {
        var results = JavaEditorService.warmUpRequests().stream().map(editor::analyze).toList();
        assertThat(results.get(0).symbols()).isNotEmpty();
        assertThat(results.get(1).completions()).extracting(JavaEditorService.Completion::label).contains("nextInt");
        assertThat(results.get(2).completions()).extracting(JavaEditorService.Completion::label).contains("sum");
        assertThat(results.get(3).signatures()).isNotEmpty();
        assertThat(results.get(4).hover()).isNotNull();
    }

    @Test
    void returnsHoverAndExactSameBufferDefinition() {
        String marked = "class Main { int twice(int value) { return value * 2; } void run() { int result = tw|ice(2); } }";
        String source = marked.replace("|", "");
        var result = query(marked, "inspect");
        assertThat(result.hover()).isNotNull();
        assertThat(result.hover().contents()).contains("int twice(int value)");
        assertThat(source.substring(result.hover().start(), result.hover().end())).isEqualTo("twice");
        assertThat(result.definition()).isNotNull();
        assertThat(result.definition().start()).isEqualTo(source.indexOf("twice"));
        assertThat(source.substring(result.definition().start(), result.definition().end())).isEqualTo("twice");
        var jdk = query("class Main { void run() { System.out.print|ln(1); } }", "inspect");
        assertThat(jdk.hover().contents()).contains("println").contains("java.io.PrintStream");
        assertThat(jdk.definition()).isNull();
    }

    @Test
    void returnsOverloadsAndActiveParameterEvenDuringIncompleteTyping() {
        var complete = query("class Main { void run() { Math.max(1, |2); } }", "signature");
        assertThat(complete.signatures()).extracting(JavaEditorService.Signature::label).anyMatch(s -> s.contains("int max(int") && s.contains(", int"));
        assertThat(complete.activeParameter()).isEqualTo(1);
        var incomplete = query("class Main { void run() { System.out.println(| } }", "signature");
        assertThat(incomplete.signatures()).hasSizeGreaterThan(5);
        var nested = query("class Main { void run() { Math.max(Math.min(1, 2), |3); } }", "signature");
        assertThat(nested.activeParameter()).isEqualTo(1);
        var constructor = query("import java.util.*; class Main { void run() { Scanner input = new Scanner(|System.in); } }", "signature");
        assertThat(constructor.signatures()).extracting(JavaEditorService.Signature::label).anyMatch(s -> s.contains("Scanner(java.io.InputStream"));
    }

    @Test
    void doesNotExecuteInitializersGenerateClassFilesOrExposeBackendClasspath(@TempDir Path directory) throws Exception {
        Path forbidden = directory.resolve("must-not-exist.txt");
        String source = "class Dangerous { static { try { java.nio.file.Files.writeString(java.nio.file.Path.of(\"" + forbidden.toString().replace("\\", "\\\\") + "\"), \"executed\"); } catch (Exception e) {} } }";
        assertThat(editor.analyze(new JavaEditorService.Request(source, null, null)).diagnostics()).isEmpty();
        assertThat(forbidden).doesNotExist();
        try (var files = Files.list(directory)) { assertThat(files.toList()).isEmpty(); }
        var isolated = editor.analyze(new JavaEditorService.Request("import com.duipai.service.JavaEditorService; class Main {}", null, null));
        assertThat(isolated.diagnostics()).extracting(JavaEditorService.Issue::code).contains("compiler.err.doesnt.exist");
    }

    @Test
    void validatesBoundedRequestsAndNeverLeaksAnnotationProcessingIntoAnalysis() {
        for (var invalid : List.of(new JavaEditorService.Request(null, null, null), new JavaEditorService.Request("class Main {}", -1, null),
                new JavaEditorService.Request("class Main {}", 100, null), new JavaEditorService.Request("", 0, "execute"),
                new JavaEditorService.Request(" ".repeat(JavaEditorService.MAX_SOURCE_LENGTH + 1), null, null)))
            assertThatThrownBy(() -> editor.analyze(invalid)).isInstanceOf(ResponseStatusException.class);
        var source = "@Deprecated class Main { void run() { java.util.List raw = new java.util.ArrayList(); } }";
        assertThat(editor.analyze(new JavaEditorService.Request(source, null, null)).diagnostics()).anyMatch(d -> d.severity().equals("warning") && d.code().contains("raw"));
    }

    @Test
    void matchesExecutionEngineMainJavaFilenameRule() {
        assertThat(editor.analyze(new JavaEditorService.Request("public class Main {}", null, null)).diagnostics()).isEmpty();
        var wrongName = editor.analyze(new JavaEditorService.Request("public class Foo {}", null, null));
        assertThat(wrongName.diagnostics()).anyMatch(d -> d.severity().equals("error") && d.code().equals("compiler.err.class.public.should.be.in.file"));
        assertThat(editor.analyze(new JavaEditorService.Request("class Foo {}", null, null)).diagnostics()).isEmpty();
    }
}
