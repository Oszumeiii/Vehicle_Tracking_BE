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


def leaning_plate(angle, folder):
    """A 200 x 60 white plate with a row of dark characters on a dark car, leaning `angle`
    degrees (cv2 sign); stored as a crop with its detection (box = the plate's extent)."""
    import cv2
    import numpy as np

    canvas = np.full((200, 320, 3), 40, np.uint8)
    cv2.rectangle(canvas, (60, 70), (260, 130), (235, 235, 235), -1)
    for x in range(72, 250, 26):
        cv2.rectangle(canvas, (x, 82), (x + 16, 118), (20, 20, 20), -1)
    matrix = cv2.getRotationMatrix2D((160, 100), angle, 1)
    canvas = cv2.warpAffine(canvas, matrix, (320, 200), borderValue=(40, 40, 40))
    ys, xs = np.where(canvas[:, :, 0] > 150)
    box = [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]
    path = folder / f"plate_{angle}.png"
    cv2.imwrite(str(path), canvas)
    return dict(bbox=box, crop_bbox=[0, 0, 320, 200], crop_width=320, crop_height=200, crop_storage_key=path.name)


def test_skew_angle_levels_a_leaning_plate(tmp_path):
    import cv2
    from app.recognition.runner import PredictionRunner

    for lean in (-9, 0, 6, 12):
        detection = leaning_plate(lean, tmp_path)
        gray = cv2.imread(str(tmp_path / detection["crop_storage_key"]), cv2.IMREAD_GRAYSCALE)
        left, top, right, bottom = PredictionRunner.ocr_box(detection, .05)
        assert abs(PredictionRunner.skew_angle(gray[top:bottom, left:right], 15) + lean) <= 1, lean


def test_deskew_reads_the_level_plate_one_angle_per_track(tmp_path):
    from PIL import Image
    import numpy as np
    from app.recognition.runner import PredictionRunner

    detections = [leaning_plate(lean, tmp_path) for lean in (8, 9, 10)]
    assert PredictionRunner.ocr_regions(detections, tmp_path, None, 15) == [None] * 3, "old snapshots read the whole crop"
    plain = PredictionRunner.ocr_regions(detections, tmp_path, 0, 0)
    assert plain == [PredictionRunner.ocr_box(d, 0) for d in detections] and all(len(b) == 4 for b in plain)
    regions = PredictionRunner.ocr_regions(detections, tmp_path, 0, 15)
    assert all(r[:4] == b for r, b in zip(regions, plain))
    assert len({r[4] for r in regions}) == 1 and abs(regions[0][4] + 9) <= 1, "the track's median lean"
    with Image.open(tmp_path / detections[1]["crop_storage_key"]) as picture:
        level = PredictionRunner.ocr_image(picture, regions[1])
    # The level plate is about 200 x 60 (plus the small margin), not the 218 x 90 box it leaned in.
    assert 195 <= level.width <= 220 and 58 <= level.height <= 72, level.size
    bright = (np.asarray(level.convert("L")) > 150).mean(axis=1)
    assert bright[:3].mean() < .5 and bright[len(bright) // 2] > .3, "plate rows in the middle, car above"
