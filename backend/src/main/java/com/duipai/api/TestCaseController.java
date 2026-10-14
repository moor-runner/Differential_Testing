package com.duipai.api;

import com.duipai.service.TestCaseService;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** Runs one solver against statement samples and saved custom cases; never stored as a duipai run. */
@RestController
@RequestMapping("/api")
public class TestCaseController {
    private final TestCaseService tests;

    public TestCaseController(TestCaseService tests) { this.tests = tests; }

    @GetMapping("/problems/{id}/tests") public List<Map<String, Object>> list(@PathVariable String id) { return tests.list(id); }
    @PutMapping("/problems/{id}/tests") public List<Map<String, Object>> save(@PathVariable String id, @RequestBody List<Object> body) { return tests.save(id, body); }
    @PostMapping("/tests/run") public Map<String, Object> run(@RequestBody Map<String, Object> body) { return tests.run(body); }
    @PostMapping("/tests/{runId}/cancel") public Map<String, Object> cancel(@PathVariable String runId) { return tests.cancel(runId); }
}
