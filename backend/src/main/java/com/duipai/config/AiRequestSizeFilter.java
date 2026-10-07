package com.duipai.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/** Limits JSON before deserialization, including requests without Content-Length. */
@Component
public class AiRequestSizeFilter extends OncePerRequestFilter {
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getServletPath();
        if (path == null || path.isEmpty()) path = request.getRequestURI();
        path = path.replaceAll(";[^/]*", "");
        int limit = request.getMethod().equals("POST") && path.equals("/api/ai/organize") ? 1024 * 1024
                : request.getMethod().equals("PUT") && path.equals("/api/settings/ai") ? 64 * 1024
                : request.getMethod().equals("POST") && path.equals("/api/ai/test") ? 16 * 1024 : 0;
        if (limit == 0) { chain.doFilter(request, response); return; }
        if (request.getContentLengthLong() > limit) { reject(response); return; }
        byte[] body = request.getInputStream().readNBytes(limit + 1);
        if (body.length > limit) { reject(response); return; }
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override public ServletInputStream getInputStream() {
                ByteArrayInputStream bytes = new ByteArrayInputStream(body);
                return new ServletInputStream() {
                    @Override public boolean isFinished() { return bytes.available() == 0; }
                    @Override public boolean isReady() { return true; }
                    @Override public void setReadListener(ReadListener listener) {
                        try { if (!isFinished()) listener.onDataAvailable(); if (isFinished()) listener.onAllDataRead(); }
                        catch (IOException error) { listener.onError(error); }
                    }
                    @Override public int read() { return bytes.read(); }
                    @Override public int read(byte[] target, int offset, int length) { return bytes.read(target, offset, length); }
                };
            }
            @Override public BufferedReader getReader() { return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8)); }
            @Override public int getContentLength() { return body.length; }
            @Override public long getContentLengthLong() { return body.length; }
        }, response);
    }

    private void reject(HttpServletResponse response) throws IOException {
        response.setStatus(413);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"message\":\"AI 请求内容过大，请缩短题面或设置内容\"}");
    }
}
