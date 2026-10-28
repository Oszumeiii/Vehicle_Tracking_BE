"""Still images: size limits in the upload probe and EXIF orientation in recognition."""
import struct
import zlib

import pytest
from PIL import Image

from app.recognition.runner import _image_detections
from scripts.probe_media import probe


def rotated_jpeg(path, width=40, height=20, orientation=6):
    """A landscape JPEG whose EXIF says to turn it upright (6: rotate 90 degrees clockwise)."""
    picture = Image.new("RGB", (width, height), (200, 30, 30))
    exif = Image.Exif()
    exif[0x0112] = orientation
    picture.save(path, exif=exif)
    return path


def huge_png_header(path, width=20000, height=10000):
    """A tiny PNG whose header declares a huge image (nothing large is allocated)."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"")) +
                     chunk(b"IEND", b""))
    return path


def test_a_declared_decompression_bomb_is_invalid_input_not_a_runtime_failure(tmp_path):
    with pytest.raises(ValueError):
        probe(huge_png_header(tmp_path / "huge.png"))


def test_the_probe_reports_the_upright_size_of_a_rotated_photo(tmp_path):
    info = probe(rotated_jpeg(tmp_path / "phone.jpg"))
    assert (info["width"], info["height"]) == (20, 40)
    info = probe(rotated_jpeg(tmp_path / "plain.jpg", orientation=1))
    assert (info["width"], info["height"]) == (40, 20)


def test_recognition_crops_the_upright_image(tmp_path):
    payload = dict(input_path=str(rotated_jpeg(tmp_path / "phone.jpg")), input_mode="plate_crop",
                   pipeline_snapshot=dict(tracking=dict(crop_padding=0.)))
    folder = tmp_path / "out"
    folder.mkdir()
    appearances, _ = _image_detections(payload, None, folder, tmp_path)
    with Image.open(folder / "frame.png") as frame:
        assert frame.size == (20, 40)
    detection = appearances[0]["detections"][0]
    assert (detection["crop_width"], detection["crop_height"]) == (20, 40)
