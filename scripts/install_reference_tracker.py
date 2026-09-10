"""Install the optional pinned CoTracker3 backend with this ComfyUI Python.

CoTracker source and weights remain CC-BY-NC-4.0; they are not part of the GPL pack.
Existing torch/runtime packages are left to the ComfyUI environment.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen

COMMIT = "82e02e8029753ad4ef13cf06be7f4fc5facdda4d"
SOURCE_HASH = "45ccb696ddd27b89caffefe6b9c2f5c36f61357fd8419ae02da7ba7b8cc999d1"
MODEL_HASH = "205d34789f19699d64b22cf93f9b697f15f28d4025240e31532e504109837218"
MODEL_HASHES = {"online": MODEL_HASH, "offline": "2670d4562ed69326dda775a26e54883925cd11b6fc9b24cb7aa9f8078bce7834"}


def verified_download(url, path, expected):
    digest = hashlib.sha256()
    with urlopen(url, timeout=60) as response, path.open("wb") as destination:
        while chunk := response.read(1024*1024):
            destination.write(chunk); digest.update(chunk)
    if digest.hexdigest() != expected:
        path.unlink()
        raise RuntimeError("Downloaded file failed SHA-256 verification")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-root", type=Path, required=True)
    parser.add_argument("--mode", choices=("online", "offline", "both"), default="online")
    parser.add_argument("--model-dir", type=Path, help="Override the cotracker directory, e.g. an extra_model_paths directory")
    parser.add_argument("--weights-only", action="store_true", help="Keep the existing CoTracker Python installation")
    args = parser.parse_args()
    if not (args.comfy_root / "main.py").is_file():
        parser.error("comfy-root must point to the ComfyUI installation")
    model_dir = args.model_dir or args.comfy_root / "models" / "cotracker"
    with tempfile.TemporaryDirectory(prefix="s3f-cotracker-install-") as temporary:
        root = Path(temporary)
        if not args.weights_only:
            archive = root / "source.tar.gz"
            verified_download(f"https://codeload.github.com/facebookresearch/co-tracker/tar.gz/{COMMIT}", archive, SOURCE_HASH)
            with tarfile.open(archive) as tar:
                tar.extractall(root, filter="data")
            subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", str(root / f"co-tracker-{COMMIT}")], check=True)
        for mode in MODEL_HASHES if args.mode == "both" else [args.mode]:
            destination = model_dir / f"cotracker3_scaled_{mode}.pth"
            expected = MODEL_HASHES[mode]
            if destination.exists():
                with destination.open("rb") as existing:
                    matches = hashlib.file_digest(existing, "sha256").hexdigest() == expected
                if not matches:
                    raise RuntimeError(f"An existing checkpoint differs from the pinned model: {destination}")
            else:
                model = root / "model.pth"
                verified_download(f"https://huggingface.co/facebook/cotracker3/resolve/bf55ea50d4390e1820a267f131cd6587240fb2c5/scaled_{mode}.pth", model, expected)
                destination.parent.mkdir(parents=True, exist_ok=True)
                staging = destination.with_suffix(".download")
                try:
                    shutil.copyfile(model, staging)
                    staging.replace(destination)
                finally:
                    staging.unlink(missing_ok=True)
            print(f"Verified CoTracker3 {mode} checkpoint: {destination}")


if __name__ == "__main__":
    main()
