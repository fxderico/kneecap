# kneecap — builds libkneecap_whisper.so (Android on-device captions).
#
# The whisper.cpp sources are NOT in this repo; `scripts/fetch-whisper-cpp.sh`
# clones a pinned tag into ./whisper.cpp (gitignored). When that directory is
# absent this file builds NOTHING and the app still compiles and installs —
# captions then fail at runtime with a clear UnsatisfiedLinkError rather than
# breaking the whole Android build for everyone who has not run the fetch.
cmake_minimum_required(VERSION 3.22.1)
project(kneecap_whisper CXX C)

set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp)

if(NOT EXISTS ${WHISPER_DIR}/include/whisper.h)
	message(WARNING
		"whisper.cpp sources not found at ${WHISPER_DIR} — skipping libkneecap_whisper. "
		"Run apps/mobile/scripts/fetch-whisper-cpp.sh to enable Android captions.")
	# A stub target keeps `externalNativeBuild` happy (it requires at least
	# one target) without producing a .so that would fail to link.
	add_library(kneecap_whisper_absent STATIC ${CMAKE_CURRENT_SOURCE_DIR}/whisper_absent.c)
	return()
endif()

# whisper.cpp's own CMake, driven as a subproject. Everything optional is off:
# the extras (examples, tests, tools, its own SDL/ffmpeg integrations) pull in
# host-only dependencies that do not cross-compile, and the alternate backends
# are irrelevant on the ABIs kneecap ships.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
add_subdirectory(${WHISPER_DIR} ${CMAKE_CURRENT_BINARY_DIR}/whisper_build EXCLUDE_FROM_ALL)

add_library(kneecap_whisper SHARED kneecap_whisper_jni.cpp)
target_link_libraries(kneecap_whisper PRIVATE whisper log)
target_compile_options(kneecap_whisper PRIVATE -O3)
