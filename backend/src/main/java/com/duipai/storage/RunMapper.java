package com.duipai.storage;

import org.apache.ibatis.annotations.*;
import java.util.List;

@Mapper
public interface RunMapper {
    @Select("SELECT * FROM runs WHERE id=#{id}") RunRow find(String id);
    @Select("SELECT id,problem_id,json_remove(snapshot_json,'$.input','$.generator','$.brute','$.optimized','$.codes','$.compileErrors') AS snapshot_json,created_at FROM runs WHERE problem_id=#{problemId} ORDER BY created_at DESC, id DESC") List<RunRow> list(String problemId);
    @Select("SELECT * FROM runs WHERE json_extract(snapshot_json,'$.state') != 'FINISHED'") List<RunRow> unfinished();
    @Delete("DELETE FROM runs WHERE id=#{id}") void delete(String id);
    @Insert("INSERT INTO runs(id,problem_id,snapshot_json,created_at) VALUES(#{id},#{problemId},#{snapshotJson},#{createdAt}) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json") void save(RunRow row);
}
