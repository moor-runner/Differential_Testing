package com.duipai.api;

import com.duipai.service.JavaEditorService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Compiler-backed editor queries never execute or emit the submitted program. */
@RestController
@RequestMapping("/api/editor/java")
public class JavaEditorController {
    private final JavaEditorService editor;

    public JavaEditorController(JavaEditorService editor) { this.editor = editor; }

    @PostMapping("/analyze")
    public JavaEditorService.Result analyze(@RequestBody JavaEditorService.Request request) {
        return editor.analyze(request);
    }
}
