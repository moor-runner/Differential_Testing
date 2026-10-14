package com.duipai.config;

import com.duipai.engine.DebugEngine;
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
            // 自定义测试用例；题面样例由前端从题面解析，不在此保存。
            statement.execute("CREATE TABLE IF NOT EXISTS problem_tests (problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE, cases_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
            // 断点：每道题三份代码各自的断点行号，随题目删除。
            statement.execute("CREATE TABLE IF NOT EXISTS problem_breakpoints (problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE, breakpoints_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
            // 分类（文件夹）：题目可选归入一个分类；删除分类时题目回到未分类，不删除题目。
            statement.execute("CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
            if (!hasColumn(connection, "problems", "folder_id")) statement.execute("ALTER TABLE problems ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL");
            statement.execute("CREATE INDEX IF NOT EXISTS problems_folder ON problems(folder_id)");
        }
        return source;
    }

    private static boolean hasColumn(Connection connection, String table, String column) throws SQLException {
        try (var columns = connection.getMetaData().getColumns(null, null, table, column)) { return columns.next(); }
    }

    @Bean(destroyMethod = "close")
    public RunEngine runEngine(DataPaths paths) { return new RunEngine(paths.work()); }

    @Bean(destroyMethod = "close")
    public DebugEngine debugEngine(DataPaths paths) { return new DebugEngine(paths.work()); }
}
