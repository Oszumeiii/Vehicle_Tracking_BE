"""Clips of live recordings: pick the recorded segments of a time span and cut them without re-encoding.

A recording is a folder of MP4 segments written by ffmpeg next to the decoded frames
(see recorder.py) plus index.jsonl, one line per closed segment:
  {"file", "pts_start", "pts_end", "utc_start", "utc_end",
   "first_ts": the file's own timestamp of its first keyframe, "keyframes": [seconds from it]}
Each segment starts with a keyframe. A stream copy can only start on a keyframe, so a clip
starts at the last keyframe at or before the requested start; first_seen_offset tells a
player where the requested moment is inside the clip. Cuts use the concat demuxer's
inpoint/outpoint in the files' own timestamps: an output -ss compares decoding times and,
with B-frames, would skip the keyframe it should start on.

  python -m app.live.clips --index REC/index.jsonl [...] --from ISO --to ISO --out clip.mp4
  python -m app.live.clips --video DEMO.mp4 --pts-from S --pts-to S [--pad 3] --out clip.mp4
prints {"first_seen_offset": s, "seconds": s} or exits 2 when the span is not recorded.
A demo camera replays its video in a loop, so the video is its own recording: --video cuts
a track (seen from PTS S to S) out of it, padded on both sides.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess
import tempfile


class NotRecorded(Exception):
    """No recorded segment covers the requested span."""


def ffmpeg_exe():
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def _seconds(value):
    """PTS seconds as given, ISO UTC timestamps as POSIX seconds."""
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return float(value)


def read_index(files):
    """Entries of index.jsonl files, each with its folder; unreadable lines are skipped."""
    entries = []
    for file in map(Path, files):
        try:
            lines = file.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if (file.parent / entry["file"]).is_file():
                entries.append({**entry, "dir": str(file.parent)})
    return entries


def plan(entries, start, end, clock="pts"):
    """Segments covering [start, end] ("pts" seconds or "utc" ISO times) and the cut inside them.

    Returns (segments, start keyframe, end, first_seen_offset), the times in seconds from
    the first chosen segment's start.
    """
    start, end = _seconds(start), _seconds(end)
    if end <= start:
        raise ValueError("The clip must end after it starts")
    lo, hi = f"{clock}_start", f"{clock}_end"
    chosen = sorted((e for e in entries if _seconds(e[hi]) > start and _seconds(e[lo]) < end),
                    key=lambda e: _seconds(e[lo]))
    if not chosen:
        raise NotRecorded("No recording covers this time")
    first = _seconds(chosen[0][lo])
    into = max(0., start - first)
    ss = max([k for k in chosen[0].get("keyframes") or [0.] if k <= into + 1e-6] or [0.])
    to = end - first
    return chosen, round(ss, 3), round(to, 3), round(into - ss, 3)


def cut(entries, start, end, out, clock="pts", ffmpeg=None, timeout=60):
    """Write the clip of [start, end] to out (.mp4); returns where the requested start is in it."""
    segments, ss, to, offset = plan(entries, start, end, clock)
    lo = f"{clock}_start"
    first_start = _seconds(segments[0][lo])
    lines = []
    for i, segment in enumerate(segments):
        lines.append(f"file '{(Path(segment['dir']) / segment['file']).as_posix()}'")
        base = float(segment.get("first_ts", 0.))
        if i == 0:
            lines.append(f"inpoint {base + ss:.3f}")
        if i == len(segments) - 1:
            lines.append(f"outpoint {base + to - (_seconds(segment[lo]) - first_start):.3f}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        listing = Path(folder) / "segments.txt"
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        partial = out.with_name(out.stem + ".part.mp4")
        subprocess.run([ffmpeg or ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-nostdin",
                        "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", "-y", str(partial)],
                       check=True, timeout=timeout, capture_output=True)
        partial.replace(out)
    return dict(first_seen_offset=offset, seconds=round(to - ss, 3))


def keyframes(file, ffmpeg=None, timeout=30):
    """(timestamp of the first keyframe, keyframe times in seconds from it); decodes keyframes only."""
    result = subprocess.run([ffmpeg or ffmpeg_exe(), "-hide_banner", "-nostdin", "-skip_frame", "nokey",
                             "-copyts", "-i", str(file), "-an", "-vf", "showinfo=checksum=0", "-f", "null", "-"],
                            capture_output=True, timeout=timeout)
    times = [float(t) for t in re.findall(rb"pts_time:\s*(-?[\d.]+)", result.stderr)]
    return (times[0], [round(t - times[0], 3) for t in times]) if times else (0., [0.])


def file_entry(path, duration, ffmpeg=None):
    """A demo video as a one-segment recording (pts from 0 to its duration)."""
    path = Path(path)
    first, times = keyframes(path, ffmpeg)
    return dict(file=path.name, dir=str(path.parent), pts_start=0., pts_end=float(duration),
                first_ts=first, keyframes=times)


def video_duration(path):
    import cv2
    capture = cv2.VideoCapture(str(path))
    try:
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        return float(capture.get(cv2.CAP_PROP_FRAME_COUNT)) / fps if fps > 0 else 0.
    finally:
        capture.release()


def cut_demo(path, first, last, out, pad=3.0, duration=None, entry=None, ffmpeg=None):
    """Clip of a track seen from PTS first to last on a looped demo video (PTS p plays p mod duration).

    Returns where the plate first shows up inside the clip, and the clip's length.
    """
    if duration is None:
        duration = video_duration(path)
    offset = (first // duration) * duration if duration > 0 else 0.
    start, end, seen = max(0., first - pad - offset), min(duration, last + pad - offset), first - offset
    info = cut([entry or file_entry(path, duration, ffmpeg)], start, end, out, clock="pts", ffmpeg=ffmpeg)
    return dict(first_seen_offset=round(info["first_seen_offset"] + seen - start, 3), seconds=info["seconds"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", nargs="+", type=Path)
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--video", type=Path)
    parser.add_argument("--pts-from", type=float)
    parser.add_argument("--pts-to", type=float)
    parser.add_argument("--pad", type=float, default=3.0)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.video is None and not (args.index and args.start and args.end):
        parser.error("give --index with --from/--to, or --video with --pts-from/--pts-to")
    if args.video is not None and (args.pts_from is None or args.pts_to is None):
        parser.error("--video needs --pts-from and --pts-to")
    try:
        if args.video is not None:
            if not args.video.is_file():
                raise NotRecorded("Demo video not found")
            info = cut_demo(args.video, args.pts_from, args.pts_to, args.out, pad=args.pad)
        else:
            info = cut(read_index(args.index), args.start, args.end, args.out, clock="utc")
    except NotRecorded as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
