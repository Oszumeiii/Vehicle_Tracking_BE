import numpy as np
import torch
import torch.nn as nn
from torch.nn import functional as F
from torch.nn.init import kaiming_normal_, ones_, trunc_normal_, zeros_

from app.recognition.svtr_config import Config


class SharedSTNBlock(nn.Module):
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
        nn.init.zeros_(self.fc_loc[-1].weight)
        nn.init.zeros_(self.fc_loc[-1].bias)

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

# Adapted from Topdu/OpenOCR, Apache License 2.0.
# Source commit: 1ccfc6ee6161f7133b192e16af3a9265273997ba
# Upstream: openrec/modeling/encoders/svtrv2_lnconv_two33.py and modeling/common.py
# Modifications: inline dependencies; add Base configuration and 384->512 adapter.
# The upstream encoder operators, normalization order, and state-dict keys are unchanged.
# Full upstream Apache-2.0 license is included in the final notebook cell.

class DropPath(nn.Module):
    """Drop paths (Stochastic Depth) per sample  (when applied in main path of
    residual blocks)."""

    def __init__(self, drop_prob: float = 0.0, scale_by_keep: bool = True):
        super(DropPath, self).__init__()
        self.drop_prob = drop_prob
        self.scale_by_keep = scale_by_keep

    def forward(self, x):
        return DropPath.drop_path(x, self.drop_prob, self.training, self.scale_by_keep)

    def extra_repr(self):
        return f'drop_prob={round(self.drop_prob,3):0.3f}'

    @staticmethod
    def drop_path(x,
                  drop_prob: float = 0.0,
                  training: bool = False,
                  scale_by_keep: bool = True):
        """Drop paths (Stochastic Depth) per sample (when applied in main path of
        residual blocks).

        This is the same as the DropConnect impl I created for EfficientNet, etc networks, however,
        the original name is misleading as 'Drop Connect' is a different form of dropout in a separate paper...
        See discussion: https://github.com/tensorflow/tpu/issues/494#issuecomment-532968956 ... I've opted for
        changing the layer and argument names to 'drop path' rather than mix DropConnect as a layer name and use
        'survival rate' as the argument.
        """
        if drop_prob == 0.0 or not training:
            return x
        keep_prob = 1 - drop_prob
        shape = (x.shape[0], ) + (1, ) * (
            x.ndim - 1)  # work with diff dim tensors, not just 2D ConvNets
        random_tensor = x.new_empty(shape).bernoulli_(keep_prob)
        if keep_prob > 0.0 and scale_by_keep:
            random_tensor.div_(keep_prob)
        return x * random_tensor


class Identity(nn.Module):

    def __init__(self):
        super(Identity, self).__init__()

    def forward(self, input):
        return input

class Mlp(nn.Module):

    def __init__(
        self,
        in_features,
        hidden_features=None,
        out_features=None,
        act_layer=nn.GELU,
        drop=0.0,
    ):
        super().__init__()
        out_features = out_features or in_features
        hidden_features = hidden_features or in_features
        self.fc1 = nn.Linear(in_features, hidden_features)
        self.act = act_layer()
        self.fc2 = nn.Linear(hidden_features, out_features)
        self.drop = nn.Dropout(drop)

    def forward(self, x):
        x = self.fc1(x)
        x = self.act(x)
        x = self.drop(x)
        x = self.fc2(x)
        x = self.drop(x)
        return x

# DropPath, Identity and Mlp are inlined above from OpenOCR common.py.


class ConvBNLayer(nn.Module):

    def __init__(
        self,
        in_channels,
        out_channels,
        kernel_size=3,
        stride=1,
        padding=0,
        bias=False,
        groups=1,
        act=nn.GELU,
    ):
        super().__init__()
        self.conv = nn.Conv2d(
            in_channels=in_channels,
            out_channels=out_channels,
            kernel_size=kernel_size,
            stride=stride,
            padding=padding,
            groups=groups,
            bias=bias,
        )
        self.norm = nn.BatchNorm2d(out_channels)
        self.act = act()

    def forward(self, inputs):
        out = self.conv(inputs)
        out = self.norm(out)
        out = self.act(out)
        return out


class Attention(nn.Module):

    def __init__(
        self,
        dim,
        num_heads=8,
        qkv_bias=False,
        qk_scale=None,
        attn_drop=0.0,
        proj_drop=0.0,
    ):
        super().__init__()
        self.num_heads = num_heads
        self.dim = dim
        self.head_dim = dim // num_heads
        self.scale = qk_scale or self.head_dim**-0.5
        self.qkv = nn.Linear(dim, dim * 3, bias=qkv_bias)
        self.attn_drop = nn.Dropout(attn_drop)
        self.proj = nn.Linear(dim, dim)
        self.proj_drop = nn.Dropout(proj_drop)

    def forward(self, x):
        B, N, _ = x.shape
        qkv = self.qkv(x).reshape(B, N, 3, self.num_heads,
                                  self.head_dim).permute(2, 0, 3, 1, 4)
        q, k, v = qkv.unbind(0)
        attn = q @ k.transpose(-2, -1) * self.scale
        attn = attn.softmax(dim=-1)
        attn = self.attn_drop(attn)
        x = attn @ v
        x = x.transpose(1, 2).reshape(B, N, self.dim)
        x = self.proj(x)
        x = self.proj_drop(x)
        return x


class Block(nn.Module):

    def __init__(
        self,
        dim,
        num_heads,
        mlp_ratio=4.0,
        qkv_bias=False,
        qk_scale=None,
        drop=0.0,
        attn_drop=0.0,
        drop_path=0.0,
        act_layer=nn.GELU,
        norm_layer=nn.LayerNorm,
        eps=1e-6,
    ):
        super().__init__()
        mlp_hidden_dim = int(dim * mlp_ratio)
        self.norm1 = norm_layer(dim, eps=eps)
        self.mixer = Attention(
            dim,
            num_heads=num_heads,
            qkv_bias=qkv_bias,
            qk_scale=qk_scale,
            attn_drop=attn_drop,
            proj_drop=drop,
        )
        self.drop_path = DropPath(drop_path) if drop_path > 0.0 else Identity()
        self.norm2 = norm_layer(dim, eps=eps)
        self.mlp = Mlp(
            in_features=dim,
            hidden_features=mlp_hidden_dim,
            act_layer=act_layer,
            drop=drop,
        )

    def forward(self, x):
        x = self.norm1(x + self.drop_path(self.mixer(x)))
        x = self.norm2(x + self.drop_path(self.mlp(x)))
        return x


class FlattenBlockRe2D(Block):

    def __init__(self,
                 dim,
                 num_heads,
                 mlp_ratio=4,
                 qkv_bias=False,
                 qk_scale=None,
                 drop=0,
                 attn_drop=0,
                 drop_path=0,
                 act_layer=nn.GELU,
                 norm_layer=nn.LayerNorm,
                 eps=0.000001):
        super().__init__(dim, num_heads, mlp_ratio, qkv_bias, qk_scale, drop,
                         attn_drop, drop_path, act_layer, norm_layer, eps)

    def forward(self, x):
        B, C, H, W = x.shape
        x = x.flatten(2).transpose(1, 2)
        x = super().forward(x)
        x = x.transpose(1, 2).reshape(B, C, H, W)
        return x


class ConvBlock(nn.Module):

    def __init__(
        self,
        dim,
        num_heads,
        mlp_ratio=4.0,
        drop=0.0,
        drop_path=0.0,
        act_layer=nn.GELU,
        norm_layer=nn.LayerNorm,
        eps=1e-6,
        num_conv=2,
        kernel_size=3,
    ):
        super().__init__()
        mlp_hidden_dim = int(dim * mlp_ratio)
        self.norm1 = norm_layer(dim, eps=eps)
        self.mixer = nn.Sequential(*[
            nn.Conv2d(
                dim, dim, kernel_size, 1, kernel_size // 2, groups=num_heads)
            for i in range(num_conv)
        ])
        self.drop_path = DropPath(drop_path) if drop_path > 0.0 else Identity()
        self.norm2 = norm_layer(dim, eps=eps)
        self.mlp = Mlp(
            in_features=dim,
            hidden_features=mlp_hidden_dim,
            act_layer=act_layer,
            drop=drop,
        )

    def forward(self, x):
        C, H, W = x.shape[1:]
        x = x + self.drop_path(self.mixer(x))
        x = self.norm1(x.flatten(2).transpose(1, 2))
        x = self.norm2(x + self.drop_path(self.mlp(x)))
        x = x.transpose(1, 2).reshape(-1, C, H, W)
        return x


class FlattenTranspose(nn.Module):

    def forward(self, x):
        return x.flatten(2).transpose(1, 2)


class SubSample2D(nn.Module):

    def __init__(
        self,
        in_channels,
        out_channels,
        stride=[2, 1],
    ):
        super().__init__()
        self.conv = nn.Conv2d(in_channels,
                              out_channels,
                              kernel_size=3,
                              stride=stride,
                              padding=1)
        self.norm = nn.LayerNorm(out_channels)

    def forward(self, x, sz):
        # print(x.shape)
        x = self.conv(x)
        C, H, W = x.shape[1:]
        x = self.norm(x.flatten(2).transpose(1, 2))
        x = x.transpose(1, 2).reshape(-1, C, H, W)
        return x, [H, W]


class SubSample1D(nn.Module):

    def __init__(
        self,
        in_channels,
        out_channels,
        stride=[2, 1],
    ):
        super().__init__()
        self.conv = nn.Conv2d(in_channels,
                              out_channels,
                              kernel_size=3,
                              stride=stride,
                              padding=1)
        self.norm = nn.LayerNorm(out_channels)

    def forward(self, x, sz):
        C = x.shape[-1]
        x = x.transpose(1, 2).reshape(-1, C, sz[0], sz[1])
        x = self.conv(x)
        C, H, W = x.shape[1:]
        x = self.norm(x.flatten(2).transpose(1, 2))
        return x, [H, W]


class IdentitySize(nn.Module):

    def forward(self, x, sz):
        return x, sz


class SVTRStage(nn.Module):

    def __init__(self,
                 dim=64,
                 out_dim=256,
                 depth=3,
                 mixer=['Local'] * 3,
                 kernel_sizes=[3] * 3,
                 sub_k=[2, 1],
                 num_heads=2,
                 mlp_ratio=4,
                 qkv_bias=True,
                 qk_scale=None,
                 drop_rate=0.0,
                 attn_drop_rate=0.0,
                 drop_path=[0.1] * 3,
                 norm_layer=nn.LayerNorm,
                 act=nn.GELU,
                 eps=1e-6,
                 num_conv=[2] * 3,
                 downsample=None,
                 **kwargs):
        super().__init__()
        self.dim = dim

        self.blocks = nn.Sequential()
        for i in range(depth):
            if mixer[i] == 'Conv':
                self.blocks.append(
                    ConvBlock(dim=dim,
                              kernel_size=kernel_sizes[i],
                              num_heads=num_heads,
                              mlp_ratio=mlp_ratio,
                              drop=drop_rate,
                              act_layer=act,
                              drop_path=drop_path[i],
                              norm_layer=norm_layer,
                              eps=eps,
                              num_conv=num_conv[i]))
            else:
                if mixer[i] == 'Global':
                    block = Block
                elif mixer[i] == 'FGlobal':
                    block = Block
                    self.blocks.append(FlattenTranspose())
                elif mixer[i] == 'FGlobalRe2D':
                    block = FlattenBlockRe2D
                self.blocks.append(
                    block(
                        dim=dim,
                        num_heads=num_heads,
                        mlp_ratio=mlp_ratio,
                        qkv_bias=qkv_bias,
                        qk_scale=qk_scale,
                        drop=drop_rate,
                        act_layer=act,
                        attn_drop=attn_drop_rate,
                        drop_path=drop_path[i],
                        norm_layer=norm_layer,
                        eps=eps,
                    ))

        if downsample:
            if mixer[-1] == 'Conv' or mixer[-1] == 'FGlobalRe2D':
                self.downsample = SubSample2D(dim, out_dim, stride=sub_k)
            else:
                self.downsample = SubSample1D(dim, out_dim, stride=sub_k)
        else:
            self.downsample = IdentitySize()

    def forward(self, x, sz):
        for blk in self.blocks:
            x = blk(x)
        x, sz = self.downsample(x, sz)
        return x, sz


class ADDPosEmbed(nn.Module):

    def __init__(self, feat_max_size=[8, 32], embed_dim=768):
        super().__init__()
        pos_embed = torch.zeros(
            [1, feat_max_size[0] * feat_max_size[1], embed_dim],
            dtype=torch.float32)
        trunc_normal_(pos_embed, mean=0, std=0.02)
        self.pos_embed = nn.Parameter(
            pos_embed.transpose(1, 2).reshape(1, embed_dim, feat_max_size[0],
                                              feat_max_size[1]),
            requires_grad=True,
        )

    def forward(self, x):
        sz = x.shape[2:]
        x = x + self.pos_embed[:, :, :sz[0], :sz[1]]
        return x


class POPatchEmbed(nn.Module):
    """Image to Patch Embedding."""

    def __init__(self,
                 in_channels=3,
                 feat_max_size=[8, 32],
                 embed_dim=768,
                 use_pos_embed=False,
                 flatten=False,
                 bias=False):
        super().__init__()
        self.patch_embed = nn.Sequential(
            ConvBNLayer(
                in_channels=in_channels,
                out_channels=embed_dim // 2,
                kernel_size=3,
                stride=2,
                padding=1,
                act=nn.GELU,
                bias=bias,
            ),
            ConvBNLayer(
                in_channels=embed_dim // 2,
                out_channels=embed_dim,
                kernel_size=3,
                stride=2,
                padding=1,
                act=nn.GELU,
                bias=bias,
            ),
        )
        if use_pos_embed:
            self.patch_embed.append(ADDPosEmbed(feat_max_size, embed_dim))
        if flatten:
            self.patch_embed.append(FlattenTranspose())

    def forward(self, x):
        sz = x.shape[2:]
        x = self.patch_embed(x)
        return x, [sz[0] // 4, sz[1] // 4]


class LastStage(nn.Module):

    def __init__(self, in_channels, out_channels, last_drop, out_char_num=0):
        super().__init__()
        self.last_conv = nn.Linear(in_channels, out_channels, bias=False)
        self.hardswish = nn.Hardswish()
        self.dropout = nn.Dropout(p=last_drop)

    def forward(self, x, sz):
        x = x.reshape(-1, sz[0], sz[1], x.shape[-1])
        x = x.mean(1)
        x = self.last_conv(x)
        x = self.hardswish(x)
        x = self.dropout(x)
        return x, [1, sz[1]]


class Feat2D(nn.Module):

    def __init__(self):
        super().__init__()

    def forward(self, x, sz):
        C = x.shape[-1]
        x = x.transpose(1, 2).reshape(-1, C, sz[0], sz[1])
        return x, sz


class SVTRv2LNConvTwo33(nn.Module):

    def __init__(self,
                 max_sz=[32, 128],
                 in_channels=3,
                 out_channels=192,
                 depths=[3, 6, 3],
                 dims=[64, 128, 256],
                 mixer=[['Conv'] * 3, ['Conv'] * 3 + ['Global'] * 3,
                        ['Global'] * 3],
                 use_pos_embed=True,
                 sub_k=[[1, 1], [2, 1], [1, 1]],
                 num_heads=[2, 4, 8],
                 mlp_ratio=4,
                 qkv_bias=True,
                 qk_scale=None,
                 drop_rate=0.0,
                 last_drop=0.1,
                 attn_drop_rate=0.0,
                 drop_path_rate=0.1,
                 norm_layer=nn.LayerNorm,
                 act=nn.GELU,
                 last_stage=False,
                 feat2d=False,
                 eps=1e-6,
                 num_convs=[[2] * 3, [2] * 3 + [3] * 3, [3] * 3],
                 kernel_sizes=[[3] * 3, [3] * 3 + [3] * 3, [3] * 3],
                 pope_bias=False,
                 **kwargs):
        super().__init__()
        num_stages = len(depths)
        self.num_features = dims[-1]

        feat_max_size = [max_sz[0] // 4, max_sz[1] // 4]
        self.pope = POPatchEmbed(in_channels=in_channels,
                                 feat_max_size=feat_max_size,
                                 embed_dim=dims[0],
                                 use_pos_embed=use_pos_embed,
                                 flatten=mixer[0][0] != 'Conv',
                                 bias=pope_bias)

        dpr = np.linspace(0, drop_path_rate,
                          sum(depths))  # stochastic depth decay rule

        self.stages = nn.ModuleList()
        for i_stage in range(num_stages):
            stage = SVTRStage(
                dim=dims[i_stage],
                out_dim=dims[i_stage + 1] if i_stage < num_stages - 1 else 0,
                depth=depths[i_stage],
                mixer=mixer[i_stage],
                kernel_sizes=kernel_sizes[i_stage]
                if len(kernel_sizes[i_stage]) == len(mixer[i_stage]) else [3] *
                len(mixer[i_stage]),
                sub_k=sub_k[i_stage],
                num_heads=num_heads[i_stage],
                mlp_ratio=mlp_ratio,
                qkv_bias=qkv_bias,
                qk_scale=qk_scale,
                drop=drop_rate,
                attn_drop=attn_drop_rate,
                drop_path=dpr[sum(depths[:i_stage]):sum(depths[:i_stage + 1])],
                norm_layer=norm_layer,
                act=act,
                downsample=False if i_stage == num_stages - 1 else True,
                eps=eps,
                num_conv=num_convs[i_stage] if len(num_convs[i_stage]) == len(
                    mixer[i_stage]) else [2] * len(mixer[i_stage]),
            )
            self.stages.append(stage)

        self.out_channels = self.num_features
        self.last_stage = last_stage
        if last_stage:
            self.out_channels = out_channels
            self.stages.append(
                LastStage(self.num_features, out_channels, last_drop))
        if feat2d:
            self.stages.append(Feat2D())
        self.apply(self._init_weights)

    def _init_weights(self, m: nn.Module):
        if isinstance(m, nn.Linear):
            trunc_normal_(m.weight, mean=0, std=0.02)
            if isinstance(m, nn.Linear) and m.bias is not None:
                zeros_(m.bias)
        if isinstance(m, nn.LayerNorm):
            zeros_(m.bias)
            ones_(m.weight)
        if isinstance(m, nn.Conv2d):
            kaiming_normal_(m.weight, mode='fan_out', nonlinearity='relu')

    @torch.jit.ignore
    def no_weight_decay(self):
        return {'patch_embed', 'downsample', 'pos_embed'}

    def forward(self, x):
        if len(x.shape) == 5:
            x = x.flatten(0, 1)
        x, sz = self.pope(x)
        for stage in self.stages:
            x, sz = stage(x, sz)
        return x


class SVTRv2BaseBackbone2D(nn.Module):
    """OpenOCR SVTRv2 Base visual encoder + 384->512 adapter for regional OCR.

    The encoder is the official LNConvTwo33 implementation, not SVTR v1.
    No FRM / SGM / character decoder is attached to the feature extractor.
    """
    stage_depths = (6, 6, 6)
    stage_dims = (128, 256, 384)
    stage_heads = (4, 8, 12)
    raw_out_channels = 384
    out_channels = 512
    output_stride = (8, 4)
    mixer_types = (
        ('Conv',) * 6,
        ('Conv', 'Conv', 'FGlobal', 'Global', 'Global', 'Global'),
        ('Global',) * 6,
    )

    def __init__(self, drop_path_max=None):
        super().__init__()
        if (tuple(Config.BACKBONE_DIMS), tuple(Config.BACKBONE_DEPTHS), tuple(Config.BACKBONE_HEADS)) != (
                self.stage_dims, self.stage_depths, self.stage_heads):
            raise ValueError('SVTRv2 Base requires dims=[128,256,384], depths=[6,6,6], heads=[4,8,12].')
        if Config.BACKBONE_RAW_CHANNELS != 384 or Config.BACKBONE_OUTPUT_CHANNELS != 512:
            raise ValueError('This integration requires raw C=384 and adapter C=512.')
        if Config.BACKBONE_PRETRAINED:
            raise ValueError('No pretrained weights are bundled. Set BACKBONE_PRETRAINED=False to train from scratch.')
        drop_path_max = Config.DROP_PATH_MAX if drop_path_max is None else float(drop_path_max)
        if not 0.0 <= drop_path_max < 1.0:
            raise ValueError('drop_path_max must be in [0,1).')
        self.encoder = SVTRv2LNConvTwo33(
            in_channels=3, max_sz=[Config.IMG_HEIGHT, Config.IMG_WIDTH],
            dims=list(self.stage_dims), depths=list(self.stage_depths),
            num_heads=list(self.stage_heads), mixer=[list(x) for x in self.mixer_types],
            use_pos_embed=False, sub_k=[[1,1], [2,1], [-1,-1]],
            last_stage=False, feat2d=True, mlp_ratio=4, qkv_bias=True,
            drop_rate=0.0, attn_drop_rate=0.0, drop_path_rate=drop_path_max,
            num_convs=[[2]*6, [2]*6, [2]*6], kernel_sizes=[[3]*6, [3]*6, [3]*6],
        )
        self.projection = nn.Conv2d(self.raw_out_channels, self.out_channels, 1, bias=False)
        nn.init.kaiming_normal_(self.projection.weight, mode='fan_out', nonlinearity='linear')

    def forward(self, x):
        if x.ndim != 4 or x.shape[1] != 3:
            raise ValueError(f'Expected [N,3,H,W], got {tuple(x.shape)}')
        # Official POPatchEmbed records floor(H/4), floor(W/4).
        # Enforce divisible dimensions to avoid silently reshaping incompatible input.
        H, W = x.shape[-2:]
        if H % 4 or W % 4:
            raise ValueError('SVTRv2 input H and W must be divisible by 4; this notebook uses 40x128.')
        features = self.encoder(x)
        expected = (x.shape[0], self.raw_out_channels, (H + 7)//8, W//4)
        if tuple(features.shape) != expected:
            raise RuntimeError(f'SVTRv2 feature shape {tuple(features.shape)} != {expected}')
        return self.projection(features).contiguous()
