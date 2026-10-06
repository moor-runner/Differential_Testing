package com.duipai.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

@Component
public class DataPaths {
    private final Path root;

    public DataPaths(@Value("${duipai.data-dir:${DUIPAI_DATA_DIR:./data}}") String root) throws IOException {
        this.root = Path.of(root).toAbsolutePath().normalize();
        Files.createDirectories(this.root);
        Files.createDirectories(images());
        Files.createDirectories(work());
    }

    public Path root() { return root; }
    public Path database() { return root.resolve("duipai.db"); }
    public Path images() { return root.resolve("images"); }
    public Path work() { return root.resolve("work"); }
    public Path settings() { return root.resolve("settings.json"); }
}
