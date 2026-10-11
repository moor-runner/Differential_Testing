package com.duipai.service;

import com.sun.source.util.JavacTask;

import javax.lang.model.element.*;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;
import java.io.IOException;
import java.io.StringWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Public java.base types for completion and import fixes, listed once from javac's own view of the
 * platform. Requests only match names here; they never load these classes unless one is chosen.
 */
final class JdkTypes {
    /**
     * {@code insertText} is how code names the type: {@code Map.Entry} for a nested type, imported through
     * {@code importName} (the outer type; null in java.lang). {@code fixImport} is the single-type import
     * that resolves the simple name. {@code supertypes} holds the erased qualified names of the type and
     * all its supertypes.
     */
    record Type(String name, String qualifiedName, String insertText, String importName, String fixImport, String kind,
                boolean deprecated, boolean instantiable, boolean extensible, boolean generic, Set<String> supertypes) {
        String detail() { return kind + " " + qualifiedName; }
    }

    static final List<String> PACKAGES = List.of("java.lang", "java.util", "java.util.function", "java.util.stream", "java.util.concurrent",
            "java.util.concurrent.atomic", "java.util.regex", "java.io", "java.math", "java.nio.file", "java.nio.charset", "java.text", "java.time", "java.time.format");

    /** Types contest and everyday code reach for; they rank above the long tail of the platform. */
    static final Set<String> COMMON = Set.of("java.util.Scanner", "java.util.Arrays", "java.util.Collections", "java.util.Comparator", "java.util.Objects",
            "java.util.Random", "java.util.SplittableRandom", "java.util.List", "java.util.ArrayList", "java.util.LinkedList", "java.util.Map", "java.util.HashMap",
            "java.util.TreeMap", "java.util.LinkedHashMap", "java.util.Set", "java.util.HashSet", "java.util.TreeSet", "java.util.LinkedHashSet", "java.util.Queue",
            "java.util.Deque", "java.util.ArrayDeque", "java.util.PriorityQueue", "java.util.Iterator", "java.util.StringTokenizer", "java.util.BitSet",
            "java.util.Optional", "java.util.OptionalInt", "java.util.OptionalLong", "java.util.IntSummaryStatistics", "java.util.Map.Entry",
            "java.util.AbstractMap.SimpleEntry", "java.util.Stack", "java.util.function.Function", "java.util.function.BiFunction",
            "java.util.function.Consumer", "java.util.function.Predicate", "java.util.function.Supplier", "java.util.function.IntUnaryOperator",
            "java.util.concurrent.atomic.AtomicInteger", "java.util.concurrent.atomic.AtomicLong", "java.io.BufferedReader", "java.io.BufferedWriter",
            "java.io.InputStreamReader", "java.io.OutputStreamWriter", "java.io.PrintWriter", "java.io.InputStream", "java.io.OutputStream",
            "java.io.IOException", "java.io.File", "java.io.FileInputStream", "java.io.FileOutputStream", "java.io.ByteArrayInputStream",
            "java.io.ByteArrayOutputStream", "java.io.StreamTokenizer", "java.io.DataInputStream", "java.math.BigInteger", "java.math.BigDecimal",
            "java.math.MathContext", "java.math.RoundingMode", "java.util.stream.IntStream", "java.util.stream.LongStream", "java.util.stream.DoubleStream",
            "java.util.stream.Stream", "java.util.stream.Collectors", "java.nio.file.Path", "java.nio.file.Paths", "java.nio.file.Files",
            "java.util.regex.Pattern", "java.util.regex.Matcher", "java.lang.String", "java.lang.StringBuilder", "java.lang.StringBuffer", "java.lang.Math",
            "java.lang.System", "java.lang.Integer", "java.lang.Long", "java.lang.Double", "java.lang.Character", "java.lang.Boolean", "java.lang.Object",
            "java.lang.Exception", "java.lang.RuntimeException", "java.lang.Thread", "java.lang.Comparable", "java.lang.Iterable", "java.lang.Runnable");

    private static final class Holder { static final List<Type> TYPES = build(); }

    static List<Type> all() { return Holder.TYPES; }

    static List<Type> named(String simpleName) {
        return all().stream().filter(type -> type.name().equals(simpleName)).toList();
    }

    private static List<Type> build() {
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) return List.of();
        try (StandardJavaFileManager files = compiler.getStandardFileManager(null, Locale.ENGLISH, StandardCharsets.UTF_8)) {
            files.setLocationFromPaths(StandardLocation.CLASS_PATH, List.of());
            JavaFileObject empty = new SimpleJavaFileObject(URI.create("string:///Index.java"), JavaFileObject.Kind.SOURCE) {
                @Override public CharSequence getCharContent(boolean ignoreEncodingErrors) { return "class Index {}"; }
            };
            JavacTask task = (JavacTask) compiler.getTask(new StringWriter(), files, null, List.of("-proc:none", "--release", "21"), null, List.of(empty));
            task.analyze();
            Elements elements = task.getElements();
            Types types = task.getTypes();
            Map<String, Set<String>> supertypes = new HashMap<>();
            List<Type> result = new ArrayList<>();
            for (String name : PACKAGES) {
                PackageElement pkg = elements.getPackageElement(name);
                if (pkg == null) continue;
                for (Element member : pkg.getEnclosedElements()) {
                    if (!(member instanceof TypeElement type) || !type.getModifiers().contains(Modifier.PUBLIC)) continue;
                    result.add(entry(type, null, elements, types, supertypes));
                    for (Element inner : type.getEnclosedElements()) {
                        // Member interfaces, enums and records are implicitly static.
                        if (inner instanceof TypeElement nested && nested.getModifiers().contains(Modifier.PUBLIC)
                                && (nested.getModifiers().contains(Modifier.STATIC) || nested.getKind() != ElementKind.CLASS))
                            result.add(entry(nested, type, elements, types, supertypes));
                    }
                }
            }
            return List.copyOf(result);
        } catch (IOException | IllegalStateException unavailable) {
            return List.of();
        }
    }

    private static Type entry(TypeElement type, TypeElement outer, Elements elements, Types types, Map<String, Set<String>> supertypes) {
        String qualified = type.getQualifiedName().toString();
        String insert = outer == null ? type.getSimpleName().toString() : outer.getSimpleName() + "." + type.getSimpleName();
        String importOwner = (outer == null ? type : outer).getQualifiedName().toString();
        boolean javaLang = elements.getPackageOf(type).getQualifiedName().contentEquals("java.lang");
        boolean isAbstract = type.getModifiers().contains(Modifier.ABSTRACT);
        boolean openConstructor = type.getEnclosedElements().stream().anyMatch(e -> e.getKind() == ElementKind.CONSTRUCTOR
                && (e.getModifiers().contains(Modifier.PUBLIC) || e.getModifiers().contains(Modifier.PROTECTED)));
        boolean classLike = type.getKind() == ElementKind.CLASS || type.getKind() == ElementKind.RECORD;
        boolean instantiable = classLike && !isAbstract && openConstructor;
        boolean extensible = type.getKind() == ElementKind.INTERFACE && !type.getModifiers().contains(Modifier.SEALED)
                || type.getKind() == ElementKind.CLASS && isAbstract && openConstructor && !type.getModifiers().contains(Modifier.SEALED);
        return new Type(type.getSimpleName().toString(), qualified, insert, javaLang ? null : importOwner, javaLang ? null : qualified,
                type.getKind().name().toLowerCase(Locale.ROOT), elements.isDeprecated(type), instantiable, extensible,
                !type.getTypeParameters().isEmpty(), supertypes(type.asType(), types, supertypes));
    }

    private static Set<String> supertypes(TypeMirror type, Types types, Map<String, Set<String>> memo) {
        if (!(type instanceof DeclaredType declared) || !(declared.asElement() instanceof TypeElement element)) return Set.of();
        String name = element.getQualifiedName().toString();
        Set<String> known = memo.get(name);
        if (known != null) return known;
        Set<String> result = new HashSet<>();
        result.add(name);
        for (TypeMirror parent : types.directSupertypes(type)) result.addAll(supertypes(parent, types, memo));
        Set<String> frozen = Set.copyOf(result);
        memo.put(name, frozen);
        return frozen;
    }

    private JdkTypes() { }
}
