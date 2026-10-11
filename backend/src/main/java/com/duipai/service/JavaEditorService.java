package com.duipai.service;

import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.TreeScanner;
import com.sun.source.util.Trees;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;
import java.io.IOException;
import java.io.StringWriter;
import java.net.URI;
import java.util.*;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A bounded, in-memory javac session per request; no user code or processors are run. */
@Service
public class JavaEditorService {
    private static final Logger LOG = LoggerFactory.getLogger(JavaEditorService.class);
    static final int MAX_SOURCE_LENGTH = 200_000;
    private static final int MAX_COMPLETIONS = 200;
    private static final String CURSOR = "__duipai_editor_cursor__";
    private static final Set<String> KEYWORDS = Set.of("abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "null", "package", "permits", "private", "protected", "public", "record", "return", "sealed", "short", "static", "super", "switch", "synchronized", "this", "throw", "throws", "true", "false", "try", "var", "void", "volatile", "while", "yield");
    private static final List<String> PRIMITIVE_TYPES = List.of("boolean", "byte", "char", "short", "int", "long", "float", "double");
    /** Keywords that can start the code at each position; the situational ones are added by Session.keywords. */
    private static final Map<String, List<String>> CONTEXT_KEYWORDS = Map.of(
            "top", List.of("import", "package", "static", "public", "final", "abstract", "sealed", "class", "interface", "enum", "record"),
            "member", concat(List.of("public", "private", "protected", "static", "final", "abstract", "synchronized", "native", "transient", "volatile", "sealed", "class", "interface", "enum", "record", "void"), PRIMITIVE_TYPES),
            "statement", concat(List.of("if", "for", "while", "do", "switch", "try", "return", "throw", "synchronized", "assert", "final", "var", "class", "record", "interface", "enum", "new", "null", "true", "false"), PRIMITIVE_TYPES),
            "expression", concat(List.of("new", "null", "true", "false", "switch"), PRIMITIVE_TYPES),
            "new", PRIMITIVE_TYPES,
            "switch", List.of("case", "default"));
    private final Semaphore compilerSlots = new Semaphore(2, true);
    private final AtomicLong infrastructureWarnings = new AtomicLong();

    public record Request(String source, Integer offset, String operation) { }
    /** {@code imports}: single-type imports that would resolve an unknown name, most common first. */
    public record Issue(int start, int end, String severity, String message, String code, List<String> imports) { }
    public record Symbol(String name, String kind, String detail, int start, int end, int selectionStart, int selectionEnd) { }
    public record Completion(String label, String kind, String detail, String insertText, String importName, boolean deprecated) { }
    public record Hover(int start, int end, String contents) { }
    public record Definition(int start, int end) { }
    public record Signature(String label, List<String> parameters) { }
    /**
     * {@code context} classifies a completion position: top, member, statement, expression, new, switch or name.
     * {@code incomplete} marks completions cut at the cap, which the editor must request again as typing narrows them.
     */
    public record Result(List<Issue> diagnostics, List<Symbol> symbols, List<Completion> completions,
                         Hover hover, Definition definition, List<Signature> signatures, int activeParameter, String context, boolean incomplete) { }

    /** A fresh JVM needs ~10x longer for its first javac session; pay that before the first keystroke. */
    @EventListener(ApplicationReadyEvent.class)
    public void warmUpInBackground() {
        Thread.ofPlatform().daemon(true).priority(Thread.MIN_PRIORITY).name("java-editor-warmup").start(this::warmUp);
    }

    /** Every editor operation once, on the template users see first. */
    static List<Request> warmUpRequests() {
        String source = Templates.BRUTE;
        int member = source.indexOf("in.nextInt") + "in.".length(), identifier = source.indexOf("sum +=") + 1;
        int call = source.indexOf("println(") + "println(".length(), symbol = source.indexOf("nextLong");
        return List.of(new Request(source, null, "analyze"), new Request(source, member, "complete"),
                new Request(source, identifier, "complete"), new Request(source, call, "signature"), new Request(source, symbol, "inspect"));
    }

    void warmUp() {
        try {
            JdkTypes.all();
            for (int round = 0; round < 4; round++) for (Request request : warmUpRequests()) analyze(request);
        } catch (RuntimeException unavailable) {
            // Busy or missing compiler: real requests report this themselves.
            LOG.debug("Java editor warm-up skipped", unavailable);
        }
    }

    public Result analyze(Request request) {
        if (request == null || request.source() == null)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请提供 Java 源代码");
        String source = request.source();
        if (source.length() > MAX_SOURCE_LENGTH)
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Java 源代码不能超过 200000 个字符");
        int offset = request.offset() == null ? source.length() : request.offset();
        if (offset < 0 || offset > source.length())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "编辑器位置超出源代码范围");
        String operation = request.operation() == null ? "analyze" : request.operation();
        if (!Set.of("analyze", "complete", "inspect", "signature").contains(operation))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不支持的 Java 编辑器操作");
        boolean acquired = false;
        try {
            acquired = compilerSlots.tryAcquire(2, TimeUnit.SECONDS);
            if (!acquired) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Java 代码分析繁忙，请稍后重试");
            JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
            if (compiler == null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Java 编辑器需要包含编译器的 JDK 21");
            Edit edit = operation.equals("complete") ? completionEdit(source, offset) : Edit.identity(source);
            DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
            try (StandardJavaFileManager standard = compiler.getStandardFileManager(collector, Locale.ENGLISH, java.nio.charset.StandardCharsets.UTF_8)) {
                // Only platform modules and this buffer are visible. User imports cannot inspect backend classes.
                standard.setLocationFromPaths(StandardLocation.CLASS_PATH, List.of());
                standard.setLocationFromPaths(StandardLocation.SOURCE_PATH, List.of());
                standard.setLocationFromPaths(StandardLocation.ANNOTATION_PROCESSOR_PATH, List.of());
                JavaFileManager files = new ForwardingJavaFileManager<>(standard) {
                    @Override public JavaFileObject getJavaFileForOutput(Location location, String name, JavaFileObject.Kind kind, FileObject sibling) throws IOException {
                        throw new IOException("Editor analysis cannot generate files");
                    }
                    @Override public FileObject getFileForOutput(Location location, String packageName, String relativeName, FileObject sibling) throws IOException {
                        throw new IOException("Editor analysis cannot generate files");
                    }
                };
                boolean diagnostics = operation.equals("analyze");
                String compiled = diagnostics ? edit.source() : focusOn(compiler, files, edit.source(), operation.equals("complete") ? edit.start() : offset);
                List<String> options = diagnostics ? List.of("-proc:none", "--release", "21", "-implicit:none", "-Xlint:all", "-Xmaxerrs", "100", "-Xmaxwarns", "100")
                        : List.of("-proc:none", "--release", "21", "-implicit:none");
                JavacTask task = (JavacTask) compiler.getTask(new StringWriter(), files, collector, options, null, List.of(sourceFile(compiled)));
                task.setLocale(Locale.ENGLISH);
                CompilationUnitTree unit = task.parse().iterator().next();
                task.analyze();
                Session session = new Session(source, offset, edit, unit, Trees.instance(task), task.getElements(), task.getTypes());
                return switch (operation) {
                    case "complete" -> session.complete();
                    case "inspect" -> session.inspect();
                    case "signature" -> session.signature();
                    default -> result(issues(collector, source), session.symbols(), List.of(), null, null, List.of(), 0);
                };
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Java 代码分析已中断");
        } catch (IOException | IllegalStateException error) {
            long count = infrastructureWarnings.incrementAndGet();
            // Keep a recurring infrastructure failure observable without flooding logs or logging user code.
            if (count <= 3 || count % 100 == 0)
                LOG.warn("Java editor compiler unavailable operation={} failureCount={}", operation, count, error);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Java 代码分析暂不可用", error);
        } finally {
            if (acquired) compilerSlots.release();
        }
    }

    // The execution engine also compiles Main.java; preserve its public-class-name rule.
    private static JavaFileObject sourceFile(String code) {
        return new SimpleJavaFileObject(URI.create("string:///Main.java"), JavaFileObject.Kind.SOURCE) {
            @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return code; }
        };
    }

    /**
     * Completion, hover and signature help only need the method being edited. Blanking every other method
     * body keeps all offsets, and attribution then costs the same for a 30-line or a 700-line file.
     */
    private static String focusOn(JavaCompiler compiler, JavaFileManager files, String source, int focus) {
        JavacTask parser = (JavacTask) compiler.getTask(new StringWriter(), files, new DiagnosticCollector<>(), List.of("-proc:none", "--release", "21"), null, List.of(sourceFile(source)));
        CompilationUnitTree unit;
        try { unit = parser.parse().iterator().next(); }
        catch (IOException | RuntimeException unparsable) { return source; }
        SourcePositions positions = Trees.instance(parser).getSourcePositions();
        char[] code = source.toCharArray();
        new TreeScanner<Void, Void>() {
            @Override public Void visitMethod(MethodTree method, Void ignored) {
                BlockTree body = method.getBody();
                if (body == null) return null;
                long start = positions.getStartPosition(unit, body), end = positions.getEndPosition(unit, body);
                if (start <= focus && focus <= end) return super.visitMethod(method, ignored);
                if (start < 0 || end > code.length || end - start < 2 || code[(int) start] != '{' || code[(int) end - 1] != '}') return null;
                for (int i = (int) start + 1; i < end - 1; i++) if (code[i] != '\n' && code[i] != '\r') code[i] = ' ';
                return null;
            }
        }.scan(unit, null);
        return new String(code);
    }

    private static Result result(List<Issue> issues, List<Symbol> symbols, List<Completion> completions,
                                 Hover hover, Definition definition, List<Signature> signatures, int activeParameter) {
        return new Result(issues, symbols, completions, hover, definition, signatures, activeParameter, null, false);
    }

    private static List<Issue> issues(DiagnosticCollector<JavaFileObject> collector, String source) {
        int length = source.length();
        return collector.getDiagnostics().stream().filter(d -> d.getKind() != Diagnostic.Kind.OTHER)
                .limit(100).map(d -> {
                    int start = clamp(d.getStartPosition() < 0 ? d.getPosition() : d.getStartPosition(), length);
                    int end = clamp(d.getEndPosition(), length);
                    if (end <= start) end = Math.min(length, start + 1);
                    String severity = d.getKind() == Diagnostic.Kind.ERROR ? "error"
                            : d.getKind() == Diagnostic.Kind.WARNING || d.getKind() == Diagnostic.Kind.MANDATORY_WARNING ? "warning" : "info";
                    // javac localizes the message text; the diagnostic range itself names the unknown symbol.
                    List<String> imports = d.getCode().contains("cant.resolve") ? importFixes(source.substring(start, end)) : List.of();
                    return new Issue(start, end, severity, d.getMessage(Locale.ENGLISH), d.getCode(), imports);
                }).toList();
    }

    /** AtomicInteger → java.util.concurrent.atomic.AtomicInteger; Entry → java.util.Map.Entry. */
    static List<String> importFixes(String name) {
        return JdkTypes.named(name).stream().filter(type -> type.fixImport() != null)
                .sorted(Comparator.comparing((JdkTypes.Type type) -> !JdkTypes.COMMON.contains(type.qualifiedName())).thenComparing(JdkTypes.Type::qualifiedName))
                .map(JdkTypes.Type::fixImport).distinct().toList();
    }

    private static List<String> concat(List<String> first, List<String> second) {
        List<String> result = new ArrayList<>(first);
        result.addAll(second);
        return List.copyOf(result);
    }

    private static int clamp(long position, int length) { return (int) Math.max(0, Math.min(length, position)); }

    private record Edit(String source, int start, int removed, int inserted) {
        static Edit identity(String source) { return new Edit(source, source.length(), 0, 0); }
        int original(long position) {
            if (position < 0) return -1;
            if (position <= start) return (int) position;
            if (position < start + inserted) return start + Math.min(removed, (int) position - start);
            return (int) position - inserted + removed;
        }
    }

    private static Edit completionEdit(String source, int offset) {
        int start = offset, end = offset;
        while (start > 0 && Character.isJavaIdentifierPart(source.charAt(start - 1))) start--;
        while (end < source.length() && Character.isJavaIdentifierPart(source.charAt(end))) end++;
        String marker = CURSOR + "()";
        // A method call remains a legal expression statement while a bare placeholder field does not.
        if (end < source.length() && source.charAt(end) == '(') marker = CURSOR;
        return new Edit(source.substring(0, start) + marker + source.substring(end), start, end - start, marker.length());
    }

    /** Keep UTF-16 positions while hiding strings, text blocks, characters and comments. */
    private static String mask(String source) {
        char[] result = source.toCharArray();
        for (int i = 0; i < result.length;) {
            if (i + 1 < result.length && result[i] == '/' && result[i + 1] == '/') {
                int end = source.indexOf('\n', i + 2); if (end < 0) end = result.length;
                Arrays.fill(result, i, end, ' '); i = end;
            } else if (i + 1 < result.length && result[i] == '/' && result[i + 1] == '*') {
                int end = source.indexOf("*/", i + 2); end = end < 0 ? result.length : end + 2;
                for (int j = i; j < end; j++) if (result[j] != '\n' && result[j] != '\r') result[j] = ' ';
                i = end;
            } else if (result[i] == '"' || result[i] == '\'') {
                char quote = result[i]; int start = i++;
                boolean textBlock = quote == '"' && source.startsWith("\"\"\"", start);
                if (textBlock) {
                    int end = source.indexOf("\"\"\"", start + 3); i = end < 0 ? result.length : end + 3;
                } else {
                    while (i < result.length) {
                        if (result[i] == '\\') { i = Math.min(result.length, i + 2); continue; }
                        if (result[i++] == quote) break;
                    }
                }
                for (int j = start; j < i; j++) if (result[j] != '\n' && result[j] != '\r') result[j] = ' ';
            } else i++;
        }
        return new String(result);
    }

    private static final class Session {
        final String source;
        final int offset;
        final Edit edit;
        final CompilationUnitTree unit;
        final Trees trees;
        final Elements elements;
        final Types types;
        final List<TreePath> paths = new ArrayList<>();

        Session(String source, int offset, Edit edit, CompilationUnitTree unit, Trees trees, Elements elements, Types types) {
            this.source = source; this.offset = offset; this.edit = edit; this.unit = unit;
            this.trees = trees; this.elements = elements; this.types = types;
            new TreePathScanner<Void, Void>() {
                @Override public Void scan(Tree tree, Void ignored) {
                    if (tree != null) {
                        TreePath path = getCurrentPath() == null ? new TreePath(unit) : new TreePath(getCurrentPath(), tree);
                        paths.add(path);
                    }
                    return super.scan(tree, ignored);
                }
            }.scan(unit, null);
        }

        int start(Tree tree) { return clamp(edit.original(trees.getSourcePositions().getStartPosition(unit, tree)), source.length()); }
        int end(Tree tree) { return clamp(edit.original(trees.getSourcePositions().getEndPosition(unit, tree)), source.length()); }
        Element element(TreePath path) { try { return trees.getElement(path); } catch (IllegalArgumentException ignored) { return null; } }
        TypeMirror type(TreePath path) { try { return trees.getTypeMirror(path); } catch (IllegalArgumentException ignored) { return null; } }
        Scope scope(TreePath path) {
            for (TreePath candidate = path; candidate != null; candidate = candidate.getParentPath()) {
                try { Scope scope = trees.getScope(candidate); if (scope != null) return scope; }
                catch (IllegalArgumentException | IllegalStateException ignored) { }
            }
            return null;
        }

        List<Symbol> symbols() {
            List<Symbol> result = new ArrayList<>();
            for (TreePath path : paths) {
                Tree tree = path.getLeaf(); Element element = element(path);
                if (element == null || trees.getSourcePositions().getStartPosition(unit, tree) < 0) continue;
                String kind = switch (element.getKind()) {
                    case CLASS, RECORD, ANNOTATION_TYPE -> "class";
                    case INTERFACE -> "interface";
                    case ENUM -> "enum";
                    case METHOD -> "method";
                    case CONSTRUCTOR -> "constructor";
                    case FIELD, ENUM_CONSTANT -> "field";
                    default -> null;
                };
                if (kind == null || !(tree instanceof ClassTree || tree instanceof MethodTree || tree instanceof VariableTree)) continue;
                if (tree instanceof VariableTree && path.getParentPath().getLeaf() instanceof MethodTree) continue;
                String name = displayName(element);
                int[] selection = declarationRange(path, name);
                if (selection == null) continue; // javac adds implicit constructors and record members.
                result.add(new Symbol(name, kind, describe(element, element.asType()), start(tree), end(tree), selection[0], selection[1]));
            }
            return result.stream().sorted(Comparator.comparingInt(Symbol::start)).toList();
        }

        /** How well a candidate's value suits the surrounding code (0 same type, 1 assignable, 2 not), and how far down it belongs regardless. */
        private record Candidate(Completion completion, int fit, int demotion, int order) { }
        private enum Access { STATIC, INSTANCE, ANY }
        private TypeMirror expected;
        private Element declaring;
        private String masked;
        /** After `new`: only types, written as constructor calls. */
        private boolean creating;

        String expectedName() {
            return expected != null && types.erasure(expected) instanceof DeclaredType declared && declared.asElement() instanceof TypeElement type
                    ? type.getQualifiedName().toString() : null;
        }

        /**
         * After `new` for an expected type: everyday implementations (ArrayList for List), then the type itself as an
         * anonymous class (Comparator), then other implementations, other abstract subtypes, and unrelated types.
         */
        int creationFit(String qualified, boolean subtype, boolean instantiable) {
            if (!subtype) return 4;
            if (instantiable) return JdkTypes.COMMON.contains(qualified) || !qualified.startsWith("java.") ? 0 : 2;
            return qualified.equals(expectedName()) ? 1 : 3;
        }

        boolean instantiable(TypeElement type) {
            return (type.getKind() == ElementKind.CLASS || type.getKind() == ElementKind.RECORD) && !type.getModifiers().contains(Modifier.ABSTRACT)
                    && type.getEnclosedElements().stream().anyMatch(e -> e.getKind() == ElementKind.CONSTRUCTOR && !e.getModifiers().contains(Modifier.PRIVATE));
        }

        boolean extensible(TypeElement type) {
            return type.getKind() == ElementKind.INTERFACE || type.getKind() == ElementKind.CLASS && type.getModifiers().contains(Modifier.ABSTRACT);
        }

        Result complete() {
            TreePath cursor = paths.stream().filter(path -> {
                Tree leaf = path.getLeaf();
                return leaf instanceof MemberSelectTree m && m.getIdentifier().contentEquals(CURSOR)
                        || leaf instanceof IdentifierTree i && i.getName().contentEquals(CURSOR);
            }).findFirst().orElseGet(() -> closest(edit.start()));
            String prefix = source.substring(edit.start(), offset);
            LinkedHashMap<String, Candidate> result = new LinkedHashMap<>();
            expected = expectedType(cursor);
            declaring = declaringVariable(cursor);
            if (cursor != null && cursor.getLeaf() instanceof MemberSelectTree member) {
                TreePath receiver = new TreePath(cursor, member.getExpression());
                TypeMirror receiverType = type(receiver);
                boolean typeReceiver = element(receiver) instanceof TypeElement;
                String importName = null;
                // `Arrays.` before `import java.util.Arrays;`: list that type's members and import it with the chosen one.
                if ((receiverType == null || receiverType.getKind() == TypeKind.ERROR) && member.getExpression() instanceof IdentifierTree name) {
                    List<JdkTypes.Type> known = JdkTypes.named(name.getName().toString()).stream().filter(type -> type.importName() != null && type.insertText().equals(type.name())).toList();
                    TypeElement resolved = known.size() == 1 ? elements.getTypeElement(known.getFirst().qualifiedName()) : null;
                    if (resolved != null) { receiverType = resolved.asType(); typeReceiver = true; importName = known.getFirst().fixImport(); }
                }
                addMembers(result, receiverType, typeReceiver ? Access.STATIC : Access.INSTANCE, scope(cursor), prefix, importName);
                return completed(result, prefix, null);
            }
            String context = context(cursor);
            // A new variable, field or parameter name: nothing that already exists belongs here.
            if (context.equals("name")) return completed(result, prefix, context);
            creating = context.equals("new");
            Scope scope = cursor == null ? null : scope(cursor);
            boolean staticContext = scope != null && scope.getEnclosingMethod() != null && scope.getEnclosingMethod().getModifiers().contains(Modifier.STATIC);
            if (scope != null) {
                Set<String> names = new HashSet<>();
                for (Scope current = scope; current != null; current = current.getEnclosingScope()) {
                    for (Element element : current.getLocalElements()) {
                        if (element.getSimpleName().toString().equals(CURSOR) || !names.add(element.getSimpleName().toString())) continue;
                        addCompletion(result, element, element.asType(), prefix, null);
                    }
                }
                TypeElement enclosing = scope.getEnclosingClass();
                if (enclosing != null) addMembers(result, enclosing.asType(), staticContext ? Access.STATIC : Access.ANY, scope, prefix, null);
            }
            Set<String> singleImports = new HashSet<>(), starImports = new HashSet<>();
            for (ImportTree item : unit.getImports()) {
                if (item.isStatic()) continue;
                String name = item.getQualifiedIdentifier().toString();
                if (name.endsWith(".*")) starImports.add(name.substring(0, name.length() - 2)); else singleImports.add(name);
            }
            String ownPackage = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
            for (JdkTypes.Type type : JdkTypes.all()) {
                if (!matches(type.name(), prefix) || creating && !type.instantiable() && !type.extensible()) continue;
                String owner = type.importName();
                boolean imported = owner == null || singleImports.contains(owner) || starImports.contains(owner.substring(0, owner.lastIndexOf('.')))
                        || ownPackage.equals(owner.substring(0, owner.lastIndexOf('.')));
                String insertion = creating && type.instantiable() ? type.insertText() + (type.generic() ? "<>()" : "()") : type.insertText();
                int fit = creating ? creationFit(type.qualifiedName(), expectedName() != null && type.supertypes().contains(expectedName()), type.instantiable()) : 2;
                int demotion = type.deprecated() ? 2 : JdkTypes.COMMON.contains(type.qualifiedName()) ? 0 : 1;
                result.putIfAbsent("class:" + type.qualifiedName(), new Candidate(new Completion(type.name(), "class", type.detail(), insertion,
                        imported ? null : owner, type.deprecated()), fit, demotion, 0));
            }
            List<String> keywords = keywords(cursor, context, staticContext);
            TypeMirror element = expected;
            while (element instanceof ArrayType array) element = array.getComponentType();
            for (int i = 0; i < keywords.size(); i++) if (matches(keywords.get(i), prefix)) result.putIfAbsent("keyword:" + keywords.get(i),
                    new Candidate(new Completion(keywords.get(i), "keyword", "Java 关键字", keywords.get(i), null, false),
                            creating && expected instanceof ArrayType && element.getKind().isPrimitive() && element.toString().equals(keywords.get(i)) ? 0 : 4, 0, i));
            return completed(result, prefix, context);
        }

        TreePath closest(int position) {
            return paths.stream().filter(p -> start(p.getLeaf()) <= position && end(p.getLeaf()) >= position)
                    .min(Comparator.comparingInt(p -> end(p.getLeaf()) - start(p.getLeaf()))).orElse(null);
        }

        /** Where an unqualified identifier is typed. javac drops a marker that cannot start a member, so fall back to what encloses it. */
        String context(TreePath cursor) {
            if (cursor == null) return "top";
            Tree leaf = cursor.getLeaf();
            if (leaf instanceof IdentifierTree) {
                TreePath parent = cursor.getParentPath();
                if (parent.getLeaf() instanceof NewClassTree created && created.getIdentifier() == leaf) return "new";
                // `void run() thr|` has no body yet; javac's recovery invents one around the marker.
                if (inMethodHeader(cursor)) return "member";
                TreePath expression = parent.getLeaf() instanceof MethodInvocationTree call && call.getMethodSelect() == leaf ? parent : cursor;
                return expression.getParentPath().getLeaf() instanceof ExpressionStatementTree ? "statement" : "expression";
            }
            boolean naming = paths.stream().anyMatch(path -> path.getLeaf() instanceof VariableTree variable && variable.getName().contentEquals(CURSOR)
                    && (variable.getType() == null || resolves(new TreePath(path, variable.getType())))
                    || path.getLeaf() instanceof MethodTree method && method.getName().contentEquals(CURSOR)
                    && method.getReturnType() != null && resolves(new TreePath(path, method.getReturnType())));
            if (naming) return "name";
            for (TreePath path = cursor; path != null; path = path.getParentPath()) {
                Tree tree = path.getLeaf();
                if (tree instanceof BlockTree || tree instanceof CaseTree) return "statement";
                if (tree instanceof SwitchTree || tree instanceof SwitchExpressionTree) return "switch";
                if (tree instanceof ClassTree type) {
                    // Before a top-level class's `{` is its header or the imports above it, which javac may attach to it.
                    int brace = masked().indexOf('{', start(type));
                    return brace >= 0 && brace < edit.start() || enclosingClass(path.getParentPath()) != null ? "member" : "top";
                }
            }
            return "top";
        }

        /** `int total = tot|` must not offer the variable it is initializing. */
        Element declaringVariable(TreePath cursor) {
            for (TreePath path = cursor; path != null && path.getParentPath() != null; path = path.getParentPath()) {
                Tree parent = path.getParentPath().getLeaf();
                if (parent instanceof VariableTree variable && variable.getInitializer() == path.getLeaf()) return element(path.getParentPath());
                if (parent instanceof StatementTree || parent instanceof ClassTree) return null;
            }
            return null;
        }

        /** Trees.getScope attributes a copy of the method, so its locals are distinct symbols with equal names. */
        boolean isDeclaring(Element element) {
            return declaring != null && element.getKind() == declaring.getKind() && element.getSimpleName().contentEquals(declaring.getSimpleName());
        }

        boolean inMethodHeader(TreePath cursor) {
            for (TreePath path = cursor; path != null; path = path.getParentPath()) {
                if (path.getLeaf() instanceof ClassTree) return false;
                if (path.getLeaf() instanceof MethodTree method) {
                    int brace = masked().indexOf('{', Math.max(start(method), end(method.getModifiers())));
                    return brace < 0 || brace >= edit.start();
                }
            }
            return false;
        }

        String masked() { return masked == null ? masked = mask(source) : masked; }

        boolean resolves(TreePath typeTree) {
            TypeMirror type = type(typeTree);
            return type != null && type.getKind() != TypeKind.ERROR;
        }

        List<String> keywords(TreePath cursor, String context, boolean staticContext) {
            Set<String> words = new LinkedHashSet<>(CONTEXT_KEYWORDS.getOrDefault(context, List.of()));
            String previous = previousToken();
            String last = previous.substring(previous.lastIndexOf('.') + 1);
            boolean afterValue = previous.equals("]") || !last.isEmpty() && Character.isJavaIdentifierPart(last.charAt(0))
                    && (!KEYWORDS.contains(last) || Set.of("this", "super", "null", "true", "false", "class").contains(last));
            if (context.equals("statement") || context.equals("expression")) {
                if (!staticContext) words.addAll(List.of("this", "super"));
                if (afterValue) words.add("instanceof");
            }
            if (context.equals("member") || context.equals("top")) {
                if (afterValue) words.addAll(List.of("extends", "implements", "permits"));
                if (previous.equals(")")) words.add("throws");
                if (cursor != null && enclosingClass(cursor) instanceof ClassTree type && type.getKind() == Tree.Kind.INTERFACE) words.add("default");
            }
            if (context.equals("statement") && cursor != null) words.addAll(statementKeywords(cursor));
            return List.copyOf(words);
        }

        /** Keywords valid only after a particular statement or inside a loop or switch. */
        List<String> statementKeywords(TreePath cursor) {
            List<String> words = new ArrayList<>();
            TreePath statement = cursor;
            while (statement != null && !(statement.getLeaf() instanceof ExpressionStatementTree)) statement = statement.getParentPath();
            if (statement != null && statement.getParentPath() != null) {
                Tree container = statement.getParentPath().getLeaf();
                List<? extends StatementTree> siblings = container instanceof BlockTree block ? block.getStatements()
                        : container instanceof CaseTree label && label.getStatements() != null ? label.getStatements() : List.of();
                int index = siblings.indexOf(statement.getLeaf());
                StatementTree before = index > 0 ? siblings.get(index - 1) : null;
                if (before instanceof IfTree branch && branch.getElseStatement() == null) words.add("else");
                if (before instanceof TryTree attempt && attempt.getFinallyBlock() == null) words.addAll(List.of("catch", "finally"));
                if (container instanceof CaseTree) words.addAll(List.of("case", "default"));
            }
            for (TreePath path = cursor; path != null; path = path.getParentPath()) {
                Tree tree = path.getLeaf();
                if (tree instanceof MethodTree || tree instanceof LambdaExpressionTree || tree instanceof ClassTree) break;
                if (tree instanceof ForLoopTree || tree instanceof EnhancedForLoopTree || tree instanceof WhileLoopTree || tree instanceof DoWhileLoopTree)
                    words.addAll(List.of("break", "continue"));
                if (tree instanceof SwitchTree) words.add("break");
                if (tree instanceof SwitchExpressionTree) words.add("yield");
            }
            return words;
        }

        Tree enclosingClass(TreePath path) {
            for (TreePath current = path; current != null; current = current.getParentPath())
                if (current.getLeaf() instanceof ClassTree type) return type;
            return null;
        }

        /** The code token just before the identifier on the same line; "@" for an annotation name. */
        String previousToken() {
            String masked = masked();
            int i = edit.start() - 1;
            while (i >= 0 && (masked.charAt(i) == ' ' || masked.charAt(i) == '\t')) i--;
            if (i < 0 || masked.charAt(i) == '\n' || masked.charAt(i) == '\r') return "";
            if (!Character.isJavaIdentifierPart(masked.charAt(i))) return String.valueOf(masked.charAt(i));
            int end = i + 1;
            while (i >= 0 && (Character.isJavaIdentifierPart(masked.charAt(i)) || masked.charAt(i) == '.')) i--;
            return i >= 0 && masked.charAt(i) == '@' ? "@" : masked.substring(i + 1, end);
        }

        /** The type the surrounding code needs from the expression being completed, when it is evident. */
        TypeMirror expectedType(TreePath cursor) {
            if (cursor == null || cursor.getParentPath() == null) return null;
            Tree holder = cursor.getParentPath().getLeaf();
            // The marker is wrapped as `marker()` or, after `new`, as `new marker()`: the expected type belongs to that whole expression.
            TreePath path = holder instanceof MethodInvocationTree call && call.getMethodSelect() == cursor.getLeaf()
                    || holder instanceof NewClassTree created && created.getIdentifier() == cursor.getLeaf() ? cursor.getParentPath() : cursor;
            for (; path.getParentPath() != null; path = path.getParentPath()) {
                Tree child = path.getLeaf();
                TreePath parentPath = path.getParentPath();
                Tree parent = parentPath.getLeaf();
                if (parent instanceof ParenthesizedTree || parent instanceof ConditionalExpressionTree choice && choice.getCondition() != child) continue;
                TypeMirror type = null;
                if (parent instanceof IfTree t && t.getCondition() == child || parent instanceof WhileLoopTree w && w.getCondition() == child
                        || parent instanceof DoWhileLoopTree d && d.getCondition() == child || parent instanceof ForLoopTree f && f.getCondition() == child
                        || parent instanceof ConditionalExpressionTree || parent instanceof UnaryTree unary && unary.getKind() == Tree.Kind.LOGICAL_COMPLEMENT
                        || parent instanceof BinaryTree binary && (binary.getKind() == Tree.Kind.CONDITIONAL_AND || binary.getKind() == Tree.Kind.CONDITIONAL_OR))
                    type = types.getPrimitiveType(TypeKind.BOOLEAN);
                else if (parent instanceof VariableTree variable && variable.getInitializer() == child && element(parentPath) instanceof VariableElement declared)
                    type = declared.asType();
                else if (parent instanceof AssignmentTree assignment && assignment.getExpression() == child)
                    type = type(new TreePath(parentPath, assignment.getVariable()));
                else if (parent instanceof CompoundAssignmentTree assignment && assignment.getExpression() == child) {
                    // `text += anything` compiles; only a numeric target says something about the value.
                    TypeMirror target = type(new TreePath(parentPath, assignment.getVariable()));
                    type = target != null && target.getKind().isPrimitive() ? target : null;
                } else if (parent instanceof ArrayAccessTree access && access.getIndex() == child)
                    type = types.getPrimitiveType(TypeKind.INT);
                else if (parent instanceof ReturnTree)
                    type = returnType(parentPath);
                else if (parent instanceof MethodInvocationTree call && call.getArguments().contains(child))
                    type = parameterType(new TreePath(parentPath, call.getMethodSelect()), call.getArguments().indexOf(child));
                else if (parent instanceof NewClassTree created && created.getArguments().contains(child))
                    type = parameterType(parentPath, created.getArguments().indexOf(child));
                return type == null || type.getKind() == TypeKind.ERROR || type.getKind() == TypeKind.VOID || type.getKind() == TypeKind.NONE ? null : type;
            }
            return null;
        }

        TypeMirror returnType(TreePath path) {
            for (TreePath current = path; current != null; current = current.getParentPath()) {
                if (current.getLeaf() instanceof LambdaExpressionTree || current.getLeaf() instanceof ClassTree) return null;
                if (current.getLeaf() instanceof MethodTree) return element(current) instanceof ExecutableElement method ? method.getReturnType() : null;
            }
            return null;
        }

        /** javac usually still resolves the call around an unresolvable argument when only one overload fits its arity. */
        TypeMirror parameterType(TreePath target, int index) {
            if (!(element(target) instanceof ExecutableElement method)) return null;
            TypeMirror type = method.asType();
            if (target.getLeaf() instanceof MemberSelectTree member && type(new TreePath(target, member.getExpression())) instanceof DeclaredType receiver) {
                try { type = types.asMemberOf(receiver, method); } catch (IllegalArgumentException ignored) { }
            }
            List<? extends TypeMirror> parameters = ((ExecutableType) type).getParameterTypes();
            if (parameters.isEmpty()) return null;
            if (method.isVarArgs() && index >= parameters.size() - 1 && parameters.getLast() instanceof ArrayType varargs)
                return index == parameters.size() - 1 ? null : varargs.getComponentType();
            return index < parameters.size() ? parameters.get(index) : null;
        }

        void addMembers(Map<String, Candidate> result, TypeMirror receiver, Access access, Scope scope, String prefix, String importName) {
            if (receiver == null) return;
            if (receiver.getKind() == TypeKind.ARRAY) {
                if (access != Access.STATIC && matches("length", prefix)) result.put("field:length",
                        new Candidate(new Completion("length", "field", "int length", "length", null, false), fit(types.getPrimitiveType(TypeKind.INT)), 0, 0));
                receiver = elements.getTypeElement("java.lang.Object").asType();
            }
            if (receiver instanceof TypeVariable variable) receiver = variable.getUpperBound();
            if (!(receiver instanceof DeclaredType declared) || !(declared.asElement() instanceof TypeElement type)) return;
            for (Element member : elements.getAllMembers(type)) {
                boolean isStatic = member.getModifiers().contains(Modifier.STATIC);
                if (member.getKind() == ElementKind.CONSTRUCTOR || access == Access.STATIC && !isStatic) continue;
                // `value.staticMethod()` hides intent, static interface methods cannot be called this way at all, and types are not values.
                if (access == Access.INSTANCE && (isStatic || member.getKind().isClass() || member.getKind().isInterface())) continue;
                if (!accessible(scope, member, declared)) continue;
                TypeMirror memberType;
                try { memberType = types.asMemberOf(declared, member); }
                catch (IllegalArgumentException ignored) { memberType = member.asType(); }
                addCompletion(result, member, memberType, prefix, importName);
            }
        }

        boolean accessible(Scope scope, Element member, DeclaredType type) {
            if (scope == null) return member.getModifiers().contains(Modifier.PUBLIC);
            try { return trees.isAccessible(scope, member, type); }
            catch (IllegalArgumentException ignored) { return member.getModifiers().contains(Modifier.PUBLIC); }
        }

        void addCompletion(Map<String, Candidate> result, Element element, TypeMirror type, String prefix, String importName) {
            String name = element.getSimpleName().toString();
            if (name.startsWith("__") || name.equals("this") || name.equals("super") || !matches(name, prefix) || isDeclaring(element)) return;
            String kind = switch (element.getKind()) {
                case METHOD -> "method";
                case FIELD, ENUM_CONSTANT -> "field";
                case LOCAL_VARIABLE, PARAMETER, EXCEPTION_PARAMETER, RESOURCE_VARIABLE, BINDING_VARIABLE -> "variable";
                case CLASS, INTERFACE, ENUM, RECORD, ANNOTATION_TYPE -> "class";
                default -> null;
            };
            if (kind == null || creating && !kind.equals("class")) return;
            String detail = describe(element, type);
            String insertion = kind.equals("method") ? name + "(" + (((ExecutableType) type).getParameterTypes().isEmpty() ? ")" : "") : name;
            String key = kind.equals("method") ? kind + ":" + detail : kind + ":" + name;
            boolean deprecated = elements.isDeprecated(element);
            int fit = kind.equals("class") ? 2 : fit(type instanceof ExecutableType method ? method.getReturnType() : type);
            // Object's wait/notify/hashCode clutter every member list; IDEA lists them last.
            int demotion = deprecated ? 2 : element.getEnclosingElement() instanceof TypeElement owner && owner.getQualifiedName().contentEquals("java.lang.Object") ? 1 : 0;
            if (element instanceof TypeElement declared) {
                String qualified = declared.getQualifiedName().toString();
                key = "class:" + qualified;
                // This file's own classes and everyday JDK types before the long tail of the platform.
                demotion = deprecated ? 2 : trees.getPath(declared) != null || JdkTypes.COMMON.contains(qualified) ? 0 : 1;
                if (creating) {
                    boolean instantiable = instantiable(declared);
                    if (!instantiable && !extensible(declared)) return;
                    if (instantiable) insertion = name + (declared.getTypeParameters().isEmpty() ? "()" : "<>()");
                    TypeMirror target = expected == null ? null : types.erasure(expected);
                    fit = creationFit(qualified, target != null && types.isSubtype(types.erasure(declared.asType()), target), instantiable);
                }
            }
            result.putIfAbsent(key, new Candidate(new Completion(name, kind, detail, insertion, importName, deprecated), fit, demotion, 0));
        }

        /** For `int size = list.|`, int size() comes before Integer get(int), which needs unboxing. */
        int fit(TypeMirror value) {
            if (expected == null || value == null || value.getKind() == TypeKind.VOID || value.getKind() == TypeKind.ERROR) return 2;
            try { return types.isSameType(value, expected) ? 0 : types.isAssignable(value, expected) ? 1 : 2; }
            catch (IllegalArgumentException ignored) { return 2; }
        }

        /**
         * Exact prefixes first, so the cap only ever drops the weakest fuzzy matches; then values of the
         * expected type, then locals before fields, methods, classes and keywords, with Object's and
         * deprecated members last. Keywords keep their hand-picked order: `return` before `record`.
         */
        Result completed(Map<String, Candidate> result, String prefix, String context) {
            List<Completion> completions = result.values().stream().sorted(Comparator.comparingInt((Candidate c) -> matchRank(c.completion().label(), prefix))
                    .thenComparingInt(Candidate::fit)
                    .thenComparing(c -> switch (c.completion().kind()) {
                        case "variable" -> 0; case "field" -> 1; case "method" -> 2; case "class" -> 3; default -> 4;
                    })
                    .thenComparingInt(Candidate::demotion).thenComparingInt(Candidate::order)
                    .thenComparing(c -> c.completion().label()).thenComparing(c -> c.completion().detail()))
                    .limit(MAX_COMPLETIONS).map(Candidate::completion).toList();
            return new Result(List.of(), List.of(), completions, null, null, List.of(), 0, context, result.size() > MAX_COMPLETIONS);
        }

        Result inspect() {
            TreePath path = paths.stream().filter(p -> p.getLeaf() instanceof IdentifierTree || p.getLeaf() instanceof MemberSelectTree
                            || p.getLeaf() instanceof ClassTree || p.getLeaf() instanceof MethodTree || p.getLeaf() instanceof VariableTree)
                    .filter(p -> { int[] range = referenceRange(p); return range != null && range[0] <= offset && offset < range[1]; })
                    .min(Comparator.comparingInt(p -> end(p.getLeaf()) - start(p.getLeaf()))).orElse(null);
            if (path == null || element(path) == null) return result(List.of(), List.of(), List.of(), null, null, List.of(), 0);
            Element element = element(path);
            TypeMirror type = element.asType();
            if (path.getLeaf() instanceof MemberSelectTree member) {
                TypeMirror receiver = type(new TreePath(path, member.getExpression()));
                if (receiver instanceof DeclaredType declared) try { type = types.asMemberOf(declared, element); } catch (IllegalArgumentException ignored) { }
            }
            int[] range = referenceRange(path);
            String owner = element.getEnclosingElement() instanceof TypeElement enclosing ? "\n" + enclosing.getQualifiedName() : "";
            String comment = trees.getDocComment(path);
            Hover hover = new Hover(range[0], range[1], describe(element, type) + owner + (comment == null || comment.isBlank() ? "" : "\n\n" + comment.strip()));
            TreePath declaration = trees.getPath(element);
            Definition definition = null;
            if (declaration != null && declaration.getCompilationUnit() == unit) {
                int[] selection = declarationRange(declaration, displayName(element));
                if (selection != null) definition = new Definition(selection[0], selection[1]);
            }
            return result(List.of(), List.of(), List.of(), hover, definition, List.of(), 0);
        }

        Result signature() {
            String masked = mask(source);
            Deque<Integer> parentheses = new ArrayDeque<>();
            for (int i = 0; i < offset; i++) {
                if (masked.charAt(i) == '(') parentheses.push(i);
                else if (masked.charAt(i) == ')' && !parentheses.isEmpty()) parentheses.pop();
            }
            for (int opening : parentheses) {
                TreePath invocation = paths.stream().filter(p -> p.getLeaf() instanceof MethodInvocationTree || p.getLeaf() instanceof NewClassTree)
                        .filter(p -> {
                            Tree target = p.getLeaf() instanceof MethodInvocationTree call ? call.getMethodSelect() : ((NewClassTree) p.getLeaf()).getIdentifier();
                            int targetEnd = end(target);
                            return targetEnd <= opening && targetEnd >= 0 && masked.substring(targetEnd, opening).isBlank();
                        }).findFirst().orElse(null);
                if (invocation == null) continue;
                Tree target = invocation.getLeaf() instanceof MethodInvocationTree call ? call.getMethodSelect() : ((NewClassTree) invocation.getLeaf()).getIdentifier();
                TreePath targetPath = new TreePath(invocation, target);
                String name = target instanceof MemberSelectTree member ? member.getIdentifier().toString()
                        : target instanceof IdentifierTree identifier ? identifier.getName().toString() : "";
                Scope scope = scope(invocation);
                TypeMirror receiver = null; boolean staticReceiver = false; boolean constructor = invocation.getLeaf() instanceof NewClassTree;
                if (constructor) receiver = type(targetPath);
                else if (target instanceof MemberSelectTree member) {
                    TreePath receiverPath = new TreePath(targetPath, member.getExpression());
                    receiver = type(receiverPath); staticReceiver = element(receiverPath) instanceof TypeElement;
                } else if (scope != null && scope.getEnclosingClass() != null) {
                    receiver = scope.getEnclosingClass().asType();
                    staticReceiver = scope.getEnclosingMethod() != null && scope.getEnclosingMethod().getModifiers().contains(Modifier.STATIC);
                }
                List<Signature> signatures = new ArrayList<>();
                if (receiver instanceof DeclaredType declared && declared.asElement() instanceof TypeElement enclosing) {
                    List<? extends Element> members = constructor ? enclosing.getEnclosedElements() : elements.getAllMembers(enclosing);
                    for (Element member : members) {
                        if (!(member instanceof ExecutableElement method) || constructor != (method.getKind() == ElementKind.CONSTRUCTOR)) continue;
                        if (!constructor && (!method.getSimpleName().contentEquals(name) || staticReceiver && !method.getModifiers().contains(Modifier.STATIC))) continue;
                        if (!accessible(scope, member, declared)) continue;
                        ExecutableType methodType = (ExecutableType) types.asMemberOf(declared, method);
                        List<String> parameters = parameters(method, methodType);
                        signatures.add(new Signature(describe(method, methodType), parameters));
                    }
                }
                // Static imports also have resolvable executable elements, even without a receiver class.
                Element resolved = element(targetPath);
                if (signatures.isEmpty() && resolved instanceof ExecutableElement method)
                    signatures.add(new Signature(describe(method, method.asType()), parameters(method, (ExecutableType) method.asType())));
                int active = activeParameter(masked, opening + 1, offset);
                signatures = signatures.stream().distinct().sorted(Comparator.comparingInt((Signature s) ->
                        s.parameters().size() > active ? s.parameters().size() : 1000 + s.parameters().size()).thenComparing(Signature::label)).limit(40).toList();
                if (!signatures.isEmpty()) return result(List.of(), List.of(), List.of(), null, null, signatures, active);
            }
            return result(List.of(), List.of(), List.of(), null, null, List.of(), 0);
        }

        int[] referenceRange(TreePath path) {
            Tree tree = path.getLeaf();
            if (tree instanceof MemberSelectTree member) {
                int end = end(tree); return new int[]{Math.max(start(tree), end - member.getIdentifier().length()), end};
            }
            if (tree instanceof IdentifierTree) return new int[]{start(tree), end(tree)};
            Element element = element(path); return element == null ? null : declarationRange(path, displayName(element));
        }

        int[] declarationRange(TreePath path, String name) {
            Tree tree = path.getLeaf(); int start = start(tree), end = end(tree);
            if (end <= start || name.isBlank()) return null;
            String masked = mask(source);
            int limit = end;
            if (tree instanceof MethodTree method && method.getBody() != null) limit = start(method.getBody());
            if (tree instanceof ClassTree) {
                int brace = masked.indexOf('{', start); if (brace >= start && brace < limit) limit = brace;
            }
            if (tree instanceof VariableTree variable && variable.getInitializer() != null) limit = start(variable.getInitializer());
            Matcher matcher = Pattern.compile("(?<![\\p{javaJavaIdentifierPart}])" + Pattern.quote(name) + "(?![\\p{javaJavaIdentifierPart}])").matcher(masked);
            matcher.region(start, Math.max(start, limit));
            int[] match = null;
            while (matcher.find()) {
                if (tree instanceof MethodTree) {
                    int next = matcher.end(); while (next < limit && Character.isWhitespace(masked.charAt(next))) next++;
                    if (next >= limit || masked.charAt(next) != '(') continue;
                }
                match = new int[]{matcher.start(), matcher.end()};
                if (tree instanceof ClassTree) break;
            }
            return match;
        }
    }

    /**
     * Monaco filters the returned list itself and keeps filtering it as the user types on, so this
     * accepts every name its matcher could accept for some continuation of the prefix: the first
     * character at a word start (beginning, upper case, after '_' or '$'), ignoring case, and the
     * remaining characters in order. "mV" finds maxValue and "ed" finds Edge.
     */
    static boolean matches(String name, String prefix) {
        if (prefix.isEmpty()) return true;
        for (int start = 0; start < name.length(); start++) {
            if (!wordStart(name, start) || !sameLetter(name.charAt(start), prefix.charAt(0))) continue;
            int next = 1;
            for (int i = start + 1; i < name.length() && next < prefix.length(); i++)
                if (sameLetter(name.charAt(i), prefix.charAt(next))) next++;
            if (next == prefix.length()) return true;
        }
        return false;
    }

    /** 0: exact prefix, 1: prefix ignoring case, 2: other word-start match. */
    static int matchRank(String name, String prefix) {
        if (name.startsWith(prefix)) return 0;
        return name.regionMatches(true, 0, prefix, 0, prefix.length()) ? 1 : 2;
    }

    private static boolean wordStart(String name, int index) {
        if (index == 0) return true;
        char current = name.charAt(index), previous = name.charAt(index - 1);
        return Character.isUpperCase(current) || current == '_' || current == '$' || previous == '_' || previous == '$';
    }

    private static boolean sameLetter(char left, char right) { return Character.toLowerCase(left) == Character.toLowerCase(right); }

    private static int activeParameter(String source, int start, int end) {
        int nested = 0, active = 0;
        for (int i = start; i < end; i++) {
            char c = source.charAt(i);
            if (c == '(' || c == '[' || c == '{') nested++;
            else if (c == ')' || c == ']' || c == '}') nested--;
            else if (c == ',' && nested == 0) active++;
        }
        return active;
    }

    private static String displayName(Element element) {
        return element.getKind() == ElementKind.CONSTRUCTOR ? element.getEnclosingElement().getSimpleName().toString() : element.getSimpleName().toString();
    }

    private static List<String> parameters(ExecutableElement method, ExecutableType type) {
        List<String> result = new ArrayList<>();
        for (int i = 0; i < type.getParameterTypes().size(); i++) {
            String parameterType = type.getParameterTypes().get(i).toString();
            if (method.isVarArgs() && i == type.getParameterTypes().size() - 1 && parameterType.endsWith("[]"))
                parameterType = parameterType.substring(0, parameterType.length() - 2) + "...";
            String name = i < method.getParameters().size() ? method.getParameters().get(i).getSimpleName().toString() : "arg" + i;
            result.add(parameterType + " " + name);
        }
        return result;
    }

    private static String describe(Element element, TypeMirror type) {
        if (element instanceof ExecutableElement method && type instanceof ExecutableType executable) {
            String typeParameters = method.getTypeParameters().isEmpty() ? "" : "<" + String.join(", ", method.getTypeParameters().stream().map(Object::toString).toList()) + "> ";
            String returnType = method.getKind() == ElementKind.CONSTRUCTOR ? "" : executable.getReturnType() + " ";
            return typeParameters + returnType + displayName(element) + "(" + String.join(", ", parameters(method, executable)) + ")";
        }
        if (element instanceof TypeElement declared) return element.getKind().name().toLowerCase(Locale.ROOT) + " " + declared.getQualifiedName();
        return type + " " + displayName(element);
    }
}
