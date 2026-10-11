package com.duipai.storage;

import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface ProblemMapper {
    @Select("SELECT * FROM problems ORDER BY updated_at DESC, id") List<ProblemRow> list();
    @Select("SELECT * FROM problems WHERE id=#{id}") ProblemRow find(String id);
    @Insert("INSERT INTO problems(id,title,statement,codes_json,settings_json,updated_at) VALUES(#{id},#{title},#{statement},#{codesJson},#{settingsJson},#{updatedAt})") void insert(ProblemRow row);
    @Update("UPDATE problems SET title=#{title},statement=#{statement},codes_json=#{codesJson},settings_json=#{settingsJson},updated_at=#{updatedAt} WHERE id=#{id}") int update(ProblemRow row);
    @Select("SELECT * FROM problems WHERE substr(statement,1,length(#{prefix}))=#{prefix}") List<ProblemRow> withStatementPrefix(String prefix);
    @Update("UPDATE problems SET statement=#{statement} WHERE id=#{id}") int updateStatement(@Param("id") String id, @Param("statement") String statement);
    @Delete("DELETE FROM problems WHERE id=#{id}") int delete(String id);
}
