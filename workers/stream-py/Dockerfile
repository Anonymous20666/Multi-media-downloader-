# Stream worker: MTProto + WebRTC playback engine (ADR-02). Own process because
# the native call core is LGPL — never linked into the TS controller.
# Build context is the REPO ROOT (see docker-compose.yml). No ports: driven
# over Redis. Crash-only: exits loud without STREAM_SESSION_STRING + API creds.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version | head -1

WORKDIR /app
COPY workers/stream-py/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY workers/stream-py/worker ./worker

RUN useradd -r -u 10001 -d /app -s /usr/sbin/nologin appuser \
  && chown -R appuser:appuser /app
USER appuser

CMD ["python", "-m", "worker.main"]
