# THE GUARDIAN'S SEALED BUILD INPUTS — ONE DECLARATION, TWO CONSUMERS.
#
# The stamp is a pure function of THIS file's three values and the bytes of
# STAMP_SOURCES:
#
#   - the Makefile reads this file, hashes the sources below, and embeds the
#     resulting digest in the binary as -DGUARDIAN_BUILD_STAMP=…;
#   - engine/src/filesystem/self-protection/guardian-build-stamp.ts recomputes
#     the same digest at runtime from the harness's own source tree.
#
# It is NOT a digest of the compiled binary: two compilers produce different
# code for the same inputs, and a build stamp that changed with codegen would
# refuse every CI run (the defect this replaces). The payload both sides hash
# is exactly:
#
#   <STAMP_FORMAT>
#   cflags <STAMP_CFLAGS>
#   source <sha256 of each source, in the order below> <source path>
#
# Each line ends with LF, including the last. Keep the format's first line
# stable: changing it changes every stamp, which is a reviewed re-pin through
# `harness sync`, never a hand edit.
STAMP_FORMAT := bridlewise-guardian-build-stamp/v1
STAMP_CFLAGS := -std=c11 -Wall -Wextra -Werror -O2 -D_GNU_SOURCE
STAMP_SOURCES := landlock-guardian.c landlock-guardian.h
