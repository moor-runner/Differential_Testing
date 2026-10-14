package com.duipai.api;

import com.duipai.service.BreakpointService;
import com.duipai.service.DebugService;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;

/** Breakpoint debugging of one test case in the editor; breakpoints are saved per problem and program. */
@RestController
@RequestMapping("/api")
public class DebugController {
    private final DebugService debug;
    private final BreakpointService breakpoints;

    public DebugController(DebugService debug, BreakpointService breakpoints) { this.debug = debug; this.breakpoints = breakpoints; }

    @GetMapping("/problems/{id}/breakpoints") public Map<String, Object> breakpoints(@PathVariable String id) { return breakpoints.get(id); }
    @PutMapping("/problems/{id}/breakpoints") public Map<String, Object> saveBreakpoints(@PathVariable String id, @RequestBody Map<String, Object> body) { return breakpoints.save(id, body); }

    @PostMapping("/debug") @ResponseStatus(HttpStatus.CREATED) public Map<String, Object> start(@RequestBody Map<String, Object> body) { return debug.start(body); }
    @GetMapping("/debug/{id}") public Map<String, Object> snapshot(@PathVariable String id) { return debug.snapshot(id); }
    @GetMapping(value = "/debug/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE) public SseEmitter events(@PathVariable String id) { return debug.subscribe(id); }
    @PostMapping("/debug/{id}/resume") public Map<String, Object> resume(@PathVariable String id) { return debug.resume(id); }
    @PostMapping("/debug/{id}/pause") public Map<String, Object> pause(@PathVariable String id) { return debug.pause(id); }
    @PostMapping("/debug/{id}/step") public Map<String, Object> step(@PathVariable String id, @RequestBody Map<String, Object> body) { return debug.step(id, body); }
    @PostMapping("/debug/{id}/run-to-line") public Map<String, Object> runToLine(@PathVariable String id, @RequestBody Map<String, Object> body) { return debug.runToLine(id, body); }
    @PostMapping("/debug/{id}/stop") public Map<String, Object> stop(@PathVariable String id) { return debug.stop(id); }
    @PutMapping("/debug/{id}/breakpoints") public Map<String, Object> sessionBreakpoints(@PathVariable String id, @RequestBody Map<String, Object> body) { return debug.breakpoints(id, body); }
    @GetMapping("/debug/{id}/frames/{index}/variables") public Map<String, Object> frame(@PathVariable String id, @PathVariable int index, @RequestParam int generation) { return debug.frameVariables(id, generation, index); }
    @GetMapping("/debug/{id}/variables/{reference}") public Map<String, Object> variables(@PathVariable String id, @PathVariable int reference, @RequestParam int generation,
                                                                                         @RequestParam(defaultValue = "0") int start, @RequestParam(defaultValue = "100") int count) {
        return debug.children(id, generation, reference, start, count);
    }
    @GetMapping("/debug/{id}/console") public Map<String, Object> console(@PathVariable String id, @RequestParam(defaultValue = "0") int from) { return debug.console(id, from); }
}
