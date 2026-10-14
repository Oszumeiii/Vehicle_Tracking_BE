"""Conservative whole-plate voting, independent of detector/OCR confidence."""
from collections import Counter
import re


def normalize_plate(text: str | None) -> str:
    return re.sub(r"[\s-]+", "", text or "").upper()


def fuse_predictions(texts: list[str | None]) -> dict:
    """A single image or exactly five *distinct-frame* predictions are supported.

    The caller verifies frame identity; abstentions still count toward the five.
    No character substitution, confidence-weighted tie breaking, or plurality.
    """
    if len(texts) not in (1, 5):
        raise ValueError("Recognition requires one image or exactly five video crops")
    counts = Counter(value for text in texts if (value := normalize_plate(text)))
    if not counts:
        return dict(machine_text=None, machine_status="unreadable", agreement_count=0)
    text, count = counts.most_common(1)[0]
    readable = len(texts) == 1 or count >= 3
    return dict(machine_text=text if readable else None,
                machine_status="readable" if readable else "ambiguous", agreement_count=count)


def levenshtein(a, b):
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def merge_tracks(predictions, max_gap_seconds=3.0, max_edit=1, min_len=5):
    """Notebook cell 46: group tracks that are probably one vehicle with a broken ID.

    Each prediction needs track_id, plate_text, confidence, first_seen, last_seen.
    Tracks merge when texts differ by <= max_edit characters and the time gap is
    <= max_gap_seconds. Groups of >= 3 same-length texts vote per character,
    weighted by confidence; otherwise the most confident text wins. Advisory only:
    stored appearances and their review state are not changed.
    """
    preds = [p for p in predictions if len(p["plate_text"]) >= min_len]
    parent = list(range(len(preds)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(preds):
        for j in range(i + 1, len(preds)):
            b = preds[j]
            gap = max(0.0, max(a["first_seen"], b["first_seen"]) - min(a["last_seen"], b["last_seen"]))
            if gap <= max_gap_seconds and levenshtein(a["plate_text"], b["plate_text"]) <= max_edit:
                parent[find(i)] = find(j)

    groups = {}
    for i, p in enumerate(preds):
        groups.setdefault(find(i), []).append(p)
    merged = []
    for members in groups.values():
        members.sort(key=lambda m: m["confidence"], reverse=True)
        best = members[0]
        same_len = [m for m in members if len(m["plate_text"]) == len(best["plate_text"])]
        if len(same_len) >= 3:
            chars = []
            for pos in range(len(best["plate_text"])):
                tally = {}
                for m in same_len:
                    tally[m["plate_text"][pos]] = tally.get(m["plate_text"][pos], 0.0) + m["confidence"]
                chars.append(max(tally, key=tally.get))
            text = "".join(chars)
        else:
            text = best["plate_text"]
        merged.append(dict(plate_text=text, best_track_id=best["track_id"],
                           track_ids=[m["track_id"] for m in members],
                           variants=sorted({m["plate_text"] for m in members}), n_tracks=len(members),
                           confidence=best["confidence"],
                           first_seen=min(m["first_seen"] for m in members),
                           last_seen=max(m["last_seen"] for m in members)))
    merged.sort(key=lambda g: g["first_seen"])
    return merged
