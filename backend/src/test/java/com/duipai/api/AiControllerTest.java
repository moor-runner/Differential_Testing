package com.duipai.api;

import com.duipai.config.AiRequestSizeFilter;
import com.duipai.service.AiSettingsService;
import com.duipai.service.AiStatementService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class AiControllerTest {
    private AiSettingsService settings;
    private AiStatementService statements;
    private MockMvc mvc;

    @BeforeEach
    void createController() {
        settings = mock(AiSettingsService.class);
        statements = mock(AiStatementService.class);
        mvc = MockMvcBuilders.standaloneSetup(new AiController(settings, statements))
                .setControllerAdvice(new ApiErrorHandler()).addFilters(new AiRequestSizeFilter()).build();
    }

    @Test
    void exposesOnlyTheSecretConfigurationFlagAndAcceptsOptionalKeyUpdates() throws Exception {
        AiSettingsService.Settings publicSettings = new AiSettingsService.Settings("https://example.com/v1", "my-model", true);
        when(settings.get()).thenReturn(publicSettings);
        when(settings.save(any())).thenReturn(publicSettings);
        mvc.perform(get("/api/settings/ai")).andExpect(status().isOk()).andExpect(jsonPath("$.apiKeyConfigured").value(true))
                .andExpect(jsonPath("$.apiKey").doesNotExist()).andExpect(jsonPath("$.encryptedApiKey").doesNotExist());
        mvc.perform(put("/api/settings/ai").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"baseUrl\":\"https://example.com/v1\",\"model\":\"my-model\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.apiKey").doesNotExist());
        verify(settings).save(new AiSettingsService.Update("https://example.com/v1", "my-model", null, null));
    }

    @Test
    void returnsAnOrganizationProposalWithoutUpdatingAnyProblem() throws Exception {
        when(statements.organize("原始题面\n9", null)).thenReturn(new AiStatementService.OrganizedStatement("# 整理题面\n\n```text\n9\n```"));
        mvc.perform(post("/api/ai/organize").contentType(MediaType.APPLICATION_JSON).content("{\"statement\":\"原始题面\\n9\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.statement").value("# 整理题面\n\n```text\n9\n```"));
        verify(statements).organize("原始题面\n9", null);
        verifyNoInteractions(settings);
        when(statements.test(null)).thenReturn(new AiStatementService.ConnectionResult("连接成功", "model"));
        mvc.perform(post("/api/ai/test")).andExpect(status().isOk()).andExpect(jsonPath("$.message").value("连接成功"));
    }

    @Test
    void rejectsOversizedBodiesBeforeJsonDeserializationOrProviderCalls() throws Exception {
        mvc.perform(post("/api/ai/organize").contentType(MediaType.APPLICATION_JSON).content("x".repeat(1024 * 1024 + 1)))
                .andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.message").value("AI 请求内容过大，请缩短题面或设置内容"));
        mvc.perform(put("/api/settings/ai").contentType(MediaType.APPLICATION_JSON).content("x".repeat(64 * 1024 + 1)))
                .andExpect(status().isPayloadTooLarge());
        verifyNoInteractions(settings, statements);
    }

    @Test
    void sendsInvalidJsonAndInputValidationThroughTheExistingApiErrorFormat() throws Exception {
        mvc.perform(post("/api/ai/organize").contentType(MediaType.APPLICATION_JSON).content("{"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("请求 JSON 格式无效"));
        when(statements.organize(null, null)).thenThrow(new IllegalArgumentException("请先填写或识别题面文字"));
        mvc.perform(post("/api/ai/organize").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("请先填写或识别题面文字"));
    }

    @Test
    void acceptsRequestIdsAndExposesTheSafeTrackingAndCancellationEndpoints() throws Exception {
        String id = java.util.UUID.randomUUID().toString();
        when(statements.test(id)).thenReturn(new AiStatementService.ConnectionResult("连接成功", "model"));
        mvc.perform(post("/api/ai/test").contentType(MediaType.APPLICATION_JSON).content("{\"requestId\":\"" + id + "\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.message").value("连接成功"));
        when(statements.organize("题面", id)).thenReturn(new AiStatementService.OrganizedStatement("# 题面"));
        mvc.perform(post("/api/ai/organize").contentType(MediaType.APPLICATION_JSON).content("{\"statement\":\"题面\",\"requestId\":\"" + id + "\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.statement").value("# 题面"));
        var snapshot = new com.duipai.service.AiRequestTracker.Snapshot(id, "organize", "CANCELLED", "cancelled", "已取消", 50L,
                10L, 20, 0, 200, true, java.util.List.of());
        when(statements.request(id)).thenReturn(snapshot); when(statements.cancel(id)).thenReturn(snapshot);
        mvc.perform(get("/api/ai/requests/" + id)).andExpect(status().isOk()).andExpect(jsonPath("$.receivedCharacters").value(20))
                .andExpect(jsonPath("$.thinkingDisabled").value(true)).andExpect(jsonPath("$.firstResponseMs").value(10));
        mvc.perform(post("/api/ai/requests/" + id + "/cancel")).andExpect(status().isOk()).andExpect(jsonPath("$.state").value("CANCELLED"));
        verify(statements).test(id); verify(statements).organize("题面", id); verify(statements).cancel(id);
    }
}
