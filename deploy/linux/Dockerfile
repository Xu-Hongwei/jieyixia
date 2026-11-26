FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /srv/backend
COPY backend/requirements.lock .
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.lock
COPY backend/app ./app
COPY contract /srv/contract
COPY fixtures /srv/fixtures
USER 65534:65534
