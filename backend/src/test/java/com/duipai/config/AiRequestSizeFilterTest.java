package com.duipai.config;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

class AiRequestSizeFilterTest {
    @Test
    void boundsChunkedRequestsWithoutContentLengthAndReplaysValidBodyExactly() throws Exception {
        AiRequestSizeFilter filter = new AiRequestSizeFilter();
        MockHttpServletRequest invalid = request(new byte[1024 * 1024 + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<HttpServletRequest> forwarded = new AtomicReference<>();
        filter.doFilter(invalid, response, (incoming, outgoing) -> forwarded.set((HttpServletRequest) incoming));
        assertThat(response.getStatus()).isEqualTo(413);
        assertThat(forwarded.get()).isNull();
        byte[] body = "{\"statement\":\"中文题面\\n9\"}".getBytes(StandardCharsets.UTF_8);
        filter.doFilter(request(body), new MockHttpServletResponse(), (incoming, outgoing) -> forwarded.set((HttpServletRequest) incoming));
        assertThat(forwarded.get().getInputStream().readAllBytes()).isEqualTo(body);
        assertThat(forwarded.get().getContentLengthLong()).isEqualTo(body.length);
    }

    private MockHttpServletRequest request(byte[] body) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/ai/organize") {
            @Override public int getContentLength() { return -1; }
            @Override public long getContentLengthLong() { return -1; }
        };
        request.setContent(body);
        return request;
    }
}
