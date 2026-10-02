import math
from io import BytesIO
from pathlib import Path
import zipfile

import torch
from torch import nn
from torch.nn import functional as F

from app.models.config import Config


CHARS = Config.CHARS
IDX2CHAR = Config.IDX2CHAR
NUM_CLASSES = Config.NUM_CLASSES
IMG_HEIGHT = Config.IMG_HEIGHT
IMG_WIDTH = Config.IMG_WIDTH
NUM_FRAMES = Config.NUM_FRAMES


class SharedSTNBlock(nn.Module):
    identity: torch.Tensor

    def __init__(self, max_delta=0.15):
        super().__init__()
        self.max_delta = float(max_delta)
        self.loc_net = nn.Sequential(
            nn.Conv2d(3, 32, 3, padding=1),
            nn.GroupNorm(8, 32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(32, 64, 3, padding=1),
            nn.GroupNorm(8, 64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.AdaptiveAvgPool2d((4, 16)),
        )
        self.fc_loc = nn.Sequential(
            nn.Linear(64 * 4 * 16, 64),
            nn.ReLU(inplace=True),
            nn.Linear(64, 6),
        )
        final_layer = self.fc_loc[-1]
        if not isinstance(final_layer, nn.Linear):
            raise TypeError("The final localization layer must be linear")
        nn.init.zeros_(final_layer.weight)
        nn.init.zeros_(final_layer.bias)

        identity = torch.tensor([1., 0., 0., 0., 1., 0.]).view(1, 2, 3)
        self.register_buffer("identity", identity)

    def forward(self, x):
        orig_dtype = x.dtype
        with torch.autocast(device_type=x.device.type, enabled=False):
            x32 = x.float()
            features = self.loc_net(x32).flatten(1)
            raw_delta = self.fc_loc(features)
            bounded_delta = self.max_delta * torch.tanh(raw_delta)
            theta = self.identity + bounded_delta.view(-1, 2, 3)

            if not torch.isfinite(theta).all():
                raise FloatingPointError("STN theta became non-finite.")

            grid = F.affine_grid(theta, x32.size(), align_corners=False)
            aligned = F.grid_sample(
                x32, grid, mode="bilinear", padding_mode="border", align_corners=False,
            )
        return aligned.to(orig_dtype), theta.to(orig_dtype)


class SEBlock(nn.Module):
    def __init__(self, channels, reduction=16):
        super().__init__()
        hidden = max(channels // reduction, 8)
        self.pool = nn.AdaptiveAvgPool2d(1)
        self.fc1 = nn.Conv2d(channels, hidden, 1)
        self.fc2 = nn.Conv2d(hidden, channels, 1)

    def forward(self, x):
        s = self.pool(x)
        s = F.relu(self.fc1(s), inplace=True)
        s = torch.sigmoid(self.fc2(s))
        return x * s


class SEResNetCBlock(nn.Module):
    def __init__(self, in_c, out_c, stride: int | tuple[int, int] = 1):
        super().__init__()
        self.conv1 = nn.Conv2d(in_c, out_c, 3, stride=stride, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(out_c)
        self.conv2 = nn.Conv2d(out_c, out_c, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(out_c)
        self.se = SEBlock(out_c)
        self.shortcut = nn.Identity()
        if stride != 1 or in_c != out_c:
            self.shortcut = nn.Sequential(
                nn.Conv2d(in_c, out_c, 1, stride=stride, bias=False),
                nn.BatchNorm2d(out_c),
            )

    def forward(self, x):
        y = F.relu(self.bn1(self.conv1(x)), inplace=True)
        y = self.bn2(self.conv2(y))
        y = self.se(y)
        return F.relu(y + self.shortcut(x), inplace=True)


class SEResNet34CBackboneNoPool(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(3, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, padding=1, bias=False),
            nn.BatchNorm2d(64), nn.ReLU(inplace=True),
        )
        self.layer1 = SEResNetCBlock(64, 64, 1)
        self.layer2 = SEResNetCBlock(64, 128, 2)
        self.layer3 = SEResNetCBlock(128, 256, 2)
        self.layer4 = SEResNetCBlock(256, 512, (2, 1))

    def forward(self, x):
        x = self.stem(x)
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        x = self.layer4(x)
        return x


class QualityAwareFrameFusion(nn.Module):
    def __init__(self, in_channels=512):
        super().__init__()
        self.quality_conv = nn.Sequential(
            nn.Conv2d(in_channels, 64, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(64, 1),
        )

    def forward(self, frame_features):
        B, T, C, H, W = frame_features.shape
        scores = self.quality_conv(frame_features.reshape(B * T, C, H, W))
        scores = scores.view(B, T, 1)
        weights = torch.softmax(scores.float(), dim=1).to(frame_features.dtype)
        fused = torch.sum(frame_features * weights.unsqueeze(-1).unsqueeze(-1), dim=1)
        return fused, weights.squeeze(-1)


class PositionalEncoding(nn.Module):
    pe: torch.Tensor

    def __init__(self, d_model, max_len=256):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(max_len, dtype=torch.float32).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, d_model, 2, dtype=torch.float32) * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))

    def forward(self, x):
        return x + self.pe[:, :x.size(1)].to(dtype=x.dtype)


class CTCCenterLoss(nn.Module):
    def __init__(self, num_classes, feat_dim):
        super().__init__()
        self.centers = nn.Parameter(torch.randn(num_classes, feat_dim) * 0.01)

    def forward(self, features, logits):
        with torch.no_grad():
            pseudo_labels = torch.argmax(logits, dim=-1)
            nonblank_mask = pseudo_labels != 0

        if not nonblank_mask.any():
            return (self.centers.float().sum() * 0.0).to(dtype=torch.float32)

        feat_sel = features[nonblank_mask].float()
        label_sel = pseudo_labels[nonblank_mask]
        centers_sel = self.centers[label_sel].float()
        loss = F.mse_loss(feat_sel, centers_sel)
        return loss


# ============================================================================
# 7. Single model: Fusion -> Encoder -> Linear -> CTC
# ============================================================================

class SingleLRLPRModel(nn.Module):
    def __init__(self, num_classes=None, d_model=512, num_encoder_layers=3):
        super().__init__()
        num_classes = num_classes or Config.NUM_CLASSES

        self.stn = SharedSTNBlock(Config.STN_MAX_AFFINE_DELTA)
        self.backbone = SEResNet34CBackboneNoPool()
        self.fusion = QualityAwareFrameFusion(512)
        self.pos_encoder = PositionalEncoding(d_model)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=8, dim_feedforward=1024,
            dropout=0.10, activation="gelu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_encoder_layers)

        self.final_norm = nn.LayerNorm(d_model, eps=1e-5)
        self.primary_head = nn.Linear(d_model, num_classes)
        self.auxiliary_head = nn.Linear(d_model, num_classes)

        if Config.USE_CENTER_LOSS:
            self.center_loss_fn = CTCCenterLoss(num_classes, d_model)
        else:
            self.center_loss_fn = None

    def _align_and_extract_batched(self, x_5frames):
        B, T, C, H, W = x_5frames.shape
        flat = x_5frames.reshape(B * T, C, H, W)

        if Config.USE_STN:
            aligned_flat, theta_flat = self.stn(flat)
        else:
            aligned_flat = flat
            theta_flat = self.stn.identity.expand(B * T, -1, -1).to(x_5frames)

        feat_flat = self.backbone(aligned_flat)
        _, feature_channels, feature_height, feature_width = feat_flat.shape

        frame_feats = feat_flat.view(B, T, feature_channels, feature_height, feature_width)
        thetas = theta_flat.view(B, T, 2, 3)
        return frame_feats, thetas

    def forward(self, x_5frames, return_aux=True):
        expected = (Config.NUM_FRAMES, 3, Config.IMG_HEIGHT, Config.IMG_WIDTH)
        if x_5frames.ndim != 5 or tuple(x_5frames.shape[1:]) != expected:
            raise ValueError(f"Expected [B, 5, 3, 32, 128], got {tuple(x_5frames.shape)}")

        frame_feats, thetas = self._align_and_extract_batched(x_5frames)

        fused_feat, frame_weights = self.fusion(frame_feats)
        seq_feat = fused_feat.mean(dim=2).transpose(1, 2).contiguous()

        if Config.FP32_SEQUENCE_DECODER:
            with torch.autocast(device_type=seq_feat.device.type, enabled=False):
                seq_feat_fp32 = seq_feat.float()
                aux_logits = self.auxiliary_head(seq_feat_fp32) if return_aux else None
                x = self.pos_encoder(seq_feat_fp32)
                enc_out = self.encoder(x)
                enc_out = self.final_norm(enc_out)
                primary_logits = self.primary_head(enc_out)
        else:
            aux_logits = self.auxiliary_head(seq_feat) if return_aux else None
            x = self.pos_encoder(seq_feat)
            enc_out = self.encoder(x)
            enc_out = self.final_norm(enc_out)
            primary_logits = self.primary_head(enc_out)

        if not return_aux:
            return primary_logits

        return primary_logits, aux_logits, thetas, enc_out, frame_weights



def _load_state_dict(checkpoint_path: Path, device: torch.device):
    if not checkpoint_path.is_dir():
        return torch.load(checkpoint_path, map_location=device, weights_only=True)

    if not (checkpoint_path / "data.pkl").is_file() or not (checkpoint_path / "version").is_file():
        raise ValueError(f"Not an extracted PyTorch checkpoint directory: {checkpoint_path}")

    checkpoint_buffer = BytesIO()
    checkpoint_files = sorted(
        path for path in checkpoint_path.rglob("*")
        if path.is_file() and not path.is_symlink() and path.name != ".DS_Store"
    )
    with zipfile.ZipFile(checkpoint_buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in checkpoint_files:
            archive.write(path, Path(checkpoint_path.name) / path.relative_to(checkpoint_path))
    checkpoint_buffer.seek(0)
    return torch.load(checkpoint_buffer, map_location=device, weights_only=True)


def load_model(checkpoint_path: str | Path, device: torch.device):
    checkpoint_path = Path(checkpoint_path)

    model = SingleLRLPRModel(
        num_classes=NUM_CLASSES,
        d_model=512,
        num_encoder_layers=3,
    )

    state_dict = _load_state_dict(checkpoint_path, device)

    model.load_state_dict(state_dict)

    model.to(device)
    model.eval()

    return model