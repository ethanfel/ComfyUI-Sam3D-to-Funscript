"""Benchmark cached SAM3D poses against a paired reference and save review artifacts."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from sam3d_funscript.calibration import calibrate_sequence, evaluate_actions, load_reference
from sam3d_funscript.core import ANCHORS, PoseSequence, export_project


def plot_report(baseline, calibrated, reference, report, destination):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    first, last = report["full_baseline"]["first_ms"], report["full_baseline"]["last_ms"]
    times = np.arange(first, last, 20.0)
    ref = evaluate_actions(reference["actions"], times)
    original = evaluate_actions(baseline["scripts"]["L0"]["actions"], times)
    fitted = evaluate_actions(calibrated["scripts"]["L0"]["actions"], times)
    fig, axes = plt.subplots(3, 1, figsize=(14, 9), layout="constrained")
    for ax, (lo, hi) in zip(axes[:2], [(first, last), (report["split"]["test_start_ms"], min(last, report["split"]["test_start_ms"] + 20_000))]):
        mask = (times >= lo) & (times <= hi)
        for label, values, color, alpha in [("Reference", ref, "#914dcc", .9), ("Default pelvis / up", original, "#758496", .7), ("Calibration selected on validation", fitted, "#00896f", .9)]:
            ax.plot(times[mask] / 1000, values[mask], label=label, color=color, alpha=alpha, linewidth=1)
        ax.set(xlim=(lo / 1000, hi / 1000), ylim=(-3, 103), ylabel="Position / 100", xlabel="Video time (s)")
        ax.grid(alpha=.2)
    axes[0].axvspan(report["split"]["test_start_ms"] / 1000, last / 1000, color="#e6b85b", alpha=.17, label="Held-out test interval")
    axes[0].set_title("Full overlap — authored-script agreement, not physical ground truth", loc="left")
    axes[0].legend(loc="upper left", fontsize=8, ncol=2)
    axes[1].set_title("First 20 seconds of held-out test interval", loc="left")
    windows = report["windows"]
    centers = [(w["start_ms"] + w["end_ms"]) / 2000 for w in windows]
    axes[2].plot(centers, [w["baseline"]["rmse"] for w in windows], "o-", label="Default", color="#758496")
    axes[2].plot(centers, [w["calibrated"]["rmse"] for w in windows], "o-", label="Calibrated", color="#00896f")
    axes[2].axvspan(report["split"]["test_start_ms"] / 1000, last / 1000, color="#e6b85b", alpha=.17)
    axes[2].set(xlabel="Video time (s)", ylabel="RMSE / 100", title="Error per 20-second interval; lower is better")
    axes[2].grid(alpha=.2); axes[2].legend()
    fig.savefig(destination / "comparison.png", dpi=150, bbox_inches="tight", pad_inches=.15)
    fig.savefig(destination / "comparison.pdf", bbox_inches="tight", pad_inches=.15)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--export-root", type=Path, default=Path("development/output/sam3d_funscript"))
    parser.add_argument("--name", default="calibration")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sequence = PoseSequence.load(args.cache)
    reference = load_reference(args.reference)
    baseline, calibrated, report = calibrate_sequence(sequence, reference)
    selected = report["selected"]
    h, w = sequence.metadata["image_size"]
    uv = sequence.pixels[:, selected["target_person"], ANCHORS[selected["target_anchor"]]].mean(axis=1)
    report["selected_anchor_outside_frame_fraction"] = float(np.mean((uv[:, 0] < 0) | (uv[:, 0] >= w) | (uv[:, 1] < 0) | (uv[:, 1] >= h)))
    report["baseline_project"] = str(export_project(baseline, args.export_root, args.name + "_baseline").resolve())
    report["calibrated_project"] = str(export_project(calibrated, args.export_root, args.name + "_calibrated").resolve())
    (args.output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    (args.output / "selected-config.json").write_text(json.dumps(report["config"], indent=2))
    plot_report(baseline, calibrated, reference, report, args.output)
    score = report["scores"]["test"]
    fmt = lambda value: "undefined" if value is None else f"{value:.3f}"
    lines = [f"# {args.name} calibration", "", report["scope"], "",
             "The provided script is an authoring reference. It is not a measurement of 3D motion, contact, or force.", "",
             f"Analysed {len(sequence.times_ms)} poses. Test interval starts at {report['split']['test_start_ms']/1000:.2f}s.", "",
             "| Held-out test | MAE / 100 | RMSE / 100 | Correlation | Motion standard deviation / reference |",
             "|---|---:|---:|---:|---:|"]
    for key, label in [("baseline", "Default pelvis/up"), ("calibrated", "Selected calibration"), ("constant_train_median", "Constant training-median position")]:
        m = score[key]
        lines.append(f"| {label} | {fmt(m['mae'])} | {fmt(m['rmse'])} | {fmt(m['correlation'])} | {fmt(m['std_ratio'])} |")
    lines += ["", f"Selected anchor: `{selected['target_anchor']}`, component `{selected['component']}` (0=up, 1=forward, 2=left), smoothing {selected['smoothing_ms']} ms.", "",
              f"Selected-anchor projections outside the image: {100*report['selected_anchor_outside_frame_fraction']:.1f}%. This is a consistency flag, not a visibility confidence score.", "",
              "Calibration fits gain and center on the initial 60%, selects anchor/component/smoothing using the next 20%, and evaluates once on the final 20%, with one-second gaps around boundaries. No time offset is optimized.", "",
              "The constant baseline and motion standard-deviation ratio expose collapse to a nearly stationary signal. Lower position error alone does not establish better movement tracking.", "",
              "![Reference comparison](comparison.png)", "", "Full metrics, candidate rankings and reversal matching are in [report.json](report.json)."]
    (args.output / "REPORT.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"selected": selected, "test_scores": score,
                      "calibrated_project": report["calibrated_project"], "report": str((args.output / "REPORT.md").resolve())}, indent=2))


if __name__ == "__main__":
    main()
