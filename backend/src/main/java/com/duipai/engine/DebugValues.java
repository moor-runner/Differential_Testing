package com.duipai.engine;

import com.sun.jdi.*;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.ByteOrder;
import java.util.*;
import java.util.function.Predicate;

/**
 * Describes debuggee values for the variables view without running debuggee code. Strings, boxes, builders, big
 * numbers and the common java.util collections are read from their JDK 21 fields, so values also show while the VM
 * is merely suspended (a user pause), and inspecting can never hit a breakpoint, loop or change program state.
 * Expandable values get a reference number; one instance lives for a single pause and is dropped when the
 * program continues, which invalidates its references.
 */
final class DebugValues {
    static final int PAGE_LIMIT = 1000;
    /** Containers without random access (linked, hashed, tree) list at most this many items. */
    static final int ITERATION_LIMIT = 10_000;
    private static final int PREVIEW = 8, NESTED_PREVIEW = 4, FIELD_PREVIEW = 4, CHUNK = 1024;
    private static final int SUMMARY_LIMIT = 200, STRING_LIMIT = 2000, PREVIEW_STRING_LIMIT = 40, BIG_INTEGER_WORDS = 4096;
    private static final int REFERENCE_LIMIT = 100_000;
    private static final Set<String> BOXES = Set.of("java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte",
            "java.lang.Character", "java.lang.Boolean", "java.lang.Float", "java.lang.Double");
    private static final Map<String, String> DISPLAY_NAMES = Map.of(
            "java.util.ImmutableCollections$ListN", "List.of", "java.util.ImmutableCollections$List12", "List.of",
            "java.util.ImmutableCollections$SetN", "Set.of", "java.util.ImmutableCollections$Set12", "Set.of",
            "java.util.ImmutableCollections$MapN", "Map.of", "java.util.ImmutableCollections$Map1", "Map.of",
            "java.util.Arrays$ArrayList", "Arrays.asList");

    /** How an object is listed: closed text, elements (indexed or iterated), map entries, or its instance fields. */
    private sealed interface Shape permits Leaf, Elements, Entries, Fields { }
    private record Leaf(String text, String kind) implements Shape { }
    /** {@code readable} is below {@code size} when only the first {@link #ITERATION_LIMIT} items can be listed. */
    private record Elements(int size, int readable, ElementReader reader) implements Shape { }
    private record Entries(int size, int readable, EntryReader reader) implements Shape { }
    private record Fields() implements Shape { }
    @FunctionalInterface private interface ElementReader { List<Value> read(int start, int count); }
    @FunctionalInterface private interface EntryReader { List<Value[]> read(int start, int count); }
    /** A JDK class whose fields differ from the JDK 21 layout this reader knows; the object is shown by its fields. */
    private static final class Unsupported extends RuntimeException {
        Unsupported() { super(null, null, false, false); }
    }

    private final VirtualMachine vm;
    private final Predicate<ReferenceType> userType;
    private final Map<Integer, Object> nodes = new HashMap<>();
    private final Map<Long, Shape> shapes = new HashMap<>();
    private final Map<String, Optional<ReferenceType>> types = new HashMap<>();
    private int nextReference = 1;

    DebugValues(VirtualMachine vm, Predicate<ReferenceType> userType) { this.vm = vm; this.userType = userType; }

    /** Top-level rows of a frame: {@code this}, the visible locals in declaration order, then static fields of the user's classes. */
    List<Map<String, Object>> frame(StackFrame frame) {
        List<Map<String, Object>> rows = new ArrayList<>();
        ObjectReference self = frame.thisObject();
        if (self != null) rows.add(variable("this", self, null));
        try {
            List<LocalVariable> locals = new ArrayList<>(frame.visibleVariables());
            Collections.sort(locals); // by scope start, i.e. declaration order
            Map<LocalVariable, Value> values = frame.getValues(locals);
            for (LocalVariable local : locals) rows.add(variable(local.name(), values.get(local), local.typeName()));
        } catch (AbsentInformationException ignored) { /* JDK classes carry no local variable tables. */ }
        for (ReferenceType type : enclosing(frame.location().declaringType())) {
            int count = staticFields(type).size();
            if (count == 0) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", "静态字段"); row.put("type", simpleName(type.name())); row.put("value", count + " 个");
            row.put("kind", "static"); row.put("ref", register(type));
            rows.add(row);
        }
        return rows;
    }

    /** One row: name, display type, value summary, kind and a reference number (0 when it cannot expand). */
    Map<String, Object> variable(String name, Value value, String declaredType) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", name);
        if (value == null) {
            row.put("type", declaredType == null ? "" : simpleName(declaredType));
            row.put("value", "null"); row.put("kind", "null"); row.put("ref", 0);
            return row;
        }
        if (value instanceof PrimitiveValue primitive) {
            row.put("type", primitive.type().name()); row.put("value", format(primitive)); row.put("kind", "primitive"); row.put("ref", 0);
            return row;
        }
        ObjectReference object = (ObjectReference) value;
        try {
            Shape shape = shape(object);
            row.put("type", typeLabel(object, shape));
            row.put("value", summary(object, 0));
            row.put("kind", kind(object, shape));
            int size = switch (shape) {
                case Elements elements -> elements.size();
                case Entries entries -> entries.size();
                case Fields ignored -> instanceFields(object.referenceType()).size();
                case Leaf ignored -> 0;
            };
            row.put("ref", size > 0 ? register(object) : 0);
            if (shape instanceof Elements elements) { row.put("size", elements.size()); if (elements.readable() < elements.size()) row.put("readable", elements.readable()); }
            if (shape instanceof Entries entries) { row.put("size", entries.size()); if (entries.readable() < entries.size()) row.put("readable", entries.readable()); }
        } catch (ObjectCollectedException collected) {
            row.put("type", ""); row.put("value", "（对象已被回收）"); row.put("kind", "null"); row.put("ref", 0);
        }
        return row;
    }

    /** A page of a reference's children; {@code size} is the total and {@code readable} how many can be listed. */
    Map<String, Object> children(int reference, int start, int count) {
        Object node = nodes.get(reference);
        if (node == null) throw new IllegalArgumentException("变量引用已失效，请重新展开");
        if (start < 0 || count < 1) throw new IllegalArgumentException("变量范围无效");
        count = Math.min(count, PAGE_LIMIT);
        List<Map<String, Object>> rows = new ArrayList<>();
        int size, readable;
        if (node instanceof ReferenceType type) {
            List<Field> fields = staticFields(type);
            Map<Field, Value> values = type.getValues(fields);
            for (Field field : fields) rows.add(variable(field.name(), values.get(field), field.typeName()));
            size = readable = rows.size();
        } else {
            ObjectReference object = (ObjectReference) node;
            Shape shape = shape(object);
            switch (shape) {
                case Elements elements -> {
                    size = elements.size(); readable = elements.readable();
                    int length = Math.max(0, Math.min(count, readable - start));
                    List<Value> values = length == 0 ? List.of() : elements.reader().read(start, length);
                    for (int i = 0; i < values.size(); i++) rows.add(variable("[" + (start + i) + "]", values.get(i), componentType(object)));
                }
                case Entries entries -> {
                    size = entries.size(); readable = entries.readable();
                    int length = Math.max(0, Math.min(count, readable - start));
                    for (Value[] entry : length == 0 ? List.<Value[]>of() : entries.reader().read(start, length)) {
                        rows.add(variable(summary(entry[0], 1), entry[1], null));
                    }
                }
                case Fields ignored -> {
                    List<Field> fields = instanceFields(object.referenceType());
                    Map<Field, Value> values = object.getValues(fields);
                    for (Field field : fields) rows.add(variable(field.name(), values.get(field), field.typeName()));
                    size = readable = rows.size();
                }
                case Leaf ignored -> size = readable = 0;
            }
        }
        Map<String, Object> page = new LinkedHashMap<>();
        page.put("start", start); page.put("size", size); page.put("readable", readable); page.put("variables", rows);
        return page;
    }

    private int register(Object node) {
        if (nodes.size() >= REFERENCE_LIMIT) throw new IllegalStateException("本次暂停展开的变量过多，请继续执行后再查看");
        int reference = nextReference++;
        nodes.put(reference, node);
        return reference;
    }

    // ---- shapes ----

    private Shape shape(ObjectReference object) {
        Shape cached = shapes.get(object.uniqueID());
        if (cached != null) return cached;
        Shape shape = classify(object);
        shapes.put(object.uniqueID(), shape);
        return shape;
    }

    private Shape classify(ObjectReference object) {
        if (object instanceof StringReference string) return new Leaf(quote(string.value(), STRING_LIMIT), "string");
        if (object instanceof ArrayReference array) return indexed(array, 0, array.length());
        if (object instanceof ClassObjectReference type) return new Leaf("class " + simpleName(type.reflectedType().name()), "leaf");
        ReferenceType runtime = object.referenceType();
        if (BOXES.contains(runtime.name())) return new Leaf(format(get(object, runtime, "value")), "leaf");
        for (ReferenceType type = runtime; type != null; type = type instanceof ClassType c ? c.superclass() : null) {
            try {
                Shape shape = known(object, type);
                if (shape != null) return shape;
            } catch (Unsupported unsupported) { return new Fields(); }
        }
        return new Fields();
    }

    private Shape known(ObjectReference object, ReferenceType type) {
        return switch (type.name()) {
            case "java.lang.AbstractStringBuilder" -> new Leaf(quote(builderText(object, type), STRING_LIMIT, integer(get(object, type, "count"))), "string");
            case "java.math.BigInteger" -> new Leaf(bigInteger(object, type), "leaf");
            case "java.math.BigDecimal" -> new Leaf(bigDecimal(object, type), "leaf");
            case "java.lang.Enum" -> new Leaf(String.valueOf(text(get(object, type, "name"))), "leaf");
            case "java.util.concurrent.atomic.AtomicInteger", "java.util.concurrent.atomic.AtomicLong" -> new Leaf(format(get(object, type, "value")), "leaf");
            case "java.util.concurrent.atomic.AtomicBoolean" -> new Leaf(Boolean.toString(integer(get(object, type, "value")) != 0), "leaf");
            case "java.util.ArrayList" -> indexed(array(get(object, type, "elementData")), 0, integer(get(object, type, "size")));
            case "java.util.Vector" -> indexed(array(get(object, type, "elementData")), 0, integer(get(object, type, "elementCount")));
            case "java.util.PriorityQueue" -> indexed(array(get(object, type, "queue")), 0, integer(get(object, type, "size")));
            case "java.util.Arrays$ArrayList" -> whole(array(get(object, type, "a")));
            case "java.util.ImmutableCollections$ListN" -> whole(array(get(object, type, "elements")));
            case "java.util.ImmutableCollections$List12", "java.util.ImmutableCollections$Set12" -> pair(object, type);
            case "java.util.ImmutableCollections$SetN" -> sparseSet(object, type);
            case "java.util.ImmutableCollections$MapN" -> sparseMap(object, type);
            case "java.util.ImmutableCollections$Map1" -> {
                Value[] entry = { get(object, type, "k0"), get(object, type, "v0") };
                yield new Entries(1, 1, (start, count) -> start == 0 ? List.<Value[]>of(entry) : List.of());
            }
            case "java.util.ArrayDeque" -> circular(object, type);
            case "java.util.LinkedList" -> linkedList(object, type);
            case "java.util.LinkedHashMap" -> linkedHashMap(object, type);
            case "java.util.HashMap" -> hashMap(object, type);
            case "java.util.TreeMap" -> treeMap(object, type);
            case "java.util.HashSet" -> keys(get(object, type, "map"));
            case "java.util.TreeSet" -> keys(get(object, type, "m"));
            case "java.util.Collections$UnmodifiableCollection", "java.util.Collections$SynchronizedCollection" -> delegate(get(object, type, "c"));
            case "java.util.Collections$UnmodifiableMap", "java.util.Collections$SynchronizedMap" -> delegate(get(object, type, "m"));
            default -> null;
        };
    }

    private static Elements indexed(ArrayReference array, int offset, int size) {
        int length = array == null ? 0 : Math.max(0, Math.min(size, array.length() - offset));
        return new Elements(length, length, (start, count) -> array.getValues(offset + start, count));
    }

    private static Elements whole(ArrayReference array) { return indexed(array, 0, array == null ? 0 : array.length()); }

    private Shape pair(ObjectReference object, ReferenceType type) {
        Value first = get(object, type, "e0"), second = get(object, type, "e1");
        Value empty = staticValue("java.util.ImmutableCollections", "EMPTY");
        List<Value> items = second == null || second.equals(empty) ? Collections.singletonList(first) : Arrays.asList(first, second);
        return new Elements(items.size(), items.size(), (start, count) -> items.subList(start, start + count));
    }

    private Shape sparseSet(ObjectReference object, ReferenceType type) {
        ArrayReference elements = array(get(object, type, "elements"));
        int size = integer(get(object, type, "size"));
        return new Elements(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value> items = new ArrayList<>(count);
            int index = 0;
            for (int slot = 0; elements != null && slot < elements.length() && items.size() < count; slot += CHUNK) {
                for (Value value : elements.getValues(slot, Math.min(CHUNK, elements.length() - slot))) {
                    if (value == null) continue;
                    if (index++ >= start) items.add(value);
                    if (items.size() == count) break;
                }
            }
            return items;
        });
    }

    private Shape sparseMap(ObjectReference object, ReferenceType type) {
        ArrayReference table = array(get(object, type, "table"));
        int size = integer(get(object, type, "size"));
        return new Entries(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value[]> entries = new ArrayList<>(count);
            int index = 0;
            for (int slot = 0; table != null && slot + 1 < table.length() && entries.size() < count; slot += CHUNK) {
                List<Value> values = table.getValues(slot, Math.min(CHUNK, table.length() - slot)); // CHUNK is even: pairs stay together
                for (int i = 0; i + 1 < values.size(); i += 2) {
                    if (values.get(i) == null) continue;
                    if (index++ >= start) entries.add(new Value[]{ values.get(i), values.get(i + 1) });
                    if (entries.size() == count) break;
                }
            }
            return entries;
        });
    }

    private Shape circular(ObjectReference object, ReferenceType type) {
        ArrayReference elements = array(get(object, type, "elements"));
        int head = integer(get(object, type, "head")), tail = integer(get(object, type, "tail"));
        int length = elements == null ? 0 : elements.length();
        int size = length == 0 ? 0 : Math.floorMod(tail - head, length);
        return new Elements(size, size, (start, count) -> {
            int from = (head + start) % length, first = Math.min(count, length - from);
            List<Value> items = new ArrayList<>(elements.getValues(from, first));
            if (count > first) items.addAll(elements.getValues(0, count - first));
            return items;
        });
    }

    private Shape linkedList(ObjectReference object, ReferenceType type) {
        int size = integer(get(object, type, "size"));
        Value first = get(object, type, "first");
        ReferenceType node = loaded("java.util.LinkedList$Node");
        if (node == null) return new Elements(0, 0, (start, count) -> List.of());
        Field item = field(node, "item"), next = field(node, "next");
        return new Elements(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value> items = new ArrayList<>(count);
            ObjectReference current = (ObjectReference) first;
            for (int index = 0; current != null && items.size() < count; index++) {
                Map<Field, Value> values = current.getValues(List.of(item, next));
                if (index >= start) items.add(values.get(item));
                current = (ObjectReference) values.get(next);
            }
            return items;
        });
    }

    private Shape hashMap(ObjectReference object, ReferenceType type) {
        ArrayReference table = array(get(object, type, "table"));
        int size = integer(get(object, type, "size"));
        ReferenceType node = loaded("java.util.HashMap$Node");
        if (table == null || node == null) return new Entries(0, 0, (start, count) -> List.of());
        Field key = field(node, "key"), value = field(node, "value"), next = field(node, "next");
        return new Entries(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value[]> entries = new ArrayList<>(count);
            int index = 0;
            for (int slot = 0; slot < table.length() && entries.size() < count; slot += CHUNK) {
                for (Value head : table.getValues(slot, Math.min(CHUNK, table.length() - slot))) {
                    for (ObjectReference current = (ObjectReference) head; current != null && entries.size() < count; ) {
                        Map<Field, Value> values = current.getValues(List.of(key, value, next));
                        if (index++ >= start) entries.add(new Value[]{ values.get(key), values.get(value) });
                        current = (ObjectReference) values.get(next);
                    }
                    if (entries.size() == count) break;
                }
            }
            return entries;
        });
    }

    private Shape linkedHashMap(ObjectReference object, ReferenceType type) {
        int size = integer(get(object, type, "size"));
        Value head = get(object, type, "head");
        ReferenceType node = loaded("java.util.HashMap$Node"), entry = loaded("java.util.LinkedHashMap$Entry");
        if (node == null || entry == null) return new Entries(0, 0, (start, count) -> List.of());
        Field key = field(node, "key"), value = field(node, "value"), after = field(entry, "after");
        return new Entries(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value[]> entries = new ArrayList<>(count);
            ObjectReference current = (ObjectReference) head;
            for (int index = 0; current != null && entries.size() < count; index++) {
                Map<Field, Value> values = current.getValues(List.of(key, value, after));
                if (index >= start) entries.add(new Value[]{ values.get(key), values.get(value) });
                current = (ObjectReference) values.get(after);
            }
            return entries;
        });
    }

    private Shape treeMap(ObjectReference object, ReferenceType type) {
        int size = integer(get(object, type, "size"));
        Value root = get(object, type, "root");
        ReferenceType node = loaded("java.util.TreeMap$Entry");
        if (node == null) return new Entries(0, 0, (start, count) -> List.of());
        List<Field> fields = List.of(field(node, "key"), field(node, "value"), field(node, "left"), field(node, "right"));
        return new Entries(size, Math.min(size, ITERATION_LIMIT), (start, count) -> {
            List<Value[]> entries = new ArrayList<>(count);
            Deque<Map<Field, Value>> stack = new ArrayDeque<>();
            ObjectReference current = (ObjectReference) root;
            int index = 0;
            while ((current != null || !stack.isEmpty()) && entries.size() < count) {
                while (current != null) {
                    Map<Field, Value> values = current.getValues(fields);
                    stack.push(values);
                    current = (ObjectReference) values.get(fields.get(2));
                }
                Map<Field, Value> values = stack.pop();
                if (index++ >= start) entries.add(new Value[]{ values.get(fields.get(0)), values.get(fields.get(1)) });
                current = (ObjectReference) values.get(fields.get(3));
            }
            return entries;
        });
    }

    /** A set backed by a map: its elements are the map's keys. */
    private Shape keys(Value map) {
        if (!(map instanceof ObjectReference inner) || !(shape(inner) instanceof Entries entries)) throw new Unsupported();
        return new Elements(entries.size(), entries.readable(), (start, count) -> entries.reader().read(start, count).stream().map(entry -> entry[0]).toList());
    }

    private Shape delegate(Value inner) {
        if (!(inner instanceof ObjectReference object)) throw new Unsupported();
        Shape shape = shape(object);
        if (shape instanceof Fields) throw new Unsupported();
        return shape;
    }

    private String builderText(ObjectReference object, ReferenceType type) {
        ArrayReference value = array(get(object, type, "value"));
        int count = integer(get(object, type, "count"));
        byte coder = get(object, type, "coder") instanceof ByteValue b ? b.value() : 0;
        int chars = Math.min(count, STRING_LIMIT);
        StringBuilder text = new StringBuilder(chars);
        if (value == null || chars == 0) return "";
        if (coder == 0) {
            for (Value item : value.getValues(0, Math.min(chars, value.length()))) text.append((char) (((ByteValue) item).value() & 0xff));
        } else {
            // UTF-16 builders keep each char in the platform byte order; the debuggee runs on this machine.
            boolean big = ByteOrder.nativeOrder() == ByteOrder.BIG_ENDIAN;
            List<Value> bytes = value.getValues(0, Math.min(chars * 2, value.length()));
            for (int i = 0; i + 1 < bytes.size(); i += 2) {
                int first = ((ByteValue) bytes.get(i)).value() & 0xff, second = ((ByteValue) bytes.get(i + 1)).value() & 0xff;
                text.append((char) (big ? first << 8 | second : second << 8 | first));
            }
        }
        return text.toString();
    }

    private String bigInteger(ObjectReference object, ReferenceType type) {
        int signum = integer(get(object, type, "signum"));
        ArrayReference magnitude = array(get(object, type, "mag"));
        if (magnitude == null) return "0";
        int words = magnitude.length();
        if (words > BIG_INTEGER_WORDS) return "BigInteger（约 " + (long) Math.ceil(words * 32 * Math.log10(2)) + " 位）";
        byte[] bytes = new byte[words * 4];
        List<Value> values = words == 0 ? List.of() : magnitude.getValues(0, words);
        for (int i = 0; i < words; i++) {
            int word = ((IntegerValue) values.get(i)).value();
            for (int b = 0; b < 4; b++) bytes[i * 4 + b] = (byte) (word >>> (24 - 8 * b));
        }
        return (signum == 0 ? BigInteger.ZERO : new BigInteger(signum, bytes)).toString();
    }

    private String bigDecimal(ObjectReference object, ReferenceType type) {
        long compact = get(object, type, "intCompact") instanceof LongValue value ? value.value() : Long.MIN_VALUE;
        int scale = integer(get(object, type, "scale"));
        if (compact != Long.MIN_VALUE) return BigDecimal.valueOf(compact, scale).toString();
        Value unscaled = get(object, type, "intVal");
        ReferenceType big = loaded("java.math.BigInteger");
        if (!(unscaled instanceof ObjectReference reference) || big == null) throw new Unsupported();
        String digits = bigInteger(reference, big);
        if (!digits.matches("-?\\d+")) return "BigDecimal（" + digits.substring(digits.indexOf('（') + 1).replace("）", "") + "）";
        return new BigDecimal(new BigInteger(digits), scale).toString();
    }

    // ---- summaries ----

    private String summary(Value value, int depth) {
        if (value == null) return "null";
        if (value instanceof PrimitiveValue primitive) return format(primitive);
        ObjectReference object = (ObjectReference) value;
        Shape shape;
        try { shape = shape(object); }
        catch (ObjectCollectedException collected) { return "（已回收）"; }
        if (depth > 0 && shape instanceof Leaf leaf && object instanceof StringReference string) return quote(string.value(), PREVIEW_STRING_LIMIT);
        if (depth > 0 && shape instanceof Leaf leaf && "string".equals(leaf.kind())) return leaf.text().length() > PREVIEW_STRING_LIMIT + 2 ? leaf.text().substring(0, PREVIEW_STRING_LIMIT + 1) + "…\"" : leaf.text();
        return switch (shape) {
            case Leaf leaf -> leaf.text();
            case Elements elements -> depth >= 2 ? typeLabel(object, shape) : elementPreview(elements, depth == 0 ? PREVIEW : NESTED_PREVIEW, depth);
            case Entries entries -> depth >= 1 ? typeLabel(object, shape) : entryPreview(entries);
            case Fields ignored -> depth >= 1 ? typeLabel(object, shape) : fieldPreview(object);
        };
    }

    private String elementPreview(Elements elements, int limit, int depth) {
        StringBuilder text = new StringBuilder("[");
        int count = Math.min(limit, elements.readable());
        List<Value> values = count == 0 ? List.of() : elements.reader().read(0, count);
        for (int i = 0; i < values.size() && text.length() < SUMMARY_LIMIT; i++) {
            if (i > 0) text.append(", ");
            text.append(summary(values.get(i), depth + 1));
        }
        if (elements.size() > values.size() || text.length() >= SUMMARY_LIMIT) text.append(values.isEmpty() ? "…" : ", …");
        return clip(text.append(']').toString());
    }

    private String entryPreview(Entries entries) {
        StringBuilder text = new StringBuilder("{");
        int count = Math.min(PREVIEW, entries.readable());
        List<Value[]> values = count == 0 ? List.of() : entries.reader().read(0, count);
        for (int i = 0; i < values.size() && text.length() < SUMMARY_LIMIT; i++) {
            if (i > 0) text.append(", ");
            text.append(summary(values.get(i)[0], 1)).append('=').append(summary(values.get(i)[1], 1));
        }
        if (entries.size() > values.size() || text.length() >= SUMMARY_LIMIT) text.append(values.isEmpty() ? "…" : ", …");
        return clip(text.append('}').toString());
    }

    private String fieldPreview(ObjectReference object) {
        ReferenceType type = object.referenceType();
        if (isThrowable(type)) {
            Value message = type.fieldByName("detailMessage") == null ? null : object.getValue(type.fieldByName("detailMessage"));
            return clip(simpleName(type.name()) + (message instanceof StringReference text ? ": " + text.value() : ""));
        }
        if (type.name().contains("$$Lambda")) return "lambda";
        List<Field> fields = instanceFields(type);
        List<Field> shown = fields.subList(0, Math.min(FIELD_PREVIEW, fields.size()));
        Map<Field, Value> values = object.getValues(shown);
        StringBuilder text = new StringBuilder("{");
        for (int i = 0; i < shown.size() && text.length() < SUMMARY_LIMIT; i++) {
            if (i > 0) text.append(", ");
            text.append(shown.get(i).name()).append('=').append(summary(values.get(shown.get(i)), 1));
        }
        if (fields.size() > shown.size()) text.append(shown.isEmpty() ? "…" : ", …");
        return clip(text.append('}').toString());
    }

    private String typeLabel(ObjectReference object, Shape shape) {
        if (object instanceof ArrayReference array) return arrayLabel(array.referenceType().name(), array.length());
        String name = displayName(object.referenceType().name());
        return switch (shape) {
            case Elements elements -> name + " size=" + elements.size();
            case Entries entries -> name + " size=" + entries.size();
            case Fields ignored -> name + "@" + object.uniqueID();
            case Leaf ignored -> name;
        };
    }

    private static String kind(ObjectReference object, Shape shape) {
        return switch (shape) {
            case Leaf leaf -> leaf.kind();
            case Elements ignored -> object instanceof ArrayReference ? "array" : "collection";
            case Entries ignored -> "map";
            case Fields ignored -> "object";
        };
    }

    // ---- helpers ----

    private String componentType(ObjectReference object) {
        if (!(object instanceof ArrayReference array)) return null;
        String name = array.referenceType().name();
        return name.substring(0, name.length() - 2);
    }

    private List<Field> instanceFields(ReferenceType type) {
        return type.allFields().stream().filter(field -> !field.isStatic() && !field.isSynthetic()).toList();
    }

    private List<Field> staticFields(ReferenceType type) {
        return type.fields().stream().filter(field -> field.isStatic() && !field.isSynthetic()).toList();
    }

    /** The user's declaring class and the classes it is nested in, innermost first. */
    private List<ReferenceType> enclosing(ReferenceType type) {
        if (!userType.test(type)) return List.of();
        List<ReferenceType> result = new ArrayList<>(List.of(type));
        String name = type.name();
        for (int dollar = name.lastIndexOf('$'); dollar > 0; dollar = name.lastIndexOf('$', dollar - 1)) {
            ReferenceType outer = loaded(name.substring(0, dollar));
            if (outer != null && userType.test(outer) && !result.contains(outer)) result.add(outer);
        }
        return result;
    }

    private static boolean isThrowable(ReferenceType type) {
        for (ReferenceType current = type; current != null; current = current instanceof ClassType c ? c.superclass() : null) {
            if ("java.lang.Throwable".equals(current.name())) return true;
        }
        return false;
    }

    private ReferenceType loaded(String name) {
        return types.computeIfAbsent(name, key -> vm.classesByName(key).stream().findFirst()).orElse(null);
    }

    private Value staticValue(String className, String fieldName) {
        ReferenceType type = loaded(className);
        Field field = type == null ? null : type.fieldByName(fieldName);
        return field == null ? null : type.getValue(field);
    }

    private static Field field(ReferenceType type, String name) {
        Field field = type.fieldByName(name);
        if (field == null) throw new Unsupported();
        return field;
    }

    private static Value get(ObjectReference object, ReferenceType type, String name) { return object.getValue(field(type, name)); }

    private static ArrayReference array(Value value) {
        if (value == null) return null;
        if (!(value instanceof ArrayReference array)) throw new Unsupported();
        return array;
    }

    private static int integer(Value value) {
        if (!(value instanceof PrimitiveValue primitive)) throw new Unsupported();
        return primitive.intValue();
    }

    private static String text(Value value) { return value instanceof StringReference string ? string.value() : null; }

    static String format(Value value) {
        return switch (value) {
            case null -> "null";
            case CharValue character -> character(character.value());
            case FloatValue number -> Float.toString(number.value());
            case DoubleValue number -> Double.toString(number.value());
            case PrimitiveValue primitive -> primitive.toString();
            case StringReference string -> quote(string.value(), STRING_LIMIT);
            default -> String.valueOf(value);
        };
    }

    static String character(char value) {
        String escaped = switch (value) {
            case '\n' -> "\\n"; case '\r' -> "\\r"; case '\t' -> "\\t"; case '\0' -> "\\0"; case '\'' -> "\\'"; case '\\' -> "\\\\";
            default -> value < 0x20 || value == 0x7f ? String.format("\\u%04x", (int) value) : String.valueOf(value);
        };
        return "'" + escaped + "' " + (int) value;
    }

    /** A Java string literal, cut after {@code limit} characters. */
    static String quote(String text, int limit) { return quote(text, limit, text.length()); }

    /** As {@link #quote(String, int)} for a prefix of a longer text of {@code total} characters. */
    static String quote(String text, int limit, int total) {
        int length = Math.min(text.length(), limit);
        boolean cut = total > length;
        StringBuilder out = new StringBuilder(length + 8).append('"');
        for (int i = 0; i < length; i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> { if (c < 0x20) out.append(String.format("\\u%04x", (int) c)); else out.append(c); }
            }
        }
        out.append('"');
        if (cut) out.append(limit >= STRING_LIMIT ? "…（共 " + total + " 个字符，仅显示前 " + length + " 个）" : "…");
        return out.toString();
    }

    private static String clip(String text) { return text.length() <= SUMMARY_LIMIT + 40 ? text : text.substring(0, SUMMARY_LIMIT + 40) + "…"; }

    static String arrayLabel(String typeName, int length) {
        int bracket = typeName.indexOf('[');
        if (bracket < 0) return simpleName(typeName);
        return simpleName(typeName.substring(0, bracket)) + "[" + length + "]" + typeName.substring(bracket + 2);
    }

    static String displayName(String name) {
        String special = DISPLAY_NAMES.get(name);
        return special != null ? special : simpleName(name);
    }

    /** {@code java.util.ArrayList} → {@code ArrayList}, {@code Main$Node} → {@code Node}; lambda proxies read as {@code lambda}. */
    static String simpleName(String name) {
        int dimensions = 0;
        while (name.endsWith("[]")) { name = name.substring(0, name.length() - 2); dimensions++; }
        String simple = name.substring(name.lastIndexOf('.') + 1);
        if (simple.contains("$$Lambda")) simple = "lambda";
        else {
            int dollar = simple.lastIndexOf('$');
            if (dollar >= 0 && dollar + 1 < simple.length() && Character.isJavaIdentifierStart(simple.charAt(dollar + 1))) simple = simple.substring(dollar + 1);
        }
        return simple + "[]".repeat(dimensions);
    }
}
