package com.duipai.storage;

import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface ProblemMapper {
    @Select("SELECT * FROM problems ORDER BY updated_at DESC, id") List<ProblemRow> list();
    @Select("SELECT * FROM problems WHERE id=#{id}") ProblemRow find(String id);
    @Insert("INSERT INTO problems(id,title,statement,codes_json,settings_json,updated_at,folder_id) VALUES(#{id},#{title},#{statement},#{codesJson},#{settingsJson},#{updatedAt},#{folderId})") void insert(ProblemRow row);
    // 自动保存不改动分类，移动题目只经过 moveToFolder，因此两者互不覆盖。
    @Update("UPDATE problems SET title=#{title},statement=#{statement},codes_json=#{codesJson},settings_json=#{settingsJson},updated_at=#{updatedAt} WHERE id=#{id}") int update(ProblemRow row);
    @Update("UPDATE problems SET folder_id=#{folderId} WHERE id=#{id}") int moveToFolder(@Param("id") String id, @Param("folderId") String folderId);
    @Select("SELECT EXISTS(SELECT 1 FROM folders WHERE id=#{id})") boolean folderExists(String id);
    @Select("SELECT * FROM problems WHERE substr(statement,1,length(#{prefix}))=#{prefix}") List<ProblemRow> withStatementPrefix(String prefix);
    @Update("UPDATE problems SET statement=#{statement} WHERE id=#{id}") int updateStatement(@Param("id") String id, @Param("statement") String statement);
    @Delete("DELETE FROM problems WHERE id=#{id}") int delete(String id);
}
