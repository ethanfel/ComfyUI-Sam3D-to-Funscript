"""Read one person's mask video on the original source timeline, a frame at a time."""

from fractions import Fraction

import av
import numpy as np


def timestamp_seconds(timing):
    return timing["pts"] * Fraction(*timing["time_base"]) - Fraction(*timing["origin"])


def pack_mask(gray):
    """Return native SAM3 little-endian packed bits and normalized xywh bounds."""
    binary = gray >= 128
    height, width = binary.shape
    rows, columns = np.flatnonzero(binary.any(axis=1)), np.flatnonzero(binary.any(axis=0))
    if not len(rows):
        return None, None
    bbox = [float(columns[0] / width), float(rows[0] / height),
            float((columns[-1] - columns[0] + 1) / width), float((rows[-1] - rows[0] + 1) / height)]
    # Native SAM3 packing has no unpadded-width field. Resize rather than pad,
    # so its later resize to the source canvas keeps normalized coordinates.
    packed_width = ((width + 7) // 8) * 8
    if packed_width != width:
        binary = binary[:, np.arange(packed_width) * width // packed_width]
    return np.packbits(binary, axis=-1, bitorder="little"), bbox


class MaskVideoReader:
    """Keep one decoded frame; materialize only masks for requested source PTS."""

    def __init__(self, path, start_seconds=0, duration_seconds=0):
        self.path = path
        self.start = Fraction(str(start_seconds))
        self.end = self.start + Fraction(str(duration_seconds)) if duration_seconds else None
        self.container = None
        self.frame = self.time = self.origin = self.previous = None
        self.size = None

    def __enter__(self):
        self.container = av.open(str(self.path))
        self.frames = self.container.decode(video=0)
        return self

    def __exit__(self, *exc):
        self.container.close()
        self.container = self.frames = self.frame = None

    def at(self, source_time, source_size):
        if source_time < self.start or (self.end is not None and source_time >= self.end):
            raise ValueError(f"Mask video trim does not cover source time {float(source_time):.3f}s. Use matching source/mask timelines and trims.")
        # Allow timestamp rounding when a mask is encoded with a different time base.
        tolerance = Fraction(1, 1000)
        while self.frame is None or self.time < source_time - tolerance:
            frame = next(self.frames, None)
            if frame is None:
                raise ValueError(f"Mask video ended before source time {float(source_time):.3f}s. Export masks for the full analysed interval.")
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Mask video lacks presentation timestamps")
            presentation = frame.pts * frame.time_base
            if self.origin is None:
                self.origin = presentation
            t = presentation - self.origin
            if self.previous is not None and t <= self.previous:
                raise ValueError("Mask video timestamps must be strictly increasing")
            self.frame, self.time, self.previous = frame, t, t
        if abs(self.time - source_time) > tolerance:
            raise ValueError(f"Mask/source frame timestamps differ at {float(source_time):.3f}s. Preserve source frame timing when exporting masks.")
        height, width = source_size
        size = (self.frame.width, self.frame.height)
        if self.size is not None and size != self.size:
            raise ValueError("Mask video changes resolution; use a constant-resolution mask canvas.")
        self.size = size
        if abs(self.frame.width * height - self.frame.height * width) > max(height, width):
            raise ValueError("Mask video must cover the full source canvas with the same aspect ratio; lower resolution is supported.")
        return pack_mask(self.frame.to_ndarray(format="gray"))
