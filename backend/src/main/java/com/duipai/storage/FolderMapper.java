package com.duipai.storage;

import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface FolderMapper {
    @Select("SELECT id,name,collapsed,created_at FROM folders ORDER BY created_at, id") List<FolderRow> list();
    @Select("SELECT id,name,collapsed,created_at FROM folders WHERE id=#{id}") FolderRow find(String id);
    @Select("SELECT id,name,collapsed,created_at FROM folders WHERE name=#{name} LIMIT 1") FolderRow findByName(String name);
    @Insert("INSERT INTO folders(id,name,collapsed,created_at) VALUES(#{id},#{name},#{collapsed},#{createdAt})") void insert(FolderRow row);
    @Update("UPDATE folders SET name=#{name},collapsed=#{collapsed} WHERE id=#{id}") int update(FolderRow row);
    @Update("UPDATE problems SET folder_id=NULL WHERE folder_id=#{id}") int release(String id);
    @Delete("DELETE FROM folders WHERE id=#{id}") int delete(String id);
}
