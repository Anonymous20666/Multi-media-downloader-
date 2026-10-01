# Stream worker: MTProto + WebRTC playback engine (ADR-02). Own process because
# the native call core is LGPL — never linked into the TS controller.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker ./worker

# No ports: driven over Redis. Needs STREAM_SESSION_STRING + API id/hash (env).
CMD ["python", "-m", "worker.main"]
