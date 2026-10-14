"""CTC decoders from the PBL6 PIPELINE notebook (cells 34 and 38).

Scores are ranking heuristics, not calibrated probabilities of a correct plate.
"""
import math
import re

import numpy as np
import torch

from app.recognition.icpr_model import Config

DECODERS = ("greedy", "beam_plain", "beam_filter", "beam_constrained")

_PLATE_OLD_PAT = re.compile(r"^[A-Z]{3}[0-9]{4}$")
_PLATE_MERCOSUL_PAT = re.compile(r"^[A-Z]{3}[0-9][A-Z][0-9]{2}$")


def is_valid_plate_format(text: str) -> bool:
    return bool(_PLATE_OLD_PAT.match(text) or _PLATE_MERCOSUL_PAT.match(text))


def decode_predictions_greedy(logits, idx2char=Config.IDX2CHAR):
    """Collapse repeats and drop blank index 0."""
    if logits.ndim != 3 or logits.shape[-1] != Config.NUM_CLASSES:
        raise ValueError("Expected logits with shape [batch, time, 37].")
    if not torch.isfinite(logits).all():
        raise FloatingPointError("OCR logits contain non-finite values.")
    texts = []
    for seq in torch.argmax(logits, dim=-1).tolist():
        text = []
        prev = 0
        for idx in seq:
            if idx != 0 and idx != prev:
                text.append(idx2char.get(idx, ""))
            prev = idx
        texts.append("".join(text))
    return texts


def ctc_prefix_beam_search_nbest(log_probs_np, idx2char, beam_width=8):
    T, C = log_probs_np.shape
    NEG_INF = -1e9
    beams = {(): (0.0, NEG_INF)}

    def log_sum_exp(a, b):
        if a == NEG_INF:
            return b
        if b == NEG_INF:
            return a
        m = max(a, b)
        return m + math.log(math.exp(a - m) + math.exp(b - m))

    for t in range(T):
        next_beams = {}
        row = log_probs_np[t]
        top_idx = np.argsort(row)[::-1][: min(C, beam_width * 4)]
        for prefix, (p_b, p_nb) in beams.items():
            p_total_prev = log_sum_exp(p_b, p_nb)
            for c in top_idx:
                lp = float(row[c])
                if c == 0:
                    nb_p_b, nb_p_nb = next_beams.get(prefix, (NEG_INF, NEG_INF))
                    nb_p_b = log_sum_exp(nb_p_b, p_total_prev + lp)
                    next_beams[prefix] = (nb_p_b, nb_p_nb)
                    continue
                end_char = prefix[-1] if prefix else None
                if end_char is not None and int(c) == end_char:
                    nb_p_b, nb_p_nb = next_beams.get(prefix, (NEG_INF, NEG_INF))
                    nb_p_nb = log_sum_exp(nb_p_nb, p_nb + lp)
                    next_beams[prefix] = (nb_p_b, nb_p_nb)
                    new_prefix2 = prefix + (int(c),)
                    nb_p_b2, nb_p_nb2 = next_beams.get(new_prefix2, (NEG_INF, NEG_INF))
                    nb_p_nb2 = log_sum_exp(nb_p_nb2, p_b + lp)
                    next_beams[new_prefix2] = (nb_p_b2, nb_p_nb2)
                else:
                    new_prefix = prefix + (int(c),)
                    nb_p_b, nb_p_nb = next_beams.get(new_prefix, (NEG_INF, NEG_INF))
                    nb_p_nb = log_sum_exp(nb_p_nb, p_total_prev + lp)
                    next_beams[new_prefix] = (nb_p_b, nb_p_nb)
        scored = [(pfx, log_sum_exp(pb, pnb)) for pfx, (pb, pnb) in next_beams.items()]
        scored.sort(key=lambda x: x[1], reverse=True)
        beams = {pfx: next_beams[pfx] for pfx, _ in scored[:beam_width]}

    candidates = [(pfx, log_sum_exp(pb, pnb)) for pfx, (pb, pnb) in beams.items()]
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [("".join(idx2char.get(i, "") for i in pfx), score) for pfx, score in candidates]


def ctc_prefix_beam_search(log_probs_np, idx2char, beam_width=8, format_constrained=True):
    texts_scores = ctc_prefix_beam_search_nbest(log_probs_np, idx2char, beam_width)
    if format_constrained:
        valid = [(t, s) for t, s in texts_scores if is_valid_plate_format(t)]
        if valid:
            return valid[0][0], valid[0][1], True
    if texts_scores:
        return texts_scores[0][0], texts_scores[0][1], False
    return "", -1e9, False


def _char_in_class(ch, cls):
    if cls == "L":
        return ch.isalpha()
    if cls == "D":
        return ch.isdigit()
    return ch.isalnum()


def ctc_prefix_beam_search_constrained(log_probs_np, idx2char, position_classes=None, beam_width=8):
    if position_classes is None:
        position_classes = Config.PLATE_POSITION_CLASSES
    L = len(position_classes)
    T, C = log_probs_np.shape
    NEG_INF = -1e9
    allowed = [
        [i for i, ch in idx2char.items() if 0 < i < C and _char_in_class(ch, cls)]
        for cls in position_classes
    ]

    def lse(a, b):
        if a <= NEG_INF:
            return b
        if b <= NEG_INF:
            return a
        if a < b:
            a, b = b, a
        return a + math.log1p(math.exp(b - a))

    beams = {(): (0.0, NEG_INF)}
    for t in range(T):
        row = log_probs_np[t].tolist()
        nxt = {}
        for prefix, (p_b, p_nb) in beams.items():
            k = len(prefix)
            p_tot = lse(p_b, p_nb)
            b0, nb0 = nxt.get(prefix, (NEG_INF, NEG_INF))
            b0 = lse(b0, p_tot + row[0])
            if k:
                nb0 = lse(nb0, p_nb + row[prefix[-1]])
            nxt[prefix] = (b0, nb0)
            if k < L:
                last = prefix[-1] if k else -1
                for c in allowed[k]:
                    src = p_b if c == last else p_tot
                    if src <= NEG_INF:
                        continue
                    new = prefix + (c,)
                    b1, nb1 = nxt.get(new, (NEG_INF, NEG_INF))
                    nxt[new] = (b1, lse(nb1, src + row[c]))
        buckets = {}
        for prefix, (pb, pnb) in nxt.items():
            buckets.setdefault(len(prefix), []).append((lse(pb, pnb), prefix))
        beams = {}
        for lst in buckets.values():
            lst.sort(key=lambda x: x[0], reverse=True)
            for _, prefix in lst[:beam_width]:
                beams[prefix] = nxt[prefix]

    finals = [(lse(pb, pnb), pfx) for pfx, (pb, pnb) in beams.items() if len(pfx) == L]
    if not finals:
        return "", NEG_INF, False
    score, best = max(finals, key=lambda x: x[0])
    return "".join(idx2char[i] for i in best), score, True


def decode_track(lp, decoder="beam_filter", beam_width=8):
    """Decode one [T, 37] log-probability tensor exactly like the notebook.

    ``beam_confidence_proxy`` = exp(beam_log_score / length) is the notebook's
    ranking score (``MIN_BEAM_SCORE`` threshold); it is not calibrated.
    """
    if decoder not in DECODERS:
        raise ValueError("Unknown decoder: " + str(decoder))
    greedy = decode_predictions_greedy(lp.unsqueeze(0))[0]
    ids = lp.argmax(-1).tolist()
    emitted = [t for t, k in enumerate(ids) if k != 0 and (t == 0 or k != ids[t - 1])]
    confidence = math.exp(sum(float(lp[t, ids[t]]) for t in emitted) / len(emitted)) if emitted else 0.
    text, score = greedy, None
    if decoder in ("beam_plain", "beam_filter"):
        text, score, _ = ctc_prefix_beam_search(lp.numpy(), Config.IDX2CHAR, beam_width,
                                                format_constrained=decoder == "beam_filter")
    elif decoder == "beam_constrained":
        text, score, ok = ctc_prefix_beam_search_constrained(lp.numpy(), Config.IDX2CHAR, beam_width=beam_width)
        if not ok:
            text, score = greedy, None
    proxy = (math.exp(score / len(text))
             if score is not None and math.isfinite(score) and score <= 0 and text else None)
    return dict(plate_text=text, greedy_text=greedy, format_valid=is_valid_plate_format(text),
                greedy_symbol_confidence=confidence, beam_log_score=score,
                beam_confidence_proxy=proxy, decoder=decoder, beam_width=beam_width)
