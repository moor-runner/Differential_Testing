package com.duipai.api;

import com.duipai.service.JavaEditorService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class JavaEditorControllerTest {
    private MockMvc controller(JavaEditorService service) {
        return MockMvcBuilders.standaloneSetup(new JavaEditorController(service)).setControllerAdvice(new ApiErrorHandler()).build();
    }

    @Test
    void exposesActualCompilerDiagnosticsAndTheStableJsonShape() throws Exception {
        controller(new JavaEditorService()).perform(post("/api/editor/java/analyze").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"source\":\"class Main { int value = true; }\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.diagnostics[0].severity").value("error"))
                .andExpect(jsonPath("$.diagnostics[0].start").isNumber()).andExpect(jsonPath("$.diagnostics[0].end").isNumber())
                .andExpect(jsonPath("$.symbols").isArray()).andExpect(jsonPath("$.completions").isArray())
                .andExpect(jsonPath("$.hover").isEmpty()).andExpect(jsonPath("$.definition").isEmpty())
                .andExpect(jsonPath("$.signatures").isArray()).andExpect(jsonPath("$.activeParameter").value(0));
    }

    @Test
    void rejectsInvalidRequestsAndKeepsBusyResponsesRetryable() throws Exception {
        MockMvc real = controller(new JavaEditorService());
        real.perform(post("/api/editor/java/analyze").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("请提供 Java 源代码"));
        real.perform(post("/api/editor/java/analyze").contentType(MediaType.APPLICATION_JSON).content("{"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("请求 JSON 格式无效"));
        String oversized = new ObjectMapper().writeValueAsString(new JavaEditorService.Request(" ".repeat(200_001), null, null));
        real.perform(post("/api/editor/java/analyze").contentType(MediaType.APPLICATION_JSON).content(oversized))
                .andExpect(status().isPayloadTooLarge());
        JavaEditorService busy = mock(JavaEditorService.class);
        when(busy.analyze(any())).thenThrow(new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Java 代码分析繁忙，请稍后重试"));
        controller(busy).perform(post("/api/editor/java/analyze").contentType(MediaType.APPLICATION_JSON).content("{\"source\":\"class Main {}\"}"))
                .andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.message").value("Java 代码分析繁忙，请稍后重试"));
    }
}
