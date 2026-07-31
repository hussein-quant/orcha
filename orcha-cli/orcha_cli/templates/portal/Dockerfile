FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# --proxy-headers: behind the cloud reverse proxy (Caddy), honor
# X-Forwarded-Proto/Host so generated URLs (pairing QR!) say https — Foundation
# strips Authorization on http->https redirects, so an http QR breaks iOS auth.
# forwarded-allow-ips "*" is safe: the portal port is loopback/compose-bound.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
