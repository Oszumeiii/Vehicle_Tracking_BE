"""Choosing a track's five crops: hidden or cut plates are set aside, larger crops win."""
from app.recognition.video_tracking import CropSelector

CFG = {"crop_confidence": .25}


def row(i, width, height=None, sharp=50., conf=.8, edge=1):
    """An observation of a plate growing as the car comes closer (x1 fixed at 100)."""
    height = height or width / 3.2
    return dict(frame_index=i, timestamp_seconds=i / 10, box=[100., 50., 100. + width, 50. + height],
                confidence=conf, sharpness=sharp, box_height=height, box_area=width * height, edge_ok=edge)


def track(widths, **changes):
    rows = [row(i, w) for i, w in enumerate(widths)]
    for i, fields in changes.items():
        rows[int(i)].update(fields)
    return rows


def test_a_plate_hidden_by_a_pole_or_cut_or_at_the_edge_is_flagged():
    rows = track([40, 44, 48, 52, 30, 60, 64, 68])  # frame 4: the pole hides half of it
    assert CropSelector.hidden_or_cut(rows) == {4}
    rows[6]["box"] = [100., 50., 120., 70.]  # width/height 1.0 against ~3.2: cut on one side
    rows[2]["edge_ok"] = 0
    assert CropSelector.hidden_or_cut(rows) >= {2, 4, 6}
    assert not CropSelector.hidden_or_cut(track([40, 44, 48, 52, 56, 60])), "a plate that only grows is fine"


def test_robust_selection_skips_the_hidden_crop_and_prefers_large_ones():
    widths = [30 + 2 * i for i in range(20)]
    widths[17] = 45  # behind the pole: narrower than its neighbours, yet sharp and confident
    rows = track(widths, **{"17": dict(sharpness=500., confidence=.99)})
    current, _ = CropSelector.select_five(rows, {**CFG, "crop_selection": "current"})
    robust, _ = CropSelector.select_five(rows, {**CFG, "crop_selection": "robust"})
    assert 17 in [r["frame_index"] for r in current], "the old scoring picks the hidden crop"
    assert 17 not in [r["frame_index"] for r in robust]
    width = lambda chosen: sum(r["box"][2] - r["box"][0] for r in chosen)  # noqa: E731
    assert width(robust) > width(current)
    frames = [r["frame_index"] for r in robust]
    assert frames == sorted(frames) and len(set(frames)) == 5, "five distinct frames in time order"


def test_a_short_track_keeps_five_crops_by_taking_back_the_best_flagged_one():
    rows = track([40, 44, 30, 52, 56])  # only five observations, one hidden
    chosen, reason = CropSelector.select_five(rows, {**CFG, "crop_selection": "robust"})
    assert reason is None and [r["frame_index"] for r in chosen] == [0, 1, 2, 3, 4]
    few, reason = CropSelector.select_five(track([40, 44, 48, 52]), {**CFG, "crop_selection": "robust"})
    assert few is None and reason == "fewer_than_five_valid_frames"


def test_robust_is_the_default_and_current_stays_available():
    rows = track([30, 32, 34, 36, 40, 44, 48, 52, 56, 25, 64, 68])
    assert CropSelector.select_five(rows, CFG) == CropSelector.select_five(rows, {**CFG, "crop_selection": "robust"})
    assert CropSelector.select_five(rows, {**CFG, "crop_selection": "current"})[0]


def test_four_observations_are_kept_when_the_pipeline_reads_four_crop_tracks():
    rows = track([40, 44, 30, 52])  # one hidden: taken back, there is nothing better
    chosen, reason = CropSelector.select_five(rows, {**CFG, "min_frames": 4})
    assert reason is None and [r["frame_index"] for r in chosen] == [0, 1, 2, 3]
    chosen, _ = CropSelector.select_five(track([40 + 2 * i for i in range(12)]), {**CFG, "min_frames": 4})
    assert len(chosen) == 5, "longer tracks still give five crops"
    assert CropSelector.select_five(track([40, 44, 48]), {**CFG, "min_frames": 4}) == (None, "fewer_than_four_valid_frames")


def test_a_four_crop_track_repeats_its_sharpest_crop_in_place(tmp_path):
    import cv2
    import numpy as np
    from app.recognition.runner import PredictionRunner

    paths = []
    for i in range(4):
        image = np.full((32, 96), 128, np.uint8)
        if i == 2:
            image[:, ::2] = 0  # stripes: by far the sharpest crop
        path = tmp_path / f"crop-{i}.png"
        cv2.imwrite(str(path), image)
        paths.append(path)
    assert PredictionRunner.ocr_inputs(paths) == ([paths[0], paths[1], paths[2], paths[2], paths[3]], [None] * 5)
    five = paths + [tmp_path / "fifth.png"]
    assert PredictionRunner.ocr_inputs(five) == (five, [None] * 5), "five stay as they are"
    # Sharpness is measured on the region the OCR reads: crop 0 is sharp only there.
    sharp = np.full((32, 96), 128, np.uint8)
    sharp[8:24, 8:40:2] = 0
    cv2.imwrite(str(paths[0]), sharp)
    cv2.imwrite(str(paths[2]), np.full((32, 96), 128, np.uint8))  # no longer the sharpest
    regions = [[8, 8, 40, 24]] + [[0, 0, 96, 32]] * 3
    chosen, boxes = PredictionRunner.ocr_inputs(paths, regions)
    assert chosen == [paths[0], paths[0], paths[1], paths[2], paths[3]] and boxes[:2] == [[8, 8, 40, 24]] * 2


def test_ocr_reads_the_detector_box_plus_its_own_margin_from_the_stored_crop():
    from app.recognition.runner import PredictionRunner

    # Box 100 x 40 at (210, 120); the stored crop kept 15 % (crop_bbox from crop_bounds).
    detection = dict(bbox=[210., 120., 310., 160.], crop_bbox=[195, 114, 325, 166], crop_width=130, crop_height=52)
    assert PredictionRunner.ocr_box(detection, None) is None, "old snapshots read the whole crop"
    assert PredictionRunner.ocr_box(detection, 0) == [15, 6, 115, 46]
    assert PredictionRunner.ocr_box(detection, .05) == [10, 4, 120, 48]
    assert PredictionRunner.ocr_box(detection, .15) == [0, 0, 130, 52], "the stored margin is the most there is"
    # A crop clipped by the frame edge: the region stays inside the stored image.
    edge = dict(bbox=[2., 0., 102., 40.], crop_bbox=[0, 0, 117, 46], crop_width=117, crop_height=46)
    assert PredictionRunner.ocr_box(edge, .05) == [0, 0, 107, 42]
