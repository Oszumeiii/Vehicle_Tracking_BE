"""Application package for the Vehicle Tracking backend."""
import os

# Load CUDA kernels when first used instead of all at start-up. On Windows the eager default
# commits ~5 GiB more virtual memory per process (live host: ~12 GiB instead of ~5), which can
# exhaust the commit limit (RAM + page file) and kill a session with "Unable to allocate".
# Set before torch is imported; an explicit environment value still wins.
os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")

__all__ = []
