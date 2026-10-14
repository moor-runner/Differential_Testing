package com.duipai.engine;

import java.nio.file.Path;
import java.util.Objects;
import java.util.UUID;

/**
 * Owns the single interactive debug session. Starting another stops the previous one; debugging is independent
 * of duipai jobs and test runs, which keep their own engine.
 */
public final class DebugEngine implements AutoCloseable {
    private final Path workRoot;
    private DebugSession current;
    private boolean closed;

    public DebugEngine(Path workRoot) { this.workRoot = Objects.requireNonNull(workRoot).toAbsolutePath().normalize(); }

    public synchronized DebugSession start(DebugSession.Request request, DebugSession.Listener listener) {
        if (closed) throw new IllegalStateException("调试器已关闭");
        if (current != null) current.stop();
        current = new DebugSession(UUID.randomUUID().toString(), workRoot.resolve("debug-" + UUID.randomUUID()), request, listener);
        current.start();
        return current;
    }

    /** The session with this id, while it is the current one (finished sessions stay readable until the next start). */
    public synchronized DebugSession find(String id) { return current != null && current.id().equals(id) ? current : null; }

    public synchronized DebugSession current() { return current; }

    @Override public void close() {
        DebugSession session;
        synchronized (this) {
            if (closed) return;
            closed = true;
            session = current;
        }
        if (session == null) return;
        session.stop();
        try { session.awaitTermination(8000); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    }
}
