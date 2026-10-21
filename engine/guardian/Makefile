# Makefile for harness-landlock-guardian + test_payload.
# Standalone static-ish C build. No node-gyp, no binding.gyp, no external deps.

# THE GUARDIAN'S COMPILER, DECLARED ONCE.
#
# The compiler is no longer part of the trust anchor: `root-policy.ts` binds
# the binary by its REPRODUCIBLE BUILD STAMP (the digest of the sealed inputs
# below), not by the binary's bytes, so the same sources and declared flags
# pass on any compiler. Both workflows install this package and invoke this
# Makefile WITHOUT a CC= literal; engine/guardian/build.ts invokes `make` and
# no longer carries its own search list; the prevention guard
# tests/prevention/guardian-compiler-pin.test.ts reads THIS line and refuses a
# workflow that spells the compiler again.
#
# A missing gcc-14 fails in `make` with the compiler's own words, which is the
# honest failure: there is no fallback compiler, by design.
CC := gcc-14

# THE SEALED INPUTS, ONE OWNER: build-stamp.spec (read by the runtime too).
# `include` gives this Makefile STAMP_FORMAT, STAMP_CFLAGS and STAMP_SOURCES;
# the C compiler receives the same flags the stamp declares, so a flag change
# is a stamp change and a reviewed re-pin through `harness sync`.
STAMP_SPEC := build-stamp.spec
include $(STAMP_SPEC)

CFLAGS  := $(STAMP_CFLAGS)
BUILD   := build

# The canonical payload (see build-stamp.spec) hashed with sha256sum. `$$` is
# make's escape for a shell `$`; each source's digest and path are printed in
# declaration order, one line each, with LF after every line.
BUILD_STAMP := $(shell { \
	printf '%s\n' '$(STAMP_FORMAT)'; \
	printf 'cflags %s\n' '$(STAMP_CFLAGS)'; \
	for f in $(STAMP_SOURCES); do \
		d=$$(sha256sum -- "$$f" | cut -d' ' -f1) || exit 1; \
		printf 'source %s %s\n' "$$d" "$$f"; \
	done; \
} | sha256sum | cut -d' ' -f1)

CPPFLAGS := -DGUARDIAN_BUILD_STAMP=\"$(BUILD_STAMP)\"

BIN      := $(BUILD)/harness-landlock-guardian
TEST_SRC := tests/test_payload.c
TEST_BIN := $(BUILD)/test_payload

.PHONY: all guardian test_payload test_process_supervisor clean test

all: guardian test_payload

guardian: $(BIN)

$(BIN): $(STAMP_SOURCES) $(STAMP_SPEC) | $(BUILD)
	@test -n "$(BUILD_STAMP)" || { echo "guardian build: refusing to embed an empty build stamp (is sha256sum installed?)" >&2; exit 1; }
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $(filter %.c,$(STAMP_SOURCES))

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
