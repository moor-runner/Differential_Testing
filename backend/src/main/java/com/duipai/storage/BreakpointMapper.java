package com.duipai.storage;

import org.apache.ibatis.annotations.*;

@Mapper
public interface BreakpointMapper {
    @Select("SELECT breakpoints_json FROM problem_breakpoints WHERE problem_id=#{problemId}") String find(String problemId);
    @Insert("INSERT INTO problem_breakpoints(problem_id,breakpoints_json,updated_at) VALUES(#{problemId},#{breakpointsJson},#{updatedAt}) ON CONFLICT(problem_id) DO UPDATE SET breakpoints_json=excluded.breakpoints_json,updated_at=excluded.updated_at")
    void save(@Param("problemId") String problemId, @Param("breakpointsJson") String breakpointsJson, @Param("updatedAt") String updatedAt);
}
