# Makefile for harness-landlock-guardian + test_payload.
# Standalone static-ish C build. No node-gyp, no binding.gyp, no external deps.

# THE GUARDIAN'S COMPILER, DECLARED ONCE.
#
# `root-policy.ts` binds the built guardian binary by sha256, so the compiler
# is part of the measured artifact: a build with another compiler produces a
# different binary and a different pin. Both workflows install this package and
# invoke this Makefile WITHOUT a CC= literal; engine/guardian/build.ts invokes
# `make` and no longer carries its own search list; the prevention guard
# tests/prevention/guardian-compiler-pin.test.ts reads THIS line and refuses a
# workflow that spells the compiler again.
#
# A missing gcc-14 fails in `make` with the compiler's own words, which is the
# honest failure: there is no fallback compiler, by design.
CC := gcc-14

CFLAGS := -std=c11 -Wall -Wextra -Werror -O2 -D_GNU_SOURCE
BUILD  := build

SRC     := landlock-guardian.c
HDR     := landlock-guardian.h
BIN     := $(BUILD)/harness-landlock-guardian
TEST_SRC := tests/test_payload.c
TEST_BIN := $(BUILD)/test_payload

.PHONY: all guardian test_payload test_process_supervisor clean test

all: guardian test_payload

guardian: $(BIN)

$(BIN): $(SRC) $(HDR) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(SRC)

test_payload: $(TEST_BIN)

# The test runner needs Linux lifetime operations unavailable in Node.
# Keep the primitive separate from the security guardian executable.
test_process_supervisor: $(BUILD)/test-process-supervisor

# Compiled to a private temporary and renamed into place: two concurrent
# makes (two suites starting at once) never leave a torn binary behind.
$(BUILD)/test-process-supervisor: test-process-supervisor.c | $(BUILD)
	$(CC) $(CFLAGS) -o $@.$$$$.tmp $< -lm && mv -f $@.$$$$.tmp $@

$(TEST_BIN): $(TEST_SRC) | $(BUILD)
	$(CC) $(CFLAGS) -o $@ $(TEST_SRC)

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)

test: all
	bash tests/run-tests.sh
