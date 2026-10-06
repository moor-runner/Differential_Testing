package com.duipai.api;

import com.duipai.config.BackendLifecycle;
import com.duipai.config.DataPaths;
import com.duipai.service.*;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final ProblemService problems;
    private final JobService jobs;
    private final LayoutService layouts;
    private final ImageService images;
    private final DataPaths paths;
    private final BackendLifecycle lifecycle;
    public ApiController(ProblemService problems, JobService jobs, LayoutService layouts, ImageService images, DataPaths paths, BackendLifecycle lifecycle) {
        this.problems = problems; this.jobs = jobs; this.layouts = layouts; this.images = images; this.paths = paths; this.lifecycle = lifecycle;
    }

    @GetMapping("/health") public Map<String, Object> health() { return Map.of("status", "ok", "javaVersion", System.getProperty("java.version"), "dataDir", paths.root().toString()); }
    @PostMapping("/shutdown") public Map<String, String> shutdown() { lifecycle.shutdown(); return Map.of("status", "shutting-down"); }
    @GetMapping("/problems") public List<Map<String, Object>> list() { return problems.list(); }
    @PostMapping("/problems") @ResponseStatus(HttpStatus.CREATED) public Map<String, Object> create(@RequestBody Map<String, Object> body) { return problems.create(body); }
    @GetMapping("/problems/{id}") public Map<String, Object> problem(@PathVariable String id) { return problems.get(id); }
    @PutMapping("/problems/{id}") public Map<String, Object> update(@PathVariable String id, @RequestBody Map<String, Object> body) { return problems.update(id, body); }
    @DeleteMapping("/problems/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) public void delete(@PathVariable String id) {
        jobs.deleteProblem(id);
    }
    @GetMapping("/settings/layout") public Map<String, Object> layout() throws IOException { return layouts.get(); }
    @PutMapping("/settings/layout") public Map<String, Object> saveLayout(@RequestBody Map<String, Object> body) throws IOException { return layouts.save(body); }
    @PostMapping(value = "/images", consumes = MediaType.MULTIPART_FORM_DATA_VALUE) public Map<String, String> upload(@RequestParam("file") MultipartFile file) throws IOException { return Map.of("url", images.upload(file)); }
    @GetMapping("/images/{filename}") public ResponseEntity<FileSystemResource> image(@PathVariable String filename) {
        return ResponseEntity.ok().contentType(MediaType.IMAGE_PNG).body(new FileSystemResource(images.get(filename)));
    }
    @GetMapping("/problems/{id}/runs") public List<Map<String, Object>> history(@PathVariable String id) { return jobs.history(id); }
    @GetMapping({"/runs/{id}", "/jobs/{id}"}) public Map<String, Object> run(@PathVariable String id) { return jobs.snapshot(id); }
    @PostMapping("/jobs") @ResponseStatus(HttpStatus.CREATED) public Map<String, Object> start(@RequestBody Map<String, Object> body) {
        Object problemId = body.get("problemId"), replay = body.get("replaySeed");
        if (!(problemId instanceof String id) || id.isBlank()) throw new IllegalArgumentException("须提供题目 ID");
        if (replay != null && !(replay instanceof String)) throw new IllegalArgumentException("复现种子须为字符串");
        return jobs.start(id, (String) replay);
    }
    @GetMapping(value = "/jobs/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE) public SseEmitter events(@PathVariable String id) { return jobs.subscribe(id); }
    @PostMapping("/jobs/{id}/cancel") public Map<String, Object> cancel(@PathVariable String id) { return jobs.cancel(id); }
    @GetMapping("/runs/{id}/export/{kind}") public ResponseEntity<byte[]> export(@PathVariable String id, @PathVariable String kind) {
        byte[] data = jobs.export(id, kind).getBytes(StandardCharsets.UTF_8);
        return ResponseEntity.ok().contentType(new MediaType("text", "plain", StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(kind + ".txt", StandardCharsets.UTF_8).build().toString()).body(data);
    }
}
