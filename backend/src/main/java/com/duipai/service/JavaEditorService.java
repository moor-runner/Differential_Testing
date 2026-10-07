package com.duipai.service;

import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
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
    private static final List<String> KEYWORDS = List.of("abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "null", "package", "private", "protected", "public", "record", "return", "short", "static", "super", "switch", "synchronized", "this", "throw", "throws", "true", "false", "try", "var", "void", "volatile", "while", "yield");
    private static final List<String> JDK_TYPES = List.of("java.util.Scanner", "java.util.List", "java.util.ArrayList", "java.util.LinkedList", "java.util.Map", "java.util.HashMap", "java.util.TreeMap", "java.util.Set", "java.util.HashSet", "java.util.TreeSet", "java.util.Arrays", "java.util.Collections", "java.util.Comparator", "java.util.Queue", "java.util.Deque", "java.util.ArrayDeque", "java.util.PriorityQueue", "java.util.Random", "java.util.Optional", "java.util.StringTokenizer", "java.util.Objects", "java.io.BufferedReader", "java.io.InputStreamReader", "java.io.BufferedWriter", "java.io.OutputStreamWriter", "java.io.PrintWriter", "java.io.IOException", "java.math.BigInteger", "java.math.BigDecimal", "java.util.stream.Stream", "java.util.stream.IntStream", "java.lang.String", "java.lang.StringBuilder", "java.lang.Math", "java.lang.System", "java.lang.Integer", "java.lang.Long", "java.lang.Double", "java.lang.Character", "java.lang.Object", "java.lang.Thread");
    private final Semaphore compilerSlots = new Semaphore(2, true);
    private final AtomicLong infrastructureWarnings = new AtomicLong();

    public record Request(String source, Integer offset, String operation) { }
    public record Issue(int start, int end, String severity, String message, String code) { }
    public record Symbol(String name, String kind, String detail, int start, int end, int selectionStart, int selectionEnd) { }
    public record Completion(String label, String kind, String detail, String insertText, String importName) { }
    public record Hover(int start, int end, String contents) { }
    public record Definition(int start, int end) { }
    public record Signature(String label, List<String> parameters) { }
    public record Result(List<Issue> diagnostics, List<Symbol> symbols, List<Completion> completions,
                         Hover hover, Definition definition, List<Signature> signatures, int activeParameter) { }

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
                // The execution engine also compiles Main.java; preserve its public-class-name rule.
                JavaFileObject input = new SimpleJavaFileObject(URI.create("string:///Main.java"), JavaFileObject.Kind.SOURCE) {
                    @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return edit.source(); }
                };
                JavacTask task = (JavacTask) compiler.getTask(new StringWriter(), files, collector,
                        List.of("-proc:none", "--release", "21", "-implicit:none", "-Xlint:all", "-Xmaxerrs", "100", "-Xmaxwarns", "100"), null, List.of(input));
                task.setLocale(Locale.ENGLISH);
                CompilationUnitTree unit = task.parse().iterator().next();
                task.analyze();
                Session session = new Session(source, offset, edit, unit, Trees.instance(task), task.getElements(), task.getTypes());
                return switch (operation) {
                    case "complete" -> result(List.of(), List.of(), session.completions(), null, null, List.of(), 0);
                    case "inspect" -> session.inspect();
                    case "signature" -> session.signature();
                    default -> result(issues(collector, source.length()), session.symbols(), List.of(), null, null, List.of(), 0);
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

    private static Result result(List<Issue> issues, List<Symbol> symbols, List<Completion> completions,
                                 Hover hover, Definition definition, List<Signature> signatures, int activeParameter) {
        return new Result(issues, symbols, completions, hover, definition, signatures, activeParameter);
    }

    private static List<Issue> issues(DiagnosticCollector<JavaFileObject> collector, int length) {
        return collector.getDiagnostics().stream().filter(d -> d.getKind() != Diagnostic.Kind.OTHER)
                .limit(100).map(d -> {
                    int start = clamp(d.getStartPosition() < 0 ? d.getPosition() : d.getStartPosition(), length);
                    int end = clamp(d.getEndPosition(), length);
                    if (end <= start) end = Math.min(length, start + 1);
                    String severity = d.getKind() == Diagnostic.Kind.ERROR ? "error"
                            : d.getKind() == Diagnostic.Kind.WARNING || d.getKind() == Diagnostic.Kind.MANDATORY_WARNING ? "warning" : "info";
                    return new Issue(start, end, severity, d.getMessage(Locale.ENGLISH), d.getCode());
                }).toList();
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

        List<Completion> completions() {
            TreePath cursor = paths.stream().filter(path -> {
                Tree leaf = path.getLeaf();
                return leaf instanceof MemberSelectTree m && m.getIdentifier().contentEquals(CURSOR)
                        || leaf instanceof IdentifierTree i && i.getName().contentEquals(CURSOR);
            }).findFirst().orElseGet(() -> closest(edit.start()));
            String prefix = source.substring(edit.start(), offset);
            LinkedHashMap<String, Completion> result = new LinkedHashMap<>();
            if (cursor != null && cursor.getLeaf() instanceof MemberSelectTree member) {
                TreePath receiver = new TreePath(cursor, member.getExpression());
                addMembers(result, type(receiver), element(receiver) instanceof TypeElement, scope(cursor), prefix);
                return sorted(result);
            }
            Scope scope = cursor == null ? null : scope(cursor);
            if (scope != null) {
                Set<String> names = new HashSet<>();
                for (Scope current = scope; current != null; current = current.getEnclosingScope()) {
                    for (Element element : current.getLocalElements()) {
                        if (element.getSimpleName().toString().equals(CURSOR) || !names.add(element.getSimpleName().toString())) continue;
                        addCompletion(result, element, element.asType(), prefix, null);
                    }
                }
                TypeElement enclosing = scope.getEnclosingClass();
                boolean staticContext = scope.getEnclosingMethod() != null && scope.getEnclosingMethod().getModifiers().contains(Modifier.STATIC);
                if (enclosing != null) addMembers(result, enclosing.asType(), staticContext, scope, prefix);
            }
            for (String fullName : JDK_TYPES) {
                String name = fullName.substring(fullName.lastIndexOf('.') + 1);
                if (!name.startsWith(prefix)) continue;
                TypeElement type = elements.getTypeElement(fullName);
                if (type == null) continue;
                boolean imported = fullName.startsWith("java.lang.") || unit.getImports().stream().anyMatch(i ->
                        i.getQualifiedIdentifier().toString().equals(fullName)
                                || i.getQualifiedIdentifier().toString().equals(fullName.substring(0, fullName.lastIndexOf('.')) + ".*"));
                addCompletion(result, type, type.asType(), prefix, imported ? null : fullName);
            }
            for (String keyword : KEYWORDS) if (keyword.startsWith(prefix)) result.putIfAbsent("keyword:" + keyword,
                    new Completion(keyword, "keyword", "Java 关键字", keyword, null));
            return sorted(result);
        }

        TreePath closest(int position) {
            return paths.stream().filter(p -> start(p.getLeaf()) <= position && end(p.getLeaf()) >= position)
                    .min(Comparator.comparingInt(p -> end(p.getLeaf()) - start(p.getLeaf()))).orElse(null);
        }

        void addMembers(Map<String, Completion> result, TypeMirror receiver, boolean staticReceiver, Scope scope, String prefix) {
            if (receiver == null) return;
            if (receiver.getKind() == TypeKind.ARRAY) {
                if (!staticReceiver && "length".startsWith(prefix)) result.put("field:length", new Completion("length", "field", "int length", "length", null));
                receiver = elements.getTypeElement("java.lang.Object").asType();
            }
            if (receiver instanceof TypeVariable variable) receiver = variable.getUpperBound();
            if (!(receiver instanceof DeclaredType declared) || !(declared.asElement() instanceof TypeElement type)) return;
            for (Element member : elements.getAllMembers(type)) {
                if (member.getKind() == ElementKind.CONSTRUCTOR || staticReceiver && !member.getModifiers().contains(Modifier.STATIC)) continue;
                if (!accessible(scope, member, declared)) continue;
                TypeMirror memberType;
                try { memberType = types.asMemberOf(declared, member); }
                catch (IllegalArgumentException ignored) { memberType = member.asType(); }
                addCompletion(result, member, memberType, prefix, null);
            }
        }

        boolean accessible(Scope scope, Element member, DeclaredType type) {
            if (scope == null) return member.getModifiers().contains(Modifier.PUBLIC);
            try { return trees.isAccessible(scope, member, type); }
            catch (IllegalArgumentException ignored) { return member.getModifiers().contains(Modifier.PUBLIC); }
        }

        void addCompletion(Map<String, Completion> result, Element element, TypeMirror type, String prefix, String importName) {
            String name = element.getSimpleName().toString();
            if (name.startsWith("__") || name.equals("this") || name.equals("super") || !name.startsWith(prefix)) return;
            String kind = switch (element.getKind()) {
                case METHOD -> "method";
                case FIELD, ENUM_CONSTANT -> "field";
                case LOCAL_VARIABLE, PARAMETER, EXCEPTION_PARAMETER, RESOURCE_VARIABLE, BINDING_VARIABLE -> "variable";
                case CLASS, INTERFACE, ENUM, RECORD, ANNOTATION_TYPE -> "class";
                default -> null;
            };
            if (kind == null) return;
            String detail = describe(element, type);
            String insertion = kind.equals("method") ? name + "(" + (((ExecutableType) type).getParameterTypes().isEmpty() ? ")" : "") : name;
            String key = kind.equals("method") ? kind + ":" + detail : kind + ":" + name;
            result.putIfAbsent(key, new Completion(name, kind, detail, insertion, importName));
        }

        List<Completion> sorted(Map<String, Completion> result) {
            return result.values().stream().sorted(Comparator.comparing((Completion c) -> switch (c.kind()) {
                case "variable" -> 0; case "field" -> 1; case "method" -> 2; case "class" -> 3; default -> 4;
            }).thenComparing(Completion::label).thenComparing(Completion::detail)).limit(MAX_COMPLETIONS).toList();
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
