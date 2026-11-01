# syntax=docker/dockerfile:1

# yt-dlp declares no postprocessors in handlers.py, so it never shells out and
# this image does not need ffmpeg — the audio is uploaded in whatever format
# was downloaded and transcription reads the content type.

FROM python:3.14-slim@sha256:cd89c30eda26ee911a4611b18680086e0ea42e6f5f8cbe653d07fa7958c9cec8 AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_ENV=production

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# The app imports its own modules as top-level names (`from env import env`),
# matching how it runs as a script.
ENV PYTHONPATH=/app/app

RUN useradd --create-home --uid 10001 fetcher
USER fetcher

CMD ["python", "app/app.py"]
