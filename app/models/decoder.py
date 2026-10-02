import math

import numpy as np
import torch

from app.models.config import Config


BeamStates = dict[tuple[int, ...], tuple[float, float]]


def decode_greedy(
    logits: torch.Tensor,
    idx2char: dict,
) -> str:

    indices = torch.argmax(
        logits,
        dim=-1,
    )

    result = []

    prev = 0

    for idx in indices[0].tolist():

        if idx != 0 and idx != prev:
            result.append(
                idx2char.get(idx, "")
            )

        prev = idx

    return "".join(result)



def _log_add(a, b, neg_inf):
    if a <= neg_inf:
        return b
    if b <= neg_inf:
        return a
    maximum = max(a, b)
    return maximum + math.log(math.exp(a - maximum) + math.exp(b - maximum))


def _advance_unconstrained_beam(next_beams, prefix, p_blank, p_nonblank, token, log_probability, p_total, neg_inf):
    if token == 0:
        next_blank, next_nonblank = next_beams.get(prefix, (neg_inf, neg_inf))
        next_beams[prefix] = (_log_add(next_blank, p_total + log_probability, neg_inf), next_nonblank)
        return

    if prefix and token == prefix[-1]:
        next_blank, next_nonblank = next_beams.get(prefix, (neg_inf, neg_inf))
        next_nonblank = _log_add(next_nonblank, p_nonblank + log_probability, neg_inf)
        next_beams[prefix] = (next_blank, next_nonblank)
        extended = prefix + (token,)
        extended_blank, extended_nonblank = next_beams.get(extended, (neg_inf, neg_inf))
        extended_nonblank = _log_add(extended_nonblank, p_blank + log_probability, neg_inf)
        next_beams[extended] = (extended_blank, extended_nonblank)
        return

    extended = prefix + (token,)
    next_blank, next_nonblank = next_beams.get(extended, (neg_inf, neg_inf))
    next_nonblank = _log_add(next_nonblank, p_total + log_probability, neg_inf)
    next_beams[extended] = (next_blank, next_nonblank)


def _prune_beams(beams, beam_width, neg_inf):
    scored = [
        (prefix, _log_add(p_blank, p_nonblank, neg_inf))
        for prefix, (p_blank, p_nonblank) in beams.items()
    ]
    scored.sort(key=lambda item: item[1], reverse=True)
    return {prefix: beams[prefix] for prefix, _ in scored[:beam_width]}


def ctc_prefix_beam_search_nbest(log_probs_np, idx2char, beam_width=8):
    """CTC prefix beam search KHONG rang buoc. Tra ve list (text, log_score) giam dan theo diem."""
    time_steps, class_count = log_probs_np.shape
    neg_inf = -1e9
    beams: BeamStates = {(): (0.0, neg_inf)}

    for time_index in range(time_steps):
        next_beams: BeamStates = {}
        row = log_probs_np[time_index]
        top_indices = np.argsort(row)[::-1][: min(class_count, beam_width * 4)]

        for prefix, (p_blank, p_nonblank) in beams.items():
            p_total = _log_add(p_blank, p_nonblank, neg_inf)
            for class_index in top_indices:
                token = int(class_index)
                _advance_unconstrained_beam(
                    next_beams, prefix, p_blank, p_nonblank, token,
                    float(row[token]), p_total, neg_inf,
                )

        beams = _prune_beams(next_beams, beam_width, neg_inf)

    candidates = [
        ("".join(idx2char.get(token, "") for token in prefix), _log_add(p_blank, p_nonblank, neg_inf))
        for prefix, (p_blank, p_nonblank) in beams.items()
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates


def ctc_prefix_beam_search(log_probs_np, idx2char, beam_width=8, format_constrained=True):
    """Beam khong rang buoc, sau do (tuy chon) LOC cac ung vien cuoi theo dinh dang bien so.
    Giu lai de tuong thich: ban nay chi loc o cuoi, khong rang buoc trong luc search."""
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
    return ch.isalnum()          # "A": chu hoac so


def _advance_constrained_beam(next_beams, prefix, p_blank, p_nonblank, row, allowed, max_length, neg_inf):
    prefix_length = len(prefix)
    p_total = _log_add(p_blank, p_nonblank, neg_inf)

    next_blank, next_nonblank = next_beams.get(prefix, (neg_inf, neg_inf))
    next_blank = _log_add(next_blank, p_total + row[0], neg_inf)
    if prefix_length:
        next_nonblank = _log_add(next_nonblank, p_nonblank + row[prefix[-1]], neg_inf)
    next_beams[prefix] = (next_blank, next_nonblank)

    if prefix_length >= max_length:
        return
    last_token = prefix[-1] if prefix_length else -1
    for token in allowed[prefix_length]:
        source_score = p_blank if token == last_token else p_total
        if source_score <= neg_inf:
            continue
        extended = prefix + (token,)
        extended_blank, extended_nonblank = next_beams.get(extended, (neg_inf, neg_inf))
        extended_nonblank = _log_add(extended_nonblank, source_score + row[token], neg_inf)
        next_beams[extended] = (extended_blank, extended_nonblank)


def _prune_constrained_beams(next_beams, beam_width, neg_inf):
    buckets = {}
    for prefix, (p_blank, p_nonblank) in next_beams.items():
        score = _log_add(p_blank, p_nonblank, neg_inf)
        buckets.setdefault(len(prefix), []).append((score, prefix))

    beams: BeamStates = {}
    for candidates in buckets.values():
        candidates.sort(key=lambda item: item[0], reverse=True)
        for _, prefix in candidates[:beam_width]:
            beams[prefix] = next_beams[prefix]
    return beams


def is_valid_plate_format(text, position_classes=None):
    if position_classes is None:
        position_classes = Config.PLATE_POSITION_CLASSES
    return bool(position_classes) and len(text) == len(position_classes) and all(
        _char_in_class(char, cls) for char, cls in zip(text, position_classes)
    )


def ctc_prefix_beam_search_constrained(log_probs_np, idx2char, position_classes=None, beam_width=8):
    """CTC prefix beam search voi rang buoc dinh dang THEO VI TRI ngay trong luc search.

    position_classes: chuoi, moi ky tu mo ta lop cua 1 vi tri: L=chu, D=so, A=chu hoac so.
    Bien so Brazil cu (AAA9999) va Mercosul (AAA9A99) chi khac nhau o vi tri 5 -> "LLLDADD".
    - chi cho phep ky tu dung lop o vi tri dang mo rong, khong cho prefix dai qua len(position_classes)
    - cat tia (prune) THEO TUNG DO DAI (top beam_width moi do dai) nen luon con ung vien dai du
      do dai cuoi, khong bi cac prefix ngan lan at
    - ket qua cuoi chi chon trong cac prefix co dung len(position_classes) ky tu
    Tra ve (text, log_score, ok). ok=False neu khong co ung vien nao (hiem; khi do caller dung fallback).
    """
    if position_classes is None:
        position_classes = Config.PLATE_POSITION_CLASSES
    L = len(position_classes)
    T, C = log_probs_np.shape
    NEG_INF = -1e9

    allowed = [
        [i for i, ch in idx2char.items() if 0 < i < C and _char_in_class(ch, cls)]
        for cls in position_classes
    ]

    beams: BeamStates = {(): (0.0, NEG_INF)}
    for time_index in range(T):
        row = log_probs_np[time_index].tolist()
        next_beams: BeamStates = {}
        for prefix, (p_blank, p_nonblank) in beams.items():
            _advance_constrained_beam(
                next_beams, prefix, p_blank, p_nonblank, row, allowed, L, NEG_INF,
            )
        beams = _prune_constrained_beams(next_beams, beam_width, NEG_INF)

    finals = [
        (_log_add(p_blank, p_nonblank, NEG_INF), prefix)
        for prefix, (p_blank, p_nonblank) in beams.items()
        if len(prefix) == L
    ]
    if not finals:
        return "", NEG_INF, False
    score, best = max(finals, key=lambda x: x[0])
    return "".join(idx2char[i] for i in best), score, True


def decode_constrained(logits, idx2char, position_classes=None, beam_width=8):
    if logits.ndim != 3 or logits.size(0) != 1:
        raise ValueError(f"Expected logits with shape [1, T, C], got {tuple(logits.shape)}")
    if position_classes is None:
        position_classes = Config.PLATE_POSITION_CLASSES
    log_probs = torch.log_softmax(logits[0].float(), dim=-1).cpu().numpy()
    return ctc_prefix_beam_search_constrained(
        log_probs, idx2char, position_classes=position_classes, beam_width=beam_width,
    )

