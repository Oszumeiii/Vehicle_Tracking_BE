"""Architecture copied from the modular SE-ResNet-34-C notebook; no training imports."""
from collections.abc import Mapping
from io import BytesIO
import math
from pathlib import Path
import zipfile

import torch
from torch import nn
from torch.nn import functional as F

class Config:
    IMG_HEIGHT = 48
    IMG_WIDTH = 192
    NUM_FRAMES = 5
    NUM_CLASSES = 37
    USE_STN = True
    STN_MAX_AFFINE_DELTA = 0.15
    DROP_PATH_MAX = 0.10
    HEAD_DROPOUT = 0.10
    ENCODER_DROPOUT = 0.20
    FP32_SEQUENCE_DECODER = False

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
            raise TypeError("The final localization layer must be linear.")
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

class DropPath(nn.Module):

    def __init__(self, p=0.0):
        super().__init__()
        self.p = float(p)

    def forward(self, x):
        if self.p <= 0.0 or not self.training:
            return x
        keep = 1.0 - self.p
        mask = x.new_empty((x.shape[0],) + (1,) * (x.ndim - 1)).bernoulli_(keep)
        return x * mask / keep

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
    def __init__(self, in_c, out_c, stride=1, drop_path=0.0):
        super().__init__()
        self.conv1 = nn.Conv2d(in_c, out_c, 3, stride=stride, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(out_c)
        self.conv2 = nn.Conv2d(out_c, out_c, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(out_c)
        self.se = SEBlock(out_c)
        self.drop_path = DropPath(drop_path)
        self.shortcut = nn.Identity()
        if stride != 1 or in_c != out_c:
            self.shortcut = nn.Sequential(
                nn.Conv2d(in_c, out_c, 1, stride=stride, bias=False),
                nn.BatchNorm2d(out_c),
            )

    def forward(self, x):
        y = F.relu(self.bn1(self.conv1(x)), inplace=True)
        y = self.bn2(self.conv2(y))
        y = self.drop_path(self.se(y))
        return F.relu(y + self.shortcut(x), inplace=True)

class SEResNet34CBackboneNoPool(nn.Module):
    'SE-ResNet-34 stage topology [3,4,6,3], C-stem, output stride (8,4).'

    stage_depths = (3, 4, 6, 3)
    out_channels = 512
    output_stride = (8, 4)

    def __init__(self, drop_path_max=None):
        super().__init__()
        drop_path_max = Config.DROP_PATH_MAX if drop_path_max is None else float(drop_path_max)
        if not 0.0 <= drop_path_max < 1.0:
            raise ValueError("drop_path_max must be in [0, 1).")
        self.in_channels = 64
        self.stem = nn.Sequential(
            nn.Conv2d(3, 32, 3, stride=1, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, 3, stride=1, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 64, 3, stride=1, padding=1, bias=False),
            nn.BatchNorm2d(64), nn.ReLU(inplace=True),
        )
        rates = torch.linspace(0.0, drop_path_max, sum(self.stage_depths)).tolist()
        self.layer1 = self._make_layer(64, 3, stride=1, drop_rates=rates[:3])
        self.layer2 = self._make_layer(128, 4, stride=2, drop_rates=rates[3:7])
        self.layer3 = self._make_layer(256, 6, stride=2, drop_rates=rates[7:13])
        self.layer4 = self._make_layer(512, 3, stride=(2, 1), drop_rates=rates[13:])
        self._initialize_weights()

    def _make_layer(self, out_channels, num_blocks, stride, drop_rates):
        if len(drop_rates) != num_blocks:
            raise ValueError("Each residual block requires one DropPath rate.")
        blocks = []
        for index in range(num_blocks):
            blocks.append(SEResNetCBlock(
                self.in_channels, out_channels,
                stride=stride if index == 0 else 1,
                drop_path=drop_rates[index],
            ))
            self.in_channels = out_channels
        return nn.Sequential(*blocks)

    def _initialize_weights(self):
        for module in self.modules():
            if isinstance(module, nn.Conv2d):
                nn.init.kaiming_normal_(module.weight, mode="fan_out", nonlinearity="relu")
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.BatchNorm2d):
                nn.init.ones_(module.weight)
                nn.init.zeros_(module.bias)

    def forward(self, x):
        x = self.stem(x)
        x = self.layer1(x)
        x = self.layer2(x)
        x = self.layer3(x)
        return self.layer4(x)

class QualityAwareFrameFusion(nn.Module):
    'Fuse frame features with weights per frame and column.'

    def __init__(self, in_channels=512):
        super().__init__()
        self.quality_conv = nn.Sequential(
            nn.Conv2d(in_channels, 64, 3, padding=1),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(64, 1),
        )
        self.col_score = nn.Sequential(
            nn.Conv2d(in_channels, 128, 3, padding=1),
            nn.GroupNorm(8, 128),
            nn.ReLU(inplace=True),
            nn.Conv2d(128, 1, 1),
        )
        final_layer = self.col_score[-1]
        if not isinstance(final_layer, nn.Conv2d):
            raise TypeError("The final column-score layer must be a convolution.")
        if final_layer.weight is None or final_layer.bias is None:
            raise TypeError("The final column-score layer must have trainable parameters.")
        nn.init.zeros_(final_layer.weight)
        nn.init.zeros_(final_layer.bias)

    def forward(self, frame_features):
        B, T, C, H, W = frame_features.shape
        flat = frame_features.reshape(B * T, C, H, W)
        g = self.quality_conv(flat).view(B, T, 1).float()
        col = self.col_score(flat).float().mean(dim=2).view(B, T, W)
        weights = torch.softmax(g + col, dim=1).to(frame_features.dtype)
        fused = torch.sum(frame_features * weights[:, :, None, None, :], dim=1)
        return fused, weights.mean(dim=-1)

class HeightAttentionPool(nn.Module):
    'Height attention plus a projection of flattened height/channel features.'

    def __init__(self, channels=512, height=6, heads=8):
        super().__init__()
        assert channels % heads == 0
        self.heads = heads
        self.score = nn.Sequential(
            nn.Conv2d(channels, channels // 4, 3, padding=1),
            nn.GELU(),
            nn.Conv2d(channels // 4, heads, 1),
        )
        final_layer = self.score[-1]
        if not isinstance(final_layer, nn.Conv2d):
            raise TypeError("The final height-score layer must be a convolution.")
        if final_layer.weight is None or final_layer.bias is None:
            raise TypeError("The final height-score layer must have trainable parameters.")
        nn.init.zeros_(final_layer.weight)
        nn.init.zeros_(final_layer.bias)
        self.flat_proj = nn.Linear(channels * height, channels)
        nn.init.zeros_(self.flat_proj.weight)
        nn.init.zeros_(self.flat_proj.bias)

    def forward(self, x):
        B, C, H, W = x.shape
        w = torch.softmax(self.score(x).float(), dim=2).to(x.dtype)
        xg = x.reshape(B, self.heads, C // self.heads, H, W)
        pooled = (xg * w.unsqueeze(2)).sum(dim=3).reshape(B, C, W)
        flat = self.flat_proj(x.permute(0, 3, 1, 2).reshape(B, W, C * H))
        return pooled + flat.transpose(1, 2)

def backbone_out_height(h):
    for _ in range(3):
        h = (h + 1) // 2
    return h

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

class SingleLRLPRModel(nn.Module):
    encoder: nn.TransformerEncoder

    def __init__(self, num_classes=None, d_model=512, num_encoder_layers=3):
        super().__init__()
        num_classes = num_classes or Config.NUM_CLASSES

        self.stn = SharedSTNBlock(Config.STN_MAX_AFFINE_DELTA)
        self.backbone = SEResNet34CBackboneNoPool()
        self.fusion = QualityAwareFrameFusion(512)
        self.height_pool = HeightAttentionPool(512, backbone_out_height(Config.IMG_HEIGHT))
        self.head_drop = nn.Dropout(Config.HEAD_DROPOUT)
        self.pos_encoder = PositionalEncoding(d_model)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=8, dim_feedforward=1024,
            dropout=Config.ENCODER_DROPOUT, activation="gelu", batch_first=True, norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_encoder_layers)

        self.final_norm = nn.LayerNorm(d_model, eps=1e-5)
        self.primary_head = nn.Linear(d_model, num_classes)
        self.auxiliary_head = nn.Linear(d_model, num_classes)




    def _align_and_extract_batched(self, x_5frames):
        B, T, C, H, W = x_5frames.shape
        flat = x_5frames.reshape(B * T, C, H, W)

        if Config.USE_STN:
            aligned_flat, theta_flat = self.stn(flat)
        else:
            aligned_flat = flat
            theta_flat = self.stn.identity.expand(B * T, -1, -1).to(x_5frames)

        feat_flat = self.backbone(aligned_flat)
        _, Cf, Hf, Wf = feat_flat.shape

        frame_feats = feat_flat.view(B, T, Cf, Hf, Wf)
        thetas = theta_flat.view(B, T, 2, 3)
        aligned = aligned_flat.view(B, T, C, H, W)
        return frame_feats, thetas, aligned

    def forward(self, x_5frames, return_aux=False, return_weights=False):
        if x_5frames.ndim != 5 or x_5frames.size(1) != Config.NUM_FRAMES:
            raise ValueError(f"Expected [B, 5, C, H, W], got {tuple(x_5frames.shape)}")
        frame_feats, thetas, _ = self._align_and_extract_batched(x_5frames)

        fused_feat, frame_weights = self.fusion(frame_feats)
        seq_feat = self.height_pool(fused_feat).transpose(1, 2).contiguous()

        if Config.FP32_SEQUENCE_DECODER:
            with torch.autocast(device_type="cuda", enabled=False):
                seq_feat_fp32 = seq_feat.float()
                aux_logits = self.auxiliary_head(seq_feat_fp32) if return_aux else None
                x = self.pos_encoder(seq_feat_fp32)
                enc_out = self.encoder(x)
                enc_out = self.final_norm(enc_out)
                primary_logits = self.primary_head(self.head_drop(enc_out))
        else:
            aux_logits = self.auxiliary_head(seq_feat) if return_aux else None
            x = self.pos_encoder(seq_feat)
            enc_out = self.encoder(x)
            enc_out = self.final_norm(enc_out)
            primary_logits = self.primary_head(self.head_drop(enc_out))

        if not return_aux:
            return (primary_logits, frame_weights) if return_weights else primary_logits

        return primary_logits, aux_logits, thetas, frame_weights


def _load_state_dict(checkpoint_path: Path):
    if checkpoint_path.is_dir():
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
        payload = torch.load(checkpoint_buffer, map_location="cpu", weights_only=True)
    elif checkpoint_path.is_file():
        payload = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    else:
        raise FileNotFoundError(f"Model checkpoint not found: {checkpoint_path}")

    if isinstance(payload, Mapping):
        for key in ("model_state_dict", "state_dict"):
            if key in payload:
                payload = payload[key]
                break
    if not isinstance(payload, Mapping) or not payload:
        raise ValueError("Checkpoint must contain a non-empty state_dict.")

    state = {}
    for name, value in payload.items():
        if not isinstance(name, str) or not isinstance(value, torch.Tensor):
            raise ValueError("Checkpoint state_dict must map parameter names to tensors.")
        key = name.removeprefix("module.")
        if key.startswith("sr_decoder."):
            continue
        if key in state:
            raise ValueError(f"Duplicate checkpoint key: {key}")
        state[key] = value
    return state


def load_model(checkpoint_path: str | Path, device: torch.device):
    model = SingleLRLPRModel()
    state_dict = _load_state_dict(Path(checkpoint_path))
    try:
        model.load_state_dict(state_dict, strict=True)
    except RuntimeError as exc:
        raise RuntimeError(
            "Checkpoint does not match the configured SE-ResNet-34-C inference model."
        ) from exc
    return model.to(device).eval()
