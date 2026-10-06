package com.duipai.config;

import com.duipai.engine.RunEngine;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class BackendLifecycle {
    private final ConfigurableApplicationContext context;
    private final RunEngine engine;
    private final long parentPid;

    public BackendLifecycle(ConfigurableApplicationContext context, RunEngine engine, @Value("${duipai.parent-pid:0}") long parentPid) {
        this.context = context;
        this.engine = engine;
        this.parentPid = parentPid;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void ready() {
        System.out.println("DUIPAI_READY:" + ((WebServerApplicationContext) context).getWebServer().getPort());
        System.out.flush();
        if (parentPid > 0) {
            ProcessHandle.of(parentPid).ifPresentOrElse(parent -> parent.onExit().thenRun(this::shutdown), this::shutdown);
        }
    }

    public void shutdown() {
        Thread.ofPlatform().daemon(true).name("duipai-shutdown").start(() -> {
            try { Thread.sleep(100); } catch (InterruptedException exception) { Thread.currentThread().interrupt(); }
            engine.close();
            context.close();
        });
    }
}
