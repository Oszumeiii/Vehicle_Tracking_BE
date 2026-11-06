import math

import torch
import torch.nn as nn
from torch.nn import functional as F

from app.recognition.svtr_backbone import SharedSTNBlock, SVTRv2BaseBackbone2D
from app.recognition.svtr_config import Config


class RegionalEvidenceFusion(nn.Module):
    """Horizontal feature alignment and CTC-column evidence fusion.

    Columns are feature positions, not guaranteed one-to-one character boxes.
    Diagnostics are returned explicitly (never retained on the module).
    """
    def __init__(self, channels=512):
        super().__init__()
        # Integer state is copied exactly by EMA and saved in checkpoints.
        # A fresh model defaults to full alignment for standalone smoke tests.
        self.register_buffer("alignment_epoch", torch.tensor(
            Config.ALIGN_FREEZE_EPOCHS + Config.ALIGN_RAMP_EPOCHS, dtype=torch.long))
        self.align_enabled = Config.USE_FEATURE_ALIGNMENT
        self.evidence_enabled = Config.USE_DISAGREEMENT
        if self.align_enabled:
            self.offset_net = nn.Sequential(
                nn.Conv1d(channels * 2, 64, 3, padding=1), nn.GELU(),
                nn.Conv1d(64, 1, 3, padding=1))
            nn.init.zeros_(self.offset_net[-1].weight)
            nn.init.zeros_(self.offset_net[-1].bias)
        self.frame_head = nn.Linear(channels, Config.NUM_CLASSES)
        self.quality = nn.Sequential(nn.Conv1d(channels, 64, 3, padding=1),
                                     nn.GELU(), nn.Conv1d(64, 1, 1))
        if self.evidence_enabled:
            self.evidence_score = nn.Conv1d(3, 1, 1)
            nn.init.constant_(self.evidence_score.weight, -0.5)
            nn.init.zeros_(self.evidence_score.bias)
            self.reject_score = nn.Conv1d(3, 1, 1)
            nn.init.constant_(self.reject_score.weight, 0.5)
            nn.init.constant_(self.reject_score.bias, -2.0)
            self.unknown_feature = nn.Parameter(torch.zeros(1, channels, 1, 1))

    def set_alignment_epoch(self, epoch):
        self.alignment_epoch.fill_(int(epoch))

    def alignment_scale(self):
        if Config.ALIGN_RAMP_EPOCHS <= 0:
            return (self.alignment_epoch > Config.ALIGN_FREEZE_EPOCHS).float()
        return ((self.alignment_epoch.float() - Config.ALIGN_FREEZE_EPOCHS)
                / Config.ALIGN_RAMP_EPOCHS).clamp(0.0, 1.0)

    def align_features(self, features):
        B, T, C, H, W = features.shape
        if not self.align_enabled:
            return features, features.new_zeros(B, T, W)
        columns = features.mean(dim=3)
        reference = columns[:, T // 2:T // 2 + 1].expand(-1, T, -1, -1)
        inputs = torch.cat([columns, reference], dim=2).reshape(B * T, 2 * C, W)
        # Always execute offset_net, including scale=0, so DDP sees its graph.
        offsets = (Config.ALIGN_MAX_SHIFT * self.alignment_scale()
                   * self.offset_net(inputs).tanh().view(B, T, W))
        # Keep the middle frame as the coordinate anchor.
        anchor_mask = features.new_ones(1, T, 1)
        anchor_mask[:, T // 2] = 0
        offsets = offsets * anchor_mask
        with torch.autocast(device_type=features.device.type, enabled=False):
            y = (torch.arange(H, device=features.device).float() + 0.5) * 2 / H - 1
            x = (torch.arange(W, device=features.device).float() + 0.5) * 2 / W - 1
            yy, xx = torch.meshgrid(y, x, indexing='ij')
            gx = xx[None] + offsets.float().reshape(B * T, 1, W) * (2.0 / W)
            gy = yy[None].expand(B * T, -1, -1)
            grid = torch.stack([gx, gy], dim=-1)
            aligned = F.grid_sample(features.float().reshape(B * T, C, H, W),
                                    grid, padding_mode='border', align_corners=False)
        return aligned.to(features.dtype).view(B, T, C, H, W), offsets

    def forward(self, features):
        aligned, offsets = self.align_features(features)
        B, T, C, H, W = aligned.shape
        columns = aligned.mean(dim=3)
        frame_logits = self.frame_head(columns.permute(0, 1, 3, 2))
        # Stop gradients through uncertainty statistics; train this predictor via CTC.
        p = frame_logits.detach().float().softmax(dim=-1).clamp_min(1e-7)
        consensus = p.mean(dim=1, keepdim=True).clamp_min(1e-7)
        entropy = -(p * p.log()).sum(-1) / math.log(p.size(-1))
        mixture = (p + consensus) * 0.5
        disagreement = 0.5 * ((p * (p.log() - mixture.log())).sum(-1)
                              + (consensus * (consensus.log() - mixture.log())).sum(-1))
        # Blank probability is a CTC signal, not a calibrated estimate of image quality.
        evidence = torch.stack([entropy, disagreement / math.log(2), p[..., 0]], dim=2)
        score = self.quality(columns.reshape(B * T, C, W)).view(B, T, W).float()
        if self.evidence_enabled:
            score = score + self.evidence_score(evidence.reshape(B * T, 3, W)).view(B, T, W).float()
            reject = self.reject_score(evidence.mean(dim=1)).float()
            all_weights = torch.softmax(torch.cat([score, reject], dim=1), dim=1)
            weights, reject_weight = all_weights[:, :T], all_weights[:, T:]
            fused = (aligned * weights[:, :, None, None, :].to(aligned.dtype)).sum(1)
            fused = fused + self.unknown_feature * reject_weight[:, :, None, :].to(fused.dtype)
        else:
            weights = score.softmax(dim=1)
            reject_weight = score.new_zeros(B, 1, W)
            fused = (aligned * weights[:, :, None, None, :].to(aligned.dtype)).sum(1)
        # Same shallow classifier on both paths reduces CTC timing mismatch in consistency.
        fused_local_logits = self.frame_head(fused.mean(dim=2).transpose(1, 2))
        diagnostics = dict(frame_logits=frame_logits, fused_local_logits=fused_local_logits,
                           column_weights=weights, reject_weight=reject_weight,
                           entropy=entropy, disagreement=disagreement, offsets=offsets)
        return fused, weights.mean(-1), diagnostics


class PositionalEncoding(nn.Module):
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
        nn.init.zeros_(self.score[-1].weight)
        nn.init.zeros_(self.score[-1].bias)
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


class SingleLRLPRModel(nn.Module):
    def __init__(self, num_classes=None, d_model=512, num_encoder_layers=3):
        super().__init__()
        num_classes = num_classes or Config.NUM_CLASSES

        self.stn = SharedSTNBlock(Config.STN_MAX_AFFINE_DELTA)
        self.backbone = SVTRv2BaseBackbone2D()
        self.fusion = RegionalEvidenceFusion(512)
        if d_model != 512:
            raise ValueError("SVTRv2 adapter and height pooling output C=512; use d_model=512.")
        self.height_pool = HeightAttentionPool(512, SingleLRLPRModel.backbone_out_height(Config.IMG_HEIGHT))
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
        return frame_feats, thetas

    def forward(self, x_5frames, return_aux=True, return_fusion=False):
        if x_5frames.ndim != 5 or x_5frames.size(1) != Config.NUM_FRAMES:
            raise ValueError(f"Expected [B, 5, C, H, W], got {tuple(x_5frames.shape)}")
        frame_feats, thetas = self._align_and_extract_batched(x_5frames)

        fused_feat, frame_weights, fusion_info = self.fusion(frame_feats)
        seq_feat = self.height_pool(fused_feat).transpose(1, 2).contiguous()

        if Config.FP32_SEQUENCE_DECODER:
            with torch.autocast(device_type=seq_feat.device.type, enabled=False):
                primary_logits, aux_logits = self._sequence_head(seq_feat.float(), return_aux)
        else:
            primary_logits, aux_logits = self._sequence_head(seq_feat, return_aux)

        if not return_aux:
            return primary_logits

        if return_fusion:
            return primary_logits, aux_logits, thetas, frame_weights, fusion_info

        return primary_logits, aux_logits, thetas, frame_weights

    def _sequence_head(self, seq_feat, return_aux):
        aux_logits = self.auxiliary_head(seq_feat) if return_aux else None
        enc_out = self.final_norm(self.encoder(self.pos_encoder(seq_feat)))
        primary_logits = self.primary_head(self.head_drop(enc_out))
        return primary_logits, aux_logits

    @staticmethod
    def backbone_out_height(h):
        for _ in range(3):
            h = (h + 1) // 2
        return h
