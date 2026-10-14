"""Read-only metadata probe for the NestJS upload service; emits only JSON."""
import argparse
import json
import math
from pathlib import Path
import sys


def probe(path):
    suffix = path.suffix.lower()
    if suffix in ('.png', '.jpg', '.jpeg'):
        from PIL import Image
        with Image.open(path) as picture:
            if picture.format not in ('JPEG', 'PNG') or picture.width * picture.height > 25_000_000:
                raise ValueError('Invalid format or image exceeds 25 megapixels')
            picture.verify()
        with Image.open(path) as picture:
            picture.load()
            return dict(media_type='image', mime_type=Image.MIME[picture.format], width=picture.width,
                        height=picture.height, duration_seconds=None)
    import cv2
    with path.open('rb') as source:
        header = source.read(16)
    if suffix == '.avi':
        if header[:4] != b'RIFF' or header[8:12] != b'AVI ':
            raise ValueError('Invalid AVI container')
    elif suffix in ('.mp4', '.mov'):
        if header[4:8] not in (b'ftyp', b'moov', b'mdat', b'wide', b'free', b'skip'):
            raise ValueError('Invalid MP4/MOV container')
    else:
        raise ValueError('Unsupported media format')
    capture = cv2.VideoCapture(str(path))
    try:
        fps, count = capture.get(cv2.CAP_PROP_FPS), capture.get(cv2.CAP_PROP_FRAME_COUNT)
        ok, frame = capture.read()
        if not capture.isOpened() or not ok or not math.isfinite(fps) or fps <= 0:
            raise ValueError('Cannot decode video')
        return dict(media_type='video', mime_type={'.mp4':'video/mp4','.mov':'video/quicktime','.avi':'video/x-msvideo'}[suffix],
                    width=frame.shape[1], height=frame.shape[0], duration_seconds=count/fps if math.isfinite(count) and count>0 else None)
    finally:
        capture.release()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--path', type=Path, required=True)
    path = parser.parse_args().path
    try:
        metadata = probe(path)
    except ImportError:
        print('Media inspection dependencies are unavailable.', file=sys.stderr)
        raise SystemExit(3)
    except (ValueError, OSError, SyntaxError):
        print('Media is invalid or cannot be decoded.', file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(metadata, allow_nan=False))
