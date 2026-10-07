package com.duipai.service;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.*;

class AiRequestTrackerTest {
    @Test
    void boundsHistoryAndRetainsOnlySafeMetadata() {
        AiRequestTracker tracker = new AiRequestTracker();
        String firstId = UUID.randomUUID().toString();
        AiRequestTracker.Entry first = tracker.start("organize", firstId);
        first.policy(true); first.headers(200); first.firstResponse();
        for (int index = 0; index < 100; index++) first.progress(index % 2, index);
        assertThat(tracker.get(firstId).logs()).hasSize(50);
        assertThat(tracker.get(firstId).logs().getFirst().message()).contains("开始请求");
        first.succeed();
        for (int index = 0; index < 128; index++) tracker.start("test", null).succeed();
        assertThatThrownBy(() -> tracker.get(firstId)).isInstanceOfSatisfying(ResponseStatusException.class,
                error -> assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    void invokesCancellationExactlyOnceAndCannotChangeATerminalRequest() {
        AiRequestTracker tracker = new AiRequestTracker(); String id = UUID.randomUUID().toString();
        AiRequestTracker.Entry entry = tracker.start("organize", id); AtomicInteger stopped = new AtomicInteger();
        entry.attachCancellation(stopped::incrementAndGet);
        AiRequestTracker.Snapshot cancelled = tracker.cancel(id);
        tracker.cancel(id); entry.headers(200); entry.progress(100, 200); entry.fail("safe failure");
        assertThat(entry.succeed()).isFalse();
        assertThat(tracker.get(id)).isEqualTo(cancelled);
        assertThat(stopped).hasValue(1);
        AiRequestTracker.Entry race = tracker.start("test", null); race.cancel(); race.attachCancellation(stopped::incrementAndGet);
        assertThat(stopped).hasValue(2);
    }
}
