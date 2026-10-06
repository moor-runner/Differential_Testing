package com.duipai.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Component
public class LocalAuthenticationFilter extends OncePerRequestFilter {
    private final byte[] expected;
    private final String devOrigin;

    public LocalAuthenticationFilter(@Value("${duipai.token:${DUIPAI_TOKEN:}}") String token, @Value("${duipai.dev-origin:${DUIPAI_DEV_ORIGIN:}}") String devOrigin) {
        if (token.length() < 32) throw new IllegalStateException("DUIPAI_TOKEN must contain at least 32 characters; launch through Electron.");
        expected = token.getBytes(StandardCharsets.UTF_8);
        this.devOrigin = devOrigin;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        response.setHeader("Referrer-Policy", "no-referrer");
        String route = request.getServletPath();
        // Servlet paths are decoded; Spring ignores matrix parameters when mapping.
        // Mock requests and some containers provide an empty servlet path.
        if (route == null || route.isEmpty()) route = request.getRequestURI();
        route = route.replaceAll(";[^/]*", "");
        if (!route.equals("/api") && !route.startsWith("/api/")) { chain.doFilter(request, response); return; }
        response.setHeader("Cache-Control", "no-store");
        if (!isLoopback(request.getServerName()) || !validOrigin(request)) {
            reject(response, 403, "仅允许本机请求");
            return;
        }
        String candidate = request.getHeader("X-Duipai-Token");
        boolean authenticated = matches(candidate);
        if (!authenticated && request.getCookies() != null) {
            for (Cookie cookie : request.getCookies()) {
                if ("duipai_token".equals(cookie.getName()) && matches(cookie.getValue())) authenticated = true;
            }
        }
        if (!authenticated) {
            reject(response, 401, "本地访问令牌无效");
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean matches(String value) {
        return value != null && MessageDigest.isEqual(expected, value.getBytes(StandardCharsets.UTF_8));
    }

    private boolean validOrigin(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin == null) return true;
        try {
            URI uri = URI.create(origin);
            if (!"http".equals(uri.getScheme()) || !isLoopback(uri.getHost()) || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(uri.getRawPath() == null || uri.getRawPath().isEmpty())) return false;
            int port = uri.getPort() == -1 ? 80 : uri.getPort();
            return (uri.getHost().equalsIgnoreCase(request.getServerName()) && port == request.getServerPort()) || (!devOrigin.isBlank() && origin.equals(devOrigin));
        } catch (IllegalArgumentException exception) { return false; }
    }

    private boolean isLoopback(String host) {
        return "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host) || "[::1]".equals(host) || "::1".equals(host);
    }

    private void reject(HttpServletResponse response, int status, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"message\":\"" + message + "\"}");
    }
}
