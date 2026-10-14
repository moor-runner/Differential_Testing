package com.duipai.api;

import com.duipai.service.AiSettingsService;
import com.duipai.service.AiStatementService;
import com.duipai.service.AiTestCaseService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class AiController {
    private final AiSettingsService settings;
    private final AiStatementService statements;
    private final AiTestCaseService testCases;

    public AiController(AiSettingsService settings, AiStatementService statements, AiTestCaseService testCases) {
        this.settings = settings;
        this.statements = statements;
        this.testCases = testCases;
    }

    @GetMapping("/settings/ai")
    public AiSettingsService.Settings settings() { return settings.get(); }

    @PutMapping("/settings/ai")
    public AiSettingsService.Settings settings(@RequestBody AiSettingsService.Update update) { return settings.save(update); }

    @PostMapping("/ai/test")
    public AiStatementService.ConnectionResult test(@RequestBody(required = false) TestRequest request) {
        return statements.test(request == null ? null : request.requestId());
    }

    @PostMapping("/ai/organize")
    public AiStatementService.OrganizedStatement organize(@RequestBody OrganizeRequest request) {
        return statements.organize(request == null ? null : request.statement(), request == null ? null : request.requestId());
    }

    /** Never saves cases: the frontend previews them and imports the selected ones as custom cases. */
    @PostMapping("/ai/testcases")
    public AiTestCaseService.GeneratedTests testCases(@RequestBody OrganizeRequest request) {
        return testCases.generate(request == null ? null : request.statement(), request == null ? null : request.requestId());
    }

    @GetMapping("/ai/requests/{id}")
    public com.duipai.service.AiRequestTracker.Snapshot request(@PathVariable String id) { return statements.request(id); }

    @PostMapping("/ai/requests/{id}/cancel")
    public com.duipai.service.AiRequestTracker.Snapshot cancel(@PathVariable String id) { return statements.cancel(id); }

    public record OrganizeRequest(String statement, String requestId) { }
    public record TestRequest(String requestId) { }
}
