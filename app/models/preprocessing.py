import cv2
import numpy as np
import torch


IMG_HEIGHT = 32
IMG_WIDTH = 128


def preprocess_image(image_bytes: bytes) -> torch.Tensor:

    image_array = np.frombuffer(
        image_bytes,
        dtype=np.uint8,
    )

    image = cv2.imdecode(
        image_array,
        cv2.IMREAD_COLOR,
    )

    if image is None:
        raise ValueError("Cannot decode image")

    image = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2RGB,
    )

    image = cv2.resize(
        image,
        (IMG_WIDTH, IMG_HEIGHT),
        interpolation=cv2.INTER_LINEAR,
    )

    image = image.astype(np.float32) / 255.0

    image = (image - 0.5) / 0.5

    image = torch.from_numpy(image)

    # HWC -> CHW
    image = image.permute(2, 0, 1).contiguous()

    return image