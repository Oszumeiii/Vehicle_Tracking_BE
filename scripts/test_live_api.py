"""Exercise a running API + worker over real HTTP; only deletes jobs created by this script."""
import argparse
import http.client
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

import httpx

from app.core.config import MODELS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--models", nargs="+", choices=MODELS, default=list(MODELS))
    parser.add_argument("--timeout", type=float, default=1800, help="Maximum seconds per job")
    parser.add_argument("--max-upload-mib", type=int, default=500, help="Must match the server setting")
    args = parser.parse_args()
    output = Path("data") / f"live-api-test-{time.strftime('%Y%m%d-%H%M%S')}"
    output.mkdir(parents=True, exist_ok=False)
    report = {"base_url": args.base_url, "video": str(args.video.resolve()), "checks": [], "models": {}, "passed": False}
    base = "/api/v1/plate-jobs"

    def check(name, response, expected):
        report["checks"].append({"name": name, "expected": expected, "actual": response.status_code})
        assert response.status_code == expected, f"{name}: {response.status_code} {response.text[:300]}"
        print(f"PASS {name}: HTTP {expected}", flush=True)
        return response

    def post(client, content, filename="test.mp4", **fields):
        return client.post(base, files={"file": (filename, content, "video/mp4")}, data=fields)

    def finish(client, url):
        deadline = time.monotonic() + args.timeout
        polls = 0
        while time.monotonic() < deadline:
            response = client.get(url)
            assert response.status_code == 200, response.text
            status = response.json()
            health = client.get("/health")
            assert health.status_code == 200
            polls += 1
            if status["status"] in ("succeeded", "failed"):
                return status, polls
            time.sleep(2)
        raise TimeoutError(f"Job did not finish: {url}. Check that the worker is running.")

    try:
        with httpx.Client(base_url=args.base_url.rstrip("/"), timeout=120, trust_env=False) as client:
            for route in ("/", "/health", "/docs", "/openapi.json"):
                check(route, client.get(route), 200)
            check("Unknown job", client.get(base + "/does-not-exist"), 404)
            check("Delete unknown job", client.delete(base + "/does-not-exist"), 404)
            check("Missing upload", client.post(base), 422)
            check("Unsupported extension", post(client, b"x", filename="test.txt"), 415)
            check("Empty upload", post(client, b""), 422)
            for fields in ({"model": "unknown"}, {"confidence": "0"}, {"confidence": "1.1"}, {"confidence": "nan"}):
                check(f"Invalid parameters {fields}", post(client, b"x", **fields), 422)

            # Send only oversized headers: middleware should reject before any large upload.
            parts = urlsplit(args.base_url)
            cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
            connection = cls(parts.hostname, parts.port, timeout=15)
            try:
                connection.putrequest("POST", base)
                connection.putheader("Content-Type", "multipart/form-data; boundary=test")
                connection.putheader("Content-Length", str(args.max_upload_mib * 1024 * 1024 + 128 * 1024))
                connection.endheaders()
                oversized = connection.getresponse()
                report["checks"].append({"name": "Oversized upload headers", "expected": 413, "actual": oversized.status})
                assert oversized.status == 413
                oversized.read()
                print("PASS Oversized upload headers: HTTP 413 (no large file sent)", flush=True)
            finally:
                connection.close()

            for model in args.models:
                started = time.monotonic()
                with args.video.open("rb") as source:
                    response = check(f"Upload {model}", post(client, source, filename=args.video.name, model=model, confidence="0.25"), 202)
                accepted = response.json()
                url = accepted["status_url"]
                report["models"][model] = {"job_id": accepted["job_id"], "status_url": url}
                check("Results before completion", client.get(url + "/plates"), 409)
                check("Crop before completion", client.get(url + "/crops/00000001"), 409)
                check("Delete unfinished job", client.delete(url), 409)
                status, polls = finish(client, url)
                assert status["status"] == "succeeded", status
                assert "input_path" not in status
                for query in ("limit=0", "limit=201", "offset=-1"):
                    check(f"Invalid pagination {query}", client.get(url + "/plates?" + query), 422)
                first = check("List crops", client.get(url + "/plates?limit=1&offset=0"), 200).json()
                assert first["total"] == status["total_crops"]
                full = []
                for offset in range(0, first["total"], 200):
                    page = client.get(url + f"/plates?limit=200&offset={offset}")
                    assert page.status_code == 200
                    full.extend(page.json()["items"])
                assert len(full) == len({row["crop_id"] for row in full}) == first["total"]
                for item in full:
                    assert "path" not in item
                    image = client.get(item["crop_url"])
                    assert image.status_code == 200 and image.headers["content-type"] == "image/jpeg"
                    assert image.content.startswith(b"\xff\xd8")
                if full:
                    example = full[0]
                    (output / f"{model}-crop.jpg").write_bytes(client.get(example["crop_url"]).content)
                    report["models"][model]["example"] = example
                check("Missing crop", client.get(url + "/crops/unknown"), 404)
                page = check("Pagination past end", client.get(url + f"/plates?offset={first['total']}"), 200).json()
                assert page["items"] == []
                report["models"][model].update(status=status, health_polls=polls, elapsed_seconds=round(time.monotonic() - started, 2))
                (output / f"{model}-plates.json").write_text(json.dumps(full, indent=2), encoding="utf-8")
                print(f"PASS {model}: {status['selected_frames']} frames, {status['total_crops']} crops; all JPEGs readable", flush=True)
                (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

            # A separate, disposable job verifies the failure and deletion endpoints.
            accepted = check("Upload corrupted video", post(client, b"not a real mp4"), 202).json()
            url = accepted["status_url"]
            status, _ = finish(client, url)
            assert status["status"] == "failed" and status["error_code"] == "INVALID_VIDEO", status
            report["failed_job_before_delete"] = status
            check("Results of failed job", client.get(url + "/plates"), 409)
            check("Delete finished job", client.delete(url), 204)
            check("Status after delete", client.get(url), 404)
            check("Repeated delete", client.delete(url), 404)
            check("Crops after delete", client.get(url + "/crops/00000001"), 404)
            report["passed"] = True
    finally:
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("Report:", (output / "report.json").resolve(), flush=True)
    print("All HTTP checks passed. Successful jobs were kept for viewing in Swagger.", flush=True)


if __name__ == "__main__":
    main()
