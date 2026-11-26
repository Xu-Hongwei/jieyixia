"""Build the personal-Qwen web app and assemble a minimal Linux release."""
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FRONTEND = ROOT / "frontend"


def release_files():
    yield from ((HERE / name, name) for name in ("compose.yaml", "Caddyfile", "start.sh", "README.md"))
    yield HERE / "Dockerfile", "api/Dockerfile"
    yield ROOT / "backend/requirements.lock", "api/backend/requirements.lock"
    for source in sorted((ROOT / "backend/app").rglob("*.py")):
        yield source, "api/" + source.relative_to(ROOT).as_posix()
    for name in ("models.py", "assistant_models.py", "assistant_http.py"):
        yield ROOT / "contract" / name, "api/contract/" + name
    for name in ("01-course-assignment", "02-grading-supplement", "03-deadline-change", "04-reference-paper"):
        yield ROOT / "fixtures" / (name + ".json"), "api/fixtures/" + name + ".json"
    dist = FRONTEND / "dist"
    yield dist / "index.html", "web/index.html"
    for asset in sorted((dist / "assets").rglob("*")):
        if asset.is_file() and asset.suffix.lower() in {".js", ".css", ".png", ".jpg", ".webp", ".svg", ".woff", ".woff2"}:
            yield asset, "web/" + asset.relative_to(dist).as_posix()


def main():
    subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "run", "build"], cwd=FRONTEND, check=True)
    output = ROOT / "output/releases"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "jiexialai-linux.tar.gz"
    with tempfile.TemporaryDirectory(dir=output) as staging:
        tmp = Path(staging) / archive.name
        with tarfile.open(tmp, "w:gz") as tar:
            for source, name in release_files():
                data = source.read_bytes()
                if name == "start.sh":
                    data = data.replace(b"\r\n", b"\n")
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o755 if name == "start.sh" else 0o644
                tar.addfile(entry, io.BytesIO(data))
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        tmp.replace(archive)
        checksum = archive.with_suffix(".gz.sha256")
        checksum.write_bytes(f"{digest}  {archive.name}\n".encode("ascii"))
    print(archive)
    print(checksum)


if __name__ == "__main__":
    main()
