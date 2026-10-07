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
