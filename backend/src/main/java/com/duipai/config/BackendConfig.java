package com.duipai.config;

import com.duipai.engine.RunEngine;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;

@Configuration
public class BackendConfig {
    @Bean
    public DataSource dataSource(DataPaths paths) throws SQLException {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + paths.database());
        config.setDriverClassName("org.sqlite.JDBC");
        config.setMaximumPoolSize(1);
        config.setMinimumIdle(1);
        config.setConnectionInitSql("PRAGMA foreign_keys=ON");
        config.setPoolName("duipai-sqlite");
        HikariDataSource source = new HikariDataSource(config);
        try (Connection connection = source.getConnection(); Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("PRAGMA busy_timeout=5000");
            statement.execute("CREATE TABLE IF NOT EXISTS problems (id TEXT PRIMARY KEY, title TEXT NOT NULL, statement TEXT NOT NULL, codes_json TEXT NOT NULL, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
            statement.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL)");
            statement.execute("CREATE INDEX IF NOT EXISTS runs_problem_time ON runs(problem_id, created_at DESC)");
        }
        return source;
    }

    @Bean(destroyMethod = "close")
    public RunEngine runEngine(DataPaths paths) { return new RunEngine(paths.work()); }
}
