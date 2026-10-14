package com.duipai.config;

import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.assertj.core.api.Assertions.assertThat;

class BackendConfigMigrationTest {
    @Test
    void addsFoldersToLegacyDatabaseKeepingProblemsAndReleasesThemWhenFolderIsDeleted(@TempDir Path directory) throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        try (Connection legacy = DriverManager.getConnection("jdbc:sqlite:" + paths.database()); Statement statement = legacy.createStatement()) {
            statement.execute("CREATE TABLE problems (id TEXT PRIMARY KEY, title TEXT NOT NULL, statement TEXT NOT NULL, codes_json TEXT NOT NULL, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
            statement.execute("INSERT INTO problems VALUES('old','旧题目','# 旧题目','{}','{}','2026-01-01T00:00:00Z')");
        }
        for (int launch = 0; launch < 2; launch++) {
            try (HikariDataSource source = (HikariDataSource) new BackendConfig().dataSource(paths); Connection connection = source.getConnection(); Statement statement = connection.createStatement()) {
                try (ResultSet row = statement.executeQuery("SELECT title, folder_id FROM problems WHERE id='old'")) {
                    assertThat(row.next()).isTrue();
                    assertThat(row.getString("title")).isEqualTo("旧题目");
                    assertThat(row.getString("folder_id")).isNull();
                }
                if (launch == 0) {
                    statement.execute("INSERT INTO folders(id,name,created_at) VALUES('f','分类','2026-01-01T00:00:00Z')");
                    statement.execute("UPDATE problems SET folder_id='f' WHERE id='old'");
                    statement.execute("DELETE FROM folders WHERE id='f'");
                }
            }
        }
    }
}
