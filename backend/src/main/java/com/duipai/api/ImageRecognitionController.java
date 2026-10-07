package com.duipai.api;

import com.duipai.service.WindowsOcrService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/images")
public class ImageRecognitionController {
    private final WindowsOcrService recognition;

    public ImageRecognitionController(WindowsOcrService recognition) { this.recognition = recognition; }

    @GetMapping("/recognition/status")
    public WindowsOcrService.Status status() { return recognition.status(); }

    @PostMapping("/{filename}/recognize")
    public WindowsOcrService.Recognition recognize(@PathVariable String filename,
                                                  @RequestBody(required = false) Request body) {
        return recognition.recognize(filename, body == null ? null : body.language(), body == null ? null : body.region());
    }

    public record Request(String language, WindowsOcrService.Region region) { }
}
