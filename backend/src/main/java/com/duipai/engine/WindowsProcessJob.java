package com.duipai.engine;

import com.sun.jna.Memory;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.WString;
import com.sun.jna.win32.StdCallLibrary;
import java.util.concurrent.TimeUnit;

/** A Windows job keeps short-lived JVM descendants owned even after their parent exits. */
final class WindowsProcessJob implements AutoCloseable {
    private static final int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
    private static final int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private static final int PROCESS_TERMINATE = 0x0001;
    private static final int PROCESS_SET_QUOTA = 0x0100;
    private Pointer handle;

    private WindowsProcessJob(Pointer handle) { this.handle = handle; }

    static WindowsProcessJob create() {
        Kernel32 api = Kernel32.INSTANCE;
        Pointer job = api.CreateJobObjectW(null, null);
        if (job == null) throw failure("CreateJobObjectW");
        // Native Windows layouts: BASIC_LIMIT_INFORMATION (64 / 48 bytes),
        // IO_COUNTERS (48 bytes), then four pointer-sized memory limits.
        try (Memory limits = new Memory(Native.POINTER_SIZE == 8 ? 144 : 112)) {
            limits.clear();
            limits.setInt(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
            if (!api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, (int) limits.size())) {
                IllegalStateException error = failure("SetInformationJobObject");
                api.CloseHandle(job);
                throw error;
            }
        }
        return new WindowsProcessJob(job);
    }

    void assign(Process process) {
        Kernel32 api = Kernel32.INSTANCE;
        Pointer processHandle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, (int) process.pid());
        if (processHandle == null) throw failure("OpenProcess");
        try {
            if (!api.AssignProcessToJobObject(handle, processHandle)) throw failure("AssignProcessToJobObject");
        } finally { api.CloseHandle(processHandle); }
    }

    @Override public synchronized void close() {
        if (handle != null) {
            Pointer closing = handle;
            handle = null;
            Kernel32 api = Kernel32.INSTANCE;
            boolean interrupted = false;
            // Wait for the entire native job, including descendants whose Java parent already exited.
            api.TerminateJobObject(closing, 1);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            try (Memory accounting = new Memory(48)) {
                while (System.nanoTime() < deadline) {
                    if (!api.QueryInformationJobObject(closing, 1, accounting, 48, null) || accounting.getInt(40) == 0) break;
                    try { Thread.sleep(5); }
                    catch (InterruptedException e) { interrupted = true; }
                }
            }
            if (!Kernel32.INSTANCE.CloseHandle(closing)) throw failure("CloseHandle");
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static IllegalStateException failure(String operation) {
        return new IllegalStateException("Windows 子进程管理失败：" + operation + "（系统错误 " + Native.getLastError() + "）");
    }

    interface Kernel32 extends StdCallLibrary {
        Kernel32 INSTANCE = Native.load("kernel32", Kernel32.class);
        Pointer CreateJobObjectW(Pointer securityAttributes, WString name);
        boolean SetInformationJobObject(Pointer job, int informationClass, Pointer information, int informationLength);
        Pointer OpenProcess(int desiredAccess, boolean inheritHandle, int processId);
        boolean AssignProcessToJobObject(Pointer job, Pointer process);
        boolean TerminateJobObject(Pointer job, int exitCode);
        boolean QueryInformationJobObject(Pointer job, int informationClass, Pointer information, int informationLength, Pointer returnLength);
        boolean CloseHandle(Pointer object);
    }
}
