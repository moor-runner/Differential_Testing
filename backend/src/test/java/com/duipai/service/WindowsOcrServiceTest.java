package com.duipai.service;

import com.duipai.config.DataPaths;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class WindowsOcrServiceTest {
    @TempDir Path directory;
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void recognizesOnlyValidatedLocalUploadsAndTreatsEmptyLanguageAsAutomatic() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        ImageService images = new ImageService(paths);
        String filename = upload(images, image(200, 100, "Example"));
        AtomicReference<Map<String, String>> request = new AtomicReference<>();
        WindowsOcrService service = new WindowsOcrService(images, json, (body, timeout) -> {
            request.set(body);
            assertThat(timeout).isEqualTo(Duration.ofSeconds(45));
            return json.readTree("{\"width\":200,\"height\":100,\"language\":\"en-US\",\"lines\":[{\"text\":\"Example\",\"x\":5,\"y\":10,\"width\":100,\"height\":30,\"words\":[]}]}");
        });
        assertThat(service.recognize(filename, "").lines()).extracting(WindowsOcrService.Line::text).containsExactly("Example");
        assertThat(request.get()).containsEntry("path", paths.images().resolve(filename).toString()).doesNotContainKey("language");
        service.recognize(filename, "en-US");
        assertThat(request.get()).containsEntry("language", "en-US");
    }

    @Test
    void rejectsInvalidPathsAndLanguageBeforeStartingPowerShell() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        ImageService images = new ImageService(paths);
        String filename = upload(images, image(200, 100, "Example"));
        AtomicInteger launches = new AtomicInteger();
        WindowsOcrService service = new WindowsOcrService(images, json, (body, timeout) -> {
            launches.incrementAndGet();
            return json.createObjectNode();
        });
        for (String invalid : List.of("../../outside.png", "https://example.com/image.png", "missing.png"))
            assertThatThrownBy(() -> service.recognize(invalid, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                    error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> service.recognize(filename, "en-US; Write-Host injected")).isInstanceOf(IllegalArgumentException.class);
        assertThat(launches).hasValue(0);
    }

    @Test
    void validatesFocusedRegionAndPassesOnlyBoundedIntegerCoordinates() throws Exception {
        ImageService images = new ImageService(new DataPaths(directory.toString()));
        String filename = upload(images, image(200, 100, "Example"));
        AtomicReference<Map<String, String>> request = new AtomicReference<>();
        WindowsOcrService service = new WindowsOcrService(images, json, (body, timeout) -> {
            request.set(body);
            return json.readTree("{\"width\":200,\"height\":100,\"language\":\"en-US\",\"lines\":[]}");
        });
        for (WindowsOcrService.Region invalid : List.of(new WindowsOcrService.Region(-1, 0, 10, 10),
                new WindowsOcrService.Region(0, 0, 0, 10), new WindowsOcrService.Region(190, 0, 11, 10),
                new WindowsOcrService.Region(0, 90, 10, Integer.MAX_VALUE)))
            assertThatThrownBy(() -> service.recognize(filename, null, invalid)).isInstanceOf(IllegalArgumentException.class);
        assertThat(request.get()).isNull();
        service.recognize(filename, null, new WindowsOcrService.Region(20, 10, 150, 70));
        assertThat(request.get()).containsEntry("regionX", "20").containsEntry("regionY", "10")
                .containsEntry("regionWidth", "150").containsEntry("regionHeight", "70");
    }

    @Test
    void rejectsOverlappingRecognitionAndReleasesSlotAfterFailure() throws Exception {
        ImageService images = new ImageService(new DataPaths(directory.toString()));
        String filename = upload(images, image(200, 100, "Example"));
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger launches = new AtomicInteger();
        WindowsOcrService service = new WindowsOcrService(images, json, (body, timeout) -> {
            if (launches.incrementAndGet() == 1) {
                entered.countDown();
                try { if (!release.await(5, TimeUnit.SECONDS)) throw new IOException("Test timeout"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
                throw new IOException("Recognition failed");
            }
            return json.readTree("{\"width\":200,\"height\":100,\"language\":\"en-US\",\"lines\":[]}");
        });
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> running = executor.submit(() -> service.recognize(filename, null));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> service.recognize(filename, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                        error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS));
            } finally { release.countDown(); }
            assertThatThrownBy(() -> running.get(5, TimeUnit.SECONDS)).isInstanceOf(ExecutionException.class);
            assertThat(service.recognize(filename, null).lines()).isEmpty();
        }
    }

    @Test
    void reportsMissingLanguageAndRejectsOutOfImageCoordinates() throws Exception {
        ImageService images = new ImageService(new DataPaths(directory.toString()));
        String filename = upload(images, image(200, 100, "Example"));
        WindowsOcrService unavailable = new WindowsOcrService(images, json, (body, timeout) -> json.readTree("{\"error\":\"NO_LANGUAGE\"}"));
        assertThat(unavailable.status().available()).isFalse();
        assertThat(unavailable.status().message()).contains("光学字符识别");
        assertThatThrownBy(() -> unavailable.recognize(filename, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        WindowsOcrService malformed = new WindowsOcrService(images, json, (body, timeout) ->
                json.readTree("{\"width\":200,\"height\":100,\"language\":\"en-US\",\"lines\":[{\"text\":\"Example\",\"x\":190,\"y\":10,\"width\":100,\"height\":30,\"words\":[]}]}") );
        assertThatThrownBy(() -> malformed.recognize(filename, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY));
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void recognizesRealWindowsOcrAndRestoresOriginalCoordinatesForWideImages() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        ImageService images = new ImageService(paths);
        WindowsOcrService service = new WindowsOcrService(images, json, paths);
        WindowsOcrService.Status status = service.status();
        assumeTrue(status.available(), status.message());
        String language = status.languages().stream().map(WindowsOcrService.Language::tag).filter(tag -> tag.startsWith("en-")).findFirst().orElse(null);
        assumeTrue(language != null, "An English OCR component is required for this generated fixture");
        int width = status.maxImageDimension() + 500;
        assumeTrue((long) width * 500 <= 16_000_000);
        String filename = upload(images, image(width, 500, "Sample Input", "100 200", "Data Range", "1 <= n <= 1000"));
        WindowsOcrService.Recognition result = service.recognize(filename, language);
        assertThat(result.width()).isEqualTo(width);
        assertThat(result.height()).isEqualTo(500);
        assertThat(result.language()).isEqualTo(language);
        assertThat(result.lines()).extracting(WindowsOcrService.Line::text).anySatisfy(text -> assertThat(text).contains("Sample Input"));
        WindowsOcrService.Line sample = result.lines().stream().filter(line -> line.text().contains("Sample Input")).findFirst().orElseThrow();
        assertThat(sample.x()).isBetween(45.0, 65.0);
        assertThat(sample.words()).isNotEmpty();
        try (var files = Files.list(paths.work())) { assertThat(files).isEmpty(); }
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void recoversOmittedNumericSampleRowsFromTheRealCanvasScreenshotWithoutDuplicatingOtherRows() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        ImageService images = new ImageService(paths);
        WindowsOcrService service = new WindowsOcrService(images, json, paths);
        assumeTrue(service.status().languages().stream().anyMatch(language -> language.tag().equals("zh-Hans-CN")),
                "The Simplified Chinese OCR component is required for this regression fixture");
        byte[] bytes;
        try (var fixture = getClass().getResourceAsStream("/ocr/canvas-sample-rows.png")) {
            assertThat(fixture).isNotNull();
            bytes = fixture.readAllBytes();
        }
        String filename = images.upload(new MockMultipartFile("file", "canvas.png", "image/png", bytes)).substring("/api/images/".length());
        WindowsOcrService.Recognition result = service.recognize(filename, "zh-Hans-CN");
        assertThat(result.width()).isEqualTo(1240);
        assertThat(result.height()).isEqualTo(1690);
        List<WindowsOcrService.Line> samples = result.lines().stream().filter(line -> line.y() > 700 && line.y() < 1000).toList();
        assertThat(samples).extracting(WindowsOcrService.Line::text).containsSubsequence("3", "1 2 3", "6");
        for (String text : List.of("3", "1 2 3", "6"))
            assertThat(samples.stream().filter(line -> line.text().equals(text)).count()).isEqualTo(1);
        WindowsOcrService.Line recovered = samples.stream().filter(line -> line.text().equals("1 2 3")).findFirst().orElseThrow();
        assertThat(recovered.y()).isBetween(775.0, 790.0);
        assertThat(recovered.words()).extracting(WindowsOcrService.Word::text).containsExactly("1", "2", "3");
        assertThat(result.lines().stream().filter(line -> line.y() >= 1000).count()).isEqualTo(3);
    }

    @Test
    @EnabledOnOs(OS.WINDOWS)
    void focusedDarkScreenshotRemovesFaintWatermarksAndKeepsOriginalCoordinates() throws Exception {
        DataPaths paths = new DataPaths(directory.toString());
        ImageService images = new ImageService(paths);
        WindowsOcrService service = new WindowsOcrService(images, json, paths);
        assumeTrue(service.status().languages().stream().anyMatch(language -> language.tag().equals("en-US")));
        BufferedImage screenshot = new BufferedImage(2600, 1500, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = screenshot.createGraphics();
        try {
            graphics.setColor(new Color(24, 26, 27)); graphics.fillRect(0, 0, 2600, 1500);
            graphics.setFont(new Font("SansSerif", Font.PLAIN, 36));
            graphics.setColor(new Color(70, 72, 73)); graphics.drawString("SR2026000000000", 520, 170);
            graphics.setColor(new Color(210, 205, 198));
            graphics.drawString("Sample Input", 420, 260); graphics.drawString("9", 420, 320);
            graphics.drawString("Sample Output", 420, 400); graphics.drawString("6", 420, 460);
            graphics.drawString("Code Editor", 1700, 260);
        } finally { graphics.dispose(); }
        String filename = upload(images, screenshot);
        WindowsOcrService.Recognition result = service.recognize(filename, "en-US", new WindowsOcrService.Region(390, 100, 1000, 1000));
        assertThat(result.width()).isEqualTo(2600); assertThat(result.height()).isEqualTo(1500);
        assertThat(result.lines()).extracting(WindowsOcrService.Line::text).contains("Sample Input", "Sample Output", "9", "6")
                .noneMatch(text -> text.contains("SR2026") || text.contains("Code Editor"));
        assertThat(result.lines()).allSatisfy(line -> {
            assertThat(line.x()).isBetween(390.0, 1390.0); assertThat(line.y()).isBetween(100.0, 1100.0);
        });
        try (var files = Files.list(paths.work())) { assertThat(files).isEmpty(); }
    }

    private String upload(ImageService images, BufferedImage image) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return images.upload(new MockMultipartFile("file", "题目.png", "image/png", bytes.toByteArray())).substring("/api/images/".length());
    }

    private BufferedImage image(int width, int height, String... lines) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = image.createGraphics();
        try {
            graphics.setColor(Color.WHITE); graphics.fillRect(0, 0, width, height);
            graphics.setColor(Color.BLACK); graphics.setFont(new Font("SansSerif", Font.PLAIN, 36));
            graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
            for (int index = 0; index < lines.length; index++) graphics.drawString(lines[index], 50, 65 + index * 70);
        } finally { graphics.dispose(); }
        return image;
    }
}
