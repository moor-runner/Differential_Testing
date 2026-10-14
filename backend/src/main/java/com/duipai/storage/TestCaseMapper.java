package com.duipai.storage;

import org.apache.ibatis.annotations.*;

@Mapper
public interface TestCaseMapper {
    @Select("SELECT cases_json FROM problem_tests WHERE problem_id=#{problemId}") String find(String problemId);
    @Insert("INSERT INTO problem_tests(problem_id,cases_json,updated_at) VALUES(#{problemId},#{casesJson},#{updatedAt}) ON CONFLICT(problem_id) DO UPDATE SET cases_json=excluded.cases_json,updated_at=excluded.updated_at")
    void save(@Param("problemId") String problemId, @Param("casesJson") String casesJson, @Param("updatedAt") String updatedAt);
}
