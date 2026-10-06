package com.duipai.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;

@RestControllerAdvice
public class ApiErrorHandler {
    private static final Logger LOG = LoggerFactory.getLogger(ApiErrorHandler.class);
    @ExceptionHandler(ResponseStatusException.class) public ResponseEntity<Map<String, String>> status(ResponseStatusException exception) {
        return ResponseEntity.status(exception.getStatusCode()).body(Map.of("message", exception.getReason() == null ? "请求失败" : exception.getReason()));
    }
    @ExceptionHandler({IllegalArgumentException.class, HttpMessageNotReadableException.class}) public ResponseEntity<Map<String, String>> invalid(Exception exception) {
        return ResponseEntity.badRequest().body(Map.of("message", exception instanceof HttpMessageNotReadableException ? "请求 JSON 格式无效" : exception.getMessage()));
    }
    @ExceptionHandler(IllegalStateException.class) public ResponseEntity<Map<String, String>> conflict(IllegalStateException exception) {
        LOG.warn("Request failed", exception);
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("message", exception.getMessage() == null ? "任务状态冲突" : exception.getMessage()));
    }
    @ExceptionHandler(MaxUploadSizeExceededException.class) public ResponseEntity<Map<String, String>> size(MaxUploadSizeExceededException exception) {
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(Map.of("message", "图片上限为 10 MiB"));
    }
    @ExceptionHandler(Exception.class) public ResponseEntity<Map<String, String>> other(Exception exception) {
        LOG.error("Request failed", exception);
        return ResponseEntity.internalServerError().body(Map.of("message", "本地服务错误，请检查数据目录权限或磁盘空间"));
    }
}
