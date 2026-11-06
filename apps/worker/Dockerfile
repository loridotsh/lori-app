FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS verify
WORKDIR /source
COPY scripts/vendor-work-runtime.mjs scripts/vendor-work-runtime.mjs
COPY apps/worker/vendor apps/worker/vendor
RUN node scripts/vendor-work-runtime.mjs

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS python-runtime

FROM rust:1.92-bookworm@sha256:e90e846de4124376164ddfbaab4b0774c7bdeef5e738866295e5a90a34a307a2 AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends libseccomp-dev && rm -rf /var/lib/apt/lists/*
COPY apps/worker/Cargo.toml apps/worker/Cargo.lock ./
COPY --from=verify /source/apps/worker/vendor ./vendor
COPY apps/worker/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --locked --release && cp /build/target/release/lori-work-cloud-worker /build/lori-work-cloud-worker
COPY apps/worker/native/work-sandbox.c ./native/work-sandbox.c
RUN gcc -O2 -Wall -Wextra -Werror native/work-sandbox.c -lseccomp -o /build/lori-work-sandbox

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libseccomp2 python3 python3-venv libreoffice-writer libreoffice-calc libreoffice-impress tesseract-ocr tesseract-ocr-eng fonts-liberation fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*
COPY --from=python-runtime /usr/local /usr/local
# The shared lock requires Python >=3.12. Keep the official, pinned Bookworm
# interpreter with the same distro libraries; verify native modules before use.
RUN ldconfig && /usr/local/bin/python3 -c "import bz2, ctypes, curses, lzma, readline, sqlite3, ssl, zlib"
COPY --from=verify /source/apps/worker/vendor/work-runtime /opt/lori-work-runtime
RUN /usr/local/bin/python3 -m venv /opt/lori-work-runtime/python && /opt/lori-work-runtime/python/bin/pip install --no-cache-dir --require-hashes -r /opt/lori-work-runtime/requirements.lock && mkdir -p /opt/lori-work-runtime/bin /opt/lori-work-runtime/office/program && ln -s /usr/bin/tesseract /opt/lori-work-runtime/bin/tesseract && ln -s /usr/share/tesseract-ocr/5/tessdata /opt/lori-work-runtime/tessdata
COPY --chmod=755 apps/worker/native/office-headless.sh /opt/lori-work-runtime/office/program/soffice
# Complete DejaVu styles preserve symbols such as the rupee in normal, bold and
# italic PDF text. Keep this separate so the Office/Python layers stay cached.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-extra && rm -rf /var/lib/apt/lists/*
# Lori's document design kit: premium Word, Excel, PowerPoint and PDF defaults importable by commands.
# Its self-test runs at build time, so a broken kit never ships.
COPY apps/worker/native/lori_design /opt/lori-work-runtime/python/lib/python3.13/site-packages/lori_design
RUN MPLCONFIGDIR=/tmp/mpl TMPDIR=/tmp /opt/lori-work-runtime/python/bin/python -m lori_design.selftest && rm -rf /tmp/mpl
# Execute the recipes served to models and the layout regressions in the actual
# Linux runtime without shipping QA sources or the skill catalog in the image.
RUN --mount=type=bind,source=apps/worker/native/test_document_layout.py,target=/tmp/test_document_layout.py --mount=type=bind,source=apps/api/catalog/cloud-skills,target=/tmp/cloud-skills LORI_CLOUD_SKILLS_ROOT=/tmp/cloud-skills TMPDIR=/tmp /opt/lori-work-runtime/python/bin/python /tmp/test_document_layout.py
COPY --from=build /build/lori-work-cloud-worker /usr/local/bin/lori-work-cloud-worker
COPY --from=build /build/lori-work-sandbox /usr/local/bin/lori-work-sandbox
ENV WORK_CLOUD_RUNTIME_PATH=/opt/lori-work-runtime
ENV TMPDIR=/var/tmp/lori-work
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/lori-work-cloud-worker"]

FROM runtime AS sandbox-test
COPY apps/worker/native/test-sandbox.py /usr/local/share/lori-work-sandbox-test.py
ENTRYPOINT ["/usr/bin/python3", "/usr/local/share/lori-work-sandbox-test.py"]

FROM runtime AS production
