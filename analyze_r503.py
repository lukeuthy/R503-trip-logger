from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

import matplotlib.pyplot as plt
import pandas as pd

EXPECTED_STOPS = 14


def load_csv_if_exists(path: Path) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    return pd.read_csv(path)


def normalize_event_types(df: pd.DataFrame) -> pd.DataFrame:
    if "event_type" not in df.columns:
        return df
    df = df.copy()
    df["event_type"] = (
        df["event_type"]
        .astype(str)
        .str.lower()
        .replace({"enter": "arrive", "exit": "depart", "dwell_confirmed": "dwell"})
    )
    return df


def stop_pair_count(df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    filtered = df[df["event_type"].isin(["arrive", "depart"])].copy()
    if filtered.empty:
        return 0
    return int((filtered["event_type"] == "depart").sum())


def extract_gap_values(gps_df: pd.DataFrame) -> pd.Series:
    if "inter_point_gap_sec" in gps_df.columns:
        return gps_df["inter_point_gap_sec"].dropna()
    if "timestamp_ms" in gps_df.columns:
        ordered = gps_df.sort_values("timestamp_ms").copy()
        return ordered["timestamp_ms"].diff() / 1000.0
    if "timestamp_iso" in gps_df.columns:
        ordered = gps_df.copy()
        ordered["ts"] = pd.to_datetime(ordered["timestamp_iso"], utc=True, errors="coerce")
        ordered = ordered.sort_values("ts")
        return ordered["ts"].diff().dt.total_seconds()
    return pd.Series(dtype="float64")


def make_gap_plot(gap_map: Dict[str, pd.Series], out_path: Path) -> None:
    labels = list(gap_map.keys())
    values = [gap_map[label].dropna().tolist() for label in labels]
    if not values:
        return
    plt.figure(figsize=(9, 4))
    plt.boxplot(values, labels=labels, vert=True)
    plt.ylabel("Inter-point gap (sec)")
    plt.title("GPS Sampling Gap Distribution")

    for idx, label in enumerate(labels, start=1):
        series = gap_map[label].dropna()
        spikes = series[series > 30]
        for spike in spikes:
            plt.scatter(idx, spike, color="red", s=20, zorder=3)
            plt.text(idx + 0.02, spike, "OS gap", color="red", fontsize=7)

    plt.tight_layout()
    plt.savefig(out_path)
    plt.close()


def load_bundle(bundle_json: Path) -> Dict[str, pd.DataFrame]:
    with bundle_json.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    gps = pd.DataFrame(payload.get("gps_points", []))
    events = pd.DataFrame(payload.get("stop_events", []))
    segments = pd.DataFrame(payload.get("segment_times", []))
    return {
        "gps_points": gps,
        "stop_events": normalize_event_types(events),
        "segment_times": segments,
    }


def main() -> None:
    root = Path.cwd()
    data_root = root / "data"
    output_root = root / "analysis_out"
    output_root.mkdir(parents=True, exist_ok=True)

    variant_dirs = [path for path in data_root.iterdir() if path.is_dir()] if data_root.exists() else []
    summary_rows: List[Dict[str, object]] = []
    gap_map: Dict[str, pd.Series] = {}

    for variant_dir in sorted(variant_dirs):
        label = variant_dir.name
        gps_csv = variant_dir / "gps_points.csv"
        stop_csv = variant_dir / "stop_events.csv"
        seg_csv = variant_dir / "segment_times.csv"
        bundle_json = variant_dir / "bundle.json"

        if bundle_json.exists():
            bundle = load_bundle(bundle_json)
            gps_df = bundle["gps_points"]
            stop_df = bundle["stop_events"]
            seg_df = bundle["segment_times"]
        else:
            gps_df = load_csv_if_exists(gps_csv)
            stop_df = normalize_event_types(load_csv_if_exists(stop_csv))
            seg_df = load_csv_if_exists(seg_csv)

        gap = extract_gap_values(gps_df).dropna()
        gap_map[label] = gap
        summary_rows.append(
            {
                "variant": label,
                "gps_points": int(len(gps_df)),
                "stop_events": int(len(stop_df)),
                "arrive_depart_pairs": stop_pair_count(stop_df),
                "segments": int(len(seg_df)),
                "expected_stops": EXPECTED_STOPS,
                "max_gap_sec": float(gap.max()) if not gap.empty else None,
                "mean_gap_sec": float(gap.mean()) if not gap.empty else None,
            }
        )

    main_app_dir = data_root / "main_app"
    if main_app_dir.exists() and not any(row["variant"] == "main_app" for row in summary_rows):
        gps_df = load_csv_if_exists(main_app_dir / "gps_points.csv")
        stop_df = normalize_event_types(load_csv_if_exists(main_app_dir / "stop_events.csv"))
        seg_df = load_csv_if_exists(main_app_dir / "segment_times.csv")
        gap = extract_gap_values(gps_df).dropna()
        summary_rows.append(
            {
                "variant": "main_app",
                "gps_points": int(len(gps_df)),
                "stop_events": int(len(stop_df)),
                "arrive_depart_pairs": stop_pair_count(stop_df),
                "segments": int(len(seg_df)),
                "expected_stops": EXPECTED_STOPS,
                "max_gap_sec": float(gap.max()) if not gap.empty else None,
                "mean_gap_sec": float(gap.mean()) if not gap.empty else None,
            }
        )
        gap_map["main_app"] = gap

    summary_df = pd.DataFrame(summary_rows)
    summary_df.to_csv(output_root / "summary_table.csv", index=False)
    make_gap_plot(gap_map, output_root / "fig1_gap_boxplot.png")


if __name__ == "__main__":
    main()
