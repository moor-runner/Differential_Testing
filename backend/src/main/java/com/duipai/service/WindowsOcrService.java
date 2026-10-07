package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.HashMap;
import javax.imageio.ImageIO;
import java.util.concurrent.*;

/** Local OCR bridge; images never leave this computer. */
@Service
public class WindowsOcrService {
    private static final String LANGUAGE_HELP = "请在 Windows 设置 → 时间和语言 → 语言和区域中安装所需语言的光学字符识别组件";
    private static final Duration RECOGNITION_TIMEOUT = Duration.ofSeconds(45);
    private static final Duration STATUS_TIMEOUT = Duration.ofSeconds(15);
    private final ImageService images;
    private final ObjectMapper json;
    private final Bridge bridge;
    private final Semaphore slots = new Semaphore(1);
    private volatile CachedStatus cachedStatus;

    @Autowired
    public WindowsOcrService(ImageService images, ObjectMapper json, DataPaths paths) {
        this(images, json, new PowerShellBridge(json, paths.work()));
    }

    WindowsOcrService(ImageService images, ObjectMapper json, Bridge bridge) {
        this.images = images;
        this.json = json;
        this.bridge = bridge;
    }

    public synchronized Status status() {
        CachedStatus cached = cachedStatus;
        if (cached != null && cached.expiresAt() > System.nanoTime()) return cached.value();
        Status result;
        try {
            JsonNode response = bridge.execute(Map.of("operation", "status"), STATUS_TIMEOUT);
            checkError(response);
            Status reported = json.treeToValue(response, Status.class);
            result = new Status(reported.available(), reported.languages(), reported.defaultLanguage(), reported.maxImageDimension(),
                    reported.available() ? "使用 Windows 本地离线文字识别" : "未安装可用的 OCR 语言。" + LANGUAGE_HELP);
        } catch (ResponseStatusException exception) {
            result = new Status(false, List.of(), "", 0, exception.getReason());
        } catch (IOException exception) {
            result = new Status(false, List.of(), "", 0, "无法读取 Windows OCR 状态，请稍后重试");
        }
        cachedStatus = new CachedStatus(result, System.nanoTime() + Duration.ofSeconds(30).toNanos());
        return result;
    }

    public Recognition recognize(String filename, String language) {
        return recognize(filename, language, null);
    }

    public Recognition recognize(String filename, String language, Region region) {
        Path image = images.get(filename); // Reuse upload whitelist and reject paths or symbolic links before launching anything.
        if (region != null) {
            if (region.x() < 0 || region.y() < 0 || region.width() < 1 || region.height() < 1)
                throw new IllegalArgumentException("识别区域无效");
            try (var input = ImageIO.createImageInputStream(image.toFile())) {
                var readers = ImageIO.getImageReaders(input);
                if (!readers.hasNext()) throw new IOException("Missing PNG reader");
                var reader = readers.next();
                try {
                    reader.setInput(input);
                    if ((long) region.x() + region.width() > reader.getWidth(0) || (long) region.y() + region.height() > reader.getHeight(0))
                        throw new IllegalArgumentException("识别区域超出图片边界");
                } finally { reader.dispose(); }
            } catch (IOException exception) { throw new IllegalArgumentException("无法读取图片尺寸", exception); }
        }
        if (language != null && language.isBlank()) language = null;
        if (language != null && (language.length() > 48 || !language.matches("[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*")))
            throw new IllegalArgumentException("OCR 语言标签无效");
        if (!slots.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "正在识别另一张图片，请完成后再试");
        try {
            Map<String, String> request = new HashMap<>(Map.of("operation", "recognize", "path", image.toString()));
            if (language != null) request.put("language", language);
            if (region != null) {
                request.put("regionX", String.valueOf(region.x())); request.put("regionY", String.valueOf(region.y()));
                request.put("regionWidth", String.valueOf(region.width())); request.put("regionHeight", String.valueOf(region.height()));
            }
            JsonNode response = bridge.execute(request, RECOGNITION_TIMEOUT);
            checkError(response);
            Recognition result = json.treeToValue(response, Recognition.class);
            if (result.width() < 1 || result.height() < 1 || (long) result.width() * result.height() > 16_000_000
                    || result.language() == null || result.lines() == null)
                throw new IOException("Invalid OCR result");
            for (Line line : result.lines()) {
                if (line.text() == null || !validBox(line.x(), line.y(), line.width(), line.height(), result.width(), result.height()))
                    throw new IOException("Invalid OCR line");
                if (line.words() != null) for (Word word : line.words())
                    if (word.text() == null || !validBox(word.x(), word.y(), word.width(), word.height(), result.width(), result.height()))
                        throw new IOException("Invalid OCR word");
            }
            return result;
        } catch (IOException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "图片识别结果无法读取，请换用清晰图片重试", exception);
        } finally {
            slots.release();
        }
    }

    private static boolean validBox(double x, double y, double width, double height, int imageWidth, int imageHeight) {
        return Double.isFinite(x) && Double.isFinite(y) && Double.isFinite(width) && Double.isFinite(height)
                && x >= 0 && y >= 0 && width >= 0 && height >= 0 && x + width <= imageWidth + 1 && y + height <= imageHeight + 1;
    }

    private static void checkError(JsonNode response) {
        if (!response.has("error")) return;
        String error = response.path("error").asText();
        if ("UNSUPPORTED_LANGUAGE".equals(error))
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "未安装选定的 OCR 语言。" + LANGUAGE_HELP);
        if ("NO_LANGUAGE".equals(error))
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "未安装可用的 OCR 语言。" + LANGUAGE_HELP);
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Windows 文字识别不可用，请检查系统 OCR 语言组件并重试");
    }

    public record Status(boolean available, List<Language> languages, String defaultLanguage, int maxImageDimension, String message) { }
    public record Language(String tag, String name) { }
    public record Recognition(int width, int height, String language, List<Line> lines) { }
    public record Line(String text, double x, double y, double width, double height, List<Word> words) { }
    public record Word(String text, double x, double y, double width, double height) { }
    public record Region(int x, int y, int width, int height) { }
    private record CachedStatus(Status value, long expiresAt) { }

    @FunctionalInterface
    interface Bridge {
        JsonNode execute(Map<String, String> request, Duration timeout) throws IOException;
    }

    private static final class PowerShellBridge implements Bridge {
        private static final int MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
        private final ObjectMapper json;
        private final Path work;

        private PowerShellBridge(ObjectMapper json, Path work) { this.json = json; this.work = work; }

        @Override
        public JsonNode execute(Map<String, String> request, Duration timeout) throws IOException {
            if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).startsWith("windows"))
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "本地图片识别需要 Windows 10 或更高版本");
            String systemRoot = System.getenv("SystemRoot");
            if (systemRoot == null)
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "找不到 Windows PowerShell，无法进行本地图片识别");
            Path executable = Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!Files.isRegularFile(executable))
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "找不到 Windows PowerShell，无法进行本地图片识别");
            Path script = Files.createTempFile(work, "image-ocr-", ".ps1");
            Process process = null;
            try {
                try (InputStream source = WindowsOcrService.class.getResourceAsStream("/ocr/windows-ocr.ps1")) {
                    if (source == null) throw new IOException("OCR script is missing");
                    Files.write(script, source.readAllBytes());
                }
                // Only the bundled script path is an argument. Image paths and language are JSON on stdin, never executable code.
                process = new ProcessBuilder(executable.toString(), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script.toString())
                        .redirectErrorStream(true).start();
                Process running = process;
                FutureTask<byte[]> output = new FutureTask<>(() -> {
                    try (InputStream stream = running.getInputStream()) {
                        byte[] bytes = stream.readNBytes(MAX_OUTPUT_BYTES + 1);
                        if (bytes.length > MAX_OUTPUT_BYTES) {
                            running.destroyForcibly();
                            throw new IOException("OCR output exceeds limit");
                        }
                        return bytes;
                    }
                });
                Thread.ofVirtual().name("windows-ocr-output").start(output);
                try (var input = process.getOutputStream()) {
                    input.write((json.writeValueAsString(request) + "\n").getBytes(StandardCharsets.UTF_8));
                }
                if (!process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                    throw new ResponseStatusException(HttpStatus.GATEWAY_TIMEOUT, "图片识别超时，请缩小图片或分区域识别后重试");
                }
                byte[] bytes = output.get(3, TimeUnit.SECONDS);
                if (process.exitValue() != 0)
                    throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Windows 文字识别启动失败，请检查系统 OCR 语言组件");
                JsonNode response = json.readTree(bytes);
                if (response == null || !response.isObject()) throw new IOException("Empty OCR response");
                return response;
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "图片识别已取消", exception);
            } catch (ExecutionException | TimeoutException exception) {
                throw new IOException("Could not read OCR response", exception);
            } finally {
                if (process != null && process.isAlive()) process.destroyForcibly();
                Files.deleteIfExists(script);
            }
        }
    }
}
